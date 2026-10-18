/** Clip-wide visible-contact graph. No image colors or team data enter this code. */
const NEIGHBORS = [[1, 0], [-1, 1], [0, 1], [1, 1]] as const;
export const GRAY_SHADES = [64, 81, 98, 115, 132, 149, 166, 183, 200] as const;
export class OverlapPalette {
  private weights = new Uint32Array(256 * 256);
  private present = new Uint8Array(256);
  private target: number;
  constructor(target: number) {
    if (!Number.isInteger(target) || target < 1 || target > 255)
      throw Error("Invalid palette target");
    this.target = target;
  }
  observe(labels: Uint8Array, width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || labels.length !== width * height)
      throw Error("Invalid palette frame");
    const contacts = new Set<number>();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const a = labels[y * width + x];
      if (!a || a === this.target) continue;
      this.present[a] = 1;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const b = labels[ny * width + nx];
        if (b && b !== a && b !== this.target)
          contacts.add(Math.min(a, b) * 256 + Math.max(a, b));
      }
    }
    // One vote per touching pair per frame, so larger people do not dominate.
    for (const pair of contacts) {
      const a = pair >> 8, b = pair & 255;
      this.weights[a * 256 + b]++;
      this.weights[b * 256 + a]++;
    }
  }
  finish(): Uint8Array {
    const shades = new Uint8Array(256);
    for (let id = 1; id < 256; id++) shades[id] = 64 + (((id - 1) * 47) % 137);
    shades[0] = 224;
    shades[this.target] = 0;
    const ids = Array.from({length: 255}, (_, i) => i + 1)
      .filter(id => this.present[id] && id !== this.target);
    const degree = (id: number) => ids.reduce((sum, other) => sum + this.weights[id * 256 + other], 0);
    const degrees = new Map(ids.map(id => [id, degree(id)]));
    ids.sort((a, b) => degrees.get(b)! - degrees.get(a)! || a - b);
    const assigned: number[] = [];
    const usage = new Map<number, number>();
    for (const id of ids) {
      let best = GRAY_SHADES[0] as number, score = -1, used = Infinity;
      for (const shade of GRAY_SHADES) {
        const value = assigned.reduce((sum, other) => {
          const distance = Math.abs(shade - shades[other]);
          return sum + this.weights[id * 256 + other] * (4 * Math.min(distance, 96) + distance - (distance < 32 ? 256 : 0));
        }, 0);
        const count = usage.get(shade) ?? 0;
        if (value > score || (value === score && count < used)) {
          best = shade; score = value; used = count;
        }
      }
      shades[id] = best;
      assigned.push(id);
      usage.set(best, used + 1);
    }
    return shades;
  }
}
