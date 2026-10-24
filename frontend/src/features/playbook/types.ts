import type { CourtRoute } from "./arrowVisibility";

export type PlaybookTool = "select" | "player" | "ball" | "movement" | "pass" | "screen" | "slip-screen" | "handoff" | "pick-roll" | "pick-pop" | "off-ball-screen" | "pin-down" | "backdoor-cut" | "spacing-gate" | "delete";
export type ArrowKind = "movement" | "pass" | "screen" | "slip-screen" | "handoff" | "pick-roll" | "pick-pop" | "off-ball-screen" | "pin-down" | "backdoor-cut";
export type ArrowPath = "straight" | "curve";
export type OffenseOffBallStyle = "off" | "spacing" | "cuts" | "read-react";
export type DefenseStrategy = "off" | "contain" | "help" | "switch" | "trap-rotate" | "fight-over" | "go-under" | "drop" | "hedge" | "deny-lanes" | "protect-paint";
export type DefenseScheme = "auto" | "man-to-man" | "pack-line" | "zone-2-3" | "zone-3-2" | "zone-1-3-1" | "zone-2-1-2" | "zone-1-2-2" | "matchup-1-1-3" | "box-and-one" | "triangle-and-two";

export interface AutomaticActionSettings {
  screen: boolean;
  handoff: boolean;
  pickRoll: boolean;
  offBallScreen: boolean;
}

export interface SimulationSettings {
  offenseOffBall: OffenseOffBallStyle;
  defenseScheme: DefenseScheme;
  defenseStrategy: DefenseStrategy;
  offBallIntensity: number;
  automaticActions: AutomaticActionSettings;
  /** Keep the authored sequence intact for Counter Lab's controlled trials. */
  offenseMode?: "adaptive" | "scripted";
}

export const DEFAULT_SIMULATION_SETTINGS: SimulationSettings = {
  offenseOffBall: "read-react",
  defenseScheme: "auto",
  defenseStrategy: "help",
  offBallIntensity: 70,
  automaticActions: { screen: true, handoff: true, pickRoll: true, offBallScreen: true },
};

export interface CourtPoint {
  x: number;
  y: number;
}

export interface PlayerSkillRatings {
  threePoint: number;
  midrange: number;
  finishing: number;
}

export type OffensiveBadge =
  | "playmaker"
  | "off-dribble-creator"
  | "deep-range"
  | "catch-and-shoot"
  | "slasher"
  | "rim-finisher"
  | "cutter"
  | "screen-setter"
  | "roll-threat"
  | "post-scorer";

export type DefensiveBadge = "lockdown" | "paint-protector" | "helper";
export type PlayerBadge = OffensiveBadge | DefensiveBadge;

export interface PlaybookMarker extends CourtPoint {
  id: number;
  /** Optional on legacy version 1 plays; normalized to 3 when loaded. */
  ratings?: PlayerSkillRatings;
  /** Optional on legacy version 1 plays; normalized to an empty list when loaded. */
  badges?: PlayerBadge[];
}

export type PlaybookTimingWait = {
  id: string;
  actionId: string;
  event: "start" | "complete" | "catch" | "screen-set" | "screen-use" | "route-point";
  playerId?: number;
  routePhase?: "main" | "approach" | "use" | "release";
  routeSegment?: number;
  progress?: number;
};

export interface PlaybookActionTiming {
  /** Earliest authored start, in milliseconds from the beginning of the play */
  startAtMs: number;
  /** Actions sharing this identity begin atomically when all are ready */
  syncId?: string;
  /** Every listed event must occur before this action can begin */
  waits?: PlaybookTimingWait[];
}

export interface PlaybookArrow {
  id: string;
  kind: ArrowKind;
  start: CourtPoint;
  end: CourtPoint;
  /** 1-based order in which this action happens during a simulation. */
  sequence?: number;
  /** How the actor travels between the endpoints in the simulation. */
  path?: ArrowPath;
  /** Optional quadratic control point for a curved route. */
  control?: CourtPoint;
  /** Time in seconds reserved for this action. */
  timing?: number;
  /** Optional timing-mixer schedule. Absent on untouched legacy plays. */
  timingPlan?: PlaybookActionTiming;
  /** Player who sets an off-ball screen. */
  screener_id?: number;
  /** Player who uses an off-ball screen. */
  cutter_id?: number;
  /** Ball handler for a named on-ball screen. */
  handler_id?: number;
  /** Explicit actor for movement, cuts, or a transfer. Optional on legacy plays. */
  actor_id?: number;
  /** Explicit receiver for a pass or handoff. */
  recipient_id?: number;
  /** Destination after a pick-and-pop or pin-down screen. */
  exit_target?: CourtPoint;
}


