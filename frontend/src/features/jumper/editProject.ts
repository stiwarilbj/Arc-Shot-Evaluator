/** All edit timing is integer 30 fps frames. No source upload is retained. */
export const EDIT_FPS = 30;
export const EDIT_PROFILE = "silhouette-edited-v1" as const;
export const PALETTE_PROFILE = "silhouette-palette-v1" as const;
export type Framing = { zoom: number; x: number; y: number };
export type Piece = {
  id: string;
  start: number;
  end: number;
  speed: 0.5 | 1 | 2;
  freeze: number;
  from: Framing;
  to: Framing;
};
export type Caption = {
  id: string;
  text: string;
  start: number;
  end: number;
  size: "small" | "medium" | "large";
  position: "top" | "center" | "bottom";
  outside?: boolean;
};
export type ShotMarker = "gather" | "release" | "finish";
export type EditProject = {
  version: 1;
  baseFrames: number;
  baseMime: "video/mp4" | "video/webm";
  baseProfile: "palette" | "legacy";
  pieces: Piece[];
  captions: Caption[];
  fadeIn: boolean;
  fadeOut: boolean;
  shotMarkers?: Partial<Record<ShotMarker, number>>;
};
/** Guidance metadata never changes encoded pixels or requires another render. */
export function renderProjectKey(project: EditProject) {
  const { shotMarkers: _markers, ...render } = project;
  return JSON.stringify(render);
}
export const neutralFraming = (): Framing => ({ zoom: 1, x: 0.5, y: 0.5 });
export const pieceFrames = (p: Piece) =>
  p.freeze || Math.ceil((p.end - p.start) / p.speed);
export const projectFrames = (p: EditProject) =>
  p.pieces.reduce((sum, piece) => sum + pieceFrames(piece), 0);
