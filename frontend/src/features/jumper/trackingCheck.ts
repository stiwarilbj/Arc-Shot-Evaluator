import type {
  MaskWarning,
  PointPrompt,
  Track,
  TrackingCheck,
} from "./domain.ts";

// Compare the same source-space pixel centers on both targets. This bounded
// diagnostic grid is never used to render or repair a mask.
export const CHECK_SIZE = 128;
export function confirmedShooterFrame(objects: Track[], target: number) {
  return trackingCheckSegments(objects, target).at(-1)?.anchor;
}
export function trackingCheckSegments(objects: Track[], target: number) {
  const anchors =
    objects
      .find((o) => o.id === target)
      ?.prompts.filter((p) => p.frame > 0 && confirmsBody(p))
      .map((p) => p.frame) ?? [];
  return anchors.map((anchor, index) => ({
    anchor,
    first: index ? anchors[index - 1] + 1 : 0,
  }));
}
function confirmsBody(prompt: PointPrompt) {
  return !!prompt.box || prompt.labels?.includes(1) === true;
}
export function sampleMask(
  values: Float32Array,
  width: number,
  height: number,
) {
  const mask = new Uint8Array(CHECK_SIZE * CHECK_SIZE);
  for (let y = 0; y < CHECK_SIZE; y++) {
    const sy = Math.min(
      height - 1,
      Math.floor(((y + 0.5) * height) / CHECK_SIZE),
    );
    for (let x = 0; x < CHECK_SIZE; x++) {
      const sx = Math.min(
        width - 1,
        Math.floor(((x + 0.5) * width) / CHECK_SIZE),
      );
      mask[y * CHECK_SIZE + x] = Number(values[sy * width + sx] > 0);
    }
  }
  return mask;
}
export function masksDisagree(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) throw Error("Tracking check mask sizes differ");
  let intersection = 0,
    union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) union++;
    if (a[i] && b[i]) intersection++;
  }
  // Ignore tiny/no foreground evidence, and tolerate minor boundary changes.
  // A missing mask on one pass still disagrees with a visible mask on the other.
  return union >= 16 && intersection * 5 < union * 3;
}
export class ShooterTrackingCheck {
  private forward = new Map<number, Uint8Array>();
  private checked = new Set<number>();
  private disagreements = new Set<number>();
  readonly anchor: number;
  readonly target: number;
  constructor(anchor: number, target: number) {
    this.anchor = anchor;
    this.target = target;
  }
  record(frame: number, values: Float32Array, width: number, height: number) {
    if (frame <= this.anchor)
      this.forward.set(frame, sampleMask(values, width, height));
  }
  compare(frame: number, values: Float32Array, width: number, height: number) {
    const forward = this.forward.get(frame);
    if (!forward) throw Error("Forward tracking check frame is missing");
    if (masksDisagree(forward, sampleMask(values, width, height)))
      this.disagreements.add(frame);
    this.checked.add(frame);
    this.forward.delete(frame);
  }
  finish(): { tracking_check: TrackingCheck; warnings: MaskWarning[] } {
    if (this.checked.size !== this.anchor + 1 || this.forward.size)
      throw Error("Backward shooter check did not finish. Retry processing.");
    const frames = [...this.disagreements].sort((a, b) => a - b);
    return {
      tracking_check: {
        anchor_frame: this.anchor,
        checked_frames: this.checked.size,
        disagreement_frames: frames.length,
        target_id: this.target,
      },
      warnings: frames.map((frame) => ({
        frame,
        kind: "tracking_disagreement",
        track_ids: [this.target],
      })),
    };
  }
}
