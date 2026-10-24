import type { ActionDiagnostic } from "./simulation.ts";
import type { BaitPayoffConnection, BaitPayoffEvent, PlaybookArrow, PlaybookDraft, SimulationSettings } from "./types.ts";
import { bindAuthoredActions } from "./simulation.ts";

export type BaitPayoffSample = { atMs: number; defenders: Array<{ id: number; x: number; y: number }>; execution: ActionDiagnostic[] };
export type BaitPayoffReactionResult = {
  status: "pending" | "reaction-observed" | "reaction-not-observed" | "already-in-expected-position" | "not-evaluated";
  baitAtMs: number | null;
  checkpointAtMs: number | null;
  startPoint: { x: number; y: number } | null;
  endPoint: { x: number; y: number } | null;
  reason: string | null;
};

function hash(value: unknown) {
  const text = JSON.stringify(value);
  let result = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) result = Math.imul(result ^ text.charCodeAt(index), 0x01000193);
  return (result >>> 0).toString(16).padStart(8, "0");
}

export function baitPayoffActionSignature(arrow: PlaybookArrow, play: PlaybookDraft) {
  const binding = bindAuthoredActions(play).find((action) => action.arrow.id === arrow.id);
  return hash({ kind: arrow.kind, actorId: binding?.actorId ?? null, recipientId: binding?.recipientId ?? null,
    partnerId: binding?.partnerId ?? null });
}

export function actionExecution(sample: BaitPayoffSample | undefined, actionId: string): ActionDiagnostic | undefined {
  return sample?.execution.find((item) => item.actionId === actionId);
}

export function milestoneTime(samples: BaitPayoffSample[], actionId: string, event: BaitPayoffEvent, routeProgress?: number, routePlayerId?: number): number | null {
  for (const sample of samples) {
    const execution = actionExecution(sample, actionId);
    if (!execution) continue;
    if (event === "start" && typeof execution.startedAtMs === "number" && Number.isFinite(execution.startedAtMs)) return execution.startedAtMs;
    if (event === "complete" && execution.phase === "completed" && typeof execution.completedAtMs === "number" && Number.isFinite(execution.completedAtMs)) return execution.completedAtMs;
    if (event === "catch" && execution.transfer?.outcome.kind === "caught" && Number.isFinite(execution.transfer.outcome.atMs)) return execution.transfer.outcome.atMs;
    if (event === "screen-set" && typeof execution.setAtMs === "number" && Number.isFinite(execution.setAtMs)) return execution.setAtMs;
    if (event === "screen-use" && typeof execution.usedAtMs === "number" && Number.isFinite(execution.usedAtMs)) return execution.usedAtMs;
    if (event === "route-point" && [execution.actorId, execution.recipientId, execution.partnerId].includes(routePlayerId ?? -1)
      && execution.progress >= (routeProgress ?? 1)) return sample.atMs;
  }
  return null;
}

export function baitPayoffInteractionEndMs(samples: BaitPayoffSample[], payoffActionId: string, recordedUntilMs: number) {
  const payoffStartMs = milestoneTime(samples, payoffActionId, "start");
  const payoffEndMs = milestoneTime(samples, payoffActionId, "complete") ?? payoffStartMs;
  const recordingEndMs = Number.isFinite(recordedUntilMs) ? Math.max(0, recordedUntilMs) : 0;
  const firstAvailable = payoffStartMs ?? payoffEndMs ?? recordingEndMs;
  const lastAvailable = payoffEndMs ?? payoffStartMs ?? recordingEndMs;
  return Math.max(firstAvailable, lastAvailable);
}

function recordedAt(samples: BaitPayoffSample[], atMs: number) {
  let selected: BaitPayoffSample | null = null;
  for (const sample of samples) {
    if (sample.atMs > atMs + 1e-6) break;
    selected = sample;
  }
  return selected;
}

function inside(point: { x: number; y: number }, area: NonNullable<BaitPayoffConnection["reaction"]>["area"]) {
  const dx = (point.x - area.center.x) * 0.5;
  const dy = (point.y - area.center.y) * 0.47;
  if (area.shape === "circle") return Math.hypot(dx, dy) <= area.radiusFeet + 1e-6;
  return Math.abs(dx) <= area.widthFeet / 2 + 1e-6 && Math.abs(dy) <= area.heightFeet / 2 + 1e-6;
}

export function evaluateBaitPayoffReaction(connection: BaitPayoffConnection, samples: BaitPayoffSample[]): BaitPayoffReactionResult {
  const reaction = connection.reaction;
  if (!reaction) return { status: "pending", baitAtMs: null, checkpointAtMs: null, startPoint: null, endPoint: null, reason: null };
  const baitAtMs = milestoneTime(samples, connection.baitActionId, "start");
  if (baitAtMs === null) return { status: "not-evaluated", baitAtMs: null, checkpointAtMs: null, startPoint: null, endPoint: null, reason: "The bait action did not start in the recording" };
  const checkpointAtMs = milestoneTime(samples, reaction.checkpoint.actionId, reaction.checkpoint.event, reaction.checkpoint.progress, reaction.checkpoint.routePlayerId);
  if (checkpointAtMs === null) return { status: "not-evaluated", baitAtMs, checkpointAtMs: null, startPoint: null, endPoint: null, reason: "The selected execution milestone did not occur" };
  if (checkpointAtMs < baitAtMs - 1e-6) return { status: "not-evaluated", baitAtMs, checkpointAtMs, startPoint: null, endPoint: null, reason: "The selected checkpoint occurred before the bait started" };
  const startSample = recordedAt(samples, baitAtMs);
  const endSample = recordedAt(samples, checkpointAtMs);
  const startPoint = startSample?.defenders.find((defender) => defender.id === reaction.defenderId);
  const endPoint = endSample?.defenders.find((defender) => defender.id === reaction.defenderId);
  if (!startPoint || !endPoint) return { status: "not-evaluated", baitAtMs, checkpointAtMs,
    startPoint: startPoint ? { x: startPoint.x, y: startPoint.y } : null,
    endPoint: endPoint ? { x: endPoint.x, y: endPoint.y } : null,
    reason: `Defender ${reaction.defenderId} is unavailable at a checked moment` };
  const startedInside = inside(startPoint, reaction.area), endedInside = inside(endPoint, reaction.area);
  const alreadyExpected = reaction.direction === "enter" ? startedInside : !startedInside;
  const observed = reaction.direction === "enter" ? !startedInside && endedInside : startedInside && !endedInside;
  return { status: alreadyExpected ? "already-in-expected-position" : observed ? "reaction-observed" : "reaction-not-observed",
    baitAtMs, checkpointAtMs, startPoint: { x: startPoint.x, y: startPoint.y }, endPoint: { x: endPoint.x, y: endPoint.y }, reason: null };
}

export function scriptedBaitPayoffSettings(settings: SimulationSettings): SimulationSettings {
  return { ...settings, offenseMode: "scripted", offenseOffBall: "off", automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };
}

export function baitPayoffParticipants(arrow: PlaybookArrow, play: PlaybookDraft) {
  const action = bindAuthoredActions(play).find((candidate) => candidate.arrow.id === arrow.id);
  return [...new Set([action?.actorId, action?.recipientId, action?.partnerId].filter((id): id is number => id != null))];
}
