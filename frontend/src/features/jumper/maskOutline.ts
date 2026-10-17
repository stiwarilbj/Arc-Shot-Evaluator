// Diagnostic geometry only. Keep equivalent to backend/jumper/mask_outline.py.
// These checks never change a mask or infer anatomical body parts.
type Extent = { area: number; x: number; y: number; bounds: number[] };
type Part = { area: number; left: number; top: number; right: number; bottom: number };

function components(mask: Uint8Array, width: number, height: number) {
  const labels = new Int32Array(mask.length), queue = new Int32Array(mask.length);
  const parts: Part[] = [{ area: 0, left: 0, top: 0, right: 0, bottom: 0 }];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = parts.length;
    const part = { area: 0, left: width, top: height, right: 0, bottom: 0 };
    let head = 0, tail = 1;
    queue[0] = i;
    labels[i] = id;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      part.area++;
      part.left = Math.min(part.left, x); part.top = Math.min(part.top, y);
      part.right = Math.max(part.right, x + 1); part.bottom = Math.max(part.bottom, y + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const j = (y + dy) * width + x + dx;
        if (mask[j] && !labels[j]) { labels[j] = id; queue[tail++] = j; }
      }
    }
    parts.push(part);
  }
  let main = 0;
  for (let i = 1; i < parts.length; i++) if (parts[i].area > parts[main].area) main = i;
  return { labels, parts, main };
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    for (let dy = -radius; dy <= radius; dy++) {
      if (y + dy < 0 || y + dy >= height) continue;
      const start = (y + dy) * width;
      out.fill(1, start + Math.max(0, x - radius), start + Math.min(width, x + radius + 1));
    }
  }
  return out;
}

export function outlineChanges(previous: Uint8Array, current: Uint8Array,
  width: number, height: number, id: number, a: Extent, b: Extent) {
  // Align by body centroid, not by a fitted/resized body that could hide lost limbs.
  const dx = Math.round((b.x - a.x) * width), dy = Math.round((b.y - a.y) * height);
  const left = Math.min(Math.round(a.bounds[0] * width), Math.round(b.bounds[0] * width) - dx);
  const top = Math.min(Math.round(a.bounds[1] * height), Math.round(b.bounds[1] * height) - dy);
  const right = Math.max(Math.round(a.bounds[2] * width), Math.round(b.bounds[2] * width) - dx);
  const bottom = Math.max(Math.round(a.bounds[3] * height), Math.round(b.bounds[3] * height) - dy);
  const w = right - left, h = bottom - top;
  const old = new Uint8Array(w * h), now = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = left + x, py = top + y, qx = px + dx, qy = py + dy;
    const i = y * w + x;
    if (px >= 0 && px < width && py >= 0 && py < height) old[i] = +(previous[py * width + px] === id);
    if (qx >= 0 && qx < width && qy >= 0 && qy < height) now[i] = +(current[qy * width + qx] === id);
  }
  const before = components(old, w, h), after = components(now, w, h);
  const minArea = Math.max(4, Math.ceil(Math.min(a.area, b.area) * 0.005));
  let fragmented = false;
  for (let label = 1; label < after.parts.length; label++) {
    const part = after.parts[label];
    if (label === after.main || part.area < minArea || Math.max(part.right-part.left, part.bottom-part.top) < 3) continue;
    let overlap = 0, mainOverlap = 0;
    for (let y = part.top; y < part.bottom; y++) for (let x = part.left; x < part.right; x++) {
      const i = y * w + x;
      if (after.labels[i] !== label) continue;
      if (old[i]) overlap++;
      if (before.labels[i] === before.main) mainOverlap++;
    }
    if (mainOverlap >= part.area * 0.5 || overlap < part.area * 0.25) fragmented = true;
  }
  const bodyHeight = Math.max((a.bounds[3]-a.bounds[1])*height, (b.bounds[3]-b.bounds[1])*height);
  const tolerance = Math.max(1, Math.min(4, Math.floor(bodyHeight * 0.02 + 0.5)));
  const oldNear = dilate(old, w, h, tolerance), nowNear = dilate(now, w, h, tolerance);
  const lost = new Uint8Array(old.length), gained = new Uint8Array(old.length);
  for (let i = 0; i < old.length; i++) { lost[i] = +(!!old[i] && !nowNear[i]); gained[i] = +(!!now[i] && !oldNear[i]); }
  const reach = Math.max(3, Math.ceil(bodyHeight * 0.2));
  const length = Math.max(3, Math.ceil(bodyHeight * 0.08));
  function unmatched(changed: Uint8Array, opposite: Uint8Array) {
    const regions = components(changed, w, h);
    for (const part of regions.parts.slice(1)) {
      if (part.area < minArea || Math.max(part.right-part.left, part.bottom-part.top) < length) continue;
      let nearby = 0;
      for (let y = Math.max(0, part.top-reach); y < Math.min(h, part.bottom+reach); y++)
        for (let x = Math.max(0, part.left-reach); x < Math.min(w, part.right+reach); x++) nearby += opposite[y*w+x];
      if (nearby < part.area * 0.6) return true;
    }
    return false;
  }
  return { outline: unmatched(lost, gained) || unmatched(gained, lost), fragmented };
}
