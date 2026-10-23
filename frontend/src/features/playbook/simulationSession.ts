import { advanceSimulationState, cloneSimulationExecution, createSimulationRun, editPausedSimulationMarker, getSimulationFrame, rebasePausedSimulation, restoreSimulationExecution, setSimulationRunSettings, type SimulationRun } from "./simulation.ts";
import { validatePlaybookDocument } from "./documentValidation.ts";
import { SIMULATION_ENGINE_VERSION } from "./simulationVersion.ts";
import type { CourtPoint, PlaybookDraft, ReadCoachSessionEvent, ReadCoachSessionRecord, SimulationSettings } from "./types.ts";

const CHECKPOINT_INTERVAL_MS = 500;
export const MAX_SIMULATION_CHECKPOINTS = 24;
export const MAX_SIMULATION_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const EPSILON = 1e-7;
type Relocation = { type: "player" | "defender" | "ball"; id: number | string; point: CourtPoint };
type EventTime = { atMs: number; elapsedMs: number; accumulatorMs: number };
export type SimulationSessionEvent = ReadCoachSessionEvent;
export type SimulationSessionRecord = ReadCoachSessionRecord;
type Checkpoint = { cursor: number; atMs: number; bytes: number; state: SimulationRun };
type Session = { record: SimulationSessionRecord; endMs: number; checkpoints: Checkpoint[]; bytes: number; eventCount: number; playbackBase?: Checkpoint };
// Execution snapshots stay outside the run, so cloning a checkpoint never
// recursively copies the session or makes Counter Lab retain playback history.
const sessions = new WeakMap<SimulationRun, Session>();
const clock = (run: SimulationRun) => run.elapsedMs + run.accumulatorMs;
const eventTime = (run: SimulationRun): EventTime => ({ atMs: clock(run), elapsedMs: run.elapsedMs, accumulatorMs: run.accumulatorMs });

export function simulationSeed(seed = Math.floor(Math.random() * 0x100000000)) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError("Choose a valid unsigned 32-bit simulation seed");
  return seed;
}

export function seededSimulationRandom(seed: number) {
  let value = simulationSeed(seed);
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let result = Math.imul(value ^ value >>> 15, 1 | value);
    result ^= result + Math.imul(result ^ result >>> 7, 61 | result);
    return ((result ^ result >>> 14) >>> 0) / 0x100000000;
  };
}

// Count the whole object graph once, including Maps/Sets and typed buffers.
// Shared transfer records and actionGraph aliases count once, as in the clone.
function retainedBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return value.length * 2 + 16;
  if (value == null || typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return value.byteLength + 64;
  if (value instanceof ArrayBuffer) return value.byteLength + 64;
  if (value instanceof Map) return 64 + [...value].reduce((total, [key, item]) => total + 32 + retainedBytes(key, seen) + retainedBytes(item, seen), 0);
  if (value instanceof Set) return 64 + [...value].reduce((total, item) => total + 16 + retainedBytes(item, seen), 0);
  return 64 + Object.entries(Object.getOwnPropertyDescriptors(value)).reduce((total, [key, descriptor]) => total + key.length * 2 + ("value" in descriptor ? retainedBytes(descriptor.value, seen) : 0), 0);
}

function fitCheckpointBudget(session: Session, bytes: number, extraCount: number) {
  while (session.checkpoints.length > 1 && (session.checkpoints.length + extraCount > MAX_SIMULATION_CHECKPOINTS || session.bytes + bytes > MAX_SIMULATION_CHECKPOINT_BYTES)) {
    session.bytes -= session.checkpoints.splice(1, 1)[0].bytes;
  }
  return session.checkpoints.length + extraCount <= MAX_SIMULATION_CHECKPOINTS && session.bytes + bytes <= MAX_SIMULATION_CHECKPOINT_BYTES;
}

function checkpoint(run: SimulationRun, session: Session, force = false) {
  const last = session.checkpoints.at(-1);
  if (last?.cursor === session.record.events.length || !force && last && clock(run) - last.atMs < CHECKPOINT_INTERVAL_MS) return;
  const state = cloneSimulationExecution(run), bytes = retainedBytes(state);
  // The initial checkpoint is always retained. Large drawings can use fewer
  // checkpoints; they can still reconstruct from the initial drawing and log.
  if (bytes > MAX_SIMULATION_CHECKPOINT_BYTES) return;
  if (!fitCheckpointBudget(session, bytes, 1)) return;
  session.checkpoints.push({ cursor: session.record.events.length, atMs: clock(run), bytes, state });
  session.bytes += bytes;
}

export function beginSimulationSession(run: SimulationRun, hoop: CourtPoint, seed: number) {
  const session: Session = { record: { version: 1, engineVersion: SIMULATION_ENGINE_VERSION, seed,
    initialDrawing: structuredClone(run.source), initialSettings: structuredClone(run.settings),
    resolvedDefenseScheme: run.activeDefenseScheme, hoop: { ...hoop }, positionMs: 0, events: [] }, endMs: 0, checkpoints: [], bytes: 0, eventCount: 0 };
  checkpoint(run, session, true);
  sessions.set(run, session);
}

