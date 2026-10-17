import type { MaskWarning } from "./domain";

export const warningLabels = {
  target_lost: "Missing shooter",
  tracking_unstable: "Unstable outline",
  ambiguous_players: "Ambiguous overlap",
  possible_camera_cut: "Possible camera cut",
} as const;
export const warningKinds = Object.keys(warningLabels) as MaskWarning["kind"][];

export function warningFrames(
  warnings: MaskWarning[],
  kind: MaskWarning["kind"],
) {
  return [
    ...new Set(warnings.filter((w) => w.kind === kind).map((w) => w.frame)),
  ].sort((a, b) => a - b);
}
export function warningRanges(frames: number[]) {
  const ranges: { start: number; end: number }[] = [];
  for (const frame of frames) {
    const last = ranges.at(-1);
    if (last && frame === last.end + 1) last.end = frame;
    else ranges.push({ start: frame, end: frame });
  }
  return ranges;
}
export function nearestWarningFrame(frames: number[], desired: number) {
  return frames.reduce(
    (best, frame) =>
      Math.abs(frame - desired) < Math.abs(best - desired) ? frame : best,
    frames[0],
  );
}