export interface PlaybookBranch {
  id: string;
  label: string;
  /** Stable Main action identities for the simultaneous group before which this ending forks */
  fork: { actionIds: string[]; sequence: number };
  /** Copied continuation beginning with the fork group */
  continuation: PlaybookArrow[];
}

export type ReadCoachEventTime = { atMs: number; elapsedMs: number; accumulatorMs: number };
export type ReadCoachSessionEvent = ReadCoachEventTime & (
  { kind: "advance"; deltaMs: number; endMs: number }
  | { kind: "settings"; settings: SimulationSettings }
  | { kind: "edit"; drawing: PlaybookDraft; relocation?: { type: "player" | "defender" | "ball"; id: number | string; point: CourtPoint } }
);
export type ReadCoachSessionRecord = {
  version: 1;
  engineVersion: number;
  seed: number;
  initialDrawing: PlaybookDraft;
  initialSettings: SimulationSettings;
  resolvedDefenseScheme: Exclude<DefenseScheme, "auto">;
  hoop: CourtPoint;
  positionMs: number;
  events: ReadCoachSessionEvent[];
};
export type ReadCoachChoice = { id: string; label: string; arrows: PlaybookArrow[] };
export type ReadCoachCourtSnapshot = { players: PlaybookMarker[]; defenders: PlaybookMarker[]; ball: CourtPoint | null; ballHandlerId: number | null; atMs: number };
export type ReadCoachCheckpoint = {
  id: string;
  question: string;
  session: ReadCoachSessionRecord;
  snapshot: ReadCoachCourtSnapshot;
  choices: ReadCoachChoice[];
  correctChoiceId: string;
  explanation: string;
};
export type ReadCoachLesson = { version: 1; checkpoints: ReadCoachCheckpoint[] };

export type RoleCuePhase = "hold" | "perform" | "receive" | "screen" | "screen-use" | "roll" | "pop" | "cut" | "pass" | "handoff" | "move" | "wait";
export type RoleCueOverride = { playerId: number; actionId: string; phase: RoleCuePhase; scope: "shared" | "ending"; branchId?: string; text: string; signature: string };
export type RoleCueLesson = { version: 1; cues: RoleCueOverride[] };

export type SpacingGateEvent = "start" | "complete" | "catch" | "screen-set" | "screen-use" | "route-point";
export type SpacingGateTrigger = {
  actionId: string;
  event: SpacingGateEvent;
  routePlayerId?: number;
  routePhase?: "main" | "approach" | "use" | "release";
  routeSegment?: number;
  progress?: number;
};
export type SpacingGate = {
  id: string;
  playerId: number;
  area: { shape: "circle"; center: CourtPoint; radiusFeet: number }
    | { shape: "rectangle"; center: CourtPoint; widthFeet: number; heightFeet: number };
  rule: "inside" | "outside";
  trigger: SpacingGateTrigger;
  beforeSeconds: number;
  afterSeconds: number;
  instruction?: string;
  scope: "shared" | "ending";
  branchId?: string;
};
export type SpacingGateLesson = { version: 1; gates: SpacingGate[] };

export type PlayFlipbookSnapshot = {
  atMs: number;
  players: Array<Pick<PlaybookMarker, "id" | "x" | "y">>;
  defenders: Array<Pick<PlaybookMarker, "id" | "x" | "y">>;
  ball: CourtPoint | null;
  ballHandlerId: number | null;
  ballPhase: "held" | "pass-in-flight" | "handoff-pending" | "loose" | "shot-setup" | "shot-in-flight" | "shot-result";
  shotPhase: "idle" | "setup" | "air" | "result";
  routes: CourtRoute[];
};
export type FlipbookAnnotationKind = "circle" | "spotlight" | "callout" | "attention-line" | "freehand" | "text";
export type FlipbookAnnotation = {
  id: string;
  kind: FlipbookAnnotationKind;
  /** Court-relative points; circle and spotlight use the first two points as their bounds. */
  points: CourtPoint[];
  text?: string;
  number?: number;
};
export type FlipbookAnnotationStep = { id: string; label: string; marks: FlipbookAnnotation[] };
export type FlipbookChalkTalk = { version: 1; steps: FlipbookAnnotationStep[] };
export type PlayFlipbookPanel = {
  id: string;
  atMs: number;
  caption: string;
  focusPlayerIds: number[];
  routeIds: string[];
  snapshot: PlayFlipbookSnapshot;
  /** Frozen teaching marks, independent from executable routes and action data. */
  chalkTalk?: FlipbookChalkTalk;
};
export type PlayFlipbookStory = {
  id: string;
  playName: string;
  endingId: string | null;
  endingLabel: string;
  recording: ReadCoachSessionRecord;
  panels: PlayFlipbookPanel[];
};
export type PlayFlipbookLesson = { version: 1; stories: PlayFlipbookStory[] };
export type BaitPayoffEvent = SpacingGateEvent;
export type BaitPayoffCheckpoint = {
  actionId: string;
  event: BaitPayoffEvent;
  routePlayerId?: number;
  routePhase?: "main" | "approach" | "use" | "release";
  routeSegment?: number;
  progress?: number;
};
export type BaitPayoffArea = { shape: "circle"; center: CourtPoint; radiusFeet: number }
  | { shape: "rectangle"; center: CourtPoint; widthFeet: number; heightFeet: number };
