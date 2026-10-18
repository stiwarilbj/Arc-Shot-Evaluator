// Review-only diagnostics. Keep thresholds/rasterization equivalent to mask_joins.py.
import type { MaskWarning } from "./domain.ts";
type Track = {
  id: number;
  ignored?: boolean;
  prompts: readonly { frame: number }[];
};
type Sample = {
  pixels: Uint8Array;
  core: Uint8Array;
  area: number;
  x: number;
  y: number;
  bounds: number[];
};
type Baseline = { a: Sample; b: Sample; owners: Uint8Array };
type Pending = { first: number; baseline?: Baseline };

/** Bounded diagnostic grid; never changes inference, ownership or rendered masks. */
export class MaskJoins {
  private width: number;
  private height: number;
  private masks = new Map<number, Sample>();
  private previous = new Map<number, Sample>();
  private previousOwners?: Uint8Array;
  private previousFrame = -2;
  private pending = new Map<string, Pending>();
  constructor(width: number, height: number) {
    const scale = Math.min(1, 128 / Math.max(width, height));
    this.width = Math.max(1, Math.floor(width * scale));
    this.height = Math.max(1, Math.floor(height * scale));
  }
  begin() {
    this.masks.clear();
  }
  add(id: number, values: Float32Array, width: number, height: number) {
    const pixels = new Uint8Array(this.width * this.height),
      core = pixels.slice();
    let area = 0,
      sx = 0,
      sy = 0;
    const bounds = [this.width, this.height, 0, 0];
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) {
        const at =
          Math.floor(((y + 0.5) * height) / this.height) * width +
          Math.floor(((x + 0.5) * width) / this.width);
        if (values[at] > 0) {
          pixels[y * this.width + x] = 1;
          area++;
          sx += x;
          sy += y;
          bounds[0] = Math.min(bounds[0], x);
          bounds[1] = Math.min(bounds[1], y);
          bounds[2] = Math.max(bounds[2], x + 1);
          bounds[3] = Math.max(bounds[3], y + 1);
        }
      }
    for (let y = 1; y < this.height - 1; y++)
      for (let x = 1; x < this.width - 1; x++) {
        const i = y * this.width + x;
        core[i] = +(
          pixels[i] &&
          pixels[i - 1] &&
          pixels[i + 1] &&
          pixels[i - this.width] &&
          pixels[i + this.width]
        );
      }
    this.masks.set(id, {
      pixels,
      core,
      area,
      bounds,
      x: sx / (area || 1),
      y: sy / (area || 1),
    });
  }
  inspect(
    frame: number,
    labels: Uint8Array,
    width: number,
    height: number,
    tracks: readonly Track[],
    boxes: number[][] = [],
    reset = false,
  ): MaskWarning[] {
    if (reset || frame !== this.previousFrame + 1) {
      this.previous.clear();
      this.previousOwners = undefined;
      this.pending.clear();
    }
    const owners = new Uint8Array(this.width * this.height);
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++)
        owners[y * this.width + x] =
          labels[
            Math.floor(((y + 0.5) * height) / this.height) * width +
              Math.floor(((x + 0.5) * width) / this.width)
          ];
    const active = tracks.filter(
      (t) => !t.ignored && frame >= t.prompts[0].frame && this.masks.has(t.id),
    );
    const warnings: MaskWarning[] = [],
      next = new Map<string, Pending>();
    const emitted = new Set<string>(),
      detectionCache = new Map<number, boolean>();
    for (const a of active)
      for (const b of active) {
        if (a.id === b.id) continue;
        const currentA = this.masks.get(a.id)!,
          currentB = this.masks.get(b.id)!;
        if (
          currentA.bounds[2] <= currentB.bounds[0] ||
          currentB.bounds[2] <= currentA.bounds[0] ||
          currentA.bounds[3] <= currentB.bounds[1] ||
          currentB.bounds[3] <= currentA.bounds[1]
        )
          continue;
        const key = `${a.id}:${b.id}`,
          pending = this.pending.get(key);
        const oldA = this.previous.get(a.id),
          oldB = this.previous.get(b.id);
        const baseline =
          pending?.baseline ??
          (oldA && oldB && this.previousOwners
            ? { a: oldA, b: oldB, owners: this.previousOwners }
            : undefined);
        let core = 0,
          shared = 0,
          claimed = 0,
          newlyClaimed = 0;
        const dx = baseline ? Math.round(currentB.x - baseline.b.x) : 0;
        const dy = baseline ? Math.round(currentB.y - baseline.b.y) : 0;
        for (let y = 0; y < this.height; y++)
          for (let x = 0; x < this.width; x++) {
            const i = y * this.width + x;
            if (!currentB.core[i]) continue;
            core++;
            if (!currentA.pixels[i]) continue;
            shared++;
            if (owners[i] !== a.id) continue;
            claimed++;
            const px = x - dx,
              py = y - dy,
              j = py * this.width + px;
            if (
              baseline &&
              px >= 0 &&
              px < this.width &&
              py >= 0 &&
              py < this.height &&
              baseline.b.pixels[j] &&
              !baseline.a.pixels[j] &&
              baseline.owners[j] === b.id
            )
              newlyClaimed++;
          }
        // Require body-interior overlap and substantial final ownership, not adjacent boxes/edges.
        if (core < 12 || shared / core < 0.4 || claimed / core < 0.3) continue;
        let retained = 0,
          retainedStill = 0;
        if (baseline) {
          const ax = Math.round(currentA.x - baseline.a.x),
            ay = Math.round(currentA.y - baseline.a.y);
          for (let y = 0; y < this.height; y++)
            for (let x = 0; x < this.width; x++) {
              const px = x - ax,
                py = y - ay;
              if (
                currentA.pixels[y * this.width + x] &&
                baseline.a.pixels[y * this.width + x]
              )
                retainedStill++;
              if (
                currentA.pixels[y * this.width + x] &&
                px >= 0 &&
                px < this.width &&
                py >= 0 &&
                py < this.height &&
                baseline.a.pixels[py * this.width + px]
              )
                retained++;
            }
        }
        const takeover =
          !!baseline &&
          newlyClaimed >= 6 &&
          newlyClaimed / core >= 0.25 &&
          Math.max(retained, retainedStill) / Math.max(1, baseline.a.area) >=
            0.65;
        // Two distinct detection cores must each contain both raw mask and visible
        // claimant pixels. Box overlap alone is never evidence of a joined body.
        let detection = detectionCache.get(a.id);
        if (!takeover && detection === undefined) {
          const supported = boxes.filter((box) => {
            const cx = (box[0] + box[2]) / 2,
              cy = (box[1] + box[3]) / 2;
            const hw = (box[2] - box[0]) * 0.2,
              hh = (box[3] - box[1]) * 0.3;
            let count = 0,
              raw = 0,
              visible = 0;
            for (let y = 0; y < this.height; y++)
              for (let x = 0; x < this.width; x++) {
                if (
                  (x + 0.5) / this.width < cx - hw ||
                  (x + 0.5) / this.width >= cx + hw ||
                  (y + 0.5) / this.height < cy - hh ||
                  (y + 0.5) / this.height >= cy + hh
                )
                  continue;
                const i = y * this.width + x;
                count++;
                raw += currentA.pixels[i];
                visible += +(owners[i] === a.id);
              }
            return count >= 6 && raw / count >= 0.6 && visible / count >= 0.5;
          });
          detection = supported.some((p, i) =>
            supported
              .slice(i + 1)
              .some(
                (q) =>
                  Math.abs((p[0] + p[2] - q[0] - q[2]) / 2) >
                    Math.min(p[2] - p[0], q[2] - q[0]) * 0.6 ||
                  Math.abs((p[1] + p[3] - q[1] - q[3]) / 2) >
                    Math.min(p[3] - p[1], q[3] - q[1]) * 0.6,
              ),
          );
          detectionCache.set(a.id, detection);
        }
        if (!takeover && !detection) continue;
        next.set(key, { first: pending?.first ?? frame, baseline });
        if (!pending) continue; // Require two consecutive suspicious frames.
        for (const at of frame === pending.first + 1
          ? [pending.first, frame]
          : [frame]) {
          const pair = [a.id, b.id].sort((x, y) => x - y),
            warningKey = `${at}:${pair}`;
          if (!emitted.has(warningKey))
            warnings.push({
              frame: at,
              kind: "mask_joined",
              track_ids: [a.id, b.id],
            });
          emitted.add(warningKey);
        }
      }
    this.pending = next;
    this.previous = new Map(this.masks);
    this.previousOwners = owners;
    this.previousFrame = frame;
    return warnings;
  }
}
