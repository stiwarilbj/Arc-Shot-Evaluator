import type { CourtPoint, PlaybookDraft } from "./types.ts";

export type PointEditTarget = {
  type: "player" | "defender" | "ball" | "arrow-start" | "arrow-end" | "arrow-exit" | "arrow-control";
  id: number | string;
};

/** Copy the edited branch only. All other draft data stays read-only and shared. */
export function editPlaybookPoint(draft: PlaybookDraft, target: PointEditTarget, point: CourtPoint): PlaybookDraft {
  if (target.type === "ball") return { ...draft, ball: { ...point } };
  if (target.type === "player" || target.type === "defender") {
    const roster = target.type === "player" ? "players" : "defenders";
    return { ...draft, [roster]: draft[roster].map((marker) => marker.id === target.id ? { ...marker, ...point } : marker) };
  }
  const field = target.type === "arrow-start" ? "start" : target.type === "arrow-end" ? "end" : target.type === "arrow-exit" ? "exit_target" : "control";
  return {
    ...draft,
    arrows: draft.arrows.map((arrow) => arrow.id === target.id
      ? { ...arrow, [field]: { ...point }, ...(target.type === "arrow-control" ? { path: "curve" as const } : {}) }
      : arrow),
  };
}
