import type { ActionDiagnostic } from "./simulation.ts";
import type { AdvantageRelay, AdvantageRelayEvent, AdvantageRelayEvidence, CounterLabFrame, CounterLabOpportunity } from "./counterLabTypes.ts";

export const ADVANTAGE_OPENING_QUALITY = 55;
export const ADVANTAGE_QUALITY_DROP = 15;
export const ADVANTAGE_LOSS_PERSISTENCE_MS = 300;
export const ADVANTAGE_RELAY_VERSION = 1;

type OpeningEpisode = { createdAtMs: number; lostAtMs: number | null; lossConfirmedAtMs: number | null };
type LossSignal = { atMs: number; confirmedAtMs: number; frame: CounterLabFrame };

const rankedOptions = (options: CounterLabOpportunity[]) => [...options].sort((a, b) =>
  b.score - a.score || b.quality - a.quality || a.playerId - b.playerId || a.kind.localeCompare(b.kind));
const bestQualityOption = (options: CounterLabOpportunity[]) => [...options].sort((a, b) =>
  b.quality - a.quality || b.score - a.score || a.playerId - b.playerId || a.kind.localeCompare(b.kind))[0] ?? null;

function evidenceAt(frame: CounterLabFrame, actionId: string | null = null): AdvantageRelayEvidence {
  const execution = frame.execution?.filter((action) => action.sequence === frame.sequence && action.startedAtMs !== null
    && action.startedAtMs <= frame.elapsedMs + 1e-6 && action.phase !== "pending").sort((a, b) => a.actionId.localeCompare(b.actionId))[0];
  return {
    snapshotMs: frame.elapsedMs,
    ballHandlerId: frame.ballHandlerId,
    sequence: frame.sequence,
    action: frame.action,
    actionId: actionId ?? execution?.actionId ?? null,
    opportunities: rankedOptions(frame.opportunities).map((option) => ({ ...option })),
    assignments: frame.assignments.map((assignment) => ({ ...assignment })),
  };
}

function activeOption(frame: CounterLabFrame) {
  return rankedOptions(frame.opportunities.filter((option) => option.quality >= ADVANTAGE_OPENING_QUALITY))[0]
    ?? bestQualityOption(frame.opportunities);
}

