import { validatePlaybookDocument } from "./documentValidation.ts";
import { validateSettings, DEFENSE_SCHEME_LABELS, type SimulationFrame } from "./simulation.ts";
import { getSimulationSessionInfo } from "./simulationSession.ts";
import { SIMULATION_ENGINE_VERSION } from "./simulationVersion.ts";
import { BALL_PHASES } from "./ballState.ts";
import { freezeShotRelease, validateShotRelease } from "./shotReleaseContext.ts";
import type { CourtPoint, PlaybookDraft, SimulationSettings } from "./types.ts";

export type SimulationSessionInfo = NonNullable<ReturnType<typeof getSimulationSessionInfo>>;
export type SimulationView = { frame: SimulationFrame; settings: SimulationSettings; durationMs: number; session: SimulationSessionInfo; playing: boolean };
export type SimulationRelocation = { type: "player" | "defender" | "ball"; id: number | string; point: CourtPoint };
type Envelope = { sessionId: string; revision: number; requestId: number };
export type SimulationCommand = Envelope & (
  | { type: "start"; drawing: PlaybookDraft; settings: SimulationSettings; seed?: number }
  | { type: "playback"; playing: boolean }
  | { type: "settings"; settings: SimulationSettings }
  | { type: "edit"; drawing: PlaybookDraft; relocation?: SimulationRelocation }
  | { type: "seek"; timeMs: number }
  | { type: "frame"; deltaMs: number }
);
export type SimulationResponse = Envelope & (
  | { type: "state"; view: SimulationView }
  | { type: "error"; message: string }
);

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clock = (v: unknown): v is number => finite(v) && v >= 0;
const identity = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const point = (v: unknown) => record(v) && finite(v.x) && finite(v.y);
function check(valid: unknown, field: string): asserts valid { if (!valid) throw new Error(`Invalid Playbook worker message: ${field}`); }
function envelope(value: unknown): asserts value is Record<string, unknown> & Envelope {
  check(record(value), "expected an object");
  check(text(value.sessionId) && identity(value.requestId) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0, "session, revision or request identity");
}
function drawing(value: unknown) {
  validatePlaybookDocument(value);
  check(record(value) && value.version === 1 && text(value.id) && Array.isArray(value.players) && Array.isArray(value.defenders) && Array.isArray(value.arrows), "complete drawing required");
}
export function parseSimulationCommand(value: unknown): SimulationCommand {
  envelope(value);
  switch (value.type) {
    case "start":
      drawing(value.drawing); validateSettings(value.settings);
      check(value.seed === undefined || Number.isInteger(value.seed) && (value.seed as number) >= 0 && (value.seed as number) <= 0xffffffff, "seed"); break;
    case "playback": check(typeof value.playing === "boolean", "playing"); break;
    case "settings": validateSettings(value.settings); break;
    case "edit": {
      drawing(value.drawing);
      const r = value.relocation;
      if (r !== undefined) check(record(r) && ["player", "defender", "ball"].includes(r.type as string) && (r.type === "ball" ? r.id === "ball" : identity(r.id)) && point(r.point), "marker relocation");
      break;
    }
    case "seek": check(clock(value.timeMs), "seek time"); break;
    case "frame": check(clock(value.deltaMs) && value.deltaMs <= 50, "bounded elapsed time"); break;
    default: throw new Error("Invalid Playbook worker message: unknown command");
  }
  return value as SimulationCommand;
}

/** Only validated display snapshots enter React; executable state stays private
 * to the worker. Validation does not normalize or alter engine output. */
