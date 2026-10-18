import { isProject, projectFrames, type EditProject } from "./editProject.ts";
export const MAX_BYTES = 100 * 1024 * 1024;
export const FPS = 30;
export function maskingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /mapAsync|valid external Instance|device.*lost|GPU.*out.of.memory/i.test(
      message,
    )
  )
    return "The GPU stopped while tracking. Your video and selections are unchanged. Close other GPU-heavy tabs and retry, try a shorter segment, or use the free downloaded editor.";
  return `${message}. If this device cannot complete WebGPU processing, use the downloaded editor.`;
}
export type Variant = "highlight" | "quiz" | "reveal" | "base";
export interface Player {
  id: string;
  name: string;
  aliases: string[];
}
export interface Clip {
  version: 1;
  id: string;
  player: Player;
  duration: number;
  createdAt: string;
  mime: "video/mp4" | "video/webm";
  quiz: boolean;
  presentation?:
    | "silhouette"
    | "silhouette-palette-v1"
    | "silhouette-edited-v1";
  project?: EditProject;
}
export interface PersonalClip extends Clip {
  highlight: Blob;
  base?: Blob;
  quizVideo?: Blob;
  reveal?: Blob;
}
export interface QuizClip {
  id: string;
  player: Player;
  quiz: string;
  reveal: string;
  duration: number;
  provenance?: {
    source_url: string;
    permission_url: string;
    identity_url: string;
    license: string;
    attribution: string;
    changes: string;
  };
}
export interface Attempt {
  id: string;
  clipId: string;
  selected: Player;
  correct: Player;
  timestamp: string;
  outcome: boolean;
}
export interface PointPrompt {
  frame: number;
  /** Explicit later shooter confirmation; resets causal tracking memory. */
  anchor?: boolean;
  points?: number[][];
  labels?: number[];
  box?: number[];
}
export interface Track {
  id: number;
  ignored?: boolean;
  prompts: PointPrompt[];
}
export interface MaskRequest {
  auto_detect_others?: boolean;
  verify_shooter?: boolean;
  refine_small_players?: boolean;
  shooter_selection_resolved?: boolean;
  presentation?: "silhouette" | "silhouette-palette-v1";
  start: number;
  end: number;
  target_id: number;
  objects: Track[];
}
export interface MaskWarning {
  frame: number;
  kind:
    | "target_lost"
    | "player_lost"
    | "memory_rejected"
    | "tracking_unstable"
    | "outline_changed"
    | "mask_fragmented"
    | "mask_joined"
    | "ambiguous_players"
    | "tracking_disagreement"
    | "correction_include_missed"
    | "correction_exclude_failed"
    | "refinement_uncertain"
    | "possible_camera_cut";
  track_ids?: number[];
}
export interface TrackingCheck {
  anchor_frame: number;
  checked_frames: number;
  disagreement_frames: number;
  target_id: number;
}
export interface MaskResult {
  tracking_check?: TrackingCheck;
  objects?: Track[];
  highlight: Blob;
  quiz: Blob;
  reveal: Blob;
  duration: number;
  warnings: MaskWarning[];
}
export interface JobProgress {
  stage: string;
  progress: number;
}
export type WorkerRequest = {
  kind: "process";
  id: string;
  file: File;
  request: MaskRequest;
};
export type WorkerResponse =
  | { kind: "progress"; id: string; stage: string; progress: number }
  | { kind: "done"; id: string; result: MaskResult }
  | { kind: "error"; id: string; error: string };
