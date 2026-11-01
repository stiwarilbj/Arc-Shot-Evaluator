// Keep equivalent to backend/jumper/mask_ownership.py. No target/color preference.
const CLOSE = 0.35;
const CORE = 0.5;
const MAX_HOLD = 2; // At 30 Hz, never delay a persistent ownership change >67 ms.

/** Display-only arbitration. Tracking memory and discovery use raw current scores. */
export class MaskOwnership {
  private previous: Uint8Array;
  private age: Uint8Array;
  readonly owners: Uint8Array;
  private best: Float32Array;
  private second: Float32Array;
  private priorScore: Float32Array;

  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const size = width * height;
    this.previous = new Uint8Array(size);
    this.age = new Uint8Array(size);
    this.owners = new Uint8Array(size);
    this.best = new Float32Array(size);
    this.second = new Float32Array(size);
    this.priorScore = new Float32Array(size);
  }

  begin() {
    this.owners.fill(0);
    this.best.fill(0);
    this.second.fill(0);
    this.priorScore.fill(0);
  }

  add(id: number, scores: Float32Array) {
    for (let i = 0; i < scores.length; i++) {
      const score = scores[i];
      if (this.previous[i] === id) this.priorScore[i] = score;
      // Exact positive ties use identity, never input order or shooter/color.
      if (score > this.best[i] ||
        (score > 0 && score === this.best[i] && id < this.owners[i])) {
        this.second[i] = this.best[i];
        this.best[i] = score;
        this.owners[i] = id;
      } else if (score > this.second[i]) this.second[i] = score;
    }
  }

  finish(excluded: ReadonlySet<number>, reset = false): Uint8Array {
    const output = this.owners.slice();
    const age = new Uint8Array(output.length);
    if (!reset) for (let i = 0; i < output.length; i++) {
      const prior = this.previous[i];
      if (!prior || !output[i] || prior === output[i] || excluded.has(prior) ||
        this.age[i] >= MAX_HOLD || this.priorScore[i] <= 0 ||
        Math.fround(this.best[i] - this.priorScore[i]) > CLOSE) continue;
      // Only a narrow boundary next to a current, unambiguous owner is eligible.
      // Never extend an old mask into unsupported pixels or blanket an occluder.
      const x = i % this.width, y = Math.floor(i / this.width);
      let supported = false;
      for (let dy = -2; dy <= 2 && !supported; dy++) {
        if (y + dy < 0 || y + dy >= this.height) continue;
        for (let dx = -2; dx <= 2; dx++) {
          if (x + dx < 0 || x + dx >= this.width) continue;
          const j = (y + dy) * this.width + x + dx;
          if (this.owners[j] === prior && this.best[j] > CORE &&
            Math.fround(this.best[j] - this.second[j]) > CLOSE) { supported = true; break; }
        }
      }
      if (supported) { output[i] = prior; age[i] = this.age[i] + 1; }
    }
    for (let i = 0; i < output.length; i++)
      if (excluded.has(output[i])) output[i] = 0;
    this.previous = output.slice(); // Callers/checkpoints never share mutable history.
    this.age = age;
    return output;
  }
}
