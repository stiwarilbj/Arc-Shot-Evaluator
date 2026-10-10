import type { CourtRoute } from "./arrowVisibility";
import { DEFAULT_SIMULATION_SETTINGS } from "./types.ts";
import type { CourtPoint, DefenseScheme, DefenseStrategy, PlaybookDraft } from "./types";
import { createSimulationRun, DEFENSE_SCHEME_ORDER } from "./simulation.ts";

export type CounterLabMode = "scripted" | "adaptive";
export type CounterLabProfile = { id: string; label: string; strategy: DefenseStrategy; scheme: Exclude<DefenseScheme, "auto"> };
export type PassDiagnostic = {
  actionId: string; sequence: number; actorId: number | null; playerId: number | null;
  status: "delivered" | "failed" | "interrupted"; atMs: number;
  unsafeAtMs: number | null; receiverGap: number; laneGap: number;
};
export type CounterLabEvent = { kind: "opening-lost" | "failed-pass"; atMs: number; sequence: number | null; actionId: string | null; playerId: number | null };
export type CounterLabFrame = {
  elapsedMs: number; sequence: number | null; action: string | null; ballHandlerId: number | null;
  assignments: Array<{ defenderId: number; playerId: number }>;
  opportunities: Array<{ kind: "shot" | "pass" | "drive"; playerId: number; quality: number; score: number; receiverGap: number; laneGap: number }>;
  blockedPass: { actionId: string; sequence: number; playerId: number; receiverGap: number; laneGap: number } | null;
  involvedPlayerIds: number[];
  activeRoutes: CourtRoute[];
  players: Array<{ id: number; x: number; y: number }>;
  defenders: Array<{ id: number; x: number; y: number }>;
  ball: CourtPoint | null; shotPhase: "idle" | "setup" | "air" | "result";
};
export type CounterLabResult = {
  key: string; profile: CounterLabProfile; mode: CounterLabMode; score: number; finalShotQuality: number;
  createdAdvantage: boolean; outcome: string; firstLostOpeningMs: number | null;
  firstBlockedPass: (PassDiagnostic & { playerId: number }) | null;
  firstUnsafePass: PassDiagnostic | null; passDiagnostics: PassDiagnostic[];
  firstBreakdown: CounterLabEvent | null; releasedAtMs: number | null;
  adaptiveAttempts: number; adaptiveSuccesses: number; recoveredAtMs: number | null;
  actions: string[]; notice: string | null; trace: CounterLabFrame[];
};
export type RepairEvidence = { key: string; gain: number; verified: boolean; cleared: boolean; opening: "cleared" | "delayed" | "still failing" | "not created" | "unchanged"; delayMs: number; passCleared: boolean };
export type CounterLabSummary = Omit<CounterLabResult, "trace">;
export type CounterLabRepair = { id: string; name: string; reason: string; play: PlaybookDraft; results: CounterLabSummary[]; evidence: RepairEvidence[]; averageGain: number; bestGain: number; resolvedBreakdowns: number };
export type CounterLabProgress = { completed: number; total: number; label: string; stage: "defenses" | "repairs" };
export type CounterLabRequest =
  | { type: "analyze"; id: string; draft: PlaybookDraft; profiles: CounterLabProfile[]; modes: CounterLabMode[] }
  | { type: "details"; id: string; detailId: string; key: string; repairId: string }
  | { type: "cancel"; id: string };
export type CounterLabMessage =
  | ({ type: "progress"; id: string } & CounterLabProgress)
  | { type: "baseline"; id: string; results: CounterLabSummary[] }
  | { type: "complete"; id: string; results: CounterLabSummary[]; repairs: CounterLabRepair[] }
  | { type: "cancelled"; id: string }
  | { type: "details"; id: string; detailId: string; key: string; repairId: string; original: CounterLabFrame[] | null; repaired: CounterLabFrame[] | null }
  | { type: "error"; id: string; message: string };

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
  .filter((scheme) => scheme !== "man-to-man")
  .map((scheme) => ({ id: scheme, label: scheme.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), strategy: "help" as const, scheme }));

export function eligibleCounterLabSchemes(defenderCount: number, offensivePlayerCount: number) {
  if (defenderCount < 5) return [];
  return COUNTER_LAB_EXTRA_SCHEMES.filter((profile) => profile.scheme !== "triangle-and-two" || offensivePlayerCount >= 2);
}

const point = (x: number, y: number): CourtPoint => ({ x, y });
const clamp = (value: number) => Math.max(4, Math.min(96, value));

