import type { Caption } from "./editProject";

export type CaptionPart = "move" | "start" | "end";

/** Integer edited frames; end is exclusive. Moving preserves duration at bounds. */
export function shiftCaption(
  caption: Pick<Caption, "start" | "end">,
  part: CaptionPart,
  delta: number,
  frames: number,
) {
  const offset = Math.round(delta);
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));
  if (part === "move") {
    const duration = caption.end - caption.start;
    const start = clamp(caption.start + offset, 0, frames - duration);
    return { start, end: start + duration };
  }
  return part === "start"
    ? {
        start: clamp(caption.start + offset, 0, caption.end - 1),
        end: caption.end,
      }
    : {
        start: caption.start,
        end: clamp(caption.end + offset, caption.start + 1, frames),
      };
}
