import {
  EDIT_FPS,
  pieceFrames,
  projectFrames,
  type EditProject,
} from "./editProject.ts";

/** Edited-frame bounds; the end is exclusive, including optional neighboring footage. */
export function previewRange(
  project: EditProject,
  id: string,
  contextFrames = 0,
) {
  const index = Math.max(
    0,
    project.pieces.findIndex((p) => p.id === id),
  );
  const start = project.pieces
    .slice(0, index)
    .reduce((n, p) => n + pieceFrames(p), 0);
  const end = start + pieceFrames(project.pieces[index]);
  return {
    start: Math.max(0, start - contextFrames),
    end: Math.min(projectFrames(project), end + contextFrames),
  };
}

export function previewOrigin(
  frame: number,
  range: { start: number; end: number },
) {
  return frame >= range.start && frame < range.end ? frame : range.start;
}

/** One monotonic clock; wrapping retains overshoot instead of slowing at each boundary. */
export function previewPlaybackFrame(
  from: number,
  elapsedMs: number,
  range: { start: number; end: number },
  loop: boolean,
) {
  const elapsed = Math.floor((Math.max(0, elapsedMs) * EDIT_FPS) / 1000);
  if (loop)
    return {
      frame:
        range.start +
        ((previewOrigin(from, range) - range.start + elapsed) %
          (range.end - range.start)),
      finished: false,
    };
  const next = from + elapsed;
  return { frame: Math.min(next, range.end - 1), finished: next >= range.end };
}