export function createCounterLabRepairs(draft: PlaybookDraft): Array<Pick<CounterLabRepair, "id" | "name" | "reason" | "play">> {
  const repairs: Array<Pick<CounterLabRepair, "id" | "name" | "reason" | "play">> = [];
  const authored = createSimulationRun(draft, { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: "scripted" }).actions;
  for (const [index, arrow] of draft.arrows.entries()) {
    const move = arrow.sequence ?? index + 1;
    if ((arrow.kind === "screen" || arrow.kind === "pick-roll") && arrow.screener_id != null) {
      const play = structuredClone(draft);
      play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id
        ? { ...candidate, kind: "slip-screen", timing: Math.max(0.5, (candidate.timing ?? 1.2) * 0.8) }
        : candidate);
      repairs.push({ id: `slip-${arrow.id}`, name: "Slip the screen", reason: "Roll before the switch can settle, then test whether the handler or screener gains a cleaner option.", play });
    }
    if (arrow.kind === "pick-roll" || arrow.kind === "pick-pop") {
      const play = structuredClone(draft);
      play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id
        ? { ...candidate, kind: arrow.kind === "pick-roll" ? "pick-pop" : "pick-roll", exit_target: candidate.exit_target ?? { x: clamp(candidate.end.x + (candidate.end.x < 50 ? -12 : 12)), y: clamp(candidate.end.y + 5) } }
        : candidate);
      repairs.push({ id: `roll-pop-${arrow.id}`, name: arrow.kind === "pick-roll" ? "Pop instead of roll" : "Roll instead of pop", reason: "Change the screener's finish and compare the newly available lane or perimeter shot.", play });
    }
    if (arrow.kind === "screen" || arrow.kind === "pick-roll" || arrow.kind === "pick-pop" || arrow.kind === "pass" || arrow.kind === "movement") {
      for (const change of [-0.25, 0.25]) {
        const play = structuredClone(draft);
        play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id
          ? { ...candidate, timing: Math.max(0.5, Math.min(4, Math.round(((candidate.timing ?? 1.2) + change) * 100) / 100)) }
          : candidate);
        repairs.push({ id: `timing-${arrow.id}-${change}`, name: `${change < 0 ? "Quicker" : "More time for"} ${arrow.kind.replaceAll("-", " ")} · Move ${move}`, reason: `${change < 0 ? "Shorten" : "Lengthen"} the action duration by ${Math.abs(change).toFixed(2)} seconds. Later moves shift with the sequence.`, play });
      }
    }
    if (arrow.kind === "pass") {
      const bound = authored.find((action) => action.arrow.id === arrow.id);
      const originalReceiver = bound?.recipientId;
      // Build-time participant binding uses predicted positions at this phase,
      // so use those positions rather than the initial roster coordinates.
      const phasePositions = createSimulationRun({ ...draft, arrows: draft.arrows.filter((item, i) => (item.sequence ?? i + 1) < move) }, { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: "scripted" });
      const positions = phasePositions.actions.length ? draft.players.map((player) => {
        const route = [...phasePositions.actions].reverse().find((action) => action.actorId === player.id && action.arrow.kind === "movement");
        return route ? { ...player, ...route.arrow.end } : player;
      }) : draft.players;
      for (const recipient of positions.filter((player) => player.id !== bound?.actorId && player.id !== originalReceiver).slice(0, 2)) {
        const play = structuredClone(draft);
        play.arrows = play.arrows.map((candidate) => candidate.id === arrow.id ? { ...candidate, end: point(recipient.x, recipient.y) } : candidate);
        const redirected = createSimulationRun(play, { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: "scripted" }).actions.find((action) => action.arrow.id === arrow.id);
        if (redirected?.recipientId !== recipient.id || redirected.recipientId === originalReceiver || redirected.recipientId === redirected.actorId) continue;
        repairs.push({ id: `pass-${arrow.id}-${recipient.id}`, name: `Pass to Player ${recipient.id} · Move ${move}`, reason: "Test a different receiver against the same starting court and defense.", play });
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
  const signature = (play: PlaybookDraft) => JSON.stringify(createSimulationRun(play, { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: "scripted" }).actions.map((action) => ({ kind: action.arrow.kind, actor: action.actorId, recipient: action.recipientId, start: action.startTime, duration: action.durationMs, end: action.arrow.end, exit: action.arrow.exit_target, control: action.arrow.control })));
  const original = signature(draft);
  const effective = [...unique.values()].filter((repair) => signature(repair.play) !== original);
  // Reserve space for different edit families instead of filling the budget
  // with duration edits from the first few moves.
  const families = ["slip-", "roll-pop-", "pass-", "space-", "timing-"];
  const bounded: typeof repairs = [];
  for (let round = 0; bounded.length < 8; round++) {
    let added = false;
    for (const family of families) {
      const candidate = effective.filter((repair) => repair.id.startsWith(family))[round];
      if (candidate && bounded.length < 8) { bounded.push(candidate); added = true; }
    }
    if (!added) break;
  }
  return bounded;
}