export function assertSimulationSessionHoop(run: SimulationRun, hoop: CourtPoint) {
  const session = sessions.get(run);
  if (session && (hoop.x !== session.record.hoop.x || hoop.y !== session.record.hoop.y)) throw new Error("Keep the recorded session's hoop fixed. Start a new session to change courts");
}

/** Editing after seeking creates a new future. Seeking alone preserves it. */
function truncateFuture(session: Session, run: SimulationRun) {
  const time = session.record.positionMs;
  if (time >= session.endMs - EPSILON) return;
  const retained: SimulationSessionEvent[] = [];
  for (const event of session.record.events) {
    if (event.atMs > time + EPSILON) break;
    if (event.kind === "advance" && event.endMs > time + EPSILON) {
      if (time > event.atMs + EPSILON) retained.push({ ...event, deltaMs: time - event.atMs, endMs: time, elapsedMs: run.elapsedMs, accumulatorMs: run.accumulatorMs });
      break;
    }
    retained.push(event);
  }
  session.record.events = retained;
  session.eventCount = retained.filter(event => event.kind !== "advance").length;
  session.endMs = time;
  session.checkpoints = session.checkpoints.filter(item => item.cursor <= retained.length && item.atMs <= time + EPSILON);
  session.bytes = session.checkpoints.reduce((total, item) => total + item.bytes, 0);
  session.playbackBase = undefined;
}

export function recordSimulationSettings(run: SimulationRun) {
  const session = sessions.get(run);
  if (!session) return;
  truncateFuture(session, run);
  session.record.events.push({ ...eventTime(run), kind: "settings", settings: structuredClone(run.settings) });
  session.eventCount++;
  session.playbackBase = undefined;
  checkpoint(run, session, true);
}

export function recordSimulationEdit(run: SimulationRun, relocation?: Relocation) {
  const session = sessions.get(run);
  if (!session) return;
  truncateFuture(session, run);
  session.record.events.push({ ...eventTime(run), kind: "edit", drawing: structuredClone(run.source), ...(relocation ? { relocation: structuredClone(relocation) } : {}) });
  session.eventCount++;
  session.playbackBase = undefined;
  checkpoint(run, session, true);
}

export function recordSimulationAdvance(run: SimulationRun, deltaMs: number) {
  const session = sessions.get(run);
  if (!session) return;
  const atMs = session.record.positionMs, endMs = clock(run);
  if (endMs <= atMs) return;
  // Preserve the accepted call boundaries, not only their sum: regrouping
  // fractional deltas can change floating-point accumulator bits on recovery.
  session.record.events.push({ kind: "advance", atMs, elapsedMs: run.elapsedMs, accumulatorMs: run.accumulatorMs, deltaMs, endMs });
  session.record.positionMs = session.endMs = endMs;
  session.playbackBase = undefined;
  checkpoint(run, session);
}

function applyEvent(run: SimulationRun, event: SimulationSessionEvent, hoop: CourtPoint) {
  if (event.kind === "advance") advanceSimulationState(run, event.deltaMs, run.settings, hoop);
  else if (event.kind === "settings") setSimulationRunSettings(run, event.settings);
  else if (event.relocation) editPausedSimulationMarker(run, event.relocation.type, event.relocation.id, event.relocation.point, event.drawing);
  else if (!rebasePausedSimulation(run, event.drawing, hoop)) throw new Error("The recorded edit changes the session's actions or participants");
}

export function getSimulationSessionInfo(run: SimulationRun) {
  const session = sessions.get(run);
  return session ? { engineVersion: session.record.engineVersion, seed: session.record.seed,
    resolvedDefenseScheme: session.record.resolvedDefenseScheme, positionMs: session.record.positionMs,
    recordedUntilMs: session.endMs, checkpointCount: session.checkpoints.length + (session.playbackBase ? 1 : 0), checkpointBytes: session.bytes + (session.playbackBase?.bytes ?? 0),
    eventCount: session.eventCount } : null;
}

/** The record is independent, JSON-compatible, and contains no live run data. */
export function captureSimulationSession(run: SimulationRun): SimulationSessionRecord {
  const session = sessions.get(run);
  if (!session) throw new Error("This simulation was not started as a recorded session");
  return structuredClone(session.record);
}

/** Capture only the recorded history through the current playhead. Read Coach
 * snapshots must not contain future events, while ordinary session exports
 * retain the complete journal for deterministic seeking. */