export type BaitPayoffReaction = {
  defenderId: number;
  area: BaitPayoffArea;
  direction: "enter" | "leave";
  checkpoint: BaitPayoffCheckpoint;
};
export type BaitPayoffConnection = {
  id: string;
  baitActionId: string;
  payoffActionId: string;
  title: string;
  explanation: string;
  scope: "shared" | "ending";
  branchId?: string;
  baitSignature: string;
  payoffSignature: string;
  reaction?: BaitPayoffReaction;
};
export type BaitPayoffLesson = { version: 1; connections: BaitPayoffConnection[] };
export type SpacingGateResult = {
  gateId: string;
  status: "pending" | "checking" | "met" | "missed" | "not-evaluated";
  triggerAtMs: number | null;
  checkedAtMs: number | null;
  firstViolationAtMs: number | null;
  actualPoint: CourtPoint | null;
  reason: string | null;
};

export interface PlaybookDocument {
  version: 1;
  /** Opaque save precondition; absent only on legacy version-1 documents. */
  revision?: string;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  defenders_visible: boolean;
  players: PlaybookMarker[];
  defenders: PlaybookMarker[];
  ball: CourtPoint | null;
  arrows: PlaybookArrow[];
  /** Optional version-1 extension; absent on older unbranched plays */
  branches?: PlaybookBranch[];
  /** Optional version-1 extension containing independent, frozen read lessons */
  readCoach?: ReadCoachLesson;
  /** Optional version-1 extension for authored My Role cue wording */
  roleCues?: RoleCueLesson;
  /** Optional version-1 extension for authored spacing expectations */
  spacingGates?: SpacingGateLesson;
  /** Optional version-1 extension containing frozen, panel-by-panel walkthroughs */
  flipbooks?: PlayFlipbookLesson;
  /** Optional version-1 extension for author-defined decoy and payoff links */
  baitPayoffs?: BaitPayoffLesson;
}

export type PlaybookDraft = Omit<PlaybookDocument, "id" | "created_at" | "updated_at"> & {
  id: string;
  created_at?: string;
  updated_at?: string;
};

export { COURT_HEIGHT, COURT_WIDTH } from "./courtGeometry.ts";
import { COURT_HEIGHT, COURT_WIDTH } from "./courtGeometry.ts";

export function clonePlaybook(playbook: PlaybookDocument | PlaybookDraft): PlaybookDraft {
  return structuredClone(playbook);
}

export function pointDistance(a: CourtPoint, b: CourtPoint) {
  return Math.hypot(a.x - b.x, ((a.y - b.y) * COURT_HEIGHT) / COURT_WIDTH);
}

/** Shared validation for optional participant identities in version-1 plays. */
export function validatePlaybookParticipants(play: PlaybookDraft) {
  const ids = new Set(play.players.map((player) => player.id));
  for (const arrow of play.arrows) {
    for (const id of [arrow.actor_id, arrow.recipient_id, arrow.screener_id, arrow.handler_id, arrow.cutter_id]) {
      if (id != null && (!Number.isInteger(id) || !ids.has(id))) throw new Error("Action participants must be offensive players on this court");
    }
    if (arrow.recipient_id != null && (arrow.kind !== "pass" && arrow.kind !== "handoff" || arrow.recipient_id === arrow.actor_id)) throw new Error("Passes and handoffs need distinct participants");
  }
}
