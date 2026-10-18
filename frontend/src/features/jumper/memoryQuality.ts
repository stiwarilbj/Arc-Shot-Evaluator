/** Conservative tracking-memory admission; logits are not calibrated probabilities. */
export function reliableMask(values: Float32Array, previous?: Float32Array, score = 1) {
  let area = 0, strong = 0, oldArea = 0, intersection = 0;
  let x = 0, y = 0, oldX = 0, oldY = 0;
  const side = 256;
  if (values.length !== side * side || !Number.isFinite(score) || score <= 0) return false;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return false;
    if (values[i] > 0) {
      area++; x += i % side; y += Math.floor(i / side);
      if (values[i] >= 1) strong++;
    }
    if (previous && previous[i] > 0) {
      oldArea++; oldX += i % side; oldY += Math.floor(i / side);
      if (values[i] > 0) intersection++;
    }
  }
  if (area < 4 || strong / area < 0.25) return false;
  if (oldArea) {
    const iou = intersection / (area + oldArea - intersection);
    const ratio = area / oldArea;
    const distance = Math.hypot(x / area - oldX / oldArea, y / area - oldY / oldArea) / side;
    if (iou < 0.1 && (ratio < 0.25 || ratio > 4 || distance > 0.25)) return false;
  }
  return true;
}

/** Preserve one last reliable frame past the ordinary pointer window. */
export function pruneReliable<T>(recent: Map<number, T>, frame: number, reverse = false) {
  const direction = reverse ? -1 : 1;
  const past = [...recent.keys()].filter(at => (frame - at) * direction >= 0);
  const latest = past.sort((a,b) => (b-a)*direction)[0];
  for (const at of recent.keys())
    if ((frame - at) * direction > 15 && at !== latest) recent.delete(at);
}