/** Build a compact explanation from evidence already captured by a Counter Lab trial. */
export function buildAdvantageRelay(diagnosticTrace: CounterLabFrame[], trace: CounterLabFrame[]): AdvantageRelay {
  const episodes: OpeningEpisode[] = [];
  const events: AdvantageRelayEvent[] = [];
  const losses: LossSignal[] = [];
  let peak = 0;
  let pendingAtMs: number | null = null;
  let pendingFrame: CounterLabFrame | null = null;
  let activeEpisode: OpeningEpisode | null = null;
  let lastEvaluatedMs = 0;

  for (const frame of diagnosticTrace) {
    if (frame.shotPhase === "air" || frame.shotPhase === "result") break;
    lastEvaluatedMs = frame.elapsedMs;
    if (frame.ballPhase === "pass-in-flight") { pendingAtMs = null; pendingFrame = null; continue; }
    const best = Math.max(0, ...frame.opportunities.map((option) => option.quality));
    if (best >= ADVANTAGE_OPENING_QUALITY) {
      if (!activeEpisode) {
        activeEpisode = { createdAtMs: frame.elapsedMs, lostAtMs: null, lossConfirmedAtMs: null };
        episodes.push(activeEpisode);
        const option = activeOption(frame);
        const playerIds = [...new Set([frame.ballHandlerId, option?.playerId].filter((id): id is number => id != null))];
        const snapshot = evidenceAt(frame);
        events.push({
          id: `created-${episodes.length}-${Math.round(frame.elapsedMs)}`,
          kind: "created",
          atMs: frame.elapsedMs,
          confirmedAtMs: null,
          playerIds,
          sequence: frame.sequence,
          actionId: snapshot.actionId,
          note: frame.elapsedMs <= 1e-6 ? "Available at start" : `${option?.kind ?? "Eligible"} option recorded`,
          evidence: snapshot,
          transfer: null,
        });
      }
      peak = Math.max(peak, best);
      pendingAtMs = null;
      pendingFrame = null;
    } else if (activeEpisode && peak >= ADVANTAGE_OPENING_QUALITY && best <= peak - ADVANTAGE_QUALITY_DROP) {
      pendingAtMs ??= frame.elapsedMs;
      pendingFrame ??= frame;
      if (frame.elapsedMs - pendingAtMs >= ADVANTAGE_LOSS_PERSISTENCE_MS - 1e-6) {
        const lostFrame = pendingFrame;
        activeEpisode.lostAtMs = pendingAtMs;
        activeEpisode.lossConfirmedAtMs = frame.elapsedMs;
        losses.push({ atMs: pendingAtMs, confirmedAtMs: frame.elapsedMs, frame: lostFrame });
        const option = bestQualityOption(lostFrame.opportunities);
        const playerIds = [...new Set([lostFrame.ballHandlerId, option?.playerId].filter((id): id is number => id != null))];
        const snapshot = evidenceAt(lostFrame);
        events.push({
          id: `lost-${episodes.length}-${Math.round(pendingAtMs)}`,
          kind: "lost",
          atMs: pendingAtMs,
          confirmedAtMs: frame.elapsedMs,
          playerIds,
          sequence: lostFrame.sequence,
          actionId: snapshot.actionId,
          note: `Confirmed after ${ADVANTAGE_LOSS_PERSISTENCE_MS} ms below the recorded quality-drop threshold`,
          evidence: snapshot,
          transfer: null,
        });
        activeEpisode = null;
        pendingAtMs = null;
        pendingFrame = null;
      }
    } else {
      pendingAtMs = null;
      pendingFrame = null;
    }
  }

  const completedTransfers = new Map<string, { action: ActionDiagnostic; transfer: NonNullable<ActionDiagnostic["transfer"]>; beginAtMs: number; caughtAtMs: number }>();
  const supportingTransfers = new Map<string, AdvantageRelay["supportingTransfers"][number]>();
  for (const frame of trace) for (const action of frame.execution ?? []) {
    const transfer = action.transfer;
    if (!transfer || transfer.outcome.kind === "pending" || action.actorId == null || action.recipientId == null
      || transfer.giverId !== action.actorId || transfer.receiverId !== action.recipientId) continue;
    const atMs = transfer.outcome.kind === "caught" ? transfer.outcome.atMs : transfer.outcome.atMs;
    const supportId = `${action.actionId}\u0000${atMs}`;
    if (!supportingTransfers.has(supportId)) supportingTransfers.set(supportId, {
      id: `transfer-${action.actionId}-${Math.round(atMs)}`,
      actionId: action.actionId,
      sequence: action.sequence,
      kind: transfer.kind,
      outcome: transfer.outcome.kind,
      giverId: transfer.giverId,
      receiverId: transfer.receiverId,
      atMs,
    });
    if (transfer.outcome.kind !== "caught") continue;
    const transferStart = transfer.release?.atMs ?? (transfer.kind === "handoff"
      ? trace.find((sample) => sample.ballPhase === "handoff-pending" && sample.execution?.some((item) => item.actionId === action.actionId && item.transfer?.actionKey === transfer.actionKey))?.elapsedMs ?? action.startedAtMs
      : null);
    if (transferStart == null || transferStart > transfer.outcome.atMs) continue;
    if (!completedTransfers.has(supportId)) completedTransfers.set(supportId, { action, transfer, beginAtMs: transferStart, caughtAtMs: transfer.outcome.atMs });
  }

  const stepMs = trace.length > 1 ? Math.max(1, trace[1].elapsedMs - trace[0].elapsedMs) : 1000 / 30;
  for (const { action, transfer, beginAtMs, caughtAtMs } of completedTransfers.values()) {
    if (transfer.giverId == null || transfer.receiverId == null || transfer.outcome.kind !== "caught") continue;
    let setupFrame: CounterLabFrame | null = null;
    let setupPassOpportunity: CounterLabOpportunity | null = null;
    for (const frame of trace) {
      if (frame.elapsedMs > beginAtMs + 1e-6) break;
      if (beginAtMs - frame.elapsedMs > stepMs * 1.1) continue;
      if (frame.ballHandlerId !== transfer.giverId || frame.ballPhase !== "held") continue;
      const option = frame.opportunities.find((candidate) => candidate.kind === "pass" && candidate.playerId === transfer.receiverId
        && candidate.quality >= ADVANTAGE_OPENING_QUALITY);
      const activeAction = action.startedAtMs !== null && action.startedAtMs <= beginAtMs + 1e-6;
      if (activeAction && option) { setupFrame = frame; setupPassOpportunity = option; }
    }
    if (!setupFrame || !setupPassOpportunity) continue;

    const continuation = trace.find((frame) => frame.elapsedMs + 1e-6 >= caughtAtMs
      && frame.ballPhase === "held" && frame.ballHandlerId === transfer.receiverId
      && frame.opportunities.some((option) => option.quality >= ADVANTAGE_OPENING_QUALITY));
    if (!continuation) continue;
    // The opening must exist before the transfer begins and still be alive at
    // the receiver's continuation. A brand-new opening after a lost pass
    // cannot be credited to that earlier transfer.
    const episode = episodes.find((candidate) => candidate.createdAtMs <= beginAtMs + 1e-6
      && candidate.createdAtMs <= continuation.elapsedMs + 1e-6
      && (candidate.lossConfirmedAtMs == null || continuation.elapsedMs < candidate.lossConfirmedAtMs - 1e-6)
      && !losses.some((loss) => loss.confirmedAtMs <= continuation.elapsedMs && loss.atMs >= candidate.createdAtMs));
    if (!episode) continue;

    const continuationOpportunity = bestQualityOption(continuation.opportunities.filter((candidate) => candidate.quality >= ADVANTAGE_OPENING_QUALITY));
    if (!continuationOpportunity) continue;
    const snapshot = evidenceAt(continuation, action.actionId);
    events.push({
      id: `transferred-${action.actionId}-${Math.round(transfer.outcome.atMs)}`,
      kind: "transferred",
      atMs: continuation.elapsedMs,
      confirmedAtMs: null,
      playerIds: [transfer.giverId, transfer.receiverId],
      sequence: action.sequence,
      actionId: action.actionId,
      note: `${transfer.kind === "handoff" ? "Handoff" : "Catch"} recorded · Eligible continuation at ${Math.round(continuation.elapsedMs)} ms`,
      evidence: snapshot,
      transfer: {
        actionId: action.actionId,
        sequence: action.sequence,
        kind: transfer.kind,
        giverId: transfer.giverId,
        receiverId: transfer.receiverId,
        releasedAtMs: beginAtMs,
        caughtAtMs,
        continuationAtMs: continuation.elapsedMs,
        passOpportunity: { ...setupPassOpportunity },
        continuationOpportunity: { ...continuationOpportunity },
      },
    });
  }

  events.sort((a, b) => a.atMs - b.atMs || eventOrder(a.kind) - eventOrder(b.kind) || a.id.localeCompare(b.id));
  const durationMs = Math.max(0, trace.at(-1)?.elapsedMs ?? diagnosticTrace.at(-1)?.elapsedMs ?? lastEvaluatedMs);
  return { version: ADVANTAGE_RELAY_VERSION, status: events.length ? "recorded" : "none", durationMs, events, supportingTransfers: [...supportingTransfers.values()].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id)) };
}

