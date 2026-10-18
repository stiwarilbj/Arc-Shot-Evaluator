import type { CounterLabFrame } from "./counterLabTypes.ts";
import { unpackReplay, type ReplayArchive } from "./counterLabReplayArchive.ts";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const point = (value: unknown) => record(value) && finite(value.x) && finite(value.y);
const identity = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
const text = (value: unknown) => typeof value === "string" && value.length > 0;
const sequence = (value: unknown) => value === null || identity(value);
const clock = (value: unknown): value is number => finite(value) && value >= 0;
// No defender/lane obstruction is represented by positive infinity.
const gap = (value: unknown) => typeof value === "number" && value >= 0;
const phases = new Set(["pending", "approach", "set", "use", "release", "transfer", "completed", "obstructed", "conflict", "interrupted"]);
function check(valid: unknown): asserts valid {
  if (!valid) throw new Error("Replay data is damaged or incompatible. Retry loading the replay.");
}

/** Decode once at playback ingress, then validate without changing samples or
 * shared metadata. The low-level lossless codec remains usable independently. */
export function decodeReplayForPlayback(archive: ReplayArchive): CounterLabFrame[] {
  const frames = unpackReplay(archive);
  check(frames.length > 0);
  let previousTime = -Infinity;
  let roster: Set<number> | undefined, defense: Set<number> | undefined;
  for (const value of frames as unknown[]) {
    check(record(value));
    check(clock(value.elapsedMs) && value.elapsedMs >= previousTime);
    previousTime = value.elapsedMs;
    check(sequence(value.sequence) && (value.action === null || typeof value.action === "string"));
    check(["idle", "setup", "air", "result"].includes(value.shotPhase as string));
    check(value.ball === null || point(value.ball));
    const markers = (list: unknown) => {
      check(Array.isArray(list));
      const ids = new Set<number>();
      for (const marker of list) {
        check(record(marker) && identity(marker.id) && point(marker) && !ids.has(marker.id as number));
        ids.add(marker.id as number);
      }
      return ids;
    };
    const players = markers(value.players), defenders = markers(value.defenders);
    check(players.size > 0);
    // A possession has a fixed roster; ordering can differ between samples.
    check(!roster || roster.size === players.size && [...players].every((id) => roster!.has(id)));
    check(!defense || defense.size === defenders.size && [...defenders].every((id) => defense!.has(id)));
    roster ??= players; defense ??= defenders;
    const player = (id: unknown) => typeof id === "number" && players.has(id);
    const participant = (id: unknown) => id === null || player(id);
    check(participant(value.ballHandlerId));
    check(Array.isArray(value.assignments) && Array.isArray(value.opportunities) && Array.isArray(value.involvedPlayerIds) && Array.isArray(value.activeRoutes));
    for (const assignment of value.assignments) check(record(assignment) && defenders.has(assignment.defenderId as number) && player(assignment.playerId));
    for (const id of value.involvedPlayerIds) check(player(id));
    for (const opportunity of value.opportunities) {
      check(record(opportunity) && ["shot", "pass", "drive"].includes(opportunity.kind as string) && player(opportunity.playerId));
      check(finite(opportunity.quality) && finite(opportunity.score) && gap(opportunity.receiverGap) && gap(opportunity.laneGap));
    }
    if (value.blockedPass !== null) {
      const pass = value.blockedPass;
      check(record(pass) && text(pass.actionId) && identity(pass.sequence) && player(pass.playerId) && gap(pass.receiverGap) && gap(pass.laneGap));
    }
    for (const route of value.activeRoutes) {
      check(record(route) && text(route.id) && text(route.kind) && player(route.playerId));
      check((route.actionId === null || text(route.actionId)) && sequence(route.sequence));
      check(["on-ball", "off-ball"].includes(route.scope as string) && ["main", "adjustment"].includes(route.importance as string));
      check(point(route.start) && point(route.end) && (route.control === undefined || point(route.control)) && (route.via === undefined || point(route.via)));
      if (route.points !== undefined) { check(Array.isArray(route.points)); for (const p of route.points) check(point(p)); }
    }
    if (value.execution !== undefined) {
      check(Array.isArray(value.execution));
      for (const action of value.execution) {
        check(record(action) && text(action.actionId) && identity(action.sequence) && phases.has(action.phase as string));
        check(participant(action.actorId) && participant(action.recipientId) && participant(action.partnerId));
        check((action.startedAtMs === null || clock(action.startedAtMs)) && (action.completedAtMs === null || clock(action.completedAtMs)));
        check((action.setAtMs === undefined || clock(action.setAtMs)) && (action.usedAtMs === undefined || clock(action.usedAtMs))
          && (action.releasedAtMs === undefined || clock(action.releasedAtMs)));
        check(finite(action.progress) && (action.notice === null || typeof action.notice === "string"));
      }
    }
  }
  return frames;
}
