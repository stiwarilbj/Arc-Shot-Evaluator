import type { MaskWarning } from "./domain.ts";
type Track = { id: number; ignored?: boolean; prompts: readonly { frame: number }[] };
type Evidence = { box: number[]; depth: number; ratio: number };
type Pending = Evidence & { first: number; count: number };

/** Review-only evidence on a bounded grid. Keep equivalent to floor_attachments.py.
 * Never changes masks, ownership, prompts, or tracking memory. */
export class FloorAttachments {
  private width: number;
  private height: number;
  private previousFrame = -2;
  private pending = new Map<number, Pending>();
  constructor(width: number, height: number) {
    const scale = Math.min(1, 128 / Math.max(width, height));
    this.width = Math.max(1, Math.floor(width * scale));
    this.height = Math.max(1, Math.floor(height * scale));
  }
  inspect(frame: number, labels: Uint8Array, width: number, height: number,
    tracks: readonly Track[], boxes: readonly number[][] = [], reset = false): MaskWarning[] {
    if (reset || frame !== this.previousFrame + 1) this.pending.clear();
    const w = this.width, h = this.height;
    const owners = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      owners[y*w+x] = labels[Math.floor((y+.5)*height/h)*width + Math.floor((x+.5)*width/w)];
    const sampled = boxes.map(box => box.map((v, i) => v * (i % 2 ? h : w)));
    const warnings: MaskWarning[] = [], next = new Map<number, Pending>();
    for (const track of tracks) {
      if (track.ignored || frame < track.prompts[0].frame) continue;
      const supported = sampled.filter(([l,t,r,b]) => {
        if (r-l < 6 || b-t < 16 || b >= h-3) return false;
        let total = 0, owned = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
          if (x+.5 >= l+(r-l)*.2 && x+.5 < r-(r-l)*.2 &&
              y+.5 >= t+(b-t)*.15 && y+.5 < b-(b-t)*.1) {
            total++; owned += +(owners[y*w+x] === track.id);
          }
        return total >= 12 && owned/total >= .55;
      });
      // A box is supporting evidence, not a body/foot boundary. Avoid choosing
      // between competing detections or inferring feet from a mask's bottom.
      if (supported.length !== 1) continue;
      const box = supported[0], [l,t,r,b] = box, bw = r-l, bh = b-t;
      const foot = Math.round(b), margin = Math.max(3, Math.ceil(bh*.08));
      const bodyBottom = Math.min(h, foot);
      let body = 0, tail = 0, bottom = foot, widest = 0, footWidth = 0;
      const excluded = (x: number, y: number) => sampled.some(other => other !== box &&
        x+.5 >= other[0] && x+.5 < other[2] && y+.5 >= other[1] && y+.5 < other[3]);
      const pixel = (x: number, y: number) => x >= 0 && x < w && y >= 0 && y < h &&
        owners[y*w+x] === track.id;
      for (let y = 0; y < h; y++) {
        let row = 0, feet = 0;
        for (let x = 0; x < w; x++) {
          if (!pixel(x,y)) continue;
          if (x+.5 >= l && x+.5 < r && y+.5 >= t && y < bodyBottom) {
            body++; if (y+.5 >= b-bh*.2) feet++;
          }
          if (y >= foot+margin && x+.5 >= l-bw*.5 && x+.5 < r+bw*.5 && !excluded(x,y)) {
            tail++; row++; bottom = Math.max(bottom,y+1);
          }
        }
        widest = Math.max(widest,row); footWidth = Math.max(footWidth,feet);
      }
      if (body < 24 || tail < Math.max(8, body*.08)) continue;
      const depth = (bottom-foot)/bh;
      const shadow = depth >= .12 && widest >= Math.max(bw*.9, footWidth*1.4);
      let intersection = 0, union = 0, reflected = 0;
      for (let d = margin; d < Math.floor(bh) && foot+d < h; d++)
        for (let x = 0; x < w; x++) {
          if (x+.5 < l-bw*.1 || x+.5 >= r+bw*.1 || excluded(x,foot+d)) continue;
          const above = pixel(x,foot-1-d), below = pixel(x,foot+d);
          union += +(above || below); intersection += +(above && below); reflected += +below;
        }
      const reflection = depth >= .3 && reflected >= Math.max(12,body*.2) &&
        union > 0 && intersection/union >= .65;
      if (!shadow && !reflection) continue;
      const evidence: Evidence = { box: [...box], depth, ratio: tail/body };
      let prior = this.pending.get(track.id);
      if (track.prompts.some(p => p.frame === frame)) prior = undefined;
      if (prior) {
        const [pl,pt,pr,pb] = prior.box;
        if (bh/(pb-pt) < .7 || bh/(pb-pt) > 1.4 ||
          Math.hypot((l+r-pl-pr)/2,(t+b-pt-pb)/2) > bh*.25 ||
          Math.abs(depth-prior.depth) > .25 || evidence.ratio/prior.ratio < .5 ||
          evidence.ratio/prior.ratio > 2) prior = undefined;
      }
      const current = { ...evidence, first: prior?.first ?? frame, count: (prior?.count ?? 0)+1 };
      next.set(track.id,current);
      if (current.count < 3) continue;
      for (const at of current.count === 3 ? [current.first,current.first+1,frame] : [frame])
        warnings.push({ frame: at, kind: "floor_attachment", track_ids: [track.id] });
    }
    this.pending = next; this.previousFrame = frame;
    return warnings;
  }
}