export function parseSimulationResponse(value: unknown): SimulationResponse {
  envelope(value);
  if (value.type === "error") { check(text(value.message), "error message"); return value as SimulationResponse; }
  check(value.type === "state" && record(value.view), "response kind");
  const v = value.view;
  check(clock(v.durationMs) && typeof v.playing === "boolean", "playback state"); validateSettings(v.settings);
  const s = v.session;
  check(record(s) && s.engineVersion === SIMULATION_ENGINE_VERSION && Number.isInteger(s.seed) && (s.seed as number) >= 0 && (s.seed as number) <= 0xffffffff, "session version/seed");
  check(typeof s.resolvedDefenseScheme === "string" && Object.hasOwn(DEFENSE_SCHEME_LABELS, s.resolvedDefenseScheme), "resolved defense");
  for (const key of ["positionMs", "recordedUntilMs", "checkpointCount", "checkpointBytes", "eventCount"]) check(clock(s[key]), `session ${key}`);
  check((s.positionMs as number) <= (s.recordedUntilMs as number) + 1e-6, "session clock");
  const f = v.frame;
  check(record(f) && Array.isArray(f.players) && Array.isArray(f.defenders), "frame rosters");
  for (const roster of [f.players, f.defenders]) {
    check(roster.length <= 5, "roster size"); const ids = new Set();
    for (const m of roster) { check(record(m) && identity(m.id) && point(m) && !ids.has(m.id), "frame marker"); ids.add(m.id); }
  }
  const players = f.players;
  const player = (id: unknown) => id === null || players.some((p: { id: number }) => p.id === id);
  check(player(f.ballHandlerId) && player(f.shooterId), "frame possession");
  check(BALL_PHASES.includes(f.ballPhase as typeof BALL_PHASES[number]), "ball phase");
  for (const key of ["ball", "shotStart", "shotTarget"]) check(f[key] === null || point(f[key]), key);
  for (const key of ["defensiveQuality", "offBallQuality", "shotProgress", "shotQuality"]) check(finite(f[key]), key);
  if (f.shotRelease !== null) {
    validateShotRelease(f.shotRelease);
    check(f.shotRelease.quality === f.shotQuality && f.shotRelease.shooter.id === f.shooterId
      && f.shotRelease.atMs <= (s.positionMs as number) + 1e-6 && ["air", "result"].includes(f.shotPhase as string), "released evaluation");
    freezeShotRelease(f.shotRelease);
  } else check(f.shotPhase !== "air" && f.shotPhase !== "result", "missing released evaluation");
  for (const key of ["activeActionLabel", "adaptiveReadLabel", "adaptiveReadReason", "defenseSchemeNotice"]) check(f[key] === null || typeof f[key] === "string", key);
  check(f.activeSequence === null || identity(f.activeSequence), "active sequence");
  check(f.activeDefenseScheme === null || typeof f.activeDefenseScheme === "string" && Object.hasOwn(DEFENSE_SCHEME_LABELS, f.activeDefenseScheme), "frame defense");
  check(typeof f.defenseSchemeWasAutomatic === "boolean" && ["idle", "setup", "air", "result"].includes(f.shotPhase as string) && ["pending", "made", "missed"].includes(f.shotResult as string), "shot state");
  if (f.adaptiveReadRoute !== null) check(record(f.adaptiveReadRoute) && point(f.adaptiveReadRoute.start) && point(f.adaptiveReadRoute.end) && ["movement", "pass"].includes(f.adaptiveReadRoute.kind as string), "adaptive route");
  check(Array.isArray(f.routes), "routes");
  for (const r of f.routes) {
    check(record(r) && text(r.id) && player(r.playerId) && r.playerId !== null && text(r.kind) && (r.actionId === null || text(r.actionId)) && (r.sequence === null || identity(r.sequence)), "route identity");
    check(["on-ball", "off-ball"].includes(r.scope as string) && ["main", "adjustment"].includes(r.importance as string), "route classification");
    check(point(r.start) && point(r.end) && (r.control === undefined || point(r.control)) && (r.via === undefined || point(r.via)), "route geometry");
    if (r.points !== undefined) check(Array.isArray(r.points) && r.points.every(point), "route points");
  }
  check(Array.isArray(f.execution), "execution");
  for (const a of f.execution) {
    check(record(a) && text(a.actionId) && identity(a.sequence) && ["pending", "approach", "set", "use", "release", "transfer", "completed", "obstructed", "conflict", "interrupted"].includes(a.phase as string), "action identity/phase");
    check(player(a.actorId) && player(a.recipientId) && player(a.partnerId) && finite(a.progress), "action participants/progress");
    for (const key of ["startedAtMs", "completedAtMs"]) check(a[key] === null || clock(a[key]), "action time");
    check(a.notice === null || typeof a.notice === "string", "action notice");
  }
  return value as SimulationResponse;
}
