import type { CourtPoint } from "./types.ts";

export type BallSample = { atMs: number; position: CourtPoint };
export type TransferOutcome = { kind: "pending" } | ({ kind: "caught" } & BallSample)
  | { kind: "failed" | "interrupted"; atMs: number; reason: string };
/** One evidence record per transfer, shared by its action and the active state.
 * Historical outcomes are never used to infer current possession. */
export type TransferRecord = {
  actionKey: string; kind: "pass" | "handoff"; giverId: number | null; receiverId: number | null;
  release: BallSample | null; arrival: BallSample | null; outcome: TransferOutcome;
};
type MovingBall = { position: CourtPoint; velocity: CourtPoint };
type Shot = MovingBall & {
  shooterId: number; start: CourtPoint; setupAtMs: number; releaseAtMs: number; resultAtMs: number;
  quality: number; pathOverride: BallSample | null;
};
export type BallState =
  | (MovingBall & { kind: "held"; holderId: number })
  | (MovingBall & { kind: "pass-in-flight" | "handoff-pending"; transfer: TransferRecord; pathOverride: BallSample | null })
  | { kind: "loose"; position: CourtPoint | null; velocity: CourtPoint; sinceMs: number }
  | (Shot & { kind: "shot-setup" | "shot-in-flight" | "shot-result" });
export type BallPhase = BallState["kind"];
export const BALL_PHASES: readonly BallPhase[] = ["held", "pass-in-flight", "handoff-pending", "loose", "shot-setup", "shot-in-flight", "shot-result"];
export const ballController = (state: BallState): number | null => state.kind === "held" ? state.holderId
  : state.kind === "handoff-pending" ? state.transfer.giverId : state.kind === "shot-setup" ? state.shooterId : null;
export const isShotBall = (state: BallState): state is Extract<BallState, Shot> =>
  state.kind === "shot-setup" || state.kind === "shot-in-flight" || state.kind === "shot-result";
export const isTransferBall = (state: BallState): state is Extract<BallState, { transfer: TransferRecord }> =>
  state.kind === "pass-in-flight" || state.kind === "handoff-pending";
export const caughtAt = (record?: TransferRecord) => record?.outcome.kind === "caught" ? record.outcome.atMs : undefined;
export const failedTransfer = (record?: TransferRecord) => record?.outcome.kind === "failed";
export function copyTransfer(record: TransferRecord): TransferRecord {
  const sample = (value: BallSample | null) => value ? { atMs: value.atMs, position: point(value.position) } : null;
  return { ...record, release: sample(record.release), arrival: sample(record.arrival),
    outcome: record.outcome.kind === "caught" ? { ...record.outcome, position: point(record.outcome.position) } : { ...record.outcome } };
}
const point = (value: CourtPoint) => ({ x: value.x, y: value.y });
const zero = () => ({ x: 0, y: 0 });
export function placedBall(position: CourtPoint | null, holderId: number | null, atMs = 0): BallState {
  return position && holderId != null ? { kind: "held", holderId, position: point(position), velocity: zero() }
    : { kind: "loose", position: position ? point(position) : null, velocity: zero(), sinceMs: atMs };
}
type BallEvent =
  | { kind: "transfer"; record: TransferRecord; atMs: number }
  | { kind: "catch"; receiverId: number; atMs: number; position: CourtPoint; giverPosition?: CourtPoint }
  | { kind: "fail" | "interrupt"; atMs: number; reason: string; giverPosition?: CourtPoint }
  | { kind: "recover"; playerId: number; position: CourtPoint }
  | { kind: "shot"; shooterId: number; atMs: number; durationMs: number; quality: number }
  | { kind: "release-shot" | "finish-shot"; atMs: number }
  | { kind: "drop"; atMs: number };

/** All possession transitions pass through here. Illegal events fail before any
 * record changes. Movement updates only the current state's position/velocity. */
export function transitionBall(state: BallState, event: BallEvent): BallState {
  const illegal = (): never => { throw new Error(`Illegal ball transition: ${state.kind} → ${event.kind}`); };
  if ("atMs" in event && (!Number.isFinite(event.atMs) || event.atMs < 0)) return illegal();
  switch (event.kind) {
    case "transfer": {
      const record = event.record;
      if (state.kind !== "held" || state.holderId !== record.giverId || record.receiverId == null
        || record.giverId === record.receiverId || record.outcome.kind !== "pending") return illegal();
      if (record.kind === "pass") record.release = { atMs: event.atMs, position: point(state.position) };
      return { kind: record.kind === "pass" ? "pass-in-flight" : "handoff-pending", transfer: record,
        position: point(state.position), velocity: zero(), pathOverride: null };
    }
    case "catch": {
      if (!isTransferBall(state) || state.transfer.outcome.kind !== "pending" || state.transfer.receiverId !== event.receiverId
        || state.transfer.release && event.atMs < state.transfer.release.atMs) return illegal();
      const sample = { atMs: event.atMs, position: point(event.position) };
      state.transfer.arrival ??= { atMs: event.atMs, position: point(event.position) };
      state.transfer.release ??= { atMs: event.atMs, position: point(event.giverPosition ?? state.position) };
      state.transfer.outcome = { kind: "caught", ...sample };
      return placedBall(event.position, event.receiverId);
    }
    case "fail": case "interrupt": {
      if (!isTransferBall(state) || state.transfer.outcome.kind !== "pending") return illegal();
      state.transfer.outcome = { kind: event.kind === "fail" ? "failed" : "interrupted", atMs: event.atMs, reason: event.reason };
      // An uncompleted handoff has never released possession. A pass has.
      return state.kind === "handoff-pending" && event.giverPosition
        ? placedBall(event.giverPosition, state.transfer.giverId)
        : { kind: "loose", position: point(state.position), velocity: { ...state.velocity }, sinceMs: event.atMs };
    }
    case "recover":
      if (state.kind !== "loose" || !state.position) return illegal();
      return placedBall(event.position, event.playerId);
    case "shot":
      if (state.kind !== "held" || state.holderId !== event.shooterId || !Number.isFinite(event.durationMs) || event.durationMs <= 0 || !Number.isFinite(event.quality)) return illegal();
      return { kind: "shot-setup", position: point(state.position), velocity: zero(), shooterId: event.shooterId,
        start: point(state.position), setupAtMs: event.atMs, releaseAtMs: event.atMs + event.durationMs * .18,
        resultAtMs: event.atMs + event.durationMs * .84, quality: event.quality, pathOverride: null };
    case "release-shot":
      if (state.kind !== "shot-setup" || event.atMs + 1e-6 < state.releaseAtMs) return illegal();
      return { ...state, kind: "shot-in-flight", start: point(state.position) };
    case "finish-shot":
      if (state.kind !== "shot-in-flight" || event.atMs + 1e-6 < state.resultAtMs) return illegal();
      return { ...state, kind: "shot-result" };
    case "drop":
      if (state.kind !== "held" && state.kind !== "shot-setup") return illegal();
      return { kind: "loose", position: point(state.position), velocity: zero(), sinceMs: event.atMs };
  }
}
