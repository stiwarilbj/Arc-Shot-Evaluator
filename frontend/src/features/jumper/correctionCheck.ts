import type { MaskWarning, Track } from "./domain.ts";

/** Check explicit prompts against visible ownership after all tracks compete.
 * A membership check cannot establish identity or infer a hidden body part.
 */
export function checkCorrections(
  frame: number,
  owners: Uint8Array,
  width: number,
  height: number,
  tracks: readonly Track[],
): MaskWarning[] {
  const warnings: MaskWarning[] = [];
  for (const track of tracks) {
    if (track.ignored) continue;
    let includeMissed = false, excludeFailed = false;
    for (const prompt of track.prompts) {
      if (prompt.frame !== frame) continue;
      for (const [index, point] of (prompt.points ?? []).entries()) {
        // Prompts are already runtime validated; normalized edge points sample
        // the nearest in-frame pixel, using the same rule on both targets.
        const x = Math.min(width - 1, Math.floor(point[0] * width));
        const y = Math.min(height - 1, Math.floor(point[1] * height));
        const belongs = owners[y * width + x] === track.id;
        if (prompt.labels?.[index] === 1 && !belongs) includeMissed = true;
        if (prompt.labels?.[index] === 0 && belongs) excludeFailed = true;
      }
    }
    if (includeMissed)
      warnings.push({ frame, kind: "correction_include_missed", track_ids: [track.id] });
    if (excludeFailed)
      warnings.push({ frame, kind: "correction_exclude_failed", track_ids: [track.id] });
  }
  return warnings;
}
