import { ShooterSelectionError } from "./discovery.ts";
import type { PointPrompt } from "./domain.ts";

export const CONFIRM_SELECTION = "Your starting shooter selection changes with nearby points · Add another Include point on a different visible part of the same shooter in the first frame, then retry · If the player is too small or obscured, use a closer or clearer segment";

/** Compare evidence only; never select, merge, or enlarge a predicted mask. */
export function stableSelection(a: Float32Array, b: Float32Array) {
  if (a.length !== 65536 || b.length !== a.length) return false;
  let first = 0, second = 0, intersection = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return false;
    if (a[i] > 0) first++;
    if (b[i] > 0) second++;
    if (a[i] > 0 && b[i] > 0) intersection++;
  }
  return first >= 4 && second >= 4 && second / first >= .75 && second / first <= 4 / 3 &&
    intersection / (first + second - intersection) >= .75;
}

/** Nearby points must be inside both the selected foreground and its person box.
 * Keep every other user point and the same box; replace only the first Include.
 * At most three independent decoder probes, with no tracking-memory admission. */
export function selectionProbes(prompt: PointPrompt, mask: Float32Array): PointPrompt[] {
  const included = prompt.labels?.indexOf(1) ?? -1;
  if (!prompt.box || !prompt.points || included < 0) return [];
  if (!stableSelection(mask, mask)) throw new ShooterSelectionError(CONFIRM_SELECTION);
  const [left, top, right, bottom] = prompt.box;
  const width = right - left, height = bottom - top;
  const seed = prompt.points[included];
  const found: number[][] = [];
  for (const [dx, dy] of [[.12, 0], [-.12, 0], [0, .1], [0, -.1]]) {
    const aim = [seed[0] + dx * width, seed[1] + dy * height];
    let best: number[] | undefined, distance = Infinity;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] < 1) continue;
      const p = [(i % 256 + .5) / 256, (Math.floor(i / 256) + .5) / 256];
      if (p[0] <= left || p[0] >= right || p[1] <= top || p[1] >= bottom ||
          Math.abs(p[0] - seed[0]) > .22 * width || Math.abs(p[1] - seed[1]) > .18 * height ||
          Math.hypot(p[0] - seed[0], p[1] - seed[1]) < 2 / 256 ||
          found.some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 2 / 256) ||
          prompt.points.some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 2 / 256)) continue;
      const d = ((p[0] - aim[0]) / width) ** 2 + ((p[1] - aim[1]) / height) ** 2;
      if (d < distance) { distance = d; best = p; }
    }
    if (best) found.push(best);
    if (found.length === 3) break;
  }
  if (found.length < 2) throw new ShooterSelectionError(CONFIRM_SELECTION);
  return found.map(point => {
    const probe = structuredClone(prompt);
    probe.points![included] = point;
    return probe;
  });
}