export function captureSimulationSessionPrefix(run: SimulationRun): SimulationSessionRecord {
  const session = sessions.get(run);
  if (!session) throw new Error("This simulation was not started as a recorded session");
  const record = structuredClone(session.record);
  const position = session.record.positionMs;
  const events: SimulationSessionEvent[] = [];
  for (const event of record.events) {
    if (event.atMs > position + EPSILON) break;
    if (event.kind === "advance" && event.endMs > position + EPSILON) {
      if (position > event.atMs + EPSILON) events.push({ ...event, deltaMs: position - event.atMs,
        endMs: position, elapsedMs: run.elapsedMs, accumulatorMs: run.accumulatorMs });
      break;
    }
    events.push(event);
  }
  record.events = events;
  return record;
}

export function seekSimulationSession(run: SimulationRun, timeMs: number) {
  const session = sessions.get(run);
  if (!session) throw new Error("This simulation was not started as a recorded session");
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > session.endMs + EPSILON) throw new RangeError("Seek within the recorded simulation");
  const time = Math.min(timeMs, session.endMs);
  let start: Checkpoint | undefined;
  for (const item of session.checkpoints) if (item.atMs <= time + EPSILON) start = item;
  if (session.playbackBase && session.playbackBase.atMs <= time + EPSILON && (!start || session.playbackBase.cursor > start.cursor)) start = session.playbackBase;
  const candidate = start ? cloneSimulationExecution(start.state)
    : createSimulationRun(session.record.initialDrawing, session.record.initialSettings, session.record.hoop, { seed: session.record.seed });
  let cursor = start?.cursor ?? 0;
  let base: SimulationRun | undefined;
  for (; cursor < session.record.events.length; cursor++) {
    const index = cursor;
    const event = session.record.events[index];
    if (event.atMs > time + EPSILON) break;
    if (event.kind === "advance" && event.endMs > time + EPSILON) {
      base = cloneSimulationExecution(candidate);
      if (time > event.atMs) advanceSimulationState(candidate, time - event.atMs, candidate.settings, session.record.hoop);
      break;
    }
    applyEvent(candidate, event, session.record.hoop);
  }
  // Prepare/validate before touching the live run, so a failed recovery keeps
  // the previous court, journal, and selected play intact.
  const frame = getSimulationFrame(candidate);
  restoreSimulationExecution(run, candidate);
  session.record.positionMs = clock(candidate);
  // Keep one canonical call boundary near the playhead. Forward playback then
  // replays only new calls, rather than resimulating half a second every RAF.
  const state = base ?? cloneSimulationExecution(candidate), bytes = retainedBytes(state);
  session.playbackBase = fitCheckpointBudget(session, bytes, 1) ? { cursor, atMs: clock(state), bytes, state } : undefined;
  return frame;
}

/** Historical playback reapplies the journal instead of today's control values. */
export function advanceRecordedSimulation(run: SimulationRun, deltaMs: number): boolean {
  const session = sessions.get(run);
  if (!session || session.record.positionMs >= session.endMs - EPSILON) return false;
  const target = session.record.positionMs + deltaMs;
  seekSimulationSession(run, Math.min(target, session.endMs));
  if (target > session.endMs + EPSILON) advanceSimulationState(run, target - session.endMs, run.settings, session.record.hoop);
  return true;
}

/** Rebuild checkpoints from a versioned record; no random defense is redrawn. */
export function restoreSimulationSession(input: SimulationSessionRecord): SimulationRun {
  const record = structuredClone(input);
  if (!record || record.version !== 1 || record.engineVersion !== SIMULATION_ENGINE_VERSION) throw new Error("This simulation session requires the same engine version");
  simulationSeed(record.seed);
  validatePlaybookDocument(record.initialDrawing);
  if (!record.hoop || !Number.isFinite(record.hoop.x) || !Number.isFinite(record.hoop.y)
    || !Array.isArray(record.events) || record.events.length > 200000) throw new Error("Invalid simulation session record");
  const run = createSimulationRun(record.initialDrawing, record.initialSettings, record.hoop, { recordSession: true, seed: record.seed });
  if (run.activeDefenseScheme !== record.resolvedDefenseScheme) throw new Error("The recorded defensive scheme does not match this session");
  for (const event of record.events) {
    if (!event || !["advance", "settings", "edit"].includes(event.kind)
      || !Number.isFinite(event.atMs) || Math.abs(event.atMs - clock(run)) > EPSILON
      || !Number.isFinite(event.elapsedMs) || !Number.isFinite(event.accumulatorMs)
      || event.kind === "advance" && (!Number.isFinite(event.deltaMs) || event.deltaMs <= 0 || event.deltaMs > 50 || !Number.isFinite(event.endMs) || event.endMs <= event.atMs)) throw new Error("Invalid simulation session event");
    applyEvent(run, event, record.hoop);
    if (Math.abs(run.elapsedMs - event.elapsedMs) > EPSILON || Math.abs(run.accumulatorMs - event.accumulatorMs) > EPSILON
      || event.kind === "advance" && Math.abs(clock(run) - event.endMs) > EPSILON) throw new Error("The simulation session diverged from its recorded execution");
  }
  seekSimulationSession(run, record.positionMs);
  return run;
}
