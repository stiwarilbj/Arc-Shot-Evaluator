import {
  editFrame,
  pieceFrames,
  projectFrames,
  type EditProject,
  type ShotMarker,
} from "./editProject.ts";
export const shotMarkerNames = {
  gather: "Gather",
  release: "Release",
  finish: "Finish",
} as const;
export const shotMarkerKinds = Object.keys(shotMarkerNames) as ShotMarker[];
export type ShotMotionWarning = {
  id: string;
  message: string;
  source?: number;
  edited?: number;
};

/** Advice uses executed source samples, not just saved piece ranges. */
export function shotMotionWarnings(project: EditProject): ShotMotionWarning[] {
  const markers = project.shotMarkers ?? {};
  const warnings: ShotMotionWarning[] = [];
  if (!Object.keys(markers).length) return warnings;
  const moving = new Set<number>(),
    held = new Set<number>();
  for (let frame = 0; frame < projectFrames(project); frame++) {
    const state = editFrame(project, frame);
    (state.piece.freeze ? held : moving).add(state.source);
  }
  for (const kind of shotMarkerKinds) {
    const source = markers[kind];
    if (source === undefined) continue;
    if (!moving.has(source))
      warnings.push({
        id: `missing-${kind}`,
        source,
        message: held.has(source)
          ? `${shotMarkerNames[kind]} is retained only as a freeze frame, not moving footage`
          : `${shotMarkerNames[kind]} source frame ${source + 1} is absent from the edited video (trimmed, deleted, or skipped by speed)`,
      });
  }
  const ordered = shotMarkerKinds
    .filter((kind) => markers[kind] !== undefined)
    .map((kind) => markers[kind]!);
  if (
    ordered.some((source, index) => index > 0 && source <= ordered[index - 1])
  ) {
    warnings.push({
      id: "order",
      message:
        "Check marker order: Gather should come before Release, then Finish · Mark distinct source frames; edits remain unrestricted",
    });
    return warnings;
  }
  if (ordered.length < 2) return warnings;
  const start = ordered[0],
    finish = ordered.at(-1)!;
  let offset = pieceFrames(project.pieces[0]);
  for (let i = 1; i < project.pieces.length; i++) {
    const before = project.pieces[i - 1],
      after = project.pieces[i];
    const exit = before.freeze ? before.start : before.end;
    const entry = after.start;
    const continuous =
      exit === entry ||
      (!!after.freeze &&
        !before.freeze &&
        entry === editFrame(project, offset - 1).source) ||
      (!!before.freeze && !after.freeze && entry === before.start + 1);
    const touchesMotion =
      (exit > start && exit <= finish) ||
      (entry > start && entry <= finish) ||
      (exit <= start && entry > finish) ||
      (exit > finish &&
        entry <= start &&
        !(
          before.start <= start &&
          after.end > finish &&
          !before.freeze &&
          !after.freeze
        ));
    if (!continuous && touchesMotion)
      warnings.push({
        id: `cut-${before.id}-${after.id}`,
        edited: offset,
        message: `The cut before Piece ${i + 1} jumps through or reorders the marked shooting motion at ${(offset / 30).toFixed(2)}s`,
      });
    offset += pieceFrames(after);
  }
  return warnings;
}
