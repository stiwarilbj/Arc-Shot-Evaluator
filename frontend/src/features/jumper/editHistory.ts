import {
  editFrame,
  pieceFrames,
  projectFrames,
  type EditProject,
  type VideoEdit,
} from "./editProject.ts";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Describe the actual executable edit, ignoring selection and playback changes. */
export function describeVideoEdit(
  before: EditProject,
  after: EditProject,
  selected: string,
  frame: number,
): VideoEdit {
  const oldPieces = new Map(before.pieces.map((p) => [p.id, p]));
  const newPieces = new Map(after.pieces.map((p) => [p.id, p]));
  const added = after.pieces.filter((p) => !oldPieces.has(p.id));
  const removed = before.pieces.filter((p) => !newPieces.has(p.id));
  const changed = after.pieces.find(
    (p) => oldPieces.has(p.id) && !same(p, oldPieces.get(p.id)),
  );
  const base: VideoEdit = {
    label: "edit video",
    panel: "Cut",
    pieceId: selected,
    frame,
  };
  const original = oldPieces.get(selected);
  if (
    added.length === 1 &&
    !removed.length &&
    !changed &&
    original &&
    same({ ...added[0], id: original.id }, original)
  )
    return {
      ...base,
      label: "duplicate piece",
      pieceId: added[0].id,
      fallbackPieceId: original.id,
    };
  if (added.length)
    return {
      ...base,
      label: added.some((p) => p.freeze) ? "insert freeze" : "split piece",
      panel: added.some((p) => p.freeze) ? "Effects" : "Cut",
      pieceId: added.find((p) => p.freeze)?.id ?? added[0].id,
      fallbackPieceId: changed?.id ?? editFrame(before, frame).piece.id,
    };
  if (removed.length) {
    const index = before.pieces.indexOf(removed[0]);
    return {
      ...base,
      label: "delete piece",
      pieceId: removed[0].id,
      fallbackPieceId:
        before.pieces.slice(index + 1).find((p) => newPieces.has(p.id))?.id ??
        after.pieces.at(-1)?.id,
    };
  }
  if (
    !same(
      before.pieces.map((p) => p.id),
      after.pieces.map((p) => p.id),
    )
  )
    return { ...base, label: "reorder piece" };
  if (changed) {
    const old = oldPieces.get(changed.id)!;
    const focus = { ...base, pieceId: changed.id };
    if (old.freeze !== changed.freeze)
      return { ...focus, panel: "Effects", label: "change freeze duration" };
    if (old.speed !== changed.speed)
      return { ...focus, label: "change piece speed" };
    if (old.start !== changed.start || old.end !== changed.end)
      return { ...focus, label: "trim piece", atEnd: old.end !== changed.end };
    const from = !same(old.from, changed.from),
      to = !same(old.to, changed.to);
    return {
      ...focus,
      panel: "Effects",
      label:
        from && to
          ? "change framing"
          : from
            ? "change start framing"
            : "change end framing",
      atEnd: !from && to,
    };
  }
  const oldCaptions = new Map(before.captions.map((c) => [c.id, c]));
  const newCaptions = new Map(after.captions.map((c) => [c.id, c]));
  const addedCaption = after.captions.find((c) => !oldCaptions.has(c.id));
  const removedCaption = before.captions.find((c) => !newCaptions.has(c.id));
  const caption =
    addedCaption ??
    removedCaption ??
    after.captions.find((c) => !same(c, oldCaptions.get(c.id)));
  if (caption) {
    const old = oldCaptions.get(caption.id);
    const label = addedCaption
      ? "add caption"
      : removedCaption
        ? "delete caption"
        : old?.start !== caption.start || old?.end !== caption.end
          ? "change caption timing"
          : old.text !== caption.text
            ? "change caption text"
            : old.size !== caption.size
              ? "change caption size"
              : "move caption";
    return {
      ...base,
      label,
      panel: "Text",
      captionId: caption.id,
      frame: caption.start,
      pieceId: undefined,
    };
  }
  if (before.fadeIn !== after.fadeIn)
    return {
      ...base,
      panel: "Effects",
      label: `${after.fadeIn ? "enable" : "disable"} fade-in`,
    };
  if (before.fadeOut !== after.fadeOut)
    return {
      ...base,
      panel: "Effects",
      label: `${after.fadeOut ? "enable" : "disable"} fade-out`,
    };
  return base;
}

/** Deleted targets resolve to a surviving neighbor, never an unrelated stale ID. */
export function videoEditFocus(project: EditProject, edit: VideoEdit) {
  const caption = project.captions.find((c) => c.id === edit.captionId);
  let frame = Math.max(
    0,
    Math.min(projectFrames(project) - 1, caption?.start ?? edit.frame),
  );
  let piece =
    project.pieces.find((p) => p.id === edit.pieceId) ??
    project.pieces.find((p) => p.id === edit.fallbackPieceId);
  if (!piece || edit.captionId) piece = editFrame(project, frame).piece;
  else {
    frame = project.pieces
      .slice(0, project.pieces.indexOf(piece))
      .reduce((sum, p) => sum + pieceFrames(p), 0);
    if (edit.atEnd) frame += pieceFrames(piece) - 1;
  }
  return {
    frame,
    pieceId: piece.id,
    captionId: caption?.id ?? null,
    panel: edit.panel,
    framingEnd: !!edit.atEnd,
  };
}
