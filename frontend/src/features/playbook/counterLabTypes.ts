import type { CourtPoint, DefenseScheme, DefenseStrategy, PlaybookArrow, PlaybookDraft } from "./types";
import { DEFENSE_SCHEME_ORDER } from "./simulation.ts";

export type CounterLabMode = "scripted" | "adaptive";
export type CounterLabProfile = { id: string; label: string; strategy: DefenseStrategy; scheme: Exclude<DefenseScheme, "auto"> };
export type CounterLabFrame = {
  elapsedMs: number;
  sequence: number | null;
  action: string | null;
  ballHandlerId: number | null;
  assignments: Array<{ defenderId: number; playerId: number }>;
  opportunities: Array<{ kind: "shot" | "pass" | "drive"; playerId: number; quality: number; score: number; receiverGap: number; laneGap: number }>;
  blockedPass: { playerId: number; receiverGap: number; laneGap: number } | null;
  involvedPlayerIds: number[];
  activeRoutes: Array<{ kind: string; start: CourtPoint; end: CourtPoint; playerId: number }>;
  players: Array<{ id: number; x: number; y: number }>;
  defenders: Array<{ id: number; x: number; y: number }>;
  ball: CourtPoint | null;
};
export type CounterLabResult = {
  key: string;
  profile: CounterLabProfile;
  mode: CounterLabMode;
  score: number;
  finalShotQuality: number;
  createdAdvantage: boolean;
  outcome: string;
  firstLostOpeningMs: number | null;
  firstBlockedPass: { atMs: number; sequence: number | null; playerId: number; receiverGap: number; laneGap: number } | null;
  actions: string[];
  notice: string | null;
  trace: CounterLabFrame[];
};
export type CounterLabRepair = { id: string; name: string; reason: string; play: PlaybookDraft; results: CounterLabResult[]; averageGain: number; bestGain: number; resolvedBreakdowns: number };

export const COUNTER_LAB_DEFAULT_PROFILES: CounterLabProfile[] = [
  { id: "contain", label: "Contain", strategy: "contain", scheme: "man-to-man" },
  { id: "help", label: "Help & recover", strategy: "help", scheme: "man-to-man" },
  { id: "switch", label: "Switch", strategy: "switch", scheme: "man-to-man" },
  { id: "drop", label: "Drop", strategy: "drop", scheme: "man-to-man" },
  { id: "hedge", label: "Hedge", strategy: "hedge", scheme: "man-to-man" },
  { id: "trap", label: "Trap & rotate", strategy: "trap-rotate", scheme: "man-to-man" },
];
export const COUNTER_LAB_EXTRA_STRATEGIES: CounterLabProfile[] = [
  { id: "fight-over", label: "Fight over", strategy: "fight-over", scheme: "man-to-man" },
  { id: "go-under", label: "Go under", strategy: "go-under", scheme: "man-to-man" },
  { id: "deny-lanes", label: "Deny lanes", strategy: "deny-lanes", scheme: "man-to-man" },
  { id: "protect-paint", label: "Protect paint", strategy: "protect-paint", scheme: "man-to-man" },
  { id: "off", label: "Hold positions", strategy: "off", scheme: "man-to-man" },
];
export const COUNTER_LAB_EXTRA_SCHEMES = DEFENSE_SCHEME_ORDER
  .filter((scheme) => scheme !== "man-to-man" && scheme !== "pack-line")
  .map((scheme) => ({ id: scheme, label: scheme.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), strategy: "help" as const, scheme }));

export function eligibleCounterLabSchemes(defenderCount: number, offensivePlayerCount: number) {
  if (defenderCount < 5) return [];
  return COUNTER_LAB_EXTRA_SCHEMES.filter((profile) => profile.scheme !== "triangle-and-two" || offensivePlayerCount >= 2);
}

const point = (x: number, y: number): CourtPoint => ({ x, y });
const clamp = (value: number) => Math.max(4, Math.min(96, value));

export function createCounterLabRepairs(draft: PlaybookDraft): Array<Pick<CounterLabRepair, "id" | "name" | "reason" | "play">> {
  const repairs: Array<Pick<CounterLabRepair, "id" | "name" | "reason" | "play">> = [];
  for (const arrow of draft.arrows) {
    if ((arrow.kind === "screen" || arrow.kind === "pick-roll") && arrow.screener_id != null) {
      const play = structuredClone(draft);
      play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id
        ? { ...candidate, kind: "slip-screen", timing: Math.max(0.5, (candidate.timing ?? 1.2) * 0.8) }
        : candidate);
      repairs.push({ id: `slip-${arrow.id}`, name: "Slip the screen", reason: "Roll before the switch can settle, then test whether the handler or screener gains a cleaner option.", play });
    }
    if ((arrow.kind === "pick-roll" || arrow.kind === "pick-pop") && arrow.exit_target) {
      const play = structuredClone(draft);
      play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id
        ? { ...candidate, kind: arrow.kind === "pick-roll" ? "pick-pop" : "pick-roll" }
        : candidate);
      repairs.push({ id: `roll-pop-${arrow.id}`, name: arrow.kind === "pick-roll" ? "Pop instead of roll" : "Roll instead of pop", reason: "Change the screener's finish and compare the newly available lane or perimeter shot.", play });
    }
    if (arrow.kind === "screen" || arrow.kind === "pick-roll" || arrow.kind === "pick-pop" || arrow.kind === "pass" || arrow.kind === "movement") {
      for (const change of [-0.25, 0.25]) {
        const play = structuredClone(draft);
        play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id
          ? { ...candidate, timing: Math.max(0.5, Math.min(4, Math.round(((candidate.timing ?? 1.2) + change) * 100) / 100)) }
          : candidate);
        repairs.push({ id: `timing-${arrow.id}-${change}`, name: `${change < 0 ? "Run earlier" : "Give it room"} · ${arrow.id}`, reason: `Shift this action by ${Math.abs(change).toFixed(2)} seconds and check whether the opening lasts longer.`, play });
      }
    }
    if (arrow.kind === "pass") {
      const recipient = draft.players.filter((player) => player.id !== arrow.screener_id)
        .sort((a, b) => Math.hypot(a.x - arrow.end.x, a.y - arrow.end.y) - Math.hypot(b.x - arrow.end.x, b.y - arrow.end.y))[0];
      if (recipient && Math.hypot(recipient.x - arrow.end.x, recipient.y - arrow.end.y) > 5) {
        const play = structuredClone(draft);
        play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id ? { ...candidate, end: point(recipient.x, recipient.y) } : candidate);
        repairs.push({ id: `pass-${arrow.id}`, name: `Pass to Player ${recipient.id}`, reason: "Test the nearest alternate receiver against the same defenders and starting positions.", play });
      }
    }
    if (arrow.kind === "off-ball-screen" || arrow.kind === "pin-down") {
      const play = structuredClone(draft);
      play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id
        ? { ...candidate, end: point(clamp(candidate.end.x + (candidate.end.x < 50 ? -4 : 4)), candidate.end.y) }
        : candidate);
      repairs.push({ id: `space-${arrow.id}`, name: "Move the screen angle", reason: "Change the screening angle slightly and see whether the cutter gains space.", play });
    }
  }
  const unique = new Map<string, Pick<CounterLabRepair, "id" | "name" | "reason" | "play">>();
  repairs.forEach((repair) => { if (!unique.has(JSON.stringify(repair.play.arrows))) unique.set(JSON.stringify(repair.play.arrows), repair); });
  return [...unique.values()].slice(0, 8);
}