/** Inclusive source-boundary limits, preserving a 2–1800 frame edited timeline. */
export function pieceTrimLimits(
  piece: Piece,
  baseFrames: number,
  total: number,
) {
  const others = total - pieceFrames(piece);
  const minimum = others >= 1 ? 1 : Math.floor(piece.speed) + 1;
  const maximum = Math.floor((1800 - others) * piece.speed);
  return {
    start: { min: Math.max(0, piece.end - maximum), max: piece.end - minimum },
    end: {
      min: piece.start + minimum,
      max: Math.min(baseFrames, piece.start + maximum),
    },
  };
}
export function newProject(
  duration: number,
  mime: string,
  palette = true,
): EditProject {
  return {
    version: 1,
    baseFrames: Math.round(duration * 30),
    baseMime: mime === "video/mp4" ? "video/mp4" : "video/webm",
    baseProfile: palette ? "palette" : "legacy",
    pieces: [
      {
        id: crypto.randomUUID(),
        start: 0,
        end: Math.round(duration * 30),
        speed: 1,
        freeze: 0,
        from: neutralFraming(),
        to: neutralFraming(),
      },
    ],
    captions: [],
    fadeIn: false,
    fadeOut: false,
  };
}
export function isProject(value: unknown): value is EditProject {
  const p = value as EditProject;
  const integer = (n: number, lo: number, hi: number) =>
    Number.isInteger(n) && n >= lo && n <= hi;
  const framing = (f: Framing) =>
    !!f &&
    [f.zoom, f.x, f.y].every(Number.isFinite) &&
    f.zoom >= 1 &&
    f.zoom <= 2 &&
    f.x >= 0 &&
    f.x <= 1 &&
    f.y >= 0 &&
    f.y <= 1;
  return (
    !!p &&
    p.version === 1 &&
    integer(p.baseFrames, 2, 1800) &&
    ["video/mp4", "video/webm"].includes(p.baseMime) &&
    ["palette", "legacy"].includes(p.baseProfile) &&
    typeof p.fadeIn === "boolean" &&
    typeof p.fadeOut === "boolean" &&
    (p.shotMarkers === undefined ||
      (!!p.shotMarkers &&
        typeof p.shotMarkers === "object" &&
        !Array.isArray(p.shotMarkers) &&
        Object.entries(p.shotMarkers).every(
          ([kind, frame]) =>
            ["gather", "release", "finish"].includes(kind) &&
            integer(frame, 0, p.baseFrames - 1),
        ))) &&
    Array.isArray(p.pieces) &&
    p.pieces.length > 0 &&
    p.pieces.length <= 100 &&
    new Set(p.pieces.map((v) => v?.id)).size === p.pieces.length &&
    p.pieces.every(
      (v) =>
        !!v &&
        typeof v.id === "string" &&
        v.id.length > 0 &&
        v.id.length <= 100 &&
        integer(v.start, 0, p.baseFrames - 1) &&
        integer(v.end, v.start + 1, p.baseFrames) &&
        [0.5, 1, 2].includes(v.speed) &&
        (v.freeze === 0 || integer(v.freeze, 15, 90)) &&
        (!v.freeze || v.end === v.start + 1) &&
        framing(v.from) &&
        framing(v.to),
    ) &&
    projectFrames(p) >= 2 &&
    projectFrames(p) <= 1800 &&
    Array.isArray(p.captions) &&
    p.captions.length <= 100 &&
    new Set(p.captions.map((v) => v?.id)).size === p.captions.length &&
    p.captions.every(
      (c) =>
        !!c &&
        typeof c.id === "string" &&
        c.id.length > 0 &&
        c.id.length <= 100 &&
        typeof c.text === "string" &&
        c.text.trim().length > 0 &&
        c.text.length <= 200 &&
        integer(c.start, 0, 1799) &&
        integer(c.end, c.start + 1, 1800) &&
        c.end <= projectFrames(p) &&
        ["small", "medium", "large"].includes(c.size) &&
        ["top", "center", "bottom"].includes(c.position) &&
        (c.outside === undefined || typeof c.outside === "boolean"),
    )
  );
}
export function clampCaptions(project: EditProject): EditProject {
  const length = projectFrames(project);
  return {
    ...project,
    captions: project.captions.map((c) => ({
      ...c,
      start: Math.min(c.start, length - 1),
      end: Math.min(Math.max(c.start + 1, c.end), length),
      outside: c.outside || c.start >= length || c.end > length,
    })),
  };
}
export function editFrame(project: EditProject, frame: number, clean = false) {
  const total = projectFrames(project);
  frame = Math.max(0, Math.min(total - 1, Math.floor(frame)));
  let offset = 0;
  for (const piece of project.pieces) {
    const count = pieceFrames(piece);
    if (frame < offset + count) {
      const local = frame - offset,
        ratio = count <= 1 ? 0 : local / (count - 1);
      const mix = (a: number, b: number) => a + (b - a) * ratio;
      return {
        piece,
        source: piece.freeze
          ? piece.start
          : Math.min(
              piece.end - 1,
              piece.start + Math.floor(local * piece.speed),
            ),
        framing: clean
          ? neutralFraming()
          : {
              zoom: mix(piece.from.zoom, piece.to.zoom),
              x: mix(piece.from.x, piece.to.x),
              y: mix(piece.from.y, piece.to.y),
            },
        opacity: clean
          ? 1
          : Math.min(
              project.fadeIn ? Math.min(1, frame / 7) : 1,
              project.fadeOut ? Math.min(1, (total - 1 - frame) / 7) : 1,
            ),
        captions: clean
          ? []
          : project.captions.filter((c) => frame >= c.start && frame < c.end),
      };
    }
    offset += count;
  }
  throw Error("No timeline piece");
}
/** The split is before the displayed frame; source-frame boundaries stay exact. */
export function splitPoint(project: EditProject, frame: number) {
  const hit = editFrame(project, frame);
  const index = project.pieces.findIndex((p) => p.id === hit.piece.id);
  const offset = project.pieces
    .slice(0, index)
    .reduce((sum, p) => sum + pieceFrames(p), 0);
  const boundary =
    offset + Math.ceil((hit.source - hit.piece.start) / hit.piece.speed);
  const reason = hit.piece.freeze
    ? "Freeze frames cannot be split. Adjust their duration instead"
    : hit.source <= hit.piece.start || hit.source >= hit.piece.end
      ? "Move inside this piece; splitting here would create an empty piece"
      : boundary !== frame
        ? "This slow-motion frame repeats a source frame. Step back one frame for an exact split"
        : project.pieces.length >= 100
          ? "The timeline has 100 pieces. Delete a piece before splitting"
          : "";
  return { hit, index, boundary, reason };
}
export function splitPiece(project: EditProject, frame: number): EditProject {
  const { hit, reason } = splitPoint(project, frame);
  if (reason) throw Error(reason);
  const p = hit.piece;
  return {
    ...project,
    pieces: project.pieces.flatMap((v) =>
      v.id === p.id
        ? [
            { ...p, end: hit.source, to: hit.framing },
            {
              ...p,
              id: crypto.randomUUID(),
              start: hit.source,
              from: hit.framing,
            },
          ]
        : [v],
    ),
  };
}
export function duplicatePieceReason(project: EditProject, id: string): string {
  const piece = project.pieces.find((p) => p.id === id);
  if (!piece) return "Select a piece to duplicate";
  if (project.pieces.length >= 100)
    return "The timeline has 100 pieces. Delete a piece before duplicating";
  if (projectFrames(project) + pieceFrames(piece) > 1800)
    return "Duplicating this piece would exceed 60 seconds. Shorten the timeline first";
  return "";
}
export function duplicatePiece(project: EditProject, id: string): EditProject {
  const reason = duplicatePieceReason(project, id);
  if (reason) throw Error(reason);
  const index = project.pieces.findIndex((p) => p.id === id);
  const copy = {
    ...structuredClone(project.pieces[index]),
    id: crypto.randomUUID(),
  };
  return {
    ...project,
    pieces: [
      ...project.pieces.slice(0, index + 1),
      copy,
      ...project.pieces.slice(index + 1),
    ],
  };
}
export type VideoEdit = {
  label: string;
  panel: "Cut" | "Text" | "Effects";
  pieceId?: string;
  fallbackPieceId?: string;
  captionId?: string;
  frame: number;
  atEnd?: boolean;
};
type EditEntry = { project: EditProject; edit?: VideoEdit };
export class EditHistory {
  private past: EditEntry[] = [];
  private future: EditEntry[] = [];
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get nextUndo() {
    return this.past.at(-1)?.edit;
  }
  get nextRedo() {
    return this.future.at(-1)?.edit;
  }
  record(previous: EditProject, edit?: VideoEdit) {
    this.past.push(structuredClone({ project: previous, edit }));
    if (this.past.length > 50) this.past.shift();
    this.future = [];
  }
  undo(current: EditProject) {
    const next = this.past.pop();
    if (next)
      this.future.push(structuredClone({ project: current, edit: next.edit }));
    return next?.project ?? current;
  }
  redo(current: EditProject) {
    const next = this.future.pop();
    if (next)
      this.past.push(structuredClone({ project: current, edit: next.edit }));
    return next?.project ?? current;
  }
}