export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}
function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
    row = next;
  }
  return row[b.length];
}
export function matchPlayers(input: string, players: Player[]): Player[] {
  const query = normalizeName(input);
  if (!query) return [];
  const unique = [
    ...new Map(players.map((player) => [player.id, player])).values(),
  ];
  const exact = unique.filter((player) =>
    [player.name, ...player.aliases].some(
      (name) => normalizeName(name) === query,
    ),
  );
  if (exact.length) return exact;
  return unique
    .map((player) => ({
      player,
      score: Math.min(
        ...[player.name, ...player.aliases].map((name) => {
          const normalized = normalizeName(name);
          return normalized.startsWith(query) ||
            name
              .toLowerCase()
              .split(/\s+/)
              .some((part) => normalizeName(part) === query)
            ? 0
            : distance(query, normalized);
        }),
      ),
    }))
    .filter(({ score }) => score <= (query.length < 5 ? 1 : 2))
    .sort(
      (a, b) => a.score - b.score || a.player.name.localeCompare(b.player.name),
    )
    .slice(0, 8)
    .map(({ player }) => player);
}
export function player(value: unknown): value is Player {
  if (!value || typeof value !== "object") return false;
  const v = value as Player;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    v.id.length <= 100 &&
    typeof v.name === "string" &&
    v.name.trim().length > 0 &&
    v.name.length <= 100 &&
    Array.isArray(v.aliases) &&
    v.aliases.length <= 20 &&
    v.aliases.every((alias) => typeof alias === "string" && alias.length <= 100)
  );
}
export function clip(value: unknown): value is Clip {
  if (!value || typeof value !== "object") return false;
  const v = value as Clip;
  return (
    v.version === 1 &&
    typeof v.id === "string" &&
    /^[a-zA-Z0-9-]{1,100}$/.test(v.id) &&
    player(v.player) &&
    Number.isFinite(v.duration) &&
    v.duration > 0 &&
    v.duration <= (v.presentation === "silhouette-edited-v1" ? 60 : 15) &&
    (v.presentation !== "silhouette-edited-v1"
      ? v.project === undefined
      : isProject(v.project) &&
        Math.abs(projectFrames(v.project) / 30 - v.duration) < 0.002) &&
    typeof v.createdAt === "string" &&
    Number.isFinite(Date.parse(v.createdAt)) &&
    ["video/mp4", "video/webm"].includes(v.mime) &&
    (v.presentation === undefined ||
      ["silhouette", "silhouette-palette-v1", "silhouette-edited-v1"].includes(
        v.presentation,
      )) &&
    typeof v.quiz === "boolean"
  );
}
export function attempt(value: unknown): value is Attempt {
  if (!value || typeof value !== "object") return false;
  const v = value as Attempt;
  return (
    typeof v.id === "string" &&
    typeof v.clipId === "string" &&
    player(v.selected) &&
    player(v.correct) &&
    typeof v.outcome === "boolean" &&
    v.outcome === (v.selected.id === v.correct.id) &&
    Number.isFinite(Date.parse(v.timestamp))
  );
}
export function validateMaskRequest(
  value: unknown,
): asserts value is MaskRequest {
  const v = value as MaskRequest;
  if (
    !v ||
    (v.auto_detect_others !== undefined &&
      typeof v.auto_detect_others !== "boolean") ||
    (v.verify_shooter !== undefined && typeof v.verify_shooter !== "boolean") ||
    (v.refine_small_players !== undefined &&
      typeof v.refine_small_players !== "boolean") ||
    (v.shooter_selection_resolved !== undefined &&
      typeof v.shooter_selection_resolved !== "boolean") ||
    (v.presentation !== undefined &&
      !["silhouette", "silhouette-palette-v1"].includes(v.presentation)) ||
    !Number.isFinite(v.start) ||
    !Number.isFinite(v.end) ||
    v.start < 0 ||
    v.end - v.start < 2 / FPS ||
    v.end - v.start > 15 ||
    !Array.isArray(v.objects) ||
    !v.objects.length ||
    v.objects.length > 20
  )
    throw Error(
      "Choose a segment of at most 15 seconds and select the players.",
    );
  if (
    v.objects.reduce(
      (count, track) =>
        count + (Array.isArray(track?.prompts) ? track.prompts.length : 0),
      0,
    ) > 128
  )
    throw Error("Use at most 128 correction frames per clip.");
  const ids = new Set<number>();
  for (const track of v.objects) {
    if (
      !track ||
      (track.ignored !== undefined && typeof track.ignored !== "boolean") ||
      (track.id === v.target_id && track.ignored === true) ||
      !Number.isInteger(track.id) ||
      track.id < 1 ||
      track.id > 255 ||
      ids.has(track.id) ||
      !Array.isArray(track.prompts) ||
      !track.prompts.length ||
      track.prompts.length > 32
    )
      throw Error("Each player needs a unique track and an initial selection.");
    ids.add(track.id);
    let previous = -1;
    for (const p of track.prompts) {
      if (
        !p ||
        !Number.isInteger(p.frame) ||
        p.frame <= previous ||
        p.frame < 0 ||
        p.frame >= Math.ceil((v.end - v.start) * FPS)
      )
        throw Error("A correction is outside the selected segment.");
      previous = p.frame;
      if ((p.anchor !== undefined && typeof p.anchor !== "boolean") ||
          (p.anchor === true && (track.id !== v.target_id || p.frame === 0 ||
            (!p.box && !(Array.isArray(p.labels) && p.labels.includes(1))))))
        throw Error("A tracking anchor needs a later Include selection on the shooter.");
      const valid = (n: unknown) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
      if (
        p.box &&
        (!Array.isArray(p.box) ||
          p.box.length !== 4 ||
          !p.box.every(valid) ||
          p.box[0] >= p.box[2] ||
          p.box[1] >= p.box[3])
      )
        throw Error("Invalid player box.");
      if (
        p.points &&
        (!Array.isArray(p.points) ||
          !p.points.length ||
          p.points.length > 64 ||
          !Array.isArray(p.labels) ||
          p.points.length !== p.labels.length ||
          !p.labels.every((n) => n === 0 || n === 1) ||
          !p.points.every(
            (point) =>
              Array.isArray(point) && point.length === 2 && point.every(valid),
          ))
      )
        throw Error("Invalid correction points.");
      if (!p.box && !p.points)
        throw Error("Select the player with a point or box.");
    }
  }
  if (!ids.has(v.target_id)) throw Error("Select the named player.");
  if (
    v.objects.find((track) => track.id === v.target_id)!.prompts[0].frame !== 0
  )
    throw Error("Select the named player in the starting frame.");
}
export function shuffled(ids: string[], random = Math.random): string[] {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function stats(attempts: Attempt[]) {
  let streak = 0;
  const ordered = [...attempts].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  for (const item of ordered) streak = item.outcome ? streak + 1 : 0;
  const correct = attempts.filter((item) => item.outcome).length;
  return {
    correct,
    incorrect: attempts.length - correct,
    accuracy: attempts.length
      ? Math.round((correct / attempts.length) * 100)
      : 0,
    streak,
  };
}

export function maskResult(value: unknown): value is MaskResult {
  const v = value as MaskResult;
  return (
    !!v &&
    Number.isFinite(v.duration) &&
    v.duration > 0 &&
    v.duration <= 15 &&
    [v.highlight, v.quiz, v.reveal].every(
      (blob) =>
        blob instanceof Blob &&
        blob.size > 0 &&
        blob.size <= MAX_BYTES &&
        ["video/mp4", "video/webm"].includes(blob.type),
    ) &&
    (v.objects === undefined || validResultTracks(v.objects, v.duration)) &&
    (v.tracking_check === undefined || validTrackingCheck(v)) &&
    Array.isArray(v.warnings) &&
    v.warnings.every(
      (w) =>
        !!w &&
        Number.isInteger(w.frame) &&
        w.frame >= 0 &&
        w.frame < Math.ceil(v.duration * 30) &&
        [
          "target_lost",
          "player_lost",
          "possible_camera_cut",
          "tracking_unstable",
          "memory_rejected",
          "outline_changed",
          "mask_fragmented",
          "mask_joined",
          "ambiguous_players",
          "tracking_disagreement",
          "refinement_uncertain",
          "correction_include_missed",
          "correction_exclude_failed",
        ].includes(w.kind) &&
        (w.track_ids === undefined ||
          (Array.isArray(w.track_ids) &&
            w.track_ids.length > 0 &&
            w.track_ids.length <= 20 &&
            new Set(w.track_ids).size === w.track_ids.length &&
            w.track_ids.every(
              (id) =>
                Number.isInteger(id) &&
                id > 0 &&
                id <= 255 &&
                (!v.objects || v.objects.some((o) => o.id === id)),
            ))),
    )
  );
}

function validTrackingCheck(result: MaskResult) {
  const check = result.tracking_check;
  if (!check || typeof check !== "object" || !Array.isArray(result.warnings))
    return false;
  const flagged = result.warnings.filter(
    (w) => w?.kind === "tracking_disagreement",
  );
  return (
    Number.isInteger(check.anchor_frame) &&
    check.anchor_frame > 0 &&
    check.anchor_frame < Math.ceil(result.duration * FPS) &&
    check.checked_frames === check.anchor_frame + 1 &&
    check.disagreement_frames === new Set(flagged.map((w) => w.frame)).size &&
    flagged.every(
      (w) =>
        w.frame <= check.anchor_frame &&
        w.track_ids?.length === 1 &&
        w.track_ids[0] === check.target_id,
    ) &&
    Number.isInteger(check.target_id) &&
    !!result.objects?.some((o) => o.id === check.target_id && !o.ignored)
  );
}

export interface MaskExtent {
  area: number;
  x: number;
  y: number;
}
export function unstableMask(
  previous: MaskExtent | null,
  current: MaskExtent,
): boolean {
  return (
    !!previous &&
    previous.area > 0 &&
    current.area > 0 &&
    (current.area / previous.area < 0.35 ||
      current.area / previous.area > 2.8 ||
      Math.hypot(current.x - previous.x, current.y - previous.y) > 0.2)
  );
}

function validResultTracks(objects: Track[], duration: number) {
  try {
    validateMaskRequest({
      start: 0,
      end: duration,
      target_id: objects.find((o) => !o.ignored && o.prompts[0]?.frame === 0)
        ?.id,
      objects,
    });
    return true;
  } catch {
    return false;
  }
}
