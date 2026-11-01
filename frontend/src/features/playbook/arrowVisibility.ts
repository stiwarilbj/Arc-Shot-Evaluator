import type { CourtPoint } from "./types";
export const ARROW_VISIBILITY_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "main-on-ball", label: "Main on-ball" },
  { value: "main-all", label: "Main on-ball + off-ball" },
  { value: "all-on-ball", label: "All on-ball movements" },
  { value: "all", label: "All movements" },
] as const;
export type ArrowVisibility = typeof ARROW_VISIBILITY_OPTIONS[number]["value"];
export type CourtRoute = {
  id: string; actionId: string | null; sequence: number | null;
  kind: string; playerId: number; scope: "on-ball" | "off-ball"; importance: "main" | "adjustment";
  start: CourtPoint; end: CourtPoint; control?: CourtPoint; via?: CourtPoint; points?: CourtPoint[];
};
export function normalizeArrowVisibility(value: unknown): ArrowVisibility {
  return ARROW_VISIBILITY_OPTIONS.some((option) => option.value === value) ? value as ArrowVisibility : "main-on-ball";
}
export function routeVisible(route: Pick<CourtRoute, "scope" | "importance">, visibility: ArrowVisibility) {
  if (visibility === "off") return false;
  if (visibility === "all") return true;
  if (visibility === "main-all") return route.importance === "main";
  return route.scope === "on-ball" && (visibility === "all-on-ball" || route.importance === "main");
}