function eventOrder(kind: AdvantageRelayEvent["kind"]) { return kind === "created" ? 0 : kind === "transferred" ? 1 : 2; }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const identity = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;
const nullableIdentity = (value: unknown) => value === null || identity(value);
const clock = (value: unknown) => finite(value) && value >= 0;
const gap = (value: unknown) => finite(value) && value >= 0;
function check(valid: unknown): asserts valid { if (!valid) throw new Error("Advantage Relay data is damaged or incompatible · Retry the comparison"); }

/** Validate summary evidence at the worker boundary before it reaches the court. */
export function validateAdvantageRelay(value: unknown, playerIds: ReadonlySet<number>, defenderIds: ReadonlySet<number>): asserts value is AdvantageRelay {
  check(record(value) && value.version === ADVANTAGE_RELAY_VERSION && ["recorded", "none"].includes(value.status as string)
    && clock(value.durationMs) && Array.isArray(value.events) && value.events.length <= 128
    && Array.isArray(value.supportingTransfers) && value.supportingTransfers.length <= 256);
  const relay = value as Record<string, unknown>;
  const relayEvents = relay.events as unknown[];
  const relayTransfers = relay.supportingTransfers as unknown[];
  const durationMs = relay.durationMs as number;
  check((relay.status === "none") === (relayEvents.length === 0));
  const ids = new Set<string>();
  let previousAtMs = -Infinity;
  for (const item of relayEvents) {
    check(record(item));
    const raw = item as Record<string, unknown>;
    check(typeof raw.id === "string" && raw.id.length > 0 && !ids.has(raw.id)); ids.add(raw.id as string);
    check(["created", "transferred", "lost"].includes(raw.kind as string) && clock(raw.atMs) && (raw.atMs as number) <= durationMs + 1e-6 && (raw.atMs as number) >= previousAtMs);
    const eventAtMs = raw.atMs as number;
    const confirmation = raw.confirmedAtMs as number | null;
    previousAtMs = eventAtMs;
    check(confirmation === null || clock(confirmation) && confirmation >= eventAtMs && confirmation <= durationMs + 1e-6);
    check(Array.isArray(raw.playerIds) && raw.playerIds.length <= 5 && new Set(raw.playerIds).size === raw.playerIds.length
      && raw.playerIds.every((id) => identity(id) && playerIds.has(id as number)));
    check(raw.sequence === null || identity(raw.sequence));
    check(raw.actionId === null || typeof raw.actionId === "string" && raw.actionId.length > 0);
    check(raw.note === null || typeof raw.note === "string");
    check(record(raw.evidence));
    const evidence = raw.evidence as Record<string, unknown>;
    check(clock(evidence.snapshotMs) && (evidence.snapshotMs as number) <= durationMs + 1e-6
      && nullableIdentity(evidence.ballHandlerId) && (evidence.ballHandlerId === null || playerIds.has(evidence.ballHandlerId as number))
      && (evidence.sequence === null || identity(evidence.sequence)) && (evidence.action === null || typeof evidence.action === "string")
      && (evidence.actionId === null || typeof evidence.actionId === "string" && evidence.actionId.length > 0)
      && Array.isArray(evidence.opportunities) && evidence.opportunities.length <= 12 && Array.isArray(evidence.assignments));
    for (const option of evidence.opportunities) check(validOpportunity(option, playerIds));
    for (const assignment of evidence.assignments) check(record(assignment) && identity(assignment.defenderId) && defenderIds.has(assignment.defenderId as number)
      && identity(assignment.playerId) && playerIds.has(assignment.playerId as number));
    if (raw.kind === "transferred") {
      check(record(raw.transfer));
      const transfer = raw.transfer as Record<string, unknown>;
      check(typeof transfer.actionId === "string" && transfer.actionId.length > 0 && raw.actionId === transfer.actionId
        && identity(transfer.sequence) && raw.sequence === transfer.sequence && ["pass", "handoff"].includes(transfer.kind as string)
        && identity(transfer.giverId) && playerIds.has(transfer.giverId as number) && identity(transfer.receiverId) && playerIds.has(transfer.receiverId as number)
        && transfer.giverId !== transfer.receiverId && clock(transfer.releasedAtMs) && clock(transfer.caughtAtMs) && clock(transfer.continuationAtMs)
        && (transfer.releasedAtMs as number) <= (transfer.caughtAtMs as number) + 1e-6 && (transfer.caughtAtMs as number) <= (transfer.continuationAtMs as number) + 1e-6
        && transfer.continuationAtMs === eventAtMs && evidence.snapshotMs === eventAtMs
        && transfer.passOpportunity !== null);
      check(validOpportunity(transfer.passOpportunity, playerIds) && transfer.passOpportunity.kind === "pass"
        && transfer.passOpportunity.playerId === transfer.receiverId && transfer.passOpportunity.quality >= ADVANTAGE_OPENING_QUALITY);
      check(validOpportunity(transfer.continuationOpportunity, playerIds) && transfer.continuationOpportunity.quality >= ADVANTAGE_OPENING_QUALITY
        && raw.playerIds.includes(transfer.giverId) && raw.playerIds.includes(transfer.receiverId));
    } else check(raw.transfer === null);
    if (raw.kind === "lost") check(raw.confirmedAtMs !== null);
    else check(raw.confirmedAtMs === null);
  }
  const transferIds = new Set<string>();
  for (const item of relayTransfers) {
    check(record(item));
    const raw = item as Record<string, unknown>;
    check(typeof raw.id === "string" && raw.id.length > 0 && !transferIds.has(raw.id)); transferIds.add(raw.id as string);
    check(typeof raw.actionId === "string" && raw.actionId.length > 0 && identity(raw.sequence)
      && ["pass", "handoff"].includes(raw.kind as string) && ["caught", "failed", "interrupted"].includes(raw.outcome as string)
      && identity(raw.giverId) && playerIds.has(raw.giverId as number) && identity(raw.receiverId) && playerIds.has(raw.receiverId as number)
      && raw.giverId !== raw.receiverId && clock(raw.atMs) && (raw.atMs as number) <= durationMs + 1e-6);
  }
}

export function isValidAdvantageRelay(value: unknown, playerIds: ReadonlySet<number>, defenderIds: ReadonlySet<number>): value is AdvantageRelay {
  try { validateAdvantageRelay(value, playerIds, defenderIds); return true; }
  catch { return false; }
}

function validOpportunity(value: unknown, playerIds: ReadonlySet<number>): value is CounterLabOpportunity {
  return record(value) && ["shot", "pass", "drive"].includes(value.kind as string) && identity(value.playerId) && playerIds.has(value.playerId as number)
    && finite(value.quality) && finite(value.score) && gap(value.receiverGap)
    // The shared opportunity model intentionally uses +Infinity for shots,
    // where a passing lane does not apply. Keep that sentinel lossless.
    && (value.kind === "shot" ? value.laneGap === Infinity || gap(value.laneGap) : gap(value.laneGap));
}
