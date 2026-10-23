import { validatePlaybookDocument } from "./documentValidation.ts";
import { freezeShotRelease, validateShotRelease, type ShotReleaseContext, type ShotMotionEvidence, type ShotCatchEvidence } from "./shotReleaseContext.ts";
import { compileActionDependencies, type PlannedAction } from "./actionDependencies.ts";
import { ballController, isShotBall, isTransferBall, placedBall, transitionBall, caughtAt, failedTransfer, copyTransfer, type BallPhase, type BallState, type TransferRecord } from "./ballState.ts";
import { coordinateDefensiveDuties, createDefensiveTeamState, defensiveDutySnapshot, resetDefensiveDuties, type DefensiveResponsibility, type DefensiveTeamState } from "./defensiveResponsibilities.ts";
import { linearRoutePoint as lerpPoint, quadraticRoutePoint as quadraticPoint, perpendicularRouteControl } from "./routeGeometry.ts";
import { coordinateMovement, createMovementBuffers, createMovementOrder, interpolatePosition, type MotionIntent, type MovementBuffers, type MovementOrder } from "./coordinatedMovement.ts";
import { clearCongestionState } from "./congestionPlanning.ts";
import { beginSimulationSession, simulationSeed, seededSimulationRandom, assertSimulationSessionHoop, recordSimulationSettings, recordSimulationEdit, recordSimulationAdvance, advanceRecordedSimulation } from "./simulationSession.ts";
import type { CourtRoute } from "./arrowVisibility";
import type { CourtPoint, DefenseScheme, DefensiveBadge, OffensiveBadge, PlayerSkillRatings, PlaybookArrow, PlaybookDraft, PlaybookMarker, SimulationSettings } from "./types.ts";
import { createSimulationAttributes, refreshSimulationAttributes, preparedPlayerRating as playerRating, preparedHasBadge as playerHasBadge, preparedHasBadge as defenderHasBadge, type SimulationAttributes } from "./simulationAttributes.ts";
import {
  COURT_SCALE,
  COURT_VIEWBOX,
  NBA_COURT_GEOMETRY,
  courtPointToSvg,
  courtSvgToPoint,
} from "./courtGeometry.ts";

export type SimulationFrame = {
  defensiveResponsibilities?: DefensiveResponsibility[];
  execution?: ActionDiagnostic[];
  ballHandlerId?: number | null;
  ballPhase?: BallPhase;
  routes: CourtRoute[];
  players: PlaybookMarker[];
  defenders: PlaybookMarker[];
  ball: CourtPoint | null;
  activeSequence: number | null;
  activeActionLabel: string | null;
  adaptiveReadLabel: string | null;
  adaptiveReadReason: string | null;
  adaptiveReadRoute: { start: CourtPoint; end: CourtPoint; kind: "movement" | "pass" } | null;
  activeDefenseScheme: Exclude<DefenseScheme, "auto"> | null;
  defenseSchemeWasAutomatic: boolean;
  defenseSchemeNotice: string | null;
  defensiveQuality: number;
  offBallQuality: number;
  shotPhase: "idle" | "setup" | "air" | "result";
  shotProgress: number;
  shotResult: "pending" | "made" | "missed";
  shotQuality: number;
  shotRelease: ShotReleaseContext | null;
  shooterId: number | null;
  shotStart: CourtPoint | null;
  shotTarget: CourtPoint | null;
};

export type ActionDiagnostic = {
  congestion?: { status: "yielding" | "detouring" | "blocked"; playerId: number; blockers: string[]; sinceMs: number; reason: string };
  transfer?: TransferRecord;
  actionId: string; sequence: number; actorId: number | null; recipientId: number | null; partnerId: number | null;
  setAtMs?: number; usedAtMs?: number; releasedAtMs?: number;
  phase: "pending" | "approach" | "set" | "use" | "release" | "transfer" | "completed" | "obstructed" | "conflict" | "interrupted";
  startedAtMs: number | null; completedAtMs: number | null; progress: number; notice: string | null;
};
type ExecutionPath = { points: CourtPoint[]; feetPoints: CourtPoint[]; lengths: number[]; length: number; progress: number; closest: CourtPoint };
type ActionRuntime = ActionDiagnostic & { paths: Map<number, ExecutionPath>; routeProgress: Map<string, number>; waitMs: number };
type BoundAction = {
  plan?: PlannedAction;
  execution?: ActionRuntime;
  onBall?: boolean;
  arrow: PlaybookArrow;
  sequence: number;
  actorId: number | null;
  recipientId: number | null;
  recipientStart: CourtPoint | null;
  startTime: number;
  durationMs: number;
  plannedStart: CourtPoint | null;
  controlOffset: CourtPoint | null;
  automatic?: boolean;
  adaptiveReadLabel?: string;
  partnerId?: number | null;
  partnerStart?: CourtPoint | null;
  transfer?: TransferRecord;
  timingWaits?: NonNullable<PlaybookArrow["timingPlan"]>["waits"];
  timingSyncId?: string;
};

type Velocity = { x: number; y: number };
type PositionOverride = { atMs: number; point: CourtPoint };
type ScreenCoverageLock = { screenerDefenderId: number; screenedDefenderId: number; screenerId: number; screenedId: number } | null;

export type SimulationRun = {
  routeRevision: number;
  motionIntents?: Map<string, MotionIntent>;
  movementOrder: MovementOrder;
  attributes: SimulationAttributes;
  movementBuffers: { solver: MovementBuffers; intents: MotionIntent[]; intentMap: Map<string, MotionIntent>; playerPositions: Map<number, CourtPoint>; defenderPositions: Map<number, CourtPoint> };
  offBallDecisions?: Map<number, { target: CourtPoint; sinceMs: number; cutting: boolean }>;
  routeHistory?: Array<{ atMs: number; players: PlaybookMarker[]; onBallIds: number[] }>;
  actions: BoundAction[];
  actionGraph: Map<string, BoundAction>;
  actionDurationMs: number;
  durationMs: number;
  readonly assignments: Map<number, number>;
  readonly defense: DefensiveTeamState;
  readonly initialAssignments: Map<number, number>;
  readonly ephemeralDefenders: boolean;
  readonly activeDefenseScheme: Exclude<DefenseScheme, "auto">;
  readonly defenseSchemeWasAutomatic: boolean;
  readonly defenseSchemeNotice: string | null;
  readonly zoneAssignments: Map<number, number>;
  readonly zoneChaserAssignments: Map<number, number>;
  zoneBallDefenderId: number | null;
  zoneBallHandlerId: number | null;
  zoneBallChangedAtMs: number;
  readonly screenCoverageLocks: Map<string, ScreenCoverageLock>;
  readonly switchedActions: Set<string>;
  readonly actionStarts: Map<string, CourtPoint>;
  readonly actionStartOverrides: Map<string, PositionOverride>;
  readonly offBallAnchors: Map<number, CourtPoint>;
  readonly targetFilters: Map<string, CourtPoint>;
  readonly velocities: Map<string, Velocity>;
  readonly recipientStartOverrides: Map<string, PositionOverride>;
  readonly offBallTargetSkills: Map<number, OffBallTargetSkill | null>;
  readonly lastReceiveAtMs: Map<number, number>;
  readonly lastCatchEvidence: Map<number, ShotCatchEvidence>;
  readonly shotDurationMs: number;
  plannedActionDurationMs: number;
  nextEarlyReadMs: number;
  adaptiveActionsTaken: number;
  adaptiveContinuationStartedAtMs: number | null;
  adaptivePassPairs: Set<string>;
  earlyReadInterrupted: boolean;
  adaptiveReadResolved: boolean;
  adaptiveReadLabel: string | null;
  adaptiveReadReason: string | null;
  adaptiveReadRoute: SimulationFrame["adaptiveReadRoute"];
  source: PlaybookDraft;
  settings: SimulationSettings;
  players: PlaybookMarker[];
  defenders: PlaybookMarker[];
  ballState: BallState;
  readonly ball: CourtPoint | null;
  readonly ballHandlerId: number | null;
  readonly helpDefenderId: number | null;
  defensiveDriveThreatUntilMs: number;
  defensiveDriveThreatHandlerId: number | null;
  elapsedMs: number;
  accumulatorMs: number;
  readonly shotStart: CourtPoint | null;
  readonly shotShooterId: number | null;
  readonly shotQualityAtRelease: number;
  previousFrame: SimulationFrame;
  frame: SimulationFrame;
};

export const SIMULATION_STEP_MS = 1000 / 30;
const SIMULATION_FIXED_STEP_MS = 1000 / 60;
export const SIMULATION_SHOT_MS = 1500;
export const DEFENDER_MAX_SPEED_FT_PER_SECOND = 15;
const DEFENDER_ACCELERATION_FT_PER_SECOND = 28;
const ZONE_BALL_MIN_HOLD_MS = 320;
const ZONE_BALL_SWITCH_MARGIN_FEET = 4.5;
const DEFENSIVE_DRIVE_GRACE_MS = 180;
const DEFENDER_SOFT_SPACING_FEET = 2.2;
const OFFENSE_MAX_SPEED_FT_PER_SECOND = 19;
const OFFENSE_ACCELERATION_FT_PER_SECOND = 34;
const OFF_BALL_MAX_SPEED_FT_PER_SECOND = 12;
const ON_BALL_ANTICIPATION_SECONDS = 0.22;
const ON_BALL_ANTICIPATION_MAX_FEET = 3.25;
const OFF_BALL_ANTICIPATION_SECONDS = 0.14;
const OFF_BALL_ANTICIPATION_MAX_FEET = 2;
const BALL_MAX_SPEED_FT_PER_SECOND = 42;
const BALL_ACCELERATION_FT_PER_SECOND = 90;
const MAX_SIMULATION_DELTA_MS = 50;
const TRANSFER_CATCH_RADIUS_FEET = 1.1;
const MAX_TRANSFER_WAIT_MS = 1200;
const LOOSE_BALL_CATCH_RADIUS_FEET = 1.15;
const AI_TARGET_RESPONSE_PER_SECOND = 15;
const PASS_PREP_MS = 440;
const MIN_PLAY_DURATION_MS = 1200;
const EARLY_READ_INTERVAL_MS = 250;
const EARLY_READ_START_MS = 400;
const EARLY_SHOT_MIN_QUALITY = 72;
const EARLY_SHOT_MIN_EXPECTED_POINTS = 1.6;
const MAX_ADAPTIVE_ACTIONS = 3;
const MAX_ADAPTIVE_WINDOW_MS = 4000;
const MAX_COURT_PLAYERS = 5;
const HOOP_POINT = courtSvgToPoint(NBA_COURT_GEOMETRY.basket.center);

export type ResolvedDefenseScheme = Exclude<DefenseScheme, "auto">;

export const DEFENSE_SCHEME_LABELS: Record<ResolvedDefenseScheme, string> = {
  "man-to-man": "Man-to-man",
  "pack-line": "Pack-line man",
  "zone-2-3": "2–3 zone",
  "zone-3-2": "3–2 zone",
  "zone-1-3-1": "1–3–1 zone",
  "zone-2-1-2": "2–1–2 zone",
  "zone-1-2-2": "1–2–2 zone",
  "matchup-1-1-3": "1–1–3 matchup zone",
  "box-and-one": "Box-and-one",
  "triangle-and-two": "Triangle-and-two",
};

export const DEFENSE_SCHEME_DESCRIPTIONS: Record<DefenseScheme, string> = {
  auto: "Randomly choose an eligible scheme at the start of each possession",
  "man-to-man": "Stay with assigned players and contain the ball in front",
  "pack-line": "Guard assignments while off-ball defenders shade toward the paint",
  "zone-2-3": "Two high defenders pressure the wings; three protect the lane and baseline",
  "zone-3-2": "Three across the top close to shooters; two protect the low blocks",
  "zone-1-3-1": "Pressure the top, cover three across the middle, and patrol the baseline",
  "zone-2-1-2": "Two high defenders steer the ball toward a middle anchor and two low defenders",
  "zone-1-2-2": "One high defender pressures the ball with two wings and two low defenders behind",
  "matchup-1-1-3": "Two guards pressure high while three defenders protect the front line by area",
  "box-and-one": "One defender tracks the top threat; four defenders hold a box zone",
  "triangle-and-two": "Two defenders track the top threats; three defenders hold a triangle zone",
};

export const DEFENSE_SCHEME_ORDER: ResolvedDefenseScheme[] = [
  "man-to-man", "pack-line", "zone-2-3", "zone-3-2", "zone-1-3-1", "zone-2-1-2", "zone-1-2-2", "matchup-1-1-3", "box-and-one", "triangle-and-two",
];

export function chooseDefenseScheme(
  requested: DefenseScheme,
  defenderCount: number,
  offensivePlayerCount: number,
  random: () => number = Math.random,
): { scheme: ResolvedDefenseScheme; automatic: boolean; notice: string | null } {
  const matchupSchemes: ResolvedDefenseScheme[] = ["man-to-man", "pack-line"];
  const eligible = DEFENSE_SCHEME_ORDER.filter((scheme) => {
    if (defenderCount < MAX_COURT_PLAYERS && !matchupSchemes.includes(scheme)) return false;
    if (scheme === "box-and-one" && offensivePlayerCount < 1) return false;
    if (scheme === "triangle-and-two" && offensivePlayerCount < 2) return false;
    return true;
  });
  if (requested === "auto") {
    const sample = random();
    const roll = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999999, sample)) : 0;
    return { scheme: eligible[Math.floor(roll * eligible.length)] ?? "man-to-man", automatic: true, notice: null };
  }
  if (eligible.includes(requested)) return { scheme: requested, automatic: false, notice: null };
  const reason = defenderCount < MAX_COURT_PLAYERS
    ? `${DEFENSE_SCHEME_LABELS[requested]} needs five defenders. Man-to-man is active for this possession`
    : `${DEFENSE_SCHEME_LABELS[requested]} needs ${requested === "triangle-and-two" ? "two offensive players" : "one offensive player"}. Man-to-man is active for this possession`;
  return { scheme: "man-to-man", automatic: false, notice: reason };
}

type ZoneSlot = { x: number; y: number };
type ZoneFormation = { slots: ZoneSlot[]; chasers: number };

const ZONE_FORMATIONS: Partial<Record<ResolvedDefenseScheme, ZoneFormation>> = {
  "zone-2-3": { slots: [{ x: -8, y: 29 }, { x: 8, y: 29 }, { x: -10, y: 16 }, { x: 0, y: 12 }, { x: 10, y: 16 }], chasers: 0 },
  "zone-3-2": { slots: [{ x: -11, y: 26 }, { x: 0, y: 27 }, { x: 11, y: 26 }, { x: -8, y: 13 }, { x: 8, y: 13 }], chasers: 0 },
  "zone-1-3-1": { slots: [{ x: 0, y: 31 }, { x: -10, y: 21 }, { x: 0, y: 20 }, { x: 10, y: 21 }, { x: 0, y: 10 }], chasers: 0 },
  "zone-2-1-2": { slots: [{ x: -9, y: 26 }, { x: 9, y: 26 }, { x: 0, y: 17 }, { x: -9, y: 11 }, { x: 9, y: 11 }], chasers: 0 },
  "zone-1-2-2": { slots: [{ x: 0, y: 31 }, { x: -9, y: 22 }, { x: 9, y: 22 }, { x: -9, y: 12 }, { x: 9, y: 12 }], chasers: 0 },
  "matchup-1-1-3": { slots: [{ x: 0, y: 31 }, { x: 0, y: 23 }, { x: -10, y: 15 }, { x: 0, y: 13 }, { x: 10, y: 15 }], chasers: 0 },
  "box-and-one": { slots: [{ x: -8, y: 24 }, { x: 8, y: 24 }, { x: -8, y: 14 }, { x: 8, y: 14 }], chasers: 1 },
  "triangle-and-two": { slots: [{ x: 0, y: 26 }, { x: -10, y: 12 }, { x: 10, y: 12 }], chasers: 2 },
};

function isManScheme(scheme: ResolvedDefenseScheme) {
  return scheme === "man-to-man" || scheme === "pack-line";
}

function zoneFormation(scheme: ResolvedDefenseScheme) {
  return ZONE_FORMATIONS[scheme] ?? null;
}

function zoneAnchors(scheme: ResolvedDefenseScheme, hoop: CourtPoint) {
  const formation = zoneFormation(scheme);
  if (!formation) return [];
  const hoopFeet = toCourtFeet(hoop);
  return formation.slots.map(({ x, y }) => clampCourt(fromCourtFeet({ x: hoopFeet.x + x, y })));
}

function zoneRoleCost(defender: PlaybookMarker, anchor: CourtPoint, anchors: CourtPoint[], hoop: CourtPoint) {
  let cost = pointDistanceFeet(defender, anchor);
  const anchorDistance = pointDistanceFeet(anchor, hoop);
  const distances = anchors.map((candidate) => pointDistanceFeet(candidate, hoop)).sort((a, b) => a - b);
  const middleDistance = distances[Math.floor(distances.length / 2)] ?? anchorDistance;
  if (defenderHasBadge(defender, "paint-protector")) cost += anchorDistance <= middleDistance ? -4 : 2;
  if (defenderHasBadge(defender, "lockdown")) cost += anchorDistance >= middleDistance ? -3 : 1;
  if (defenderHasBadge(defender, "helper")) cost += anchorDistance >= 8 && anchorDistance <= 21 ? -2.5 : 1;
  return cost;
}

function assignZoneDefenders(defenders: PlaybookMarker[], anchors: CourtPoint[], excluded = new Set<number>(), hoop = HOOP_POINT) {
  const available = defenders.filter((defender) => !excluded.has(defender.id)).slice().sort((a, b) => a.id - b.id);
  const roleAssignments = new Map<number, number>();
  const count = Math.min(available.length, anchors.length);
  let bestCost = Number.POSITIVE_INFINITY;
  let bestRoles: number[] = [];
  const visit = (defenderIndex: number, used: Set<number>, roles: number[], cost: number) => {
    if (defenderIndex === count) {
      if (cost < bestCost - 1e-7) {
        bestCost = cost;
        bestRoles = [...roles];
      }
      return;
    }
    for (let slot = 0; slot < anchors.length; slot += 1) {
      if (used.has(slot)) continue;
      const nextCost = cost + zoneRoleCost(available[defenderIndex], anchors[slot], anchors, hoop);
      if (nextCost > bestCost + 1e-7) continue;
      used.add(slot);
      roles.push(slot);
      visit(defenderIndex + 1, used, roles, nextCost);
      roles.pop();
      used.delete(slot);
    }
  };
  visit(0, new Set<number>(), [], 0);
  available.slice(0, count).forEach((defender, index) => roleAssignments.set(defender.id, bestRoles[index] ?? index));
  available.slice(count).forEach((defender) => {
    let closestSlot = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    anchors.forEach((anchor, slot) => {
      const distance = zoneRoleCost(defender, anchor, anchors, hoop);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestSlot = slot;
      }
    });
    roleAssignments.set(defender.id, closestSlot);
  });
  return roleAssignments;
}

function assignZoneChasers(defenders: PlaybookMarker[], players: PlaybookMarker[], count: number, hoop: CourtPoint) {
  const threatScore = (player: PlaybookMarker) => playerRating(player, "threePoint") + playerRating(player, "midrange") + playerRating(player, "finishing") + badgeThreatScore(player, hoop);
  const threats = players.slice().sort((a, b) => threatScore(b) - threatScore(a) || a.id - b.id).slice(0, count);
  const available = defenders.slice().sort((a, b) => a.id - b.id);
  const assignments = new Map<number, number>();
  for (const threat of threats) {
    const defender = available
      .filter((candidate) => !assignments.has(candidate.id))
      .sort((a, b) => {
        const aCost = pointDistanceFeet(a, threat) - (defenderHasBadge(a, "lockdown") ? 5 : 0)
          + (defenderHasBadge(a, "paint-protector") ? 3 : 0);
        const bCost = pointDistanceFeet(b, threat) - (defenderHasBadge(b, "lockdown") ? 5 : 0)
          + (defenderHasBadge(b, "paint-protector") ? 3 : 0);
        return aCost - bCost || a.id - b.id;
      })[0];
    if (defender) assignments.set(defender.id, threat.id);
  }
  return assignments;
}

const courtUnitsPerPoint = {
  x: (COURT_VIEWBOX.width / 100) / COURT_SCALE,
  y: (COURT_VIEWBOX.height / 100) / COURT_SCALE,
};
const courtBounds = {
  left: courtSvgToPoint({ x: NBA_COURT_GEOMETRY.boundary.left, y: 0 }).x,
  right: courtSvgToPoint({ x: NBA_COURT_GEOMETRY.boundary.right, y: 0 }).x,
  top: courtSvgToPoint({ x: 0, y: NBA_COURT_GEOMETRY.boundary.top }).y,
  bottom: courtSvgToPoint({ x: 0, y: NBA_COURT_GEOMETRY.boundary.bottom }).y,
};
const courtBoundsFeet = Object.freeze({
  left: courtBounds.left * courtUnitsPerPoint.x,
  right: courtBounds.right * courtUnitsPerPoint.x,
  top: courtBounds.top * courtUnitsPerPoint.y,
  bottom: courtBounds.bottom * courtUnitsPerPoint.y,
});

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampCourt(point: CourtPoint): CourtPoint {
  return {
    x: clamp(point.x, courtBounds.left, courtBounds.right),
    y: clamp(point.y, courtBounds.top, courtBounds.bottom),
  };
}

export function pointDistanceFeet(a: CourtPoint, b: CourtPoint) {
  return Math.hypot((a.x - b.x) * courtUnitsPerPoint.x, (a.y - b.y) * courtUnitsPerPoint.y);
}

function toCourtFeet(point: CourtPoint): CourtPoint {
  return { x: point.x * courtUnitsPerPoint.x, y: point.y * courtUnitsPerPoint.y };
}

function fromCourtFeet(point: CourtPoint): CourtPoint {
  return { x: point.x / courtUnitsPerPoint.x, y: point.y / courtUnitsPerPoint.y };
}

function addFeet(point: CourtPoint, offset: CourtPoint): CourtPoint {
  const feet = toCourtFeet(point);
  return clampCourt(fromCourtFeet({ x: feet.x + offset.x, y: feet.y + offset.y }));
}

function pointToward(from: CourtPoint, to: CourtPoint, distanceFeet: number): CourtPoint {
  const a = toCourtFeet(from);
  const b = toCourtFeet(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return { ...from };
  return addFeet(from, { x: (dx / length) * distanceFeet, y: (dy / length) * distanceFeet });
}

function easeInOut(amount: number) {
  const progress = clamp(amount, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function nearestPointIndex(points: PlaybookMarker[], target: CourtPoint, excludeId?: number) {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    if (point.id === excludeId) return;
    const distance = pointDistanceFeet(point, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function markerForId(players: PlaybookMarker[], id: number | null) {
  return id == null ? null : players.find((player) => player.id === id) ?? null;
}

function orderedArrows(arrows: PlaybookArrow[]) {
  return arrows
    .map((arrow, index) => ({
      arrow,
      index,
      sequence: Number.isInteger(arrow.sequence) && (arrow.sequence ?? 0) > 0 ? arrow.sequence as number : index + 1,
    }))
    .sort((left, right) => left.sequence - right.sequence || left.index - right.index);
}

function defaultControl(start: CourtPoint, end: CourtPoint): CourtPoint {
  // Retain the engine's normalized-unit bend policy and physical court bounds.
  return clampCourt(perpendicularRouteControl(start, end, 5, 13));
}

function routeControl(action: BoundAction, start: CourtPoint, end = action.arrow.end) {
  if (!action.controlOffset) return defaultControl(start, end);
  return clampCourt({
    x: start.x + action.controlOffset.x,
    y: start.y + action.controlOffset.y,
  });
}

function routePoint(action: BoundAction, start: CourtPoint, amount: number, end = action.arrow.end) {
  if (action.arrow.path !== "curve") return lerpPoint(start, end, amount);
  return quadraticPoint(start, end, routeControl(action, start, end), amount);
}

function routeLength(action: PlaybookArrow, start: CourtPoint) {
  const bound: BoundAction = {
    arrow: action,
    sequence: 1,
    actorId: null,
    recipientId: null,
    recipientStart: null,
    startTime: 0,
    durationMs: 1,
    plannedStart: start,
    controlOffset: action.control
      ? { x: action.control.x - action.start.x, y: action.control.y - action.start.y }
      : null,
  };
  let length = 0;
  let previous = start;
  for (let index = 1; index <= 16; index += 1) {
    const current = routePoint(bound, start, index / 16);
    length += pointDistanceFeet(previous, current);
    previous = current;
  }
  return length;
}

function offBallCutterTarget(screenPoint: CourtPoint, hoop = HOOP_POINT) {
  return pointToward(screenPoint, hoop, 8);
}

function buildActions(source: PlaybookDraft): { actions: BoundAction[]; actionDurationMs: number; ballHandlerId: number | null; finalPositions: PlaybookMarker[] } {
  const positions = source.players.map((player) => ({ ...player }));
  let ballHandlerId = source.players[nearestPointIndex(source.players, source.ball ?? source.players[0] ?? HOOP_POINT)]?.id ?? null;
  let cursor = 0;
  const ordered = orderedArrows(source.arrows);
  const actions: BoundAction[] = [];
  for (let phaseStart = 0; phaseStart < ordered.length;) {
    let phaseEnd = phaseStart + 1;
    while (phaseEnd < ordered.length && ordered[phaseEnd].sequence === ordered[phaseStart].sequence) phaseEnd += 1;
    const phase = ordered.slice(phaseStart, phaseEnd);
    const phasePositions = positions.map((player) => ({ ...player }));
    const phaseHandlerId = ballHandlerId;
    let phaseDuration = 0;
    let nextHandlerId = phaseHandlerId;
    let transferClaimed = false;
    const routeClaims = new Set<number>();

    for (const { arrow, sequence } of phase) {
      const isTransfer = arrow.kind === "pass" || arrow.kind === "handoff";
      const isSlip = arrow.kind === "slip-screen";
      const isScreen = arrow.kind === "screen" || isSlip || arrow.kind === "pick-roll" || arrow.kind === "pick-pop";
      const isOffBallScreen = arrow.kind === "off-ball-screen" || arrow.kind === "pin-down";
      const isCut = arrow.kind === "backdoor-cut";
      const usesNamedScreener = arrow.screener_id != null && (isOffBallScreen || isScreen);
      const actorIndex = usesNamedScreener
        ? phasePositions.findIndex((player) => player.id === arrow.screener_id)
        : arrow.actor_id != null && (isCut || arrow.kind === "movement" || isTransfer)
          ? phasePositions.findIndex((player) => player.id === arrow.actor_id)
          : isTransfer && phaseHandlerId != null
            ? phasePositions.findIndex((player) => player.id === phaseHandlerId)
            : nearestPointIndex(phasePositions, arrow.start);
      const actor = phasePositions[actorIndex] ?? null;
      const recipientIndex = isOffBallScreen && arrow.cutter_id != null
        ? phasePositions.findIndex((player) => player.id === arrow.cutter_id)
        : isTransfer ? (arrow.recipient_id != null ? phasePositions.findIndex((player) => player.id === arrow.recipient_id) : nearestPointIndex(phasePositions, arrow.end, actor?.id)) : -1;
      const recipient = phasePositions[recipientIndex] ?? null;
      // A saved play can name a screen partner, but possession only changes
      // on a pass or handoff. Keep the live handler attached to the ball if
      // the named participant no longer holds it at this point in the play.
      const handlerId = phaseHandlerId != null ? phaseHandlerId : arrow.handler_id ?? null;
      const handler = markerForId(phasePositions, handlerId);
      const plannedStart = actor ? { x: actor.x, y: actor.y } : { ...arrow.start };
      const controlOffset = arrow.control
        ? { x: arrow.control.x - arrow.start.x, y: arrow.control.y - arrow.start.y }
        : null;
      const pathFeet = routeLength(arrow, plannedStart);
      const exitTarget = arrow.exit_target ?? offBallCutterTarget(arrow.end);
      const receiverFeet = recipient
        ? isOffBallScreen
          ? pointDistanceFeet(recipient, arrow.end) + pointDistanceFeet(arrow.end, exitTarget)
          : pointDistanceFeet(recipient, arrow.end)
        : 0;
      const extraPathFeet = arrow.kind === "pick-pop" && arrow.exit_target
        ? pointDistanceFeet(arrow.end, arrow.exit_target)
        : 0;
      const authoredDuration = clamp(arrow.timing ?? 1.2, 0.5, 4) * 1000;
      const movesOnCourt = arrow.kind === "movement" || isScreen || isOffBallScreen || isCut;
      const minimumMovementDuration = movesOnCourt
        ? Math.max(pathFeet + extraPathFeet, isOffBallScreen ? receiverFeet : 0) * 1.5 / OFFENSE_MAX_SPEED_FT_PER_SECOND * 1000
        : 0;
      const minimumTransferDuration = isTransfer
        ? Math.max(
            (pathFeet * 1.5 / BALL_MAX_SPEED_FT_PER_SECOND) * 1000,
            (receiverFeet * 1.5 / OFFENSE_MAX_SPEED_FT_PER_SECOND) * 1000 - PASS_PREP_MS,
          )
        : 0;
      const screenUser = isOffBallScreen ? recipient : handler;
      const screenUserEnd = isOffBallScreen ? exitTarget : pointToward(arrow.end, HOOP_POINT, arrow.kind === "pick-roll" || isSlip ? 10 : 8);
      const screenTravel = screenUser ? pointDistanceFeet(screenUser, arrow.end) + pointDistanceFeet(arrow.end, screenUserEnd) + 2.4 : 0;
      const releaseFeet = arrow.kind === "pick-roll" || isSlip ? 8 : extraPathFeet;
      const minimumScreenDuration = isScreen || isOffBallScreen
        ? (pathFeet / 8 + screenTravel / 7 + releaseFeet / 8) * 1000 + (isSlip ? 250 : 520)
        : 0;
      const durationMs = Math.max(authoredDuration, minimumMovementDuration, minimumTransferDuration, minimumScreenDuration);
      const partnerId = isScreen && actor?.id !== handler?.id ? handler?.id ?? null : null;
      const boundAction: BoundAction = {
        onBall: isTransfer || actor?.id === phaseHandlerId || (isScreen && handlerId != null),
        arrow,
        sequence,
        actorId: actor?.id ?? null,
        recipientId: recipient?.id ?? null,
        recipientStart: recipient ? { x: recipient.x, y: recipient.y } : null,
        startTime: cursor,
        durationMs,
        plannedStart,
        controlOffset,
        partnerId,
        partnerStart: partnerId == null ? null : { ...handler! },
        timingWaits: arrow.timingPlan?.waits ?? [],
        timingSyncId: arrow.timingPlan?.syncId,
      };
      actions.push(boundAction);
      phaseDuration = Math.max(phaseDuration, durationMs);

      // Routes are applied in diagram order. Screens still affect coverage if
      // their cutter already has a route in this simultaneous phase.
      if (movesOnCourt && actorIndex >= 0 && !routeClaims.has(actor?.id ?? -1)) {
        const finish = arrow.kind === "pick-roll" || arrow.kind === "slip-screen"
          ? pointToward(arrow.end, HOOP_POINT, 8)
          : arrow.kind === "pick-pop"
            ? arrow.exit_target ?? arrow.end
            : arrow.kind === "backdoor-cut"
              ? arrow.end
              : arrow.end;
        positions[actorIndex] = { ...positions[actorIndex], ...finish };
        routeClaims.add(actor?.id ?? -1);
      }
      if (isOffBallScreen && recipientIndex >= 0 && !routeClaims.has(recipient?.id ?? -1)) {
        positions[recipientIndex] = { ...positions[recipientIndex], ...exitTarget };
        routeClaims.add(recipient?.id ?? -1);
      } else if (isTransfer && recipientIndex >= 0 && !transferClaimed) {
        positions[recipientIndex] = { ...positions[recipientIndex], ...arrow.end };
        nextHandlerId = recipient?.id ?? nextHandlerId;
        transferClaimed = true;
      }
      // A second simultaneous transfer would start after this phase in normal
      // editing; retain possession continuity if malformed data contains one.
    }
    cursor += phaseDuration;
    ballHandlerId = nextHandlerId;
    phaseStart = phaseEnd;
  }
  // Untouched version-1 plays retain their original sequence-derived schedule.
  // Once Timing is activated, each action's stable identity owns its earliest
  // start. Runtime dependencies can delay connected actions from this point.
  if (actions.some((action) => action.arrow.timingPlan !== undefined)) {
    for (const action of actions) action.startTime = action.arrow.timingPlan?.startAtMs ?? action.startTime;
    cursor = Math.max(0, ...actions.map((action) => action.startTime + action.durationMs));
  }
  attachActionPlans(actions, source.players[nearestPointIndex(source.players, source.ball ?? source.players[0] ?? HOOP_POINT)]?.id ?? null);
  return { actions, actionDurationMs: Math.max(MIN_PLAY_DURATION_MS, cursor), ballHandlerId, finalPositions: positions };
}


const OFF_BALL_STYLES = new Set(["off", "spacing", "cuts", "read-react"]);
const DEFENSE_STRATEGIES = new Set(["off", "contain", "help", "switch", "trap-rotate", "fight-over", "go-under", "drop", "hedge", "deny-lanes", "protect-paint"]);
const DEFENSE_SCHEMES = new Set<string>(["auto", ...DEFENSE_SCHEME_ORDER]);
const AUTOMATIC_ACTION_FLAGS = ["screen", "handoff", "pickRoll", "offBallScreen"] as const;

export function validateSettings(value: unknown): asserts value is SimulationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Simulation settings must be an object");
  const settings = value as Record<string, unknown>;
  if (typeof settings.offenseOffBall !== "string" || !OFF_BALL_STYLES.has(settings.offenseOffBall)) throw new TypeError("Invalid simulation setting: offenseOffBall");
  if (typeof settings.defenseStrategy !== "string" || !DEFENSE_STRATEGIES.has(settings.defenseStrategy)) throw new TypeError("Invalid simulation setting: defenseStrategy");
  if (settings.defenseScheme !== undefined && (typeof settings.defenseScheme !== "string" || !DEFENSE_SCHEMES.has(settings.defenseScheme))) throw new TypeError("Invalid simulation setting: defenseScheme");
  if (settings.offenseMode !== undefined && settings.offenseMode !== "adaptive" && settings.offenseMode !== "scripted") throw new TypeError("Invalid simulation setting: offenseMode");
  if (typeof settings.offBallIntensity !== "number" || !Number.isFinite(settings.offBallIntensity)) throw new TypeError("Invalid simulation setting: offBallIntensity must be finite");
  const automatic = settings.automaticActions;
  if (!automatic || typeof automatic !== "object" || Array.isArray(automatic)) throw new TypeError("Invalid simulation setting: automaticActions must contain boolean flags");
  for (const flag of AUTOMATIC_ACTION_FLAGS) {
    if (typeof (automatic as Record<string, unknown>)[flag] !== "boolean") throw new TypeError(`Invalid simulation setting: automaticActions.${flag} must be boolean`);
  }
}

function normalizeSettings(settings: SimulationSettings, current?: SimulationSettings): SimulationSettings {
  // Validate before scripted overrides or the no-change shortcut can hide bad
  // input. This runs at engine boundaries, never inside a fixed-step loop.
  validateSettings(settings);
  const scripted = settings.offenseMode === "scripted";
  if (current && current.offenseMode === (settings.offenseMode ?? "adaptive")
    && current.offenseOffBall === (scripted ? "off" : settings.offenseOffBall)
    && current.defenseStrategy === settings.defenseStrategy
    && current.offBallIntensity === settings.offBallIntensity
    && current.automaticActions.screen === (scripted ? false : settings.automaticActions.screen)
    && current.automaticActions.handoff === (scripted ? false : settings.automaticActions.handoff)
    && current.automaticActions.pickRoll === (scripted ? false : settings.automaticActions.pickRoll)
    && current.automaticActions.offBallScreen === (scripted ? false : settings.automaticActions.offBallScreen)) return current;
  return {
    offenseOffBall: scripted ? "off" : settings.offenseOffBall,
    defenseScheme: current?.defenseScheme ?? settings.defenseScheme ?? "auto",
    defenseStrategy: settings.defenseStrategy,
    offBallIntensity: settings.offBallIntensity,
    automaticActions: scripted ? { screen: false, handoff: false, pickRoll: false, offBallScreen: false } : { ...settings.automaticActions },
    offenseMode: settings.offenseMode ?? "adaptive",
  };
}

function defenderGap(player: CourtPoint, defenders: PlaybookMarker[]) {
  return defenders.length ? Math.min(...defenders.map((defender) => pointDistanceFeet(player, defender))) : Number.POSITIVE_INFINITY;
}

function shotSkillFor(player: CourtPoint, hoop: CourtPoint): keyof PlayerSkillRatings {
  const feet = toCourtFeet(player);
  const basket = toCourtFeet(hoop);
  const distance = Math.hypot(feet.x - basket.x, feet.y - basket.y);
  const inCornerThree = (feet.x <= 3.2 || feet.x >= 46.8) && feet.y <= 14.25;
  if (distance <= 8) return "finishing";
  if (inCornerThree || distance >= NBA_COURT_GEOMETRY.threePoint.radiusFeet) return "threePoint";
  return "midrange";
}

function shotSkillRating(player: PlaybookMarker, hoop: CourtPoint) {
  return playerRating(player, shotSkillFor(player, hoop));
}

function badgeThreatScore(player: PlaybookMarker, hoop: CourtPoint) {
  const skill = shotSkillFor(player, hoop);
  let score = 0;
  if (playerRating(player, "threePoint") >= 2 && skill === "threePoint") {
    if (playerHasBadge(player, "deep-range")) score += 0.9;
    if (playerHasBadge(player, "catch-and-shoot")) score += 0.55;
  }
  if (playerRating(player, "midrange") >= 2 && skill === "midrange") {
    if (playerHasBadge(player, "off-dribble-creator")) score += 0.7;
    if (playerHasBadge(player, "post-scorer")) score += 0.75;
  }
  if (playerRating(player, "finishing") >= 2 && skill === "finishing") {
    if (playerHasBadge(player, "slasher")) score += 0.65;
    if (playerHasBadge(player, "rim-finisher")) score += 0.9;
    if (playerHasBadge(player, "cutter")) score += 0.35;
    if (playerHasBadge(player, "roll-threat")) score += 0.55;
  }
  if (playerHasBadge(player, "playmaker")) score += 0.35;
  if (playerHasBadge(player, "screen-setter")) score += 0.35;
  return Math.min(1.7, score);
}

function defensiveThreatRating(player: PlaybookMarker, hoop: CourtPoint) {
  return clamp(shotSkillRating(player, hoop) + badgeThreatScore(player, hoop), 1, 6.7);
}

function helpFinishingRating(player: PlaybookMarker) {
  const finishingIsViable = playerRating(player, "finishing") >= 2;
  const bonus = (finishingIsViable && playerHasBadge(player, "slasher") ? 1.15 : 0)
    + (finishingIsViable && playerHasBadge(player, "rim-finisher") ? 0.85 : 0)
    + (finishingIsViable && playerHasBadge(player, "off-dribble-creator") ? 0.35 : 0)
    + (finishingIsViable && playerHasBadge(player, "roll-threat") ? 0.35 : 0)
    + (finishingIsViable && playerHasBadge(player, "cutter") ? 0.25 : 0);
  return clamp(playerRating(player, "finishing") + bonus, 1, 5);
}

type OffBallTargetSkill = keyof PlayerSkillRatings | "post";

function offBallTargetSkill(player: PlaybookMarker, hoop: CourtPoint): OffBallTargetSkill | null {
  const badgeTargets: Array<{ badge: OffensiveBadge; skill: OffBallTargetSkill }> = [
    { badge: "deep-range", skill: "threePoint" },
    { badge: "catch-and-shoot", skill: "threePoint" },
    { badge: "post-scorer", skill: "post" },
    { badge: "cutter", skill: "finishing" },
    { badge: "slasher", skill: "finishing" },
    { badge: "rim-finisher", skill: "finishing" },
    { badge: "roll-threat", skill: "finishing" },
    { badge: "off-dribble-creator", skill: "midrange" },
  ];
  const badgeTarget = badgeTargets.find(({ badge, skill }) => playerHasBadge(player, badge)
    && playerRating(player, skill === "post" ? "midrange" : skill) >= 2);
  if (badgeTarget) return badgeTarget.skill;
  const currentSkill = shotSkillFor(player, hoop);
  const skills: Array<keyof PlayerSkillRatings> = ["threePoint", "midrange", "finishing"];
  const currentRating = playerRating(player, currentSkill);
  const bestRating = Math.max(...skills.map((skill) => playerRating(player, skill)));
  if (bestRating >= 4) {
    return skills
      .slice()
      .sort((a, b) => playerRating(player, b) - playerRating(player, a)
        || Number(b === currentSkill) - Number(a === currentSkill)
        || skills.indexOf(a) - skills.indexOf(b))[0];
  }
  if (currentRating === 1) {
    return skills
      .filter((skill) => skill !== currentSkill && playerRating(player, skill) > 1)
      .sort((a, b) => playerRating(player, b) - playerRating(player, a) || skills.indexOf(a) - skills.indexOf(b))[0] ?? null;
  }
  return null;
}

function goalSideGapFor(player: PlaybookMarker, hoop: CourtPoint, baseGap: number) {
  const skill = shotSkillFor(player, hoop);
  const rating = playerRating(player, skill);
  const weight = skill === "finishing" ? 0.65 : 1.35;
  return clamp(baseGap + (3 - rating) * weight - badgeThreatScore(player, hoop) * 0.72, 1.8, 8.5);
}

function defenderGoalSideGapFor(defender: PlaybookMarker, player: PlaybookMarker, hoop: CourtPoint, baseGap: number) {
  const lockdownAdjustment = defenderHasBadge(defender, "lockdown") ? 0.8 : 0;
  const paintAdjustment = defenderHasBadge(defender, "paint-protector")
    && shotSkillFor(player, hoop) === "finishing"
    && pointDistanceFeet(player, hoop) <= 14
    ? 0.55
    : 0;
  return clamp(goalSideGapFor(player, hoop, baseGap) - lockdownAdjustment - paintAdjustment, 1.6, 8.5);
}

function automaticOffBallArrow(players: PlaybookMarker[], defenders: PlaybookMarker[], handlerId: number | null, sequence: number): PlaybookArrow | null {
  if (players.length < 3 || handlerId == null) return null;
  const cutters = players.filter((player) => player.id !== handlerId
      && (playerRating(player, "finishing") >= 2 || playerHasBadge(player, "cutter") || playerHasBadge(player, "slasher"))
      && defenderGap(player, defenders) <= 8)
    .sort((a, b) => Number(playerHasBadge(b, "cutter")) - Number(playerHasBadge(a, "cutter"))
      || Number(playerHasBadge(b, "slasher")) - Number(playerHasBadge(a, "slasher"))
      || playerRating(b, "finishing") - playerRating(a, "finishing")
      || defenderGap(b, defenders) - defenderGap(a, defenders)
      || a.id - b.id);
  for (const cutter of cutters) {
    const cutterDefender = defenders.slice().sort((a, b) => pointDistanceFeet(a, cutter) - pointDistanceFeet(b, cutter) || a.id - b.id)[0];
    if (!cutterDefender) continue;
    const screener = players.filter((player) => player.id !== handlerId && player.id !== cutter.id)
      .filter((player) => pointDistanceFeet(player, cutter) >= 4 && pointDistanceFeet(player, cutter) <= 16 && defenderGap(player, defenders) >= 4)
      .sort((a, b) => {
        const aBadgePriority = Number(playerHasBadge(a, "screen-setter")) * 2 + Number(playerHasBadge(a, "roll-threat"));
        const bBadgePriority = Number(playerHasBadge(b, "screen-setter")) * 2 + Number(playerHasBadge(b, "roll-threat"));
        const aTopSkill = Math.max(playerRating(a, "threePoint"), playerRating(a, "midrange"), playerRating(a, "finishing"));
        const bTopSkill = Math.max(playerRating(b, "threePoint"), playerRating(b, "midrange"), playerRating(b, "finishing"));
        return bBadgePriority - aBadgePriority
          || aTopSkill - bTopSkill
          || pointDistanceFeet(a, cutter) - pointDistanceFeet(b, cutter)
          || a.id - b.id;
      })[0];
    if (!screener) continue;
    const screenPoint = pointToward(cutter, cutterDefender, 3.25);
    if (pointDistanceFeet(offBallCutterTarget(screenPoint), cutterDefender) < 3) continue;
    return { id: `auto-offball-${sequence}`, kind: "off-ball-screen", sequence, timing: 1.25, start: { x: screener.x, y: screener.y }, end: screenPoint, screener_id: screener.id, cutter_id: cutter.id };
  }
  return null;
}

function automaticOnBallArrow(players: PlaybookMarker[], defenders: PlaybookMarker[], handlerId: number | null, hoop: CourtPoint, settings: SimulationSettings, excluded: Set<number>, sequence: number): PlaybookArrow | null {
  if (players.length < 2 || handlerId == null) return null;
  const handler = markerForId(players, handlerId);
  if (!handler) return null;
  const pressure = defenderGap(handler, defenders);
  if (pressure > 12) return null;
  const teammates = players.filter((player) => player.id !== handlerId && !excluded.has(player.id));
  const receiver = teammates.filter((player) => pointDistanceFeet(player, handler) >= 3.5 && pointDistanceFeet(player, handler) <= 9 && defenderGap(player, defenders) >= 5.5)
    .sort((a, b) => {
      const aValue = calculateShotQuality(players, defenders, a, 70) * (shotSkillFor(a, hoop) === "threePoint" ? 3 : 2) / 100
        + playerRating(a, "finishing") * 0.035
        + Number(playerHasBadge(a, "catch-and-shoot")) * 0.08
        + Number(playerHasBadge(a, "deep-range")) * 0.08
        + Number(playerHasBadge(a, "roll-threat")) * 0.06
        + Number(playerHasBadge(a, "post-scorer")) * 0.05
        + Math.min(12, defenderGap(a, defenders)) * 0.004;
      const bValue = calculateShotQuality(players, defenders, b, 70) * (shotSkillFor(b, hoop) === "threePoint" ? 3 : 2) / 100
        + playerRating(b, "finishing") * 0.035
        + Number(playerHasBadge(b, "catch-and-shoot")) * 0.08
        + Number(playerHasBadge(b, "deep-range")) * 0.08
        + Number(playerHasBadge(b, "roll-threat")) * 0.06
        + Number(playerHasBadge(b, "post-scorer")) * 0.05
        + Math.min(12, defenderGap(b, defenders)) * 0.004;
      return bValue - aValue || a.id - b.id;
    })[0];
  if (settings.automaticActions.handoff && pressure <= (playerHasBadge(handler, "playmaker") ? 9 : 7) && receiver) {
    return { id: `auto-handoff-${sequence}`, kind: "handoff", sequence, timing: 1.15, start: { x: handler.x, y: handler.y }, end: { x: receiver.x, y: receiver.y } };
  }
  const screeners = teammates.filter((player) => pointDistanceFeet(player, handler) >= 4 && pointDistanceFeet(player, handler) <= 16)
    .sort((a, b) => (Number(playerHasBadge(b, "screen-setter")) * 2 + Number(playerHasBadge(b, "roll-threat"))) - (Number(playerHasBadge(a, "screen-setter")) * 2 + Number(playerHasBadge(a, "roll-threat")))
      || playerRating(b, "finishing") - playerRating(a, "finishing")
      || pointDistanceFeet(a, handler) - pointDistanceFeet(b, handler)
      || a.id - b.id);
  for (const screener of screeners) {
    const screenPoint = pointToward(handler, screener, Math.min(3.5, pointDistanceFeet(handler, screener) * 0.45));
    const rollPoint = pointToward(screenPoint, hoop, 8);
    const rollClearance = defenderGap({ ...screener, ...rollPoint }, defenders);
    if (settings.automaticActions.pickRoll && (playerRating(screener, "finishing") >= 2 || playerHasBadge(screener, "roll-threat")) && pressure >= 3 && pressure <= 10 && pointDistanceFeet(handler, hoop) > 12 && rollClearance >= 3.5) {
      return { id: `auto-pick-roll-${sequence}`, kind: "pick-roll", sequence, timing: 1.3, start: { x: screener.x, y: screener.y }, end: screenPoint, screener_id: screener.id };
    }
    if (settings.automaticActions.screen && pressure <= (playerHasBadge(screener, "screen-setter") ? 14 : 12)) {
      return { id: `auto-screen-${sequence}`, kind: "screen", sequence, timing: 1.2, start: { x: screener.x, y: screener.y }, end: screenPoint, screener_id: screener.id };
    }
  }
  return null;
}

function autoActionLabel(action: BoundAction) {
  if (action.adaptiveReadLabel) return action.adaptiveReadLabel;
  const prefix = action.automatic ? "Auto " : "";
  if (action.arrow.kind === "pass") return `${prefix}pass`;
  if (action.arrow.kind === "screen") return `${prefix}screen`;
  if (action.arrow.kind === "off-ball-screen") return `${prefix}off-ball screen`;
  if (action.arrow.kind === "handoff") return `${prefix}handoff`;
  if (action.arrow.kind === "pick-roll") return `${prefix}pick and roll`;
  if (action.arrow.kind === "pick-pop") return `${prefix}pick and pop`;
  if (action.arrow.kind === "pin-down") return `${prefix}pin-down screen`;
  if (action.arrow.kind === "backdoor-cut") return `${prefix}backdoor cut`;
  return `${prefix}movement`;
}

type AdaptiveTargetRole = "roller" | "popping screener" | "cutter" | "post" | "perimeter";

function segmentClearanceFeet(start: CourtPoint, end: CourtPoint, markers: PlaybookMarker[]) {
  if (!markers.length) return 20;
  const from = toCourtFeet(start);
  const to = toCourtFeet(end);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  return Math.min(...markers.map((marker) => {
    const point = toCourtFeet(marker);
    const progress = lengthSquared > 0
      ? clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared, 0, 1)
      : 0;
    return Math.hypot(point.x - (from.x + dx * progress), point.y - (from.y + dy * progress));
  }));
}

function nearestTeammateGap(player: PlaybookMarker, handlerId: number, players: PlaybookMarker[]) {
  const teammates = players.filter((teammate) => teammate.id !== player.id && teammate.id !== handlerId);
  if (!teammates.length) return 18;
  return Math.min(...teammates.map((teammate) => pointDistanceFeet(player, teammate)));
}

function adaptiveTargetRole(run: SimulationRun, playerId: number, hoop: CourtPoint): AdaptiveTargetRole {
  const targetActions = run.actions.filter((action) => action.actorId === playerId || action.recipientId === playerId);
  if (targetActions.some((action) => action.arrow.kind === "pick-roll" && action.actorId === playerId)) return "roller";
  if (targetActions.some((action) => action.arrow.kind === "pick-pop" && action.actorId === playerId)) return "popping screener";
  if (targetActions.some((action) =>
    action.arrow.kind === "backdoor-cut" && action.actorId === playerId
    || (action.arrow.kind === "off-ball-screen" || action.arrow.kind === "pin-down") && action.recipientId === playerId
    || action.arrow.kind === "movement" && action.actorId === playerId,
  )) return "cutter";
  const player = markerForId(run.players, playerId);
  if (player && playerHasBadge(player, "roll-threat")) return "roller";
  if (player && playerHasBadge(player, "cutter")) return "cutter";
  if (player && playerHasBadge(player, "post-scorer")) return "post";
  return player && pointDistanceFeet(player, hoop) <= 19 ? "post" : "perimeter";
}

function adaptiveRoleLabel(role: AdaptiveTargetRole) {
  if (role === "roller") return "Feed the open roller";
  if (role === "popping screener") return "Find the popping screener";
  if (role === "cutter") return "Hit the open cutter";
  if (role === "post") return "Feed the open post";
  return "Kick out to the open player";
}

function adaptivePassDuration(start: CourtPoint, end: CourtPoint) {
  return Math.max(550, pointDistanceFeet(start, end) * 1.5 / BALL_MAX_SPEED_FT_PER_SECOND * 1000);
}

function appendAdaptiveAction(
  run: SimulationRun,
  kind: "movement" | "pass",
  handler: PlaybookMarker,
  target: CourtPoint,
  recipient: PlaybookMarker | null,
  label: string,
  routeStart: CourtPoint,
) {
  const sequence = Math.max(0, ...run.actions.map((action) => action.sequence)) + 1;
  const movementDistance = pointDistanceFeet(handler, target);
  const durationMs = kind === "pass"
    ? adaptivePassDuration(routeStart, target)
    : Math.max(
        650,
        movementDistance * 1.5 / OFFENSE_MAX_SPEED_FT_PER_SECOND * 1000,
        2.4 * Math.sqrt(movementDistance / OFFENSE_ACCELERATION_FT_PER_SECOND) * 1000,
      );
  const arrow: PlaybookArrow = {
    id: `adaptive-read-${kind}`,
    kind,
    sequence,
    timing: durationMs / 1000,
    start: { x: routeStart.x, y: routeStart.y },
    end: { ...target },
  };
  const action: BoundAction = {
    onBall: true,
    arrow,
    sequence,
    actorId: handler.id,
    recipientId: recipient?.id ?? null,
    recipientStart: recipient ? { x: recipient.x, y: recipient.y } : null,
    startTime: run.actionDurationMs,
    durationMs,
    plannedStart: { x: routeStart.x, y: routeStart.y },
    controlOffset: null,
    adaptiveReadLabel: label.toLowerCase().startsWith("early read:") ? label : `Read: ${label.toLowerCase()}`,
  };
  run.actions.push(action);
  const key = `${arrow.id}:${sequence}`;
  action.plan = { key, nominalStartMs: action.startTime, dependencies: [], requiresPossessionId: handler.id };
  run.actionGraph.set(key, action);
  run.actionDurationMs += durationMs;
  run.durationMs = run.actionDurationMs + run.shotDurationMs;
  run.adaptiveActionsTaken += 1;
  if (kind === "pass" && recipient) run.adaptivePassPairs.add(`${handler.id}>${recipient.id}`);
  run.adaptiveReadLabel = label;
  run.adaptiveReadRoute = {
    start: { x: routeStart.x, y: routeStart.y },
    end: { x: target.x, y: target.y },
    kind,
  };
}

type LiveReadChoice = {
  kind: "shot" | "pass" | "drive";
  player: PlaybookMarker;
  target: CourtPoint;
  role: AdaptiveTargetRole;
  quality: number;
  expectedPoints: number;
  score: number;
  receiverGap: number;
  laneGap: number;
};

function roleValue(role: AdaptiveTargetRole) {
  return role === "roller" || role === "cutter" ? 0.08 : role === "popping screener" || role === "post" ? 0.04 : 0;
}

function badgePassValue(handler: PlaybookMarker, receiver: PlaybookMarker, role: AdaptiveTargetRole) {
  const bonus = (playerHasBadge(handler, "playmaker") ? 0.08 : 0)
    + (playerHasBadge(receiver, "catch-and-shoot") ? 0.075 : 0)
    + (playerHasBadge(receiver, "roll-threat") && role === "roller" ? 0.11 : 0)
    + (playerHasBadge(receiver, "cutter") && role === "cutter" ? 0.08 : 0)
    + (playerHasBadge(receiver, "post-scorer") && role === "post" ? 0.07 : 0);
  return Math.min(0.16, bonus);
}

function badgeShotContext(run: SimulationRun, player: PlaybookMarker, timeMs: number): ShotMotionEvidence {
  return {
    atMs: timeMs,
    shooterVelocityFtPerSecond: { ...run.velocities.get(velocityKey("player", player.id)) ?? { x: 0, y: 0 } },
    defenderVelocities: run.defenders.map(defender => ({ id: defender.id, velocityFtPerSecond: { ...run.velocities.get(velocityKey("defender", defender.id)) ?? { x: 0, y: 0 } } })),
    catch: run.lastCatchEvidence.get(player.id) ?? null,
    recentActions: run.actions.flatMap(action => {
      const state = action.execution;
      if (action.actorId !== player.id || !["movement", "pick-roll", "pick-pop", "backdoor-cut", "slip-screen"].includes(action.arrow.kind)
        || !state || state.startedAtMs === null || state.startedAtMs > timeMs
        || ["pending", "obstructed", "conflict"].includes(state.phase)
        || timeMs - (state.completedAtMs ?? state.startedAtMs) > 1800) return [];
      return [{ actionId: action.arrow.id, sequence: action.sequence, kind: action.arrow.kind, startedAtMs: state.startedAtMs, completedAtMs: state.completedAtMs }];
    }),
  };
}

function estimatedShot(run: SimulationRun, player: PlaybookMarker, position: CourtPoint, hoop: CourtPoint) {
  const candidatePlayers = run.players.map((candidate) => candidate.id === player.id ? { ...candidate, ...position } : candidate);
  const offBall = calculateOffBallQuality(candidatePlayers, position, run.settings, run.defenders, player.id);
  const candidate = { ...player, ...position };
  const quality = calculateShotQuality(candidatePlayers, run.defenders, candidate, offBall, hoop, badgeShotContext(run, candidate, run.elapsedMs));
  const points = shotSkillFor(candidate, hoop) === "threePoint" ? 3 : 2;
  return { quality, expectedPoints: quality * points / 100 };
}

function liveReadChoices(run: SimulationRun, hoop: CourtPoint) {
  const handler = markerForId(run.players, run.ballHandlerId);
  if (!handler) return { handler: null, choices: [] as LiveReadChoice[] };
  const ball = run.ball ?? handler;
  const handlerShot = estimatedShot(run, handler, handler, hoop);
  const choices: LiveReadChoice[] = [{
    kind: "shot",
    player: handler,
    target: { x: handler.x, y: handler.y },
    role: "perimeter",
    ...handlerShot,
    score: handlerShot.expectedPoints,
    receiverGap: defenderGap(handler, run.defenders),
    laneGap: Number.POSITIVE_INFINITY,
  }];

  for (const player of run.players) {
    if (player.id === handler.id || playerRating(player, shotSkillFor(player, hoop)) <= 1) continue;
    const receiverGap = defenderGap(player, run.defenders);
    const laneGap = segmentClearanceFeet(ball, player, run.defenders);
    const teammateGap = nearestTeammateGap(player, handler.id, run.players);
    if (receiverGap < 3.5 || laneGap < 2.5 || teammateGap < 3) continue;
    if (run.adaptivePassPairs.has(`${handler.id}>${player.id}`)) continue;
    const shot = estimatedShot(run, player, player, hoop);
    const role = adaptiveTargetRole(run, player.id, hoop);
    const spacingBonus = clamp((teammateGap - 3) / 24, 0, 0.06);
    const score = shot.expectedPoints + roleValue(role) + spacingBonus + badgePassValue(handler, player, role);
    choices.push({ kind: "pass", player, target: { x: player.x, y: player.y }, role, ...shot, score, receiverGap, laneGap });
  }

  const hoopGap = pointDistanceFeet(handler, hoop);
  if (playerRating(handler, "finishing") >= 2 && hoopGap > 8 && hoopGap <= 30) {
    const driveTarget = pointToward(handler, hoop, Math.min(22, hoopGap - 6));
    const laneGap = segmentClearanceFeet(handler, driveTarget, run.defenders);
    const teammateGap = segmentClearanceFeet(handler, driveTarget, run.players.filter((player) => player.id !== handler.id));
    const pressureGap = defenderGap(handler, run.defenders);
    if (laneGap >= 3.5 && teammateGap >= 2.25 && (pressureGap >= 3 || playerRating(handler, "finishing") >= 4)) {
      const shot = estimatedShot(run, handler, driveTarget, hoop);
      const driveCost = Math.min(0.14, pointDistanceFeet(handler, driveTarget) * 0.006);
      choices.push({
        kind: "drive",
        player: handler,
        target: driveTarget,
        role: "cutter",
        ...shot,
        score: shot.expectedPoints - driveCost + Math.min(0.16,
          (playerHasBadge(handler, "slasher") ? 0.11 : 0)
          + (playerHasBadge(handler, "off-dribble-creator") ? 0.08 : 0)
          + (playerHasBadge(handler, "rim-finisher") ? 0.05 : 0)),
        receiverGap: pressureGap,
        laneGap,
      });
    }
  }

  choices.sort((a, b) => b.score - a.score || a.player.id - b.player.id
    || (a.kind === "shot" ? -1 : b.kind === "shot" ? 1 : a.kind.localeCompare(b.kind)));
  return { handler, choices };
}

function routesForAction(action: BoundAction, run?: SimulationRun, hoop = HOOP_POINT): CourtRoute[] {
  if (action.actorId == null) return [];
  const arrow = action.arrow;
  const scope = (action.onBall ?? (action.actorId === run?.ballHandlerId || (action.partnerId != null && action.partnerId === run?.ballHandlerId) || arrow.kind === "pass" || arrow.kind === "handoff")) ? "on-ball" : "off-ball";
  const override = run?.actionStartOverrides.get(arrow.id);
  const start = override && run && run.elapsedMs >= override.atMs ? override.point : run?.actionStarts.get(arrow.id) ?? action.plannedStart ?? arrow.start;
  const twoLegs = ["pick-roll", "pick-pop", "slip-screen"].includes(arrow.kind);
  const end = arrow.kind === "pick-roll" || arrow.kind === "slip-screen" ? pointToward(arrow.end, hoop, 8) : arrow.kind === "pick-pop" ? arrow.exit_target ?? arrow.end : arrow.end;
  const control = !twoLegs && arrow.path === "curve" ? routeControl(action, start, end) : undefined;
  const common = { actionId: arrow.id, sequence: action.sequence, importance: "main" as const };
  const routes: CourtRoute[] = [{ ...common, id: `${arrow.id}:${action.sequence}:actor`, kind: arrow.kind, scope, playerId: action.actorId, start: { ...start }, end: { ...end }, ...(control ? { control } : {}), ...(twoLegs ? { via: { ...arrow.end } } : {}) }];
  if (action.partnerId != null && action.partnerStart) {
    routes.push({ ...common, id: `${arrow.id}:${action.sequence}:handler`, kind: "handler-support", scope: "on-ball", playerId: action.partnerId, start: { ...action.partnerStart }, end: pointToward(arrow.end, hoop, arrow.kind === "pick-roll" || arrow.kind === "slip-screen" ? 10 : 8) });
  }
  if (arrow.timingPlan && (arrow.kind === "pass" || arrow.kind === "handoff") && action.recipientId != null && action.recipientStart) {
    routes.push({ ...common, id: `${arrow.id}:${action.sequence}:receiver`, kind: "receiver-prep", scope: "on-ball", playerId: action.recipientId, start: { ...action.recipientStart }, end: { ...arrow.end } });
  }
  if ((arrow.kind === "off-ball-screen" || arrow.kind === "pin-down") && action.recipientId != null && action.recipientStart) {
    routes.push({ ...common, id: `${arrow.id}:${action.sequence}:cutter`, kind: "cutter", scope: "off-ball", playerId: action.recipientId, start: { ...action.recipientStart }, via: { ...arrow.end }, end: { ...(arrow.exit_target ?? offBallCutterTarget(arrow.end, hoop)) } });
  }
  if (run && action.execution) {
    for (const route of routes) {
      const path = action.execution.paths.get(route.playerId);
      if (path && arrow.kind !== "pass" && arrow.kind !== "handoff") {
        route.points = path.points.map((point) => ({ ...point }));
        route.start = { ...path.points[0] }; route.end = { ...path.points.at(-1)! };
        delete route.via; delete route.control;
      }
    }
  }
  return routes;
}
export function authoredCourtRoutes(source: PlaybookDraft): CourtRoute[] {
  return buildActions(source).actions.flatMap((action) => routesForAction(action));
}
const runRouteCache = new WeakMap<SimulationRun, { revision: number; hoopX: number; hoopY: number; routes: CourtRoute[] }>();
function invalidateRunRoutes(run: SimulationRun) {
  run.routeRevision += 1;
}
function getRunRoutes(run: SimulationRun, hoop = HOOP_POINT): CourtRoute[] {
  const cached = runRouteCache.get(run);
  if (cached?.revision === run.routeRevision && cached.hoopX === hoop.x && cached.hoopY === hoop.y) return cached.routes;
  const active = run.actions.filter((action) => actionIsObservable(action, run) && !failedTransfer(action.transfer) && run.elapsedMs + 1e-6 >= action.startTime && run.elapsedMs < action.startTime + action.durationMs - 1e-6);
  const routes = active.flatMap((action) => routesForAction(action, run, hoop));
  // Recorded recent movement exposes small receiving, spacing, and coasting
  // adjustments without introducing new actions or changing possession.
  const history = run.routeHistory ?? [];
  const latest = history.at(-1);
  if (latest) for (const player of run.players) {
    const onBall = latest.onBallIds.includes(player.id);
    const since = history.map((sample) => sample.onBallIds.includes(player.id) !== onBall).lastIndexOf(true) + 1;
    const points = history.slice(since).map((sample) => sample.players.find((p) => p.id === player.id)).filter((p): p is PlaybookMarker => Boolean(p)).map(({ x, y }) => ({ x, y }));
    if (points.length > 1 && points.reduce((distance, point, index) => distance + (index ? pointDistanceFeet(points[index - 1], point) : 0), 0) >= .25) routes.push({ id: `adjustment:${player.id}`, actionId: null, sequence: null, kind: "adjustment", playerId: player.id, scope: onBall ? "on-ball" : "off-ball", importance: "adjustment", start: points[0], end: points.at(-1)!, points });
  }
  if (run.shotStart) routes.push({ id: "shot", actionId: null, sequence: null, kind: "shot", playerId: run.shotShooterId ?? run.ballHandlerId ?? 0, scope: "on-ball", importance: "main", start: { ...run.shotStart }, end: { ...hoop } });
  // Frames and observations share only immutable, owned route geometry.
  // Display-frame copies remain mutable and never expose the cache itself.
  for (const route of routes) {
    Object.freeze(route.start); Object.freeze(route.end);
    if (route.control) Object.freeze(route.control);
    if (route.via) Object.freeze(route.via);
    if (route.points) { route.points.forEach(Object.freeze); Object.freeze(route.points); }
    Object.freeze(route);
  }
  Object.freeze(routes);
  runRouteCache.set(run, { revision: run.routeRevision, hoopX: hoop.x, hoopY: hoop.y, routes });
  return routes;
}
function recordRouteHistory(run: SimulationRun) {
  const supports = run.actions.filter((action) => !failedTransfer(action.transfer) && run.elapsedMs >= action.startTime - PASS_PREP_MS && run.elapsedMs < action.startTime + action.durationMs)
    .flatMap((action) => [action.partnerId, ...((action.onBall || (action.partnerId != null && action.partnerId === run.ballHandlerId)) ? [action.actorId] : []), ...(action.arrow.kind === "pass" || action.arrow.kind === "handoff" ? [action.actorId, action.recipientId] : [])]);
  const onBallIds = [...new Set([run.ballHandlerId, ...supports].filter((id): id is number => id != null))];
  run.routeHistory = [...(run.routeHistory ?? []).filter((sample) => run.elapsedMs - sample.atMs <= 300).slice(-23), { atMs: run.elapsedMs, players: run.players.map((p) => ({ ...p })), onBallIds }];
}

export type CounterLabObservation = {
  defensiveResponsibilities: DefensiveResponsibility[];
  elapsedMs: number;
  sequence: number | null;
  action: string | null;
  ballHandlerId: number | null;
  ballPhase: BallPhase;
  assignments: Array<{ defenderId: number; playerId: number }>;
  opportunities: Array<{ kind: LiveReadChoice["kind"]; playerId: number; quality: number; score: number; receiverGap: number; laneGap: number }>;
  blockedPass: { actionId: string; sequence: number; playerId: number; receiverGap: number; laneGap: number } | null;
  involvedPlayerIds: number[];
  activeRoutes: CourtRoute[];
  frame: Pick<SimulationFrame, "ball" | "shotPhase" | "execution"> & {
    players: Array<Pick<PlaybookMarker, "id" | "x" | "y">>;
    defenders: Array<Pick<PlaybookMarker, "id" | "x" | "y">>;
  };
};

/** Return a compact, evidence-based view of the current possession for Counter Lab. */
export function observeCounterLabRun(run: SimulationRun, hoop = HOOP_POINT): CounterLabObservation {
  refreshSimulationAttributes(run.attributes, run.players, run.defenders);
  const { choices } = liveReadChoices(run, hoop);
  const activeActions = run.actions.filter((candidate) => actionIsObservable(candidate, run) && !failedTransfer(candidate.transfer)
    && run.elapsedMs >= candidate.startTime - 1e-6
    && run.elapsedMs < candidate.startTime + candidate.durationMs + 1e-6);
  const action = activeActions.find((candidate) => !candidate.automatic && !candidate.adaptiveReadLabel) ?? activeActions[0] ?? null;
  let blockedPass: CounterLabObservation["blockedPass"] = null;
  const authoredPass = activeActions.find((candidate) => candidate.arrow.kind === "pass" && !candidate.automatic && !candidate.adaptiveReadLabel && candidate.recipientId != null);
  if (authoredPass?.recipientId != null) {
    const recipient = markerForId(run.players, authoredPass.recipientId);
    const handler = markerForId(run.players, authoredPass.actorId);
    if (recipient && handler) {
      const receiverGap = defenderGap(recipient, run.defenders);
      const laneGap = segmentClearanceFeet(run.ball ?? handler, recipient, run.defenders);
      if (receiverGap < 3.5 || laneGap < 2.5) blockedPass = { actionId: authoredPass.arrow.id, sequence: authoredPass.sequence, playerId: recipient.id, receiverGap, laneGap };
    }
  }
  const activeRoutes = getRunRoutes(run, hoop);
  return {
    defensiveResponsibilities: defensiveDutySnapshot(run.defense),
    elapsedMs: run.elapsedMs,
    sequence: action?.sequence ?? null,
    action: activeActions.length ? [...new Set(activeActions.map(autoActionLabel))].join(" · ") : null,
    ballHandlerId: run.ballHandlerId,
    ballPhase: run.ballState.kind,
    assignments: [...run.assignments].map(([defenderId, playerId]) => ({ defenderId, playerId })),
    opportunities: choices.map((choice) => ({
      kind: choice.kind,
      playerId: choice.player.id,
      quality: choice.quality,
      score: choice.score,
      receiverGap: choice.receiverGap,
      laneGap: choice.laneGap,
    })),
    blockedPass,
    involvedPlayerIds: [...new Set([
      ...choices.slice(0, 2).map((choice) => choice.player.id),
      ...activeActions.flatMap((active) => [active.actorId, active.recipientId, active.partnerId].filter((playerId): playerId is number => playerId != null)),
      ...(blockedPass ? [blockedPass.playerId] : []),
    ])],
    activeRoutes,
    frame: {
      players: run.frame.players.map(({ id, x, y }) => ({ id, x, y })),
      defenders: run.frame.defenders.map(({ id, x, y }) => ({ id, x, y })),
      ball: run.frame.ball ? { ...run.frame.ball } : null,
      shotPhase: run.frame.shotPhase,
      execution: run.frame.execution?.map((action) => ({ ...action,
        ...(action.congestion ? { congestion: { ...action.congestion, blockers: [...action.congestion.blockers] } } : {}),
        ...(action.transfer ? { transfer: copyTransfer(action.transfer) } : {}) })),
    },
  };
}

function stopAuthoredActionsAt(run: SimulationRun, timeMs: number) {
  const hasContinuation = run.adaptiveContinuationStartedAtMs != null;
  const ball = run.ballState;
  if (isTransferBall(ball)) {
    run.ballState = transitionBall(ball, { kind: "interrupt", atMs: timeMs,
      reason: "An adaptive read interrupted the transfer", giverPosition: markerForId(run.players, ball.transfer.giverId) ?? undefined });
  }
  run.actions = run.actions.flatMap((action) => {
    if (action.startTime >= timeMs - 1e-6) return [];
    const endTime = action.startTime + action.durationMs;
    if (endTime <= timeMs) return [action];
    const state = executionFor(action);
    if (actionIsMoving(action)) { state.phase = "interrupted"; state.completedAtMs = timeMs; state.notice = "An adaptive read replaced the remaining action"; }
    return [{ ...action, durationMs: Math.max(0, timeMs - action.startTime) }];
  });
  run.actionGraph = new Map(run.actions.filter((action) => action.plan).map((action) => [action.plan!.key, action]));
  run.offBallAnchors.clear();
  run.players.forEach((player) => run.offBallAnchors.set(player.id, { x: player.x, y: player.y }));
  run.actionDurationMs = timeMs;
  run.durationMs = timeMs + run.shotDurationMs;
  run.earlyReadInterrupted = true;
  if (!hasContinuation) {
    run.adaptiveContinuationStartedAtMs = timeMs;
    run.adaptiveActionsTaken = 0;
    run.adaptivePassPairs.clear();
  }
  run.nextEarlyReadMs = timeMs + EARLY_READ_INTERVAL_MS;
}

function beginShot(run: SimulationRun, player: PlaybookMarker, hoop: CourtPoint, atMs = run.elapsedMs) {
  if (run.ballState.kind !== "held" || run.ballHandlerId !== player.id) return false;
  const offBall = calculateOffBallQuality(run.players, run.ball, run.settings, run.defenders, player.id);
  const quality = calculateShotQuality(run.players, run.defenders, player, offBall, hoop, badgeShotContext(run, player, atMs));
  run.ballState = transitionBall(run.ballState, { kind: "shot", shooterId: player.id, atMs, durationMs: run.shotDurationMs, quality });
  run.actionDurationMs = atMs;
  run.durationMs = atMs + run.shotDurationMs;
  return true;
}

function readReason(choice: LiveReadChoice, handler: PlaybookMarker, hoop: CourtPoint) {
  if (choice.kind === "pass") {
    const space = Number.isFinite(choice.receiverGap) ? `${choice.receiverGap.toFixed(1)} ft of space` : "open space";
    const rating = shotSkillRating(choice.player, hoop);
    return `Player ${choice.player.id} has ${space}, a clear passing lane, good floor spacing, and a ${rating}/5 shot rating for ${choice.expectedPoints.toFixed(2)} estimated points`;
  }
  if (choice.kind === "drive") {
    return `Player ${handler.id} has a clear lane and a ${playerRating(handler, "finishing")}/5 finishing rating; the route projects ${choice.expectedPoints.toFixed(2)} points`;
  }
  return `Player ${choice.player.id} has the best available shot at ${choice.expectedPoints.toFixed(2)} estimated points with ${choice.quality}% quality`;
}

function startAdaptiveChoice(run: SimulationRun, choice: LiveReadChoice, hoop: CourtPoint, early = false) {
  const handler = markerForId(run.players, run.ballHandlerId);
  if (!handler) return false;
  const routeStart = run.ball ?? handler;
  if (choice.kind === "pass") {
    run.adaptiveReadReason = readReason(choice, handler, hoop);
    const label = adaptiveRoleLabel(choice.role);
    appendAdaptiveAction(run, "pass", handler, choice.target, choice.player, early ? `Early read: ${label.toLowerCase()}` : label, routeStart);
    return true;
  }
  if (choice.kind === "drive") {
    run.adaptiveReadReason = readReason(choice, handler, hoop);
    appendAdaptiveAction(run, "movement", handler, choice.target, null, early ? "Early read: attack the open lane" : "Attack the open lane", handler);
    return true;
  }
  const earlyLabel = early ? "Early shot" : run.adaptiveActionsTaken >= MAX_ADAPTIVE_ACTIONS ? "Best shot after live reads" : "Take the best available shot";
  run.adaptiveReadLabel = earlyLabel;
  run.adaptiveReadRoute = null;
  run.adaptiveReadReason = readReason(choice, handler, hoop);
  beginShot(run, choice.player, hoop);
  return true;
}

function startEarlyRead(run: SimulationRun, hoop: CourtPoint) {
  if (!markerForId(run.players, run.ballHandlerId) || currentTransferAt(run, run.elapsedMs)) return;
  const { choices } = liveReadChoices(run, hoop);
  const best = choices[0];
  if (!best || best.quality < EARLY_SHOT_MIN_QUALITY || best.expectedPoints < EARLY_SHOT_MIN_EXPECTED_POINTS) return;
  if (run.adaptiveContinuationStartedAtMs != null && best.kind !== "shot") return;

  stopAuthoredActionsAt(run, run.elapsedMs);
  run.adaptiveReadResolved = true;
  if (best.kind === "shot") {
    startAdaptiveChoice(run, best, hoop, true);
    return;
  }
  startAdaptiveChoice(run, best, hoop, true);
}

function resolveAdaptiveRead(run: SimulationRun, hoop: CourtPoint) {
  run.adaptiveReadResolved = true;
  if (run.adaptiveContinuationStartedAtMs == null) run.adaptiveContinuationStartedAtMs = run.elapsedMs;
  const handler = markerForId(run.players, run.ballHandlerId);
  if (!handler) {
    run.adaptiveReadLabel = "No ball handler";
    run.adaptiveReadReason = "The play has no player in possession to continue the action";
    return;
  }

  const { choices } = liveReadChoices(run, hoop);
  const best = choices[0];
  const handlerShot = choices.find((choice) => choice.kind === "shot");
  const bestRoute = choices.find((choice) => choice.kind !== "shot");
  const timeInContinuation = run.elapsedMs - run.adaptiveContinuationStartedAtMs;
  const continueWith = best && best.kind !== "shot"
    ? best
    : (handlerShot?.quality ?? 0) < EARLY_SHOT_MIN_QUALITY ? bestRoute : null;
  const canContinue = continueWith
    && run.adaptiveActionsTaken < MAX_ADAPTIVE_ACTIONS
    && timeInContinuation < MAX_ADAPTIVE_WINDOW_MS
    && timeInContinuation + (continueWith.kind === "pass"
      ? adaptivePassDuration(run.ball ?? handler, continueWith.target)
      : Math.max(
          650,
          pointDistanceFeet(handler, continueWith.target) * 1.5 / OFFENSE_MAX_SPEED_FT_PER_SECOND * 1000,
          2.4 * Math.sqrt(pointDistanceFeet(handler, continueWith.target) / OFFENSE_ACCELERATION_FT_PER_SECOND) * 1000,
        )) <= MAX_ADAPTIVE_WINDOW_MS
    && (continueWith.score > (handlerShot?.score ?? 0) + 0.05
      || (handlerShot?.quality ?? 0) < EARLY_SHOT_MIN_QUALITY);
  if (canContinue && continueWith) {
    startAdaptiveChoice(run, continueWith, hoop);
    return;
  }

  const shotChoice = (best?.kind === "shot" ? best : handlerShot) ?? choices.find((choice) => choice.kind === "shot");
  if (!shotChoice) {
    run.adaptiveReadLabel = "No safe continuation";
    run.adaptiveReadReason = "No player is available to finish the play";
    return;
  }
  run.adaptiveReadLabel = run.adaptiveActionsTaken > 0 ? "Best shot after live reads" : "No safe continuation";
  run.adaptiveReadRoute = null;
  run.adaptiveReadReason = run.adaptiveActionsTaken > 0
    ? readReason(shotChoice, handler, hoop)
    : `Defenders cover the best passing and driving routes, so player ${shotChoice.player.id} takes the shot with the best available expected value`;
  beginShot(run, shotChoice.player, hoop);
}

function actionOverlapsPlayers(action: BoundAction, start: number, end: number, playerIds: Set<number>) {
  return action.startTime < end && action.startTime + action.durationMs > start
    && (playerIds.has(action.actorId ?? -1) || playerIds.has(action.recipientId ?? -1));
}

function bestDefensiveMatchups(players: PlaybookMarker[], defenders: PlaybookMarker[], hoop = HOOP_POINT, handlerId: number | null = null) {
  if (!players.length || !defenders.length) return defenders.map(() => -1);
  const orderedPlayers = players.slice().sort((a, b) => a.id - b.id);
  const orderedDefenders = defenders.slice().sort((a, b) => a.id - b.id);
  const defenderCount = Math.min(orderedPlayers.length, orderedDefenders.length);
  if (defenderCount > 7) return defenders.map((_, index) => orderedPlayers[index % orderedPlayers.length].id);
  const offenseThreat = (player: PlaybookMarker) => playerRating(player, "threePoint")
    + playerRating(player, "midrange") + playerRating(player, "finishing") + badgeThreatScore(player, hoop);
  const interiorThreat = (player: PlaybookMarker) => playerRating(player, "finishing")
    + (playerHasBadge(player, "rim-finisher") ? 1.2 : 0)
    + (playerHasBadge(player, "slasher") ? 0.8 : 0)
    + (playerHasBadge(player, "roll-threat") ? 0.8 : 0)
    + (playerHasBadge(player, "post-scorer") ? 0.5 : 0)
    - Math.min(2, pointDistanceFeet(player, hoop) * 0.06);
  const topThreat = orderedPlayers.slice().sort((a, b) => offenseThreat(b) - offenseThreat(a) || a.id - b.id)[0];
  const interiorThreatPlayer = orderedPlayers.slice().sort((a, b) => interiorThreat(b) - interiorThreat(a) || a.id - b.id)[0];
  const lowestThreat = orderedPlayers.slice().sort((a, b) => offenseThreat(a) - offenseThreat(b) || a.id - b.id)[0];
  const assignmentCost = (defender: PlaybookMarker, player: PlaybookMarker) => {
    let cost = pointDistanceFeet(defender, player);
    if (defenderHasBadge(defender, "lockdown")) {
      if (player.id === topThreat.id) cost -= 5;
      if (player.id === handlerId) cost -= 1.5;
    }
    if (defenderHasBadge(defender, "paint-protector")) {
      if (player.id === interiorThreatPlayer.id) cost -= 5;
      else if (pointDistanceFeet(player, hoop) <= 17) cost -= 1.5;
    }
    if (defenderHasBadge(defender, "helper")) {
      if (player.id === lowestThreat.id) cost -= 4;
      if (playerRating(player, "threePoint") >= 4 || playerHasBadge(player, "deep-range") || playerHasBadge(player, "catch-and-shoot")) cost += 2;
    }
    return cost;
  };
  let bestCost = Number.POSITIVE_INFINITY;
  let best: number[] = [];
  const visit = (defenderIndex: number, used: Set<number>, assignments: number[], cost: number) => {
    if (defenderIndex === defenderCount) {
      if (cost < bestCost) {
        bestCost = cost;
        best = [...assignments];
      }
      return;
    }
    for (let playerIndex = 0; playerIndex < orderedPlayers.length; playerIndex += 1) {
      if (used.has(playerIndex)) continue;
      const nextCost = cost + assignmentCost(orderedDefenders[defenderIndex], orderedPlayers[playerIndex]);
      if (nextCost >= bestCost) continue;
      used.add(playerIndex);
      assignments.push(playerIndex);
      visit(defenderIndex + 1, used, assignments, nextCost);
      assignments.pop();
      used.delete(playerIndex);
    }
  };
  visit(0, new Set<number>(), [], 0);
  const orderedAssignments = orderedDefenders.map((_, index) => {
    const assigned = best[index % Math.max(1, defenderCount)];
    return orderedPlayers[assigned]?.id ?? orderedPlayers[index % orderedPlayers.length].id;
  });
  const byDefenderId = new Map(orderedDefenders.map((defender, index) => [defender.id, orderedAssignments[index]]));
  return defenders.map((defender) => byDefenderId.get(defender.id) ?? -1);
}

function createGoalSideDefenders(players: PlaybookMarker[], existing: PlaybookMarker[], hoop: CourtPoint) {
  if (existing.length) return existing.map((defender) => ({ ...defender }));
  return players.slice(0, MAX_COURT_PLAYERS).map((player, index) => ({
    id: index + 1,
    badges: [],
    ...pointToward(player, hoop, 3.5),
  }));
}

export function placeDefendersGoalSide(players: PlaybookMarker[], defenders: PlaybookMarker[], hoop = HOOP_POINT) {
  const placed = createGoalSideDefenders(players, defenders, hoop);
  refreshSimulationAttributes(createSimulationAttributes(), players, placed);
  const matchups = bestDefensiveMatchups(players, placed, hoop);
  return placed.map((defender, index) => {
    const player = players.find((candidate) => candidate.id === matchups[index]);
    return player ? { ...defender, ...pointToward(player, hoop, 3.5) } : defender;
  });
}

function velocityKey(kind: "player" | "defender", id: number) {
  return kind + ":" + id;
}

function copyFrame(frame: SimulationFrame): SimulationFrame {
  return {
    ...frame,
    defensiveResponsibilities: frame.defensiveResponsibilities?.map(duty => ({ ...duty })),
    execution: frame.execution?.map((action) => ({ ...action,
      ...(action.congestion ? { congestion: { ...action.congestion, blockers: [...action.congestion.blockers] } } : {}),
      ...(action.transfer ? { transfer: copyTransfer(action.transfer) } : {}) })),
    routes: frame.routes.map((route) => ({ ...route, start: { ...route.start }, end: { ...route.end }, control: route.control ? { ...route.control } : undefined, via: route.via ? { ...route.via } : undefined, points: route.points?.map((point) => ({ ...point })) })),
    players: frame.players.map((player) => ({ ...player })),
    defenders: frame.defenders.map((defender) => ({ ...defender })),
    ball: frame.ball ? { ...frame.ball } : null,
    shotStart: frame.shotStart ? { ...frame.shotStart } : null,
    shotTarget: frame.shotTarget ? { ...frame.shotTarget } : null,
    adaptiveReadRoute: frame.adaptiveReadRoute ? {
      ...frame.adaptiveReadRoute,
      start: { ...frame.adaptiveReadRoute.start },
      end: { ...frame.adaptiveReadRoute.end },
    } : null,
  };
}

function frameFor(run: SimulationRun): SimulationFrame {
  const activeActions = run.actions.filter((action) => actionIsObservable(action, run) && !failedTransfer(action.transfer)
    && run.elapsedMs + 1e-6 >= action.startTime
    && run.elapsedMs < action.startTime + action.durationMs - 1e-6);
  const activeAction = activeActions.find((action) => !action.automatic) ?? activeActions[0];
  const actionLabels = activeActions.map(autoActionLabel);
  const shotElapsed = run.elapsedMs - run.actionDurationMs;
  const shotProgress = run.shotStart
    ? clamp(shotElapsed / run.shotDurationMs, 0, 1)
    : 0;
  const shotPhase: SimulationFrame["shotPhase"] = run.ballState.kind === "shot-setup" ? "setup"
    : run.ballState.kind === "shot-in-flight" ? "air" : run.ballState.kind === "shot-result" ? "result" : "idle";
  const shooter = markerForId(run.players, run.shotShooterId ?? run.ballHandlerId);
  const shotQuality = isShotBall(run.ballState) ? run.ballState.quality
    : shooter ? calculateShotQuality(run.players, run.defenders, shooter,
      calculateOffBallQuality(run.players, run.ball, run.settings, run.defenders, shooter.id), HOOP_POINT, badgeShotContext(run, shooter, run.elapsedMs)) : 0;
  return {
    defensiveResponsibilities: defensiveDutySnapshot(run.defense),
    execution: actionDiagnostics(run),
    ballHandlerId: run.ballHandlerId,
    ballPhase: run.ballState.kind,
    players: run.players.map((player) => ({ ...player })),
    defenders: run.defenders.map((defender) => ({ ...defender })),
    ball: run.ball ? { ...run.ball } : null,
    routes: getRunRoutes(run),
    activeSequence: activeAction?.sequence ?? null,
    activeActionLabel: actionLabels.length ? [...new Set(actionLabels)].join(" · ") : null,
    adaptiveReadLabel: run.adaptiveReadLabel,
    adaptiveReadReason: run.adaptiveReadReason,
    adaptiveReadRoute: run.adaptiveReadRoute ? {
      ...run.adaptiveReadRoute,
      start: { ...run.adaptiveReadRoute.start },
      end: { ...run.adaptiveReadRoute.end },
    } : null,
    activeDefenseScheme: run.activeDefenseScheme,
    defenseSchemeWasAutomatic: run.defenseSchemeWasAutomatic,
    defenseSchemeNotice: run.defenseSchemeNotice,
    defensiveQuality: calculateDefensiveQuality(run),
    offBallQuality: calculateOffBallQuality(run.players, run.ball, run.settings, run.defenders, run.ballHandlerId),
    shotPhase,
    shotProgress,
    shotResult: shotPhase === "result" ? (shotQuality >= 68 ? "made" : "missed") : "pending",
    shotQuality,
    shotRelease: isShotBall(run.ballState) ? run.ballState.releaseContext : null,
    shooterId: run.shotShooterId,
    shotStart: run.shotStart ? { ...run.shotStart } : null,
    shotTarget: run.shotStart ? { ...HOOP_POINT } : null,
  };
}

function createInitialFrame(): SimulationFrame {
  return {
    routes: [],
    players: [],
    defenders: [],
    ball: null,
    activeSequence: null,
    activeActionLabel: null,
    adaptiveReadLabel: null,
    adaptiveReadReason: null,
    adaptiveReadRoute: null,
    activeDefenseScheme: null,
    defenseSchemeWasAutomatic: false,
    defenseSchemeNotice: null,
    defensiveQuality: 0,
    offBallQuality: 0,
    shotPhase: "idle",
    shotProgress: 0,
    shotResult: "pending",
    shotQuality: 0,
    shotRelease: null,
    shooterId: null,
    shotStart: null,
    shotTarget: null,
  };
}

/** Inspect authored bindings with the engine's rules, without initializing execution or defense. */
export function bindAuthoredActions(source: PlaybookDraft): BoundAction[] {
  return buildActions(structuredClone(source)).actions;
}

export function createSimulationRun(source: PlaybookDraft, settings: SimulationSettings, hoop = HOOP_POINT, options: { recordSession?: boolean; seed?: number } = {}): SimulationRun {
  const runSettings = normalizeSettings(settings);
  const seed = options.recordSession || options.seed !== undefined ? simulationSeed(options.seed) : undefined;
  const run = initializeSimulationRun(structuredClone(source), runSettings, hoop, undefined, seed === undefined ? Math.random : seededSimulationRandom(seed));
  if (options.recordSession) beginSimulationSession(run, hoop, seed!);
  return run;
}

/** Bind authored actions once; keep the template private and clone mutable state per run. */
export function prepareSimulationRun(source: PlaybookDraft) {
  const sourceCopy = structuredClone(source);
  const authored = buildActions(sourceCopy);
  const arrowIndices = authored.actions.map((action) => sourceCopy.arrows.indexOf(action.arrow));
  return (settings: SimulationSettings, hoop = HOOP_POINT): SimulationRun => {
    const runSettings = normalizeSettings(settings);
    const copy = structuredClone(sourceCopy);
    const manual = {
      ...authored,
      actions: authored.actions.map((action, index) => ({
        ...action,
        plan: action.plan ? structuredClone(action.plan) : undefined,
        ...(action.execution ? { execution: structuredClone(action.execution) } : {}),
        ...(action.transfer ? { transfer: copyTransfer(action.transfer) } : {}),
        arrow: copy.arrows[arrowIndices[index]],
        plannedStart: action.plannedStart ? { ...action.plannedStart } : null,
        recipientStart: action.recipientStart ? { ...action.recipientStart } : null,
        controlOffset: action.controlOffset ? { ...action.controlOffset } : null,
        partnerStart: action.partnerStart ? {
          ...copy.players.find((player) => player.id === action.partnerId),
          x: action.partnerStart.x, y: action.partnerStart.y,
        } : null,
      })),
      finalPositions: authored.finalPositions.map((player, index) => ({ ...copy.players[index], x: player.x, y: player.y })),
    };
    return initializeSimulationRun(copy, runSettings, hoop, manual);
  };
}

function initializeSimulationRun(sourceCopy: PlaybookDraft, runSettings: SimulationSettings, hoop: CourtPoint, authored?: ReturnType<typeof buildActions>, random = Math.random): SimulationRun {
  const players = sourceCopy.players.map((player) => ({ ...player }));
  const ephemeralDefenders = sourceCopy.defenders.length === 0;
  const defenders = createGoalSideDefenders(players, sourceCopy.defenders, hoop);
  const attributes = createSimulationAttributes();
  refreshSimulationAttributes(attributes, players, defenders);
  const defenseSchemeResolution = chooseDefenseScheme(runSettings.defenseScheme, defenders.length, players.length, random);
  const activeDefenseScheme = defenseSchemeResolution.scheme;
  const formation = zoneFormation(activeDefenseScheme);
  const initialBall = sourceCopy.ball ?? players[0] ?? null;
  const initialHandlerId = players[nearestPointIndex(players, initialBall ?? hoop)]?.id ?? null;
  const zoneChaserAssignments = formation
    ? assignZoneChasers(defenders, players, formation.chasers, hoop)
    : new Map<number, number>();
  const zoneAssignments = formation
    ? assignZoneDefenders(defenders, zoneAnchors(activeDefenseScheme, hoop), new Set(zoneChaserAssignments.keys()), hoop)
    : new Map<number, number>();
  const assignments = new Map<number, number>();
  bestDefensiveMatchups(players, defenders, hoop, initialHandlerId).forEach((playerId, index) => assignments.set(defenders[index].id, playerId));
  const initialAssignments = new Map(assignments);
  const manual = authored ?? buildActions(sourceCopy);
  const actions = [...manual.actions];
  let actionDurationMs = manual.actionDurationMs;
  const projectedPlayers = manual.finalPositions.map((player) => ({ ...player }));
  const projectedHandlerId = manual.ballHandlerId;
  const projectedHandler = markerForId(projectedPlayers, projectedHandlerId);
  const projectedBall = projectedHandler ? { x: projectedHandler.x, y: projectedHandler.y } : sourceCopy.ball;
  const excludedForOnBall = new Set<number>();
  let nextSequence = Math.max(0, ...actions.map((action) => action.sequence)) + 1;

  if (runSettings.offenseMode !== "scripted" && runSettings.automaticActions.offBallScreen) {
    const arrow = automaticOffBallArrow(projectedPlayers, defenders, projectedHandlerId, nextSequence++);
    if (arrow) {
      const single = buildActions({ ...sourceCopy, players: projectedPlayers, ball: projectedBall, arrows: [arrow] }).actions[0];
      if (single) {
        let startTime = manual.actionDurationMs;
        const participants = new Set([single.actorId ?? -1, single.recipientId ?? -1]);
        for (let candidate = 0; candidate + single.durationMs <= manual.actionDurationMs; candidate += 100) {
          if (!manual.actions.some((action) => actionOverlapsPlayers(action, candidate, candidate + single.durationMs, participants))) {
            startTime = candidate;
            break;
          }
        }
        const automatic = { ...single, startTime, automatic: true };
        actions.push(automatic);
        actionDurationMs = Math.max(actionDurationMs, startTime + automatic.durationMs);
        if (automatic.actorId != null) excludedForOnBall.add(automatic.actorId);
        if (automatic.recipientId != null) excludedForOnBall.add(automatic.recipientId);
      }
    }
  }

  if (runSettings.offenseMode !== "scripted" && (runSettings.automaticActions.screen || runSettings.automaticActions.handoff || runSettings.automaticActions.pickRoll)) {
    const arrow = automaticOnBallArrow(projectedPlayers, defenders, projectedHandlerId, hoop, runSettings, excludedForOnBall, nextSequence++);
    if (arrow) {
      const single = buildActions({ ...sourceCopy, players: projectedPlayers, ball: projectedBall, arrows: [arrow] }).actions[0];
      if (single) {
        const endOfOtherAuto = actions.filter((action) => action.automatic).reduce((end, action) => Math.max(end, action.startTime + action.durationMs), manual.actionDurationMs);
        const startTime = Math.max(manual.actionDurationMs, endOfOtherAuto);
        const partnerId = arrow.kind === "screen" || arrow.kind === "pick-roll" ? projectedHandlerId : null;
        const partner = markerForId(projectedPlayers, partnerId);
        const automatic: BoundAction = {
          ...single,
          startTime,
          automatic: true,
          partnerId,
          partnerStart: partner ? { x: partner.x, y: partner.y } : null,
        };
        actions.push(automatic);
        actionDurationMs = Math.max(actionDurationMs, startTime + automatic.durationMs);
      }
    }
  }

  const ball = sourceCopy.ball
    ? { ...sourceCopy.ball }
    : players[0]
      ? { x: players[0].x, y: players[0].y }
      : null;
  const ballHandlerId = players[nearestPointIndex(players, ball ?? hoop)]?.id ?? null;
  const run: SimulationRun = {
    routeRevision: 0,
    attributes,
    movementBuffers: { solver: createMovementBuffers(), intents: [], intentMap: new Map(), playerPositions: new Map(), defenderPositions: new Map() },
    movementOrder: createMovementOrder([...players.map((player) => velocityKey("player", player.id)), ...defenders.map((defender) => velocityKey("defender", defender.id))]),
    actions,
    actionGraph: attachActionPlans(actions, ballHandlerId),
    actionDurationMs,
    durationMs: actionDurationMs + SIMULATION_SHOT_MS,
    assignments,
    defense: createDefensiveTeamState(),
    initialAssignments,
    ephemeralDefenders,
    activeDefenseScheme,
    defenseSchemeWasAutomatic: defenseSchemeResolution.automatic,
    defenseSchemeNotice: defenseSchemeResolution.notice,
    zoneAssignments,
    zoneChaserAssignments,
    zoneBallDefenderId: null,
    zoneBallHandlerId: initialHandlerId,
    zoneBallChangedAtMs: 0,
    screenCoverageLocks: new Map(),
    switchedActions: new Set(),
    actionStarts: new Map(),
    actionStartOverrides: new Map(),
    offBallAnchors: new Map(players.map((player) => [player.id, { x: player.x, y: player.y }])),
    targetFilters: new Map(),
    velocities: new Map(),
    recipientStartOverrides: new Map(),
    offBallTargetSkills: new Map(players.map((player) => [player.id, offBallTargetSkill(player, hoop)])),
    lastReceiveAtMs: new Map(),
    lastCatchEvidence: new Map(),
    source: sourceCopy,
    settings: runSettings,
    players,
    defenders,
    ballState: placedBall(ball, ballHandlerId),
    get ball() { return this.ballState.position; },
    get ballHandlerId() { return ballController(this.ballState); },
    get shotStart() { return isShotBall(this.ballState) ? this.ballState.start : null; },
    get shotShooterId() { return isShotBall(this.ballState) ? this.ballState.shooterId : null; },
    get shotQualityAtRelease() { return isShotBall(this.ballState) ? this.ballState.releaseContext?.quality ?? 0 : 0; },
    get helpDefenderId() { return this.defense.helper?.defenderId ?? null; },
    defensiveDriveThreatUntilMs: 0,
    defensiveDriveThreatHandlerId: initialHandlerId,
    elapsedMs: 0,
    accumulatorMs: 0,
    previousFrame: createInitialFrame(),
    shotDurationMs: SIMULATION_SHOT_MS,
    plannedActionDurationMs: actionDurationMs,
    nextEarlyReadMs: EARLY_READ_START_MS,
    adaptiveActionsTaken: 0,
    adaptiveContinuationStartedAtMs: null,
    adaptivePassPairs: new Set(),
    earlyReadInterrupted: false,
    adaptiveReadResolved: false,
    adaptiveReadLabel: null,
    adaptiveReadReason: null,
    adaptiveReadRoute: null,
    frame: createInitialFrame(),
  };
  refreshActionSchedule(run);
  if (formation) {
    const initialHandler = markerForId(players, ballHandlerId);
    if (initialHandler) {
      run.zoneBallDefenderId = [...zoneAssignments.entries()]
        .sort((a, b) => pointDistanceFeet(zoneAnchors(activeDefenseScheme, hoop)[a[1]], initialHandler)
          - pointDistanceFeet(zoneAnchors(activeDefenseScheme, hoop)[b[1]], initialHandler)
          || a[0] - b[0])[0]?.[0] ?? null;
    }
  }
  run.actions.forEach((action) => action.execution?.paths.clear());
  run.offBallDecisions?.clear();
  run.routeHistory = [];
  defensiveTargets(run, 0, hoop);
  run.frame = frameFor(run);
  run.previousFrame = run.frame;
  return run;
}

export function getSimulationFrame(run: SimulationRun) {
  if (run.elapsedMs >= run.durationMs || !run.previousFrame) return copyFrame(run.frame);
  const progress = clamp(run.accumulatorMs / SIMULATION_FIXED_STEP_MS, 0, 1);
  const previousPlayers = new Map(run.previousFrame.players.map((player) => [player.id, player]));
  const previousDefenders = new Map(run.previousFrame.defenders.map((defender) => [defender.id, defender]));
  const current = copyFrame(run.frame);
  if (run.previousFrame.activeSequence !== current.activeSequence || run.previousFrame.activeActionLabel !== current.activeActionLabel || run.previousFrame.ballHandlerId !== current.ballHandlerId || run.previousFrame.ballPhase !== current.ballPhase) return current;
  current.players = current.players.map((player) => {
    const previous = previousPlayers.get(player.id);
    return previous ? { ...player, ...interpolatePosition(previous, player, progress) } : player;
  });
  current.defenders = current.defenders.map((defender) => {
    const previous = previousDefenders.get(defender.id);
    return previous ? { ...defender, ...interpolatePosition(previous, defender, progress) } : defender;
  });
  if (run.previousFrame.ball && current.ball && run.previousFrame.ballHandlerId === current.ballHandlerId && run.previousFrame.shotPhase === current.shotPhase) current.ball = interpolatePosition(run.previousFrame.ball, current.ball, progress);
  return current;
}

export function setSimulationRunSettings(run: SimulationRun, settings: SimulationSettings) {
  const nextSettings = normalizeSettings(settings, run.settings);
  refreshSimulationAttributes(run.attributes, run.players, run.defenders);
  // Equivalent values retain both settings and frame; the run's defense scheme
  // remains fixed. Mutable caller objects are checked again on every entry.
  if (nextSettings === run.settings) return;
  resetCongestionPlanning(run);
  const previousStrategy = run.settings.defenseStrategy;
  if (previousStrategy !== nextSettings.defenseStrategy) {
    resetDefensiveDuties(run.defense);
    run.screenCoverageLocks.clear();
    run.switchedActions.clear();
  }
  if (previousStrategy === "switch" && nextSettings.defenseStrategy !== "switch") {
    run.assignments.clear();
    run.initialAssignments.forEach((playerId, defenderId) => run.assignments.set(defenderId, playerId));
  }
  invalidateRunRoutes(run);
  run.settings = nextSettings;
  run.frame = frameFor(run);
  recordSimulationSettings(run);
}

function moveToward(
  point: CourtPoint,
  target: CourtPoint,
  velocity: Velocity,
  maxSpeedFeetPerSecond: number,
  accelerationFeetPerSecond: number,
  deltaSeconds: number,
): { point: CourtPoint; velocity: Velocity } {
  const start = toCourtFeet(point);
  const end = toCourtFeet(target);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.02 && Math.hypot(velocity.x, velocity.y) < accelerationFeetPerSecond * deltaSeconds) return { point: { ...point }, velocity: { x: 0, y: 0 } };
  const brakingSpeed = Math.sqrt(2 * accelerationFeetPerSecond * distance);
  const desiredSpeed = Math.min(maxSpeedFeetPerSecond, brakingSpeed, distance * 5);
  const desired = distance > .001 ? { x: (dx / distance) * desiredSpeed, y: (dy / distance) * desiredSpeed } : { x: 0, y: 0 };
  const deltaVelocity = { x: desired.x - velocity.x, y: desired.y - velocity.y };
  const change = Math.hypot(deltaVelocity.x, deltaVelocity.y);
  const maxChange = accelerationFeetPerSecond * deltaSeconds;
  const scale = change > maxChange && change > 0 ? maxChange / change : 1;
  const nextVelocity = {
    x: velocity.x + deltaVelocity.x * scale,
    y: velocity.y + deltaVelocity.y * scale,
  };
  const nextSpeed = Math.hypot(nextVelocity.x, nextVelocity.y);
  if (nextSpeed > maxSpeedFeetPerSecond) {
    nextVelocity.x *= maxSpeedFeetPerSecond / nextSpeed;
    nextVelocity.y *= maxSpeedFeetPerSecond / nextSpeed;
  }
  const next = clampCourt(fromCourtFeet({
    x: start.x + nextVelocity.x * deltaSeconds,
    y: start.y + nextVelocity.y * deltaSeconds,
  }));
  return { point: next, velocity: nextVelocity };
}

function swapAssignments(run: SimulationRun, firstPlayerId: number | null, secondPlayerId: number | null) {
  if (firstPlayerId == null || secondPlayerId == null || firstPlayerId === secondPlayerId) return false;
  const firstDefender = run.defenders.find((defender) => run.assignments.get(defender.id) === firstPlayerId);
  const secondDefender = run.defenders.find((defender) => run.assignments.get(defender.id) === secondPlayerId);
  if (!firstDefender || !secondDefender || firstDefender.id === secondDefender.id) return false;
  run.assignments.set(firstDefender.id, secondPlayerId);
  run.assignments.set(secondDefender.id, firstPlayerId);
  run.defense.recoveries.delete(firstDefender.id);
  run.defense.recoveries.delete(secondDefender.id);
  return true;
}

function processActionStart(run: SimulationRun, action: BoundAction) {
  if (action.execution?.startedAtMs != null) return;
  const state = executionFor(action);
  state.startedAtMs = run.elapsedMs;
  state.phase = action.arrow.kind === "pass" || action.arrow.kind === "handoff" ? "transfer" : "approach";
  if (action.arrow.kind === "pass" || action.arrow.kind === "handoff") {
    if (run.ballState.kind !== "held" || action.actorId !== run.ballHandlerId || action.actorId == null
      || action.actorId === action.recipientId || action.recipientId == null || !markerForId(run.players, action.recipientId)) {
      blockAction(run, action, "obstructed", "The intended passer cannot transfer the ball in its current state", run.elapsedMs);
      return;
    }
    const record = transferFor(action);
    run.ballState = transitionBall(run.ballState, { kind: "transfer", record, atMs: run.elapsedMs });
  }
  if (action.partnerId != null && action.partnerId !== run.ballHandlerId) {
    action.partnerId = run.ballHandlerId;
    action.partnerStart = markerForId(run.players, run.ballHandlerId) ?? null;
  }
}

function switchAtInteraction(run: SimulationRun, action: BoundAction, screenedId: number | null) {
  if (run.switchedActions.has(action.arrow.id) || run.settings.defenseStrategy !== "switch" || !isManScheme(run.activeDefenseScheme)) return;
  if (action.arrow.kind === "slip-screen") return;
  const actor = markerForId(run.players, action.actorId), user = markerForId(run.players, screenedId);
  if (!actor || !user || pointDistanceFeet(actor, user) > 4) return;
  const state = executionFor(action);
  if (action.arrow.kind !== "handoff" && state.phase !== "use" && state.phase !== "release") return;
  if (swapAssignments(run, action.actorId, screenedId)) run.switchedActions.add(action.arrow.id);
}

function currentActionAt(run: SimulationRun, timeMs: number) {
  return run.actions.find((action) => actionIsExecuting(action) && timeMs >= action.startTime - 1e-6 && timeMs < action.startTime + action.durationMs + 1e-6) ?? null;
}

function currentTransferAt(run: SimulationRun, _timeMs: number) {
  const state = run.ballState;
  return isTransferBall(state) ? run.actionGraph.get(state.transfer.actionKey) ?? null : null;
}

function currentPrepAt(run: SimulationRun, timeMs: number) {
  return run.actions.find((action) => {
    if (!actionIsMoving(action) || action.recipientId == null || failedTransfer(action.transfer) || (action.arrow.kind !== "pass" && action.arrow.kind !== "handoff")) return false;
    const prepWindow = Math.min(PASS_PREP_MS, Math.max(180, action.durationMs * 0.42));
    return timeMs >= Math.max(0, action.startTime - prepWindow) && timeMs < action.startTime;
  }) ?? null;
}

type ScreenCoverage = {
  action: BoundAction;
  screenerIndex: number;
  screenedIndex: number;
  screenerId: number;
  screenedId: number;
};

function zoneAnchorFor(run: SimulationRun, defenderId: number, hoop = HOOP_POINT) {
  const slot = run.zoneAssignments.get(defenderId);
  if (slot == null) return null;
  return zoneAnchors(run.activeDefenseScheme, hoop)[slot] ?? null;
}

function coverageDefenderIndex(run: SimulationRun, playerId: number, excluded = new Set<number>()) {
  if (isManScheme(run.activeDefenseScheme)) {
    return run.defenders.findIndex((defender) => !excluded.has(defender.id) && run.assignments.get(defender.id) === playerId);
  }
  const chaser = [...run.zoneChaserAssignments.entries()].find(([, markedPlayerId]) => markedPlayerId === playerId)?.[0];
  if (chaser != null && !excluded.has(chaser)) return run.defenders.findIndex((defender) => defender.id === chaser);
  const owner = [...run.defense.duties.values()].find(duty => duty.playerId === playerId && duty.role !== "helper"
    && !excluded.has(duty.defenderId) && run.zoneAssignments.has(duty.defenderId));
  if (owner) return run.defenders.findIndex(defender => defender.id === owner.defenderId);
  return run.defenders
    .filter((defender) => !excluded.has(defender.id) && run.zoneAssignments.has(defender.id))
    .sort((a, b) => {
      const player = markerForId(run.players, playerId);
      const aAnchor = zoneAnchorFor(run, a.id) ?? a;
      const bAnchor = zoneAnchorFor(run, b.id) ?? b;
      return pointDistanceFeet(aAnchor, player ?? a) - pointDistanceFeet(bAnchor, player ?? b) || a.id - b.id;
    })
    .map((defender) => run.defenders.findIndex((candidate) => candidate.id === defender.id))[0] ?? -1;
}

function screenCoverageActionsAt(run: SimulationRun, timeMs: number) {
  return run.actions
    .filter((action) => {
      if (failedTransfer(action.transfer) || !actionIsExecuting(action)) return false;
      const kind = action.arrow.kind;
      if (kind === "slip-screen") return false;
      if (kind === "handoff" && (isManScheme(run.activeDefenseScheme) || run.settings.defenseStrategy !== "switch")) return false;
      return (kind === "screen" || kind === "pick-roll" || kind === "pick-pop" || kind === "off-ball-screen" || kind === "pin-down" || kind === "handoff")
        && timeMs >= action.startTime
        && timeMs < action.startTime + action.durationMs;
    })
    .sort((a, b) => Number(Boolean(a.automatic)) - Number(Boolean(b.automatic)) || a.sequence - b.sequence || a.startTime - b.startTime);
}

function primeScreenCoverageLocks(run: SimulationRun, timeMs: number) {
  const activeScreens = screenCoverageActionsAt(run, timeMs);
  const activeIds = new Set(activeScreens.map(action => action.arrow.id));
  for (const [id, lock] of run.screenCoverageLocks) {
    const action = activeScreens.find(a => a.arrow.id === id);
    const screenedId = action?.arrow.kind === "off-ball-screen" || action?.arrow.kind === "pin-down" || action?.arrow.kind === "handoff"
      ? action.recipientId : action?.partnerId ?? run.ballHandlerId;
    if (!activeIds.has(id) || !lock || lock.screenerId !== action?.actorId || lock.screenedId !== screenedId || !run.defenders.some(d => d.id === lock.screenerDefenderId)
      || !run.defenders.some(d => d.id === lock.screenedDefenderId)) run.screenCoverageLocks.delete(id);
  }
  const usedPlayers = new Set<number>();
  const usedDefenders = new Set<number>();

  // Existing coverages keep their participants until the action ends. New
  // actions can only claim players and defenders that are still free.
  for (const action of activeScreens) {
    const lock = run.screenCoverageLocks.get(action.arrow.id);
    if (!run.screenCoverageLocks.has(action.arrow.id) || !lock) continue;
    const screenerId = action.actorId;
    const screenedId = action.arrow.kind === "handoff"
      ? action.recipientId
      : action.arrow.kind === "off-ball-screen" || action.arrow.kind === "pin-down"
        ? action.recipientId
        : action.partnerId ?? run.ballHandlerId;
    if (screenerId == null || screenedId == null || screenerId === screenedId
      || usedPlayers.has(screenerId) || usedPlayers.has(screenedId)
      || usedDefenders.has(lock.screenerDefenderId) || usedDefenders.has(lock.screenedDefenderId)) continue;
    if (!run.defenders.some((defender) => defender.id === lock.screenerDefenderId)
      || !run.defenders.some((defender) => defender.id === lock.screenedDefenderId)) continue;
    usedPlayers.add(screenerId);
    usedPlayers.add(screenedId);
    usedDefenders.add(lock.screenerDefenderId);
    usedDefenders.add(lock.screenedDefenderId);
  }
  for (const action of activeScreens) {
    const screenerId = action.actorId;
    const screenedId = action.arrow.kind === "handoff"
      ? action.recipientId
      : action.arrow.kind === "off-ball-screen" || action.arrow.kind === "pin-down"
      ? action.recipientId
      : action.partnerId ?? run.ballHandlerId;
    if (screenerId == null || screenedId == null || screenerId === screenedId) {
      if (!run.screenCoverageLocks.has(action.arrow.id)) run.screenCoverageLocks.set(action.arrow.id, null);
      continue;
    }
    const existingLock = run.screenCoverageLocks.get(action.arrow.id);
    if (run.screenCoverageLocks.has(action.arrow.id)) {
      if (!existingLock || usedPlayers.has(screenerId) || usedPlayers.has(screenedId)
        || usedDefenders.has(existingLock.screenerDefenderId) || usedDefenders.has(existingLock.screenedDefenderId)) continue;
      const screenerExists = run.defenders.some((defender) => defender.id === existingLock.screenerDefenderId);
      const screenedExists = run.defenders.some((defender) => defender.id === existingLock.screenedDefenderId);
      if (!screenerExists || !screenedExists) continue;
      usedPlayers.add(screenerId);
      usedPlayers.add(screenedId);
      usedDefenders.add(existingLock.screenerDefenderId);
      usedDefenders.add(existingLock.screenedDefenderId);
      continue;
    }
    if (usedPlayers.has(screenerId) || usedPlayers.has(screenedId)) {
      run.screenCoverageLocks.set(action.arrow.id, null);
      continue;
    }
    const screenerIndex = coverageDefenderIndex(run, screenerId, usedDefenders);
    const screenerDefenderId = screenerIndex < 0 ? null : run.defenders[screenerIndex].id;
    const screenedIndex = coverageDefenderIndex(
      run,
      screenedId,
      new Set(screenerDefenderId == null ? usedDefenders : [...usedDefenders, screenerDefenderId]),
    );
    if (screenerDefenderId == null || screenerIndex < 0 || screenedIndex < 0 || screenerIndex === screenedIndex) {
      run.screenCoverageLocks.set(action.arrow.id, null);
      continue;
    }
    const screenedDefenderId = run.defenders[screenedIndex].id;
    if (usedDefenders.has(screenerDefenderId) || usedDefenders.has(screenedDefenderId)) {
      run.screenCoverageLocks.set(action.arrow.id, null);
      continue;
    }
    run.screenCoverageLocks.set(action.arrow.id, { screenerDefenderId, screenedDefenderId, screenerId, screenedId });
    usedPlayers.add(screenerId);
    usedPlayers.add(screenedId);
    usedDefenders.add(screenerDefenderId);
    usedDefenders.add(screenedDefenderId);
  }
}

function screenCoveragesAt(run: SimulationRun, timeMs: number) {
  primeScreenCoverageLocks(run, timeMs);
  const usedPlayers = new Set<number>();
  const usedDefenders = new Set<number>();
  const coverages: ScreenCoverage[] = [];
  for (const action of screenCoverageActionsAt(run, timeMs)) {
    if (action.arrow.kind !== "handoff" && !["set", "use", "release"].includes(action.execution?.phase ?? "pending")) continue;
    const lock = run.screenCoverageLocks.get(action.arrow.id);
    const screenerId = action.actorId;
    const screenedId = action.arrow.kind === "handoff"
      ? action.recipientId
      : action.arrow.kind === "off-ball-screen" || action.arrow.kind === "pin-down"
        ? action.recipientId
        : action.partnerId ?? run.ballHandlerId;
    if (!lock || screenerId == null || screenedId == null || screenerId === screenedId
      || usedPlayers.has(screenerId) || usedPlayers.has(screenedId)
      || usedDefenders.has(lock.screenerDefenderId) || usedDefenders.has(lock.screenedDefenderId)) continue;
    const screenerIndex = run.defenders.findIndex((defender) => defender.id === lock.screenerDefenderId);
    const screenedIndex = run.defenders.findIndex((defender) => defender.id === lock.screenedDefenderId);
    if (screenerIndex < 0 || screenedIndex < 0 || screenerIndex === screenedIndex) continue;
    usedPlayers.add(screenerId);
    usedPlayers.add(screenedId);
    usedDefenders.add(lock.screenerDefenderId);
    usedDefenders.add(lock.screenedDefenderId);
    coverages.push({ action, screenerIndex, screenedIndex, screenerId, screenedId });
  }
  return coverages;
}

function separateDefenderTargets(
  run: SimulationRun,
  targets: CourtPoint[],
  protectedIds: Set<number>,
) {
  if (run.settings.defenseStrategy === "off") return targets;
  const separated = targets.map((target) => ({ ...target }));
  const order = run.defenders.map((defender, index) => ({ defender, index })).sort((a, b) => a.defender.id - b.defender.id);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let left = 0; left < order.length; left += 1) {
      for (let right = left + 1; right < order.length; right += 1) {
        const a = order[left];
        const b = order[right];
        const aProtected = protectedIds.has(a.defender.id);
        const bProtected = protectedIds.has(b.defender.id);
        if (aProtected && bProtected) continue;
        const aTarget = separated[a.index];
        const bTarget = separated[b.index];
        const distance = pointDistanceFeet(aTarget, bTarget);
        if (distance >= DEFENDER_SOFT_SPACING_FEET) continue;
        let dx = toCourtFeet(aTarget).x - toCourtFeet(bTarget).x;
        let dy = toCourtFeet(aTarget).y - toCourtFeet(bTarget).y;
        let length = Math.hypot(dx, dy);
        if (length < 0.001) {
          dx = a.defender.id < b.defender.id ? 1 : -1;
          dy = 0;
          length = 1;
        }
        const correction = Math.min(1.1, (DEFENDER_SOFT_SPACING_FEET - distance) * (aProtected || bProtected ? 0.8 : 0.5));
        const x = dx / length;
        const y = dy / length;
        if (!aProtected) separated[a.index] = clampCourt(addFeet(aTarget, { x: x * correction, y: y * correction }));
        if (!bProtected) separated[b.index] = clampCourt(addFeet(bTarget, { x: -x * correction, y: -y * correction }));
      }
    }
  }
  return separated;
}

function actionStartFor(run: SimulationRun, action: BoundAction) {
  const override = run.actionStartOverrides.get(action.arrow.id);
  if (override && run.elapsedMs >= override.atMs) return override.point;
  const existing = run.actionStarts.get(action.arrow.id);
  if (existing) return existing;
  const player = markerForId(run.players, action.actorId);
  const start = player ? { x: player.x, y: player.y } : action.plannedStart ?? action.arrow.start;
  run.actionStarts.set(action.arrow.id, start);
  return start;
}

function recordActionStarts(run: SimulationRun, timeMs: number) {
  run.actions.forEach((action) => {
    if (!actionIsExecuting(action) || timeMs < action.startTime || run.actionStarts.has(action.arrow.id)) return;
    const player = markerForId(run.players, action.actorId);
    if (player) run.actionStarts.set(action.arrow.id, { x: player.x, y: player.y });
  });
}


function offBallTarget(run: SimulationRun, player: PlaybookMarker, ball: CourtPoint, timeMs: number, driveThreat: boolean, hoop: CourtPoint) {
  const anchor = run.offBallAnchors.get(player.id) ?? player;
  const style = run.settings.offenseOffBall;
  if (style === "off") return { ...anchor };
  const intensity = clamp(run.settings.offBallIntensity / 100, 0, 1);
  const maxOffset = (style === "cuts" ? 9 : style === "spacing" ? 4 : 6) * intensity;
  let target = { ...anchor };
  const ballGap = pointDistanceFeet(anchor, ball);
  if (ballGap < 23) {
    const anchorFeet = toCourtFeet(anchor);
    const ballFeet = toCourtFeet(ball);
    const dx = anchorFeet.x - ballFeet.x;
    const dy = anchorFeet.y - ballFeet.y;
    const length = Math.max(0.01, Math.hypot(dx, dy));
    const offset = Math.min(maxOffset, 23 - ballGap);
    target = addFeet(anchor, { x: (dx / length) * offset, y: (dy / length) * offset });
  } else if (ballGap > 27) {
    target = pointToward(anchor, ball, Math.min(maxOffset, ballGap - 27));
  }
  if (driveThreat && style !== "spacing") {
    const cutPoint = pointToward(anchor, hoop, maxOffset * .8);
    const eligible = playerRating(player, "finishing") >= 4 || playerHasBadge(player, "cutter") || playerHasBadge(player, "slasher");
    const clear = segmentClearanceFeet(player, cutPoint, run.players.filter((other) => other.id !== player.id)) >= 2.4
      && segmentClearanceFeet(player, cutPoint, run.defenders) >= 2.4;
    const reserved = [...(run.offBallDecisions ?? new Map()).entries()].some(([id, decision]) => id !== player.id && decision.cutting && pointDistanceFeet(decision.target, cutPoint) < 5);
    if (eligible && clear && !reserved) target = cutPoint;
  }

  const targetSkill = run.offBallTargetSkills.get(player.id) ?? null;
  if (targetSkill) {
    const desiredRadius = targetSkill === "threePoint"
      ? NBA_COURT_GEOMETRY.threePoint.radiusFeet + (playerHasBadge(player, "deep-range") ? 2 : 0.75)
      : targetSkill === "midrange" ? 15.5 : targetSkill === "post" ? 10.5 : 7.5;
    const desired = pointToward(hoop, anchor, desiredRadius);
    const hoopFeet = toCourtFeet(hoop);
    const desiredFeet = toCourtFeet(desired);
    const radialLength = Math.max(0.01, Math.hypot(desiredFeet.x - hoopFeet.x, desiredFeet.y - hoopFeet.y));
    const lateral = { x: -(desiredFeet.y - hoopFeet.y) / radialLength, y: (desiredFeet.x - hoopFeet.x) / radialLength };
    const locationOptions = [0, -3.5, 3.5].map((offset) => addFeet(desired, { x: lateral.x * offset, y: lateral.y * offset }));
    const openLocation = locationOptions
      .map((point, index) => {
        const defenderSpace = Math.min(16, defenderGap(point, run.defenders));
        const teammateSpace = Math.min(18, nearestTeammateGap({ ...player, ...point }, player.id, run.players));
        const ballSpacing = Math.abs(pointDistanceFeet(point, ball) - 23);
        const movementCost = pointDistanceFeet(anchor, point);
        return { point, index, score: defenderSpace + teammateSpace * 0.55 - ballSpacing * 0.18 - movementCost * 0.12 };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.point ?? desired;
    const roleRating = playerRating(player, targetSkill === "post" ? "midrange" : targetSkill);
    const badgeWeight = playerHasBadge(player, "deep-range") || playerHasBadge(player, "catch-and-shoot")
      || playerHasBadge(player, "post-scorer") || playerHasBadge(player, "cutter")
      || playerHasBadge(player, "slasher") || playerHasBadge(player, "rim-finisher")
      || playerHasBadge(player, "roll-threat") || playerHasBadge(player, "off-dribble-creator");
    const roleWeight = badgeWeight ? (roleRating >= 4 ? 0.78 : 0.68) : roleRating >= 4 ? 0.7 : 0.58;
    target = lerpPoint(target, openLocation, roleWeight);
  }
  const offset = pointDistanceFeet(anchor, target);
  target = offset > maxOffset && offset > 0 ? pointToward(anchor, target, maxOffset) : clampCourt(target);
  const decisions = run.offBallDecisions ??= new Map();
  const previous = decisions.get(player.id);
  if (previous && timeMs - previous.sinceMs < 700) return previous.target;
  if (previous && pointDistanceFeet(previous.target, target) < 1.5) return previous.target;
  const occupied = [...decisions.entries()].some(([id, decision]) => id !== player.id && pointDistanceFeet(decision.target, target) < 4);
  if (occupied) target = { ...anchor };
  decisions.set(player.id, { target, sinceMs: timeMs, cutting: driveThreat && style !== "spacing" && pointDistanceFeet(target, hoop) < pointDistanceFeet(anchor, hoop) - 2 });
  return target;
}

function driveThreat(run: SimulationRun, hoop: CourtPoint) {
  const handler = markerForId(run.players, run.ballHandlerId);
  if (!handler) return false;
  const velocity = run.velocities.get(velocityKey("player", handler.id)) ?? { x: 0, y: 0 };
  const hoopFeet = toCourtFeet(hoop);
  const playerFeet = toCourtFeet(handler);
  const dx = hoopFeet.x - playerFeet.x;
  const dy = hoopFeet.y - playerFeet.y;
  const distance = Math.max(0.01, Math.hypot(dx, dy));
  const towardHoopSpeed = (velocity.x * dx + velocity.y * dy) / distance;
  const finishingThreat = playerRating(handler, "finishing") >= 2
    && (playerHasBadge(handler, "slasher") || playerHasBadge(handler, "rim-finisher") || playerHasBadge(handler, "roll-threat"));
  return towardHoopSpeed > (finishingThreat ? 1.65 : 2.5) && distance < (finishingThreat ? 34 : 30);
}

function sustainedDefensiveDriveThreat(run: SimulationRun, handler: PlaybookMarker | null, timeMs: number, hoop: CourtPoint) {
  const handlerId = handler?.id ?? null;
  if (run.defensiveDriveThreatHandlerId !== handlerId) {
    run.defensiveDriveThreatHandlerId = handlerId;
    run.defensiveDriveThreatUntilMs = 0;
  }
  if (handler && driveThreat(run, hoop)) run.defensiveDriveThreatUntilMs = timeMs + DEFENSIVE_DRIVE_GRACE_MS;
  return handler != null && timeMs < run.defensiveDriveThreatUntilMs;
}

function helpSpotFor(handler: PlaybookMarker, hoop: CourtPoint, finishingRating = 3) {
  const depth = clamp(0.34 + (finishingRating - 3) * 0.075, 0.18, 0.5);
  const maxDepth = finishingRating >= 3.8 ? 13 : finishingRating <= 2 ? 7 : 9;
  return pointToward(handler, hoop, Math.min(maxDepth, pointDistanceFeet(handler, hoop) * depth));
}

function anticipatedPlayerPoint(
  run: SimulationRun,
  player: PlaybookMarker,
  seconds: number,
  maxLeadFeet: number,
) {
  const velocity = run.velocities.get(velocityKey("player", player.id)) ?? { x: 0, y: 0 };
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed < 0.75) return player;
  const lead = Math.min(maxLeadFeet, speed * seconds);
  return clampCourt(addFeet(player, { x: (velocity.x / speed) * lead, y: (velocity.y / speed) * lead }));
}

function defenderContainmentTarget(
  run: SimulationRun,
  player: PlaybookMarker,
  hoop: CourtPoint,
  goalSideGap: number,
  onBall: boolean,
) {
  const anticipated = anticipatedPlayerPoint(
    run,
    player,
    onBall ? ON_BALL_ANTICIPATION_SECONDS : OFF_BALL_ANTICIPATION_SECONDS,
    onBall ? ON_BALL_ANTICIPATION_MAX_FEET : OFF_BALL_ANTICIPATION_MAX_FEET,
  );
  return pointToward(anticipated, hoop, goalSideGap);
}

// A live pass redirects pressure toward its receiver without granting possession.
// Loose-ball reactions follow the ball, never the incidental roster order.
function defensiveFocusPlayer(run: SimulationRun, timeMs: number) {
  const transfer = currentTransferAt(run, timeMs);
  const receiver = transfer?.arrow.kind === "pass" && transfer.execution?.phase === "transfer"
    ? markerForId(run.players, transfer.recipientId) : null;
  const ball = run.ball;
  return receiver ?? markerForId(run.players, run.ballHandlerId)
    ?? markerForId(run.players, run.shotShooterId)
    ?? (ball ? run.players.slice().sort((a, b) => pointDistanceFeet(a, ball) - pointDistanceFeet(b, ball) || a.id - b.id)[0] : null)
    ?? null;
}

function strategyForScreen(run: SimulationRun, action: BoundAction) {
  return run.settings.defenseStrategy === "switch" && (isManScheme(run.activeDefenseScheme)
    ? run.switchedActions.has(action.arrow.id) : action.arrow.kind === "handoff"
      ? action.execution?.usedAtMs != null : ["use", "release"].includes(action.execution?.phase ?? ""));
}

function defensiveTargets(run: SimulationRun, timeMs: number, hoop: CourtPoint) {
  const handler = defensiveFocusPlayer(run, timeMs);
  const activeAction = currentActionAt(run, timeMs);
  const isMan = isManScheme(run.activeDefenseScheme);
  const formation = zoneFormation(run.activeDefenseScheme);
  const allScreenCoverages = screenCoveragesAt(run, timeMs);
  const screenCoverages = run.settings.defenseStrategy === "switch" && isMan ? [] : allScreenCoverages;
  const reservedScreens = screenCoverageActionsAt(run, timeMs).flatMap(action => {
    const lock = run.screenCoverageLocks.get(action.arrow.id);
    if (!lock) return [];
    const switched = strategyForScreen(run, action);
    return [{ defenderId: lock.screenerDefenderId, playerId: switched ? lock.screenedId : lock.screenerId, actionId: action.arrow.id },
      { defenderId: lock.screenedDefenderId, playerId: switched ? lock.screenerId : lock.screenedId, actionId: action.arrow.id }];
  });
  const reservedScreenIds = new Set(reservedScreens.map(s => s.defenderId));
  const coverageByDefender = new Map<number, { coverage: ScreenCoverage; role: "screener" | "screened" }>();
  screenCoverages.forEach((coverage) => {
    coverageByDefender.set(run.defenders[coverage.screenerIndex].id, { coverage, role: "screener" });
    coverageByDefender.set(run.defenders[coverage.screenedIndex].id, { coverage, role: "screened" });
  });
  const transfer = currentTransferAt(run, timeMs);
  const drive = sustainedDefensiveDriveThreat(run,
    !transfer && !run.shotStart ? markerForId(run.players, run.ballHandlerId) : null, timeMs, hoop);
  const strategy = run.settings.defenseStrategy;
  const anchors = formation ? zoneAnchors(run.activeDefenseScheme, hoop) : [];
  const zoneShapeTargets = new Map<number, CourtPoint>();
  if (formation && handler) {
    const chaserForHandler = [...run.zoneChaserAssignments.entries()].find(([, playerId]) => playerId === handler.id)?.[0] ?? null;
    const nearestSlot = [...run.zoneAssignments.entries()]
      .sort((a, b) => pointDistanceFeet(anchors[a[1]], handler) - pointDistanceFeet(anchors[b[1]], handler) || a[0] - b[0])[0];
    const possessionChanged = run.zoneBallHandlerId !== handler.id;
    const currentBallDefender = run.zoneBallDefenderId;
    const currentAnchor = currentBallDefender == null ? null : zoneAnchorFor(run, currentBallDefender, hoop);
    if (possessionChanged) {
      run.zoneBallHandlerId = handler.id;
      run.zoneBallDefenderId = nearestSlot?.[0] ?? null;
      run.zoneBallChangedAtMs = timeMs;
    } else if (currentBallDefender == null || !run.zoneAssignments.has(currentBallDefender)) {
      run.zoneBallDefenderId = nearestSlot?.[0] ?? null;
      run.zoneBallChangedAtMs = timeMs;
    } else if (nearestSlot && currentAnchor
      && timeMs - run.zoneBallChangedAtMs >= ZONE_BALL_MIN_HOLD_MS
      && pointDistanceFeet(anchors[nearestSlot[1]], handler) + ZONE_BALL_SWITCH_MARGIN_FEET < pointDistanceFeet(currentAnchor, handler)) {
      run.zoneBallDefenderId = nearestSlot[0];
      run.zoneBallChangedAtMs = timeMs;
    }
    if (chaserForHandler != null) run.zoneBallDefenderId = run.zoneBallDefenderId ?? nearestSlot?.[0] ?? null;
  }
  const zoneBallDefenderId = formation
    ? [...run.zoneChaserAssignments.entries()].find(([, playerId]) => playerId === handler?.id)?.[0] ?? run.zoneBallDefenderId
    : null;
  let handlerDefenderIndex = handler
    ? formation
      ? run.defenders.findIndex((defender) => defender.id === zoneBallDefenderId)
      : run.defenders.findIndex((defender) => run.assignments.get(defender.id) === handler.id)
    : -1;
  if (handler && handlerDefenderIndex < 0 && isMan && run.defenders.length) {
    // A partial roster may have no original matchup for the ball threat. Give
    // that responsibility to one available defender rather than disabling the team.
    const available = run.defenders.filter(d => !reservedScreenIds.has(d.id));
    const owner = (available.length ? available : run.defenders).slice().sort((a, b) =>
      pointDistanceFeet(a, handler) - pointDistanceFeet(b, handler) || a.id - b.id)[0];
    run.assignments.set(owner.id, handler.id);
    handlerDefenderIndex = run.defenders.findIndex(d => d.id === owner.id);
  }
  if (handler && formation) {
    const locked = reservedScreens.find(s => s.playerId === handler.id);
    if (locked) handlerDefenderIndex = run.defenders.findIndex(d => d.id === locked.defenderId);
  }
  const helpStyle = strategy === "help" || strategy === "trap-rotate" || strategy === "protect-paint";
  const finishingRating = handler ? helpFinishingRating(handler) : 3;
  const helpWeight = clamp(0.55 + finishingRating * 0.15, 0.7, 1.3);
  const helpSpot = handler ? helpSpotFor(handler, hoop, finishingRating) : hoop;
  // The locked screen defender already supplies the second trap participant.
  // Release voluntary drive help immediately instead of committing a third body.
  const screenTrapCommitted = strategy === "trap-rotate" && screenCoverages.some(coverage => coverage.screenedId === handler?.id);
  const helperCandidates = screenTrapCommitted ? [] : run.defenders.flatMap((defender, index) => {
    if (index === handlerDefenderIndex || run.zoneChaserAssignments.has(defender.id) || reservedScreenIds.has(defender.id)) return [];
    if (!helpStyle && !defenderHasBadge(defender, "helper") && !defenderHasBadge(defender, "paint-protector")) return [];
    const anchor = formation ? zoneAnchorFor(run, defender.id, hoop) : null;
    const assignment = anchor
      ? markerForId(run.players, run.defense.duties.get(defender.id)?.playerId ?? null)
        ?? run.players.filter(p => ![...run.zoneChaserAssignments.values()].includes(p.id))
          .sort((a, b) => pointDistanceFeet(anchor, a) - pointDistanceFeet(anchor, b) || a.id - b.id)[0]
      : markerForId(run.players, run.assignments.get(defender.id) ?? null);
    const protectsShooter = assignment && pointDistanceFeet(assignment, hoop) > 19 && pointDistanceFeet(defender, assignment) > 8
      && (playerRating(assignment, "threePoint") >= 4 || playerHasBadge(assignment, "deep-range") || playerHasBadge(assignment, "catch-and-shoot"));
    const committed = run.helpDefenderId === defender.id;
    if ((!committed && protectsShooter) || (!formation && assignment?.id === handler?.id) || transfer?.recipientId === assignment?.id) return [];
    const distance = pointDistanceFeet(defender, helpSpot);
    const range = defenderHasBadge(defender, "helper") ? 21 : defenderHasBadge(defender, "paint-protector") ? 19 : 18;
    if (distance > range && run.helpDefenderId !== defender.id) return [];
    const threat = assignment ? defensiveThreatRating(assignment, hoop) : 3;
    const perimeterRisk = assignment ? Math.max(0, playerRating(assignment, "threePoint") - 3) * 2
      + Number(playerHasBadge(assignment, "deep-range") || playerHasBadge(assignment, "catch-and-shoot")) * 2 : 0;
    const badgePriority = Number(defenderHasBadge(defender, "helper")) * 4
      + Number(defenderHasBadge(defender, "paint-protector") && handler && pointDistanceFeet(handler, hoop) <= 18) * 2.5;
    return [{ id: defender.id, score: distance + (threat - 3) * 1.15 + perimeterRisk - badgePriority }];
  }).sort((a, b) => a.score - b.score || a.id - b.id).map(candidate => candidate.id);
  const rimCandidates = run.defenders.slice().sort((a, b) => {
    const cost = (d: PlaybookMarker) => pointDistanceFeet(zoneAnchorFor(run, d.id, hoop) ?? d, hoop)
      - Number(defenderHasBadge(d, "paint-protector")) * 6
      - (run.defense.duties.get(d.id)?.role === "rim-protector"
        ? timeMs - run.defense.duties.get(d.id)!.sinceMs < 320 ? 1000 : 4 : 0);
    return cost(a) - cost(b) || a.id - b.id;
  }).map(d => d.id);
  coordinateDefensiveDuties(run.defense, {
    atMs: timeMs, strategy, zone: Boolean(formation), players: run.players, defenders: run.defenders,
    assignments: run.assignments, zoneAssignments: run.zoneAssignments, chasers: run.zoneChaserAssignments,
    primary: handlerDefenderIndex >= 0 && handler ? { defenderId: run.defenders[handlerDefenderIndex].id, playerId: handler.id } : null,
    screens: reservedScreens,
    drive, helperCandidates, rimCandidates, distance: pointDistanceFeet,
    anchor: id => zoneAnchorFor(run, id, hoop), threat: player => defensiveThreatRating(player, hoop),
  });
  const helperIndex = run.defenders.findIndex(d => d.id === run.helpDefenderId);
  // Rotations may exchange zone slots. Rebuild their shape targets in this same
  // step so inherited duties never use the departing defender's old slot.
  if (formation) for (const [id, slot] of run.zoneAssignments) {
    const anchor = anchors[slot];
    if (!anchor) continue;
    const ballFeet = toCourtFeet(run.ball ?? handler ?? hoop), anchorFeet = toCourtFeet(anchor);
    let target = addFeet(anchor, { x: clamp((ballFeet.x - anchorFeet.x) * .28, -4.5, 4.5), y: 0 });
    if (handler && pointDistanceFeet(handler, hoop) < 18) target = pointToward(target, hoop, clamp((18 - pointDistanceFeet(handler, hoop)) * .15, 0, 2.5));
    zoneShapeTargets.set(id, target);
  }
  const transferDefenderIndex = transfer?.recipientId == null
    ? -1
    : formation
      ? coverageDefenderIndex(run, transfer.recipientId)
      : run.defenders.findIndex((defender) => run.assignments.get(defender.id) === transfer.recipientId);
  const targets = run.defenders.map((defender, index) => {
    const duty = run.defense.duties.get(defender.id);
    const assignmentId = formation ? duty?.playerId : run.assignments.get(defender.id);
    const assignment = markerForId(run.players, assignmentId ?? null) ?? handler;
    if (!handler || !assignment || strategy === "off") return { ...defender };
    const isOnBall = index === handlerDefenderIndex;
    if (!formation && duty?.playerId == null && !isOnBall) return { x: defender.x, y: defender.y };
    const hasPriorityDuty = isOnBall || reservedScreenIds.has(defender.id) || run.zoneChaserAssignments.has(defender.id);
    const canRotateForHelp = !hasPriorityDuty;
    const isHelper = duty?.role === "helper";
    const isRimProtector = duty?.role === "rim-protector";
    let target: CourtPoint;
    if (formation) {
      const chaserId = run.zoneChaserAssignments.get(defender.id);
      if (chaserId != null) {
        const chaser = markerForId(run.players, chaserId) ?? handler;
        const chaserGap = defenderGoalSideGapFor(defender, chaser, hoop, 4.25);
        target = defenderContainmentTarget(run, chaser, hoop, chaserGap, chaser.id === handler.id);
      } else {
        target = zoneShapeTargets.get(defender.id) ?? defender;
        if (isOnBall) {
          const goalSideGap = defenderGoalSideGapFor(defender, handler, hoop, strategy === "trap-rotate" ? 3.25 : 4.2);
          target = lerpPoint(target, defenderContainmentTarget(run, handler, hoop, goalSideGap, true), 0.82);
        } else {
          const closeout = markerForId(run.players, duty?.playerId ?? null);
          if (closeout) {
            const distance = pointDistanceFeet(target, closeout);
            const score = distance - (defensiveThreatRating(closeout, hoop) - 3) * 1.2;
            const closeoutGap = defenderGoalSideGapFor(defender, closeout, hoop, score < 8 ? 4.5 : 6.5);
            const closeoutPoint = defenderContainmentTarget(run, closeout, hoop, closeoutGap, false);
            target = lerpPoint(target, closeoutPoint, clamp(0.58 - distance * 0.018, 0.28, 0.58));
          }
        }
      }
    } else {
      const playerToGuard = isOnBall ? handler : assignment;
      const baseGoalSideGap = strategy === "trap-rotate" && drive ? 2.75 : 3.75;
      const goalSideGap = defenderGoalSideGapFor(defender, playerToGuard, hoop, baseGoalSideGap);
      target = defenderContainmentTarget(run, playerToGuard, hoop, goalSideGap, isOnBall);
      if (run.activeDefenseScheme === "pack-line" && !isOnBall) {
        const rating = defensiveThreatRating(assignment, hoop);
        const sagSpot = pointToward(assignment, hoop, Math.min(13, pointDistanceFeet(assignment, hoop) * 0.48));
        target = lerpPoint(target, sagSpot, clamp(0.22 + (3 - rating) * 0.1, 0.05, 0.48));
      }
    }
    if (canRotateForHelp && isRimProtector && defenderHasBadge(defender, "paint-protector")) {
      const assignmentDistance = pointDistanceFeet(assignment, hoop);
      const assignmentThreat = defensiveThreatRating(assignment, hoop);
      if (assignmentDistance > 12 && assignmentThreat < 5.2) {
        const paintSpot = pointToward(assignment, hoop, Math.min(9, assignmentDistance * 0.46));
        target = lerpPoint(target, paintSpot, 0.18);
      }
    }
    if (canRotateForHelp && isHelper && defenderHasBadge(defender, "helper")) {
      target = lerpPoint(target, helpSpot, drive ? 0.12 : 0.06);
    }
    if (canRotateForHelp && strategy === "help") {
      if (isHelper) target = lerpPoint(target, helpSpot, clamp((formation ? 0.48 : 0.62) * helpWeight, 0.3, 0.84));
    }
    if (canRotateForHelp && strategy === "trap-rotate") {
      if (isHelper) target = formation
        ? lerpPoint(target, pointToward(handler, hoop, 4.5), 0.68)
        : pointToward(handler, hoop, 4.5);
    }
    if (canRotateForHelp && isRimProtector && drive && helpStyle && strategy !== "protect-paint") {
      const rimSupport = pointToward(hoop, handler, Math.min(8, pointDistanceFeet(handler, hoop)));
      target = pointToward(target, rimSupport, Math.min(2.5, pointDistanceFeet(target, rimSupport) * .18));
    }
    if (canRotateForHelp && strategy === "deny-lanes") {
      const ball = run.ball ?? handler;
      const laneTarget = formation ? lerpPoint(target, ball, 0.28) : lerpPoint(assignment, ball, 0.48);
      target = lerpPoint(target, laneTarget, formation ? 0.24 : 0.35);
    }
    if (canRotateForHelp && strategy === "protect-paint") {
      const paintAnchor = formation ? target : assignment;
      const paintSpot = pointToward(paintAnchor, hoop, Math.min(10, pointDistanceFeet(paintAnchor, hoop) * 0.4));
      target = lerpPoint(target, paintSpot, clamp((isHelper ? 0.82 : formation ? 0.28 : 0.55) * helpWeight, 0.25, 0.95));
    }
    if (drive && handler && canRotateForHelp) {
      const handlerDistance = pointDistanceFeet(handler, hoop);
      if (index === helperIndex && defenderHasBadge(defender, "helper")) {
        const pressureSpot = pointToward(handler, hoop, Math.min(5.5, handlerDistance * 0.34));
        target = lerpPoint(target, helpSpot, helpStyle ? 0.28 : 0.56);
        target = lerpPoint(target, pressureSpot, 0.16);
      }
      if (isRimProtector && handlerDistance <= 16 && defenderHasBadge(defender, "paint-protector")) {
        const rimSpot = pointToward(handler, hoop, 4.5);
        target = lerpPoint(target, rimSpot, 0.36);
      }
    }
    if (canRotateForHelp && handler && playerHasBadge(handler, "playmaker")) {
      const likelyReceiver = assignment;
      if (likelyReceiver.id !== handler.id) {
        const laneTarget = lerpPoint(handler, likelyReceiver, 0.44);
        target = lerpPoint(target, laneTarget, formation ? 0.1 : 0.12);
      }
    }
    if (canRotateForHelp && assignmentId != null && playerHasBadge(assignment, "post-scorer") && pointDistanceFeet(assignment, hoop) <= 19) {
      const postHelp = pointToward(assignment, hoop, Math.min(9.5, pointDistanceFeet(assignment, hoop) * 0.5));
      target = lerpPoint(target, postHelp, formation ? 0.12 : 0.16);
    }
    const rollAction = activeAction?.arrow.kind === "pick-roll" || activeAction?.arrow.kind === "slip-screen" ? activeAction : null;
    const roller = rollAction ? markerForId(run.players, rollAction.actorId) : null;
    if (roller && playerHasBadge(roller, "roll-threat") && canRotateForHelp && assignment.id === roller.id) {
      const rollTarget = defenderContainmentTarget(run, roller, hoop, defenderGoalSideGapFor(defender, roller, hoop, 3.1), false);
      target = lerpPoint(target, rollTarget, formation ? 0.22 : 0.3);
    }
    if (formation && transferDefenderIndex === index && transfer?.recipientId != null) {
      const recipient = markerForId(run.players, transfer.recipientId);
      const progress = clamp((timeMs - transfer.startTime) / transfer.durationMs, 0, 1);
      if (recipient) target = lerpPoint(target, defenderContainmentTarget(run, recipient, hoop, defenderGoalSideGapFor(defender, recipient, hoop, 4), false), 0.2 + progress * 0.5);
    } else if (!formation && transfer?.recipientId === assignment.id) {
      const progress = clamp((timeMs - transfer.startTime) / transfer.durationMs, 0, 1);
      target = lerpPoint(target, assignment, 0.3 + progress * 0.4);
    }
    if (!formation && activeAction && (activeAction.arrow.kind === "screen" || activeAction.arrow.kind === "slip-screen" || activeAction.arrow.kind === "pick-roll" || activeAction.arrow.kind === "pick-pop")
      && strategy === "contain" && (isOnBall || activeAction.partnerId === assignment.id)) {
      const start = activeAction.plannedStart ?? activeAction.arrow.start;
      const end = activeAction.arrow.end;
      const progress = clamp((timeMs - activeAction.startTime) / activeAction.durationMs, 0, 1);
      target = lerpPoint(target, lerpPoint(start, end, progress), 0.12);
    }
    if (duty?.role === "recovery") {
      const inheritedPlayer = markerForId(run.players, duty.playerId);
      if (formation) target = zoneShapeTargets.get(defender.id) ?? target;
      else if (inheritedPlayer) target = defenderContainmentTarget(run, inheritedPlayer, hoop, defenderGoalSideGapFor(defender, inheritedPlayer, hoop, 3.75), false);
    }
    const coverageRole = coverageByDefender.get(defender.id);
    if (coverageRole) {
      const { action, screenedId, screenerId } = coverageRole.coverage;
      if (action.arrow.kind === "handoff") {
        if (strategyForScreen(run, action)) {
          const otherId = coverageRole.role === "screener" ? screenedId : screenerId;
          const other = markerForId(run.players, otherId);
          if (other) target = lerpPoint(target, defenderContainmentTarget(run, other, hoop, defenderGoalSideGapFor(defender, other, hoop, 4), other.id === handler.id), formation ? 0.62 : 0.85);
        }
        const handoffScreener = markerForId(run.players, screenerId);
        if (coverageRole.role === "screener" && handoffScreener && playerHasBadge(handoffScreener, "screen-setter")) {
          target = lerpPoint(target, defenderContainmentTarget(run, handoffScreener, hoop, defenderGoalSideGapFor(defender, handoffScreener, hoop, 3), false), formation ? 0.18 : 0.28);
        }
        return clampCourt(target);
      }
      const screenPoint = action.arrow.end;
      // Coverage follows the executed interaction, not the authored duration:
      // waiting for an approach or catch must not rewind a defender's recovery.
      const releaseProgress = action.execution?.releasedAtMs == null ? 0
        : clamp((timeMs - action.execution.releasedAtMs) / 400, 0, 1);
      const screenedPlayer = markerForId(run.players, screenedId) ?? handler;
      const coverageScreener = markerForId(run.players, screenerId);
      if (coverageRole.role === "screener" && coverageScreener && playerHasBadge(coverageScreener, "screen-setter")) {
        target = lerpPoint(target, defenderContainmentTarget(run, coverageScreener, hoop, defenderGoalSideGapFor(defender, coverageScreener, hoop, 3), false), formation ? 0.18 : 0.28);
      }
      if (strategy === "switch" && formation && strategyForScreen(run, action)) {
        const otherId = coverageRole.role === "screener" ? screenedId : screenerId;
        const other = markerForId(run.players, otherId);
        if (other) target = lerpPoint(target, defenderContainmentTarget(run, other, hoop, defenderGoalSideGapFor(defender, other, hoop, 4), other.id === handler.id), 0.62);
      } else if (strategy === "fight-over" && coverageRole.role === "screened") {
        const outsideRoute = pointToward(screenPoint, hoop, -3.25);
        const coverageWeight = formation ? 0.72 : 1;
        const routeTarget = lerpPoint(outsideRoute, target, releaseProgress);
        target = lerpPoint(target, routeTarget, coverageWeight);
      } else if (strategy === "go-under" && coverageRole.role === "screened") {
        const insideRoute = pointToward(screenPoint, hoop, 3.25);
        const coverageWeight = formation ? 0.72 : 1;
        const routeTarget = lerpPoint(insideRoute, target, releaseProgress);
        target = lerpPoint(target, routeTarget, coverageWeight);
      } else if (strategy === "drop" && coverageRole.role === "screener") {
        const dropSpot = pointToward(screenPoint, hoop, 5.25);
        target = lerpPoint(target, dropSpot, (0.78 - releaseProgress * 0.58) * (formation ? 0.68 : 1));
      } else if ((strategy === "hedge" || strategy === "trap-rotate") && coverageRole.role === "screener") {
        const hedgeSpot = pointToward(screenPoint, screenedPlayer, 2.25);
        const hedgeAmount = strategy === "trap-rotate" ? 0.86 : 0.62;
        const recovery = 1 - releaseProgress;
        target = lerpPoint(target, hedgeSpot, hedgeAmount * recovery * (formation ? 0.68 : 1));
      }
    }
    return clampCourt(target);
  });
  const protectedIds = new Set(coverageByDefender.keys());
  run.zoneChaserAssignments.forEach((_, defenderId) => protectedIds.add(defenderId));
  if (handlerDefenderIndex >= 0) protectedIds.add(run.defenders[handlerDefenderIndex].id);
  if (drive && helperIndex >= 0) protectedIds.add(run.defenders[helperIndex].id);
  return { targets: separateDefenderTargets(run, targets, protectedIds), drive, helperIndex, handlerDefenderIndex, helpSpot };
}

function integrateMarker(
  run: SimulationRun,
  kind: "player" | "defender",
  marker: PlaybookMarker,
  target: CourtPoint,
  dt: number,
  maxSpeed: number,
  acceleration: number,
) {
  const key = velocityKey(kind, marker.id);
  const currentVelocity = run.velocities.get(key) ?? { x: 0, y: 0 };
  const moved = moveToward(marker, target, currentVelocity, maxSpeed, acceleration, dt);
  if (run.motionIntents) {
    const existing = run.motionIntents.get(key);
    run.motionIntents.set(key, { key, point: toCourtFeet(marker), velocity: moved.velocity, previousVelocity: currentVelocity,
      speed: maxSpeed, acceleration, priority: kind === "defender" ? 2 : existing?.priority ?? 1,
      frozen: existing?.priority === 100 && Math.hypot(currentVelocity.x, currentVelocity.y) < .5,
      corridor: existing?.corridor, navigation: existing?.navigation, target: toCourtFeet(target) });
    return marker;
  }
  run.velocities.set(key, moved.velocity);
  return { ...marker, ...moved.point };
}

function smoothAITarget(
  run: SimulationRun,
  kind: "player" | "defender",
  marker: PlaybookMarker,
  target: CourtPoint,
  dt: number,
) {
  const key = velocityKey(kind, marker.id);
  const previous = run.targetFilters.get(key) ?? { x: marker.x, y: marker.y };
  const weight = 1 - Math.exp(-AI_TARGET_RESPONSE_PER_SECOND * Math.max(0, dt));
  const smoothed = lerpPoint(previous, target, weight);
  run.targetFilters.set(key, smoothed);
  return smoothed;
}

function coastMarker(run: SimulationRun, kind: "player" | "defender", marker: PlaybookMarker, dt: number, deceleration: number) {
  return integrateMarker(run, kind, marker, marker, dt, kind === "player" ? OFFENSE_MAX_SPEED_FT_PER_SECOND : DEFENDER_MAX_SPEED_FT_PER_SECOND, deceleration);
}

function integrateBall(run: SimulationRun, target: CourtPoint, dt: number) {
  const current = run.ball ?? target;
  const moved = moveToward(current, target, run.ballState.velocity, BALL_MAX_SPEED_FT_PER_SECOND, BALL_ACCELERATION_FT_PER_SECOND, dt);
  run.ballState.position = moved.point;
  run.ballState.velocity = moved.velocity;
}

function executionFor(action: BoundAction): ActionRuntime {
  return action.execution ??= { actionId: action.arrow.id, sequence: action.sequence, actorId: action.actorId,
    recipientId: action.recipientId, partnerId: action.partnerId ?? null,
    phase: "pending", startedAtMs: null, completedAtMs: null, progress: 0, notice: null, paths: new Map(), routeProgress: new Map(), waitMs: 0 };
}
function transferFor(action: BoundAction): TransferRecord {
  if (action.arrow.kind !== "pass" && action.arrow.kind !== "handoff") throw new Error("Only transfers have ball evidence");
  return action.transfer ??= { actionKey: action.plan?.key ?? `${action.arrow.id}:${action.sequence}`,
    kind: action.arrow.kind, giverId: action.actorId, receiverId: action.recipientId,
    release: null, arrival: null, outcome: { kind: "pending" } };
}
function actionDiagnostics(run: SimulationRun): ActionDiagnostic[] {
  return run.actions.filter((action) => action.execution).map((action) => {
    const { actionId, sequence, actorId, recipientId, phase, startedAtMs, completedAtMs, progress, notice, setAtMs, usedAtMs, releasedAtMs, congestion } = action.execution!;
    return { actionId, sequence, actorId, recipientId, partnerId: action.partnerId ?? null, phase, startedAtMs, completedAtMs, progress, notice, setAtMs, usedAtMs, releasedAtMs,
      ...(congestion ? { congestion: { ...congestion, blockers: [...congestion.blockers] } } : {}), ...(action.transfer ? { transfer: copyTransfer(action.transfer) } : {}) };
  });
}

/** Opt-in local verification only. No snapshots are allocated by normal runs.
 * Observe every executed slice, including slices at catch/action boundaries. */
const executionAuditors = new WeakMap<SimulationRun, (snapshot: SimulationExecutionSnapshot) => void>();
export type SimulationExecutionSnapshot = ReturnType<typeof inspectSimulationExecution>;
export function watchSimulationExecution(run: SimulationRun, audit: (snapshot: SimulationExecutionSnapshot) => void) {
  if (executionAuditors.has(run)) throw new Error("This run already has an execution auditor");
  executionAuditors.set(run, audit);
  return () => { if (executionAuditors.get(run) === audit) executionAuditors.delete(run); };
}

/** Independent diagnostic copies; never return live paths, transfers or Maps.
 * Completion geometry is sampled at execution time, before later moves/edits. */
export function inspectSimulationExecution(run: SimulationRun) {
  return {
    elapsedMs: run.elapsedMs, durationMs: run.durationMs, accumulatorMs: run.accumulatorMs,
    defenseScheme: run.activeDefenseScheme,
    ball: structuredClone(run.ballState), controllerId: run.ballHandlerId,
    frame: { controllerId: run.frame.ballHandlerId, ballPhase: run.frame.ballPhase, ball: run.frame.ball ? { ...run.frame.ball } : null },
    markers: [...run.players.map(p => ({ ...p, team: "player" as const })), ...run.defenders.map(p => ({ ...p, team: "defender" as const }))]
      .map(p => ({ id: p.id, x: p.x, y: p.y, team: p.team, velocity: { ...run.velocities.get(velocityKey(p.team, p.id)) ?? { x: 0, y: 0 } } })),
    actions: run.actions.map(action => {
      const screen = isScreenAction(action), userId = screen ? screenUserId(action) : null;
      return {
        key: `${action.arrow.id}:${action.sequence}`, kind: action.arrow.kind,
        actorId: action.actorId, recipientId: action.recipientId, userId,
        automatic: Boolean(action.automatic || action.adaptiveReadLabel),
        startTime: action.startTime, durationMs: action.durationMs,
        execution: action.execution ? structuredClone({ ...action.execution, paths: undefined }) : null,
        transfer: action.transfer ? copyTransfer(action.transfer) : null,
        dependencies: action.plan?.dependencies.map(edge => ({ ...edge })) ?? [],
        target: { ...(screen && ["pick-roll", "pick-pop", "slip-screen"].includes(action.arrow.kind) ? screenFinish(action, HOOP_POINT) : action.arrow.end) },
        userTarget: screen ? { ...screenUserFinish(action, HOOP_POINT) } : null,
        paths: [...action.execution?.paths ?? []].map(([playerId, path]) => ({ playerId, progress: path.progress, length: path.length })),
      };
    }),
  };
}
function actionIsMoving(action: BoundAction) {
  return action.execution?.phase !== "interrupted" && action.execution?.phase !== "obstructed" && action.execution?.phase !== "conflict" && action.execution?.phase !== "completed";
}
function actionIsExecuting(action: BoundAction) {
  return action.execution?.startedAtMs != null && actionIsMoving(action);
}
/** Settle ownership before publishing the boundary frame. An automatic route
 * may have extended beyond its planned slot into a later authored movement. */
function resolveMovementOwners(run: SimulationRun, actions: BoundAction[], atMs: number) {
  const owners = new Map<number, BoundAction>();
  for (const action of actions.filter(action => actionIsExecuting(action) && action.arrow.kind !== "pass" && action.arrow.kind !== "handoff")
    .sort((a, b) => Number(Boolean(a.automatic || a.adaptiveReadLabel)) - Number(Boolean(b.automatic || b.adaptiveReadLabel)))) {
    if (action.actorId == null) continue;
    if (owners.has(action.actorId)) blockAction(run, action, "conflict", `Move ${action.sequence} conflicts with another route for player ${action.actorId}`, atMs);
    else owners.set(action.actorId, action);
  }
  return owners;
}
function actionIsObservable(action: BoundAction, run: SimulationRun) {
  return actionIsExecuting(action) || run.elapsedMs === 0 && action.startTime === 0 && actionIsMoving(action) && !action.plan?.dependencies.length;
}
function attachActionPlans(actions: BoundAction[], initialHandlerId: number | null): Map<string, BoundAction> {
  const plans = actions.every((action) => action.plan && !action.automatic)
    ? null
    : compileActionDependencies(actions.map((action) => ({ key: `${action.arrow.id}:${action.sequence}`,
      sequence: action.sequence, startTime: action.startTime, kind: action.arrow.kind,
      actorId: action.actorId, recipientId: action.recipientId, userId: screenUserId(action),
      onBall: Boolean(action.onBall), automatic: Boolean(action.automatic || action.adaptiveReadLabel),
      ...(isScreenAction(action) ? { userTarget: screenUserFinish(action, HOOP_POINT) } : {}) })), initialHandlerId);
  const graph = new Map<string, BoundAction>();
  for (const action of actions) {
    if (plans) action.plan = plans.get(`${action.arrow.id}:${action.sequence}`)!;
    if (action.plan!.failure) {
      const state = executionFor(action), failure = action.plan!.failure!;
      state.phase = failure.phase; state.notice = failure.notice; state.completedAtMs = 0;
      if (action.arrow.kind === "pass" || action.arrow.kind === "handoff") {
        transferFor(action).outcome = { kind: "failed", atMs: 0, reason: failure.notice };
      }
    }
    graph.set(action.plan!.key, action);
  }
  return graph;
}
function blockAction(run: SimulationRun, action: BoundAction, phase: "conflict" | "obstructed", notice: string, atMs: number) {
  const state = executionFor(action);
  state.phase = phase; state.notice = notice; state.completedAtMs = atMs;
  if (action.arrow.kind === "pass" || action.arrow.kind === "handoff") {
    const ball = run.ballState;
    if (isTransferBall(ball) && ball.transfer.actionKey === action.plan?.key) {
      run.ballState = transitionBall(ball, { kind: "fail", atMs, reason: notice,
        giverPosition: markerForId(run.players, ball.transfer.giverId) ?? undefined });
    } else if (transferFor(action).outcome.kind === "pending") {
      transferFor(action).outcome = { kind: "failed", atMs, reason: notice };
    }
  }
  invalidateRunRoutes(run);
}
function hasTimingMetadata(run: SimulationRun) { return run.actions.some((action) => action.arrow.timingPlan !== undefined); }
/** Move only unstarted descendants; independent authored start times stay intact. */
function refreshActionSchedule(run: SimulationRun) {
  if (!hasTimingMetadata(run)) {
    // Keep the pre-Timing schedule byte-for-byte compatible for untouched
    // version-1 plays. The event-aware scheduler below only activates after
    // the user commits the first Timing edit.
    for (let pass = 0; pass < run.actions.length; pass++) {
      let changed = false;
      for (const action of run.actions) {
        if (!action.plan || action.execution?.startedAtMs != null || !actionIsMoving(action)) continue;
        let start = action.plan.nominalStartMs;
        for (const edge of action.plan.dependencies) {
          const prior = run.actionGraph.get(edge.key);
          if (prior) start = Math.max(start, edge.milestone === "catch"
            ? caughtAt(prior.transfer) ?? prior.execution?.completedAtMs ?? prior.startTime + prior.durationMs
            : prior.execution?.completedAtMs ?? prior.startTime + prior.durationMs);
        }
        start = Math.max(start, action.execution?.notice ? run.elapsedMs : 0);
        if (Math.abs(action.startTime - start) > 1e-6) { action.startTime = start; changed = true; }
      }
      if (!changed) break;
    }
    run.actionDurationMs = Math.max(MIN_PLAY_DURATION_MS, ...run.actions.map((action) => action.startTime + action.durationMs));
    if (run.adaptiveContinuationStartedAtMs == null) run.plannedActionDurationMs = run.actionDurationMs;
    run.durationMs = run.actionDurationMs + run.shotDurationMs;
    return;
  }
  // Same-sequence catch edges need not follow array order. Cycles are rejected
  // during compilation; bounded relaxation settles every valid prediction.
  for (let pass = 0; pass < run.actions.length; pass++) {
    let changed = false;
    for (const action of run.actions) {
      if (!action.plan || action.execution?.startedAtMs != null || !actionIsMoving(action)) continue;
      let start = action.plan.nominalStartMs;
      for (const edge of action.plan.dependencies) {
        const prior = run.actionGraph.get(edge.key);
        if (prior) start = Math.max(start, edge.milestone === "catch"
          ? caughtAt(prior.transfer) ?? prior.execution?.completedAtMs ?? prior.startTime + prior.durationMs
          : prior.execution?.completedAtMs ?? prior.startTime + prior.durationMs);
      }
      for (const wait of action.timingWaits ?? []) {
        const prior = run.actions.find((candidate) => candidate.arrow.id === wait.actionId);
        if (!prior) continue;
        const state = prior.execution;
        const phaseTime = wait.event === "start" ? state?.startedAtMs
          : wait.event === "complete" ? state?.completedAtMs
            : wait.event === "catch" ? caughtAt(prior.transfer)
              : wait.event === "screen-set" ? state?.setAtMs
                : wait.event === "screen-use" ? state?.usedAtMs
                  : (state?.routeProgress.get(`${wait.routePhase}:${wait.playerId}`) ?? 0) >= (wait.progress ?? 1) ? run.elapsedMs : undefined;
        const estimatedTime = wait.event === "start" ? prior.startTime
          : wait.event === "route-point" ? prior.startTime + prior.durationMs * (wait.progress ?? 0)
            : wait.event === "screen-set" || wait.event === "screen-use" ? prior.startTime + prior.durationMs * 0.55
              : prior.startTime + prior.durationMs;
        start = Math.max(start, phaseTime ?? estimatedTime);
      }
      start = Math.max(start, action.execution?.notice ? run.elapsedMs : 0);
      if (Math.abs(action.startTime - start) > 1e-6) { action.startTime = start; changed = true; }
    }
    if (!changed) break;
  }
  // A synchronized group shares one actual earliest start. Keep members that
  // are waiting on different prerequisites from drifting into separate times.
  const groups = new Map<string, BoundAction[]>();
  for (const action of run.actions) if (action.timingSyncId && actionIsMoving(action) && action.execution?.startedAtMs == null) {
    const group = groups.get(action.timingSyncId) ?? []; group.push(action); groups.set(action.timingSyncId, group);
  }
  for (const group of groups.values()) {
    const sharedStart = Math.max(...group.map((action) => action.startTime));
    for (const action of group) action.startTime = sharedStart;
  }
  run.actionDurationMs = Math.max(MIN_PLAY_DURATION_MS, ...run.actions.map((action) => action.startTime + action.durationMs));
  if (run.adaptiveContinuationStartedAtMs == null) run.plannedActionDurationMs = run.actionDurationMs;
  run.durationMs = run.actionDurationMs + run.shotDurationMs;
}
function startReadyActions(run: SimulationRun, atMs: number) {
  if (run.shotStart) return;
  refreshActionSchedule(run);
  if (!hasTimingMetadata(run)) {
    let movementStarted = false;
    for (const action of run.actions) {
      if (!actionIsMoving(action) || action.execution?.startedAtMs != null) continue;
      let waiting: BoundAction | null = null;
      for (const edge of action.plan?.dependencies ?? []) {
        const prior = run.actionGraph.get(edge.key);
        if (!prior || !actionIsMoving(prior) && prior.execution?.phase !== "completed") {
          blockAction(run, action, "obstructed", `Move ${action.sequence} cannot start: prerequisite ${prior ? `move ${prior.sequence}` : edge.key} did not complete`, atMs);
          break;
        }
        if (edge.milestone === "catch" ? caughtAt(prior.transfer) == null : prior.execution?.phase !== "completed") waiting ??= prior;
      }
      if (action.startTime > atMs + 1e-6) {
        if (waiting && action.plan!.nominalStartMs <= atMs + 1e-6 && actionIsMoving(action)) {
          executionFor(action).notice = `Waiting for move ${waiting.sequence}${waiting.arrow.kind === "pass" || waiting.arrow.kind === "handoff" ? " to complete its catch" : " to finish"}`;
        }
        continue;
      }
      if (!actionIsMoving(action)) continue;
      if (waiting) {
        executionFor(action).notice = `Waiting for move ${waiting.sequence}${waiting.arrow.kind === "pass" || waiting.arrow.kind === "handoff" ? " to complete its catch" : " to finish"}`;
        action.startTime = atMs + SIMULATION_FIXED_STEP_MS;
        continue;
      }
      const holder = action.plan?.requiresPossessionId;
      if (holder != null && holder !== run.ballHandlerId) {
        blockAction(run, action, "obstructed", `Move ${action.sequence} cannot start: player ${holder} does not hold the ball`, atMs);
        continue;
      }
      action.startTime = Math.max(action.startTime, atMs);
      executionFor(action).notice = null;
      processActionStart(run, action);
      if (action.arrow.kind !== "pass" && action.arrow.kind !== "handoff") movementStarted = true;
    }
    if (movementStarted) resolveMovementOwners(run, run.actions, atMs);
    refreshActionSchedule(run);
    return;
  }
  let movementStarted = false;
  const pending = run.actions.filter((action) => actionIsMoving(action) && action.execution?.startedAtMs == null);
  const groups = new Map<string, BoundAction[]>();
  for (const action of pending) {
    const key = action.timingSyncId ? `sync:${action.timingSyncId}` : `action:${action.plan?.key ?? action.arrow.id}`;
    const group = groups.get(key) ?? []; group.push(action); groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.some((action) => action.startTime > atMs + 1e-6)) continue;
    let waiting: BoundAction | null = null;
    let failure: { action: BoundAction; message: string } | null = null;
    const statusFor = (prior: BoundAction | undefined, event: string): "ready" | "waiting" | "impossible" => {
      if (!prior) return "impossible";
      const state = prior.execution;
      if (state?.phase === "obstructed" || state?.phase === "conflict" || state?.phase === "interrupted") return "impossible";
      if (event === "start") return state?.startedAtMs != null ? "ready" : "waiting";
      if (event === "complete") return state?.phase === "completed" ? "ready" : state?.phase === "pending" || state?.startedAtMs == null ? "waiting" : "waiting";
      if (event === "catch") return caughtAt(prior.transfer) != null ? "ready"
        : prior.transfer?.outcome.kind === "failed" ? "impossible" : "waiting";
      if (event === "screen-set") return state?.setAtMs != null ? "ready" : state?.phase === "completed" ? "impossible" : "waiting";
      if (event === "screen-use") return state?.usedAtMs != null ? "ready" : state?.phase === "completed" ? "impossible" : "waiting";
      return "waiting";
    };
    for (const action of group) {
      for (const edge of action.plan?.dependencies ?? []) {
        const prior = run.actionGraph.get(edge.key);
        const status = statusFor(prior, edge.milestone === "catch" ? "catch" : "complete");
        if (status === "impossible") failure ??= { action, message: `Move ${action.sequence} cannot start: prerequisite ${prior ? `move ${prior.sequence}` : edge.key} did not complete` };
        else if (status === "waiting") waiting ??= prior ?? null;
      }
      for (const timingWait of action.timingWaits ?? []) {
        const prior = run.actions.find((candidate) => candidate.arrow.id === timingWait.actionId);
        if (!prior) { failure ??= { action, message: `Move ${action.sequence} cannot start: a required timing event is missing` }; continue; }
        let status = statusFor(prior, timingWait.event);
        if (timingWait.event === "route-point") {
          const progress = prior.execution?.routeProgress.get(`${timingWait.routePhase}:${timingWait.playerId}`) ?? 0;
          status = progress + 1e-6 >= (timingWait.progress ?? 1) ? "ready"
            : prior.execution?.phase === "completed" ? "impossible"
              : prior.execution?.phase === "obstructed" || prior.execution?.phase === "conflict" || prior.execution?.phase === "interrupted" ? "impossible" : "waiting";
        }
        if (status === "impossible") failure ??= { action, message: `Move ${action.sequence} cannot start: required ${timingWait.event.replaceAll("-", " ")} from move ${prior.sequence} did not occur` };
        else if (status === "waiting") waiting ??= prior;
      }
      const holder = action.plan?.requiresPossessionId;
      if (holder != null && holder !== run.ballHandlerId) {
        const receivePending = run.actions.some((prior) => prior.recipientId === holder && (prior.arrow.kind === "pass" || prior.arrow.kind === "handoff") && prior.transfer?.outcome.kind === "pending");
        if (!receivePending) failure ??= { action, message: `Move ${action.sequence} cannot start: player ${holder} does not hold the ball` };
      }
    }
    if (failure) {
      for (const action of group) blockAction(run, action, "obstructed", failure.message, atMs);
      continue;
    }
    if (waiting) {
      const notice = `Waiting for move ${waiting.sequence} to reach its required event`;
      for (const action of group) executionFor(action).notice = notice;
      continue;
    }
    // A pin begins atomically at the first step where every member's event,
    // possession, and compiled dependency constraints are satisfied.
    const actualStart = Math.max(atMs, ...group.map((action) => action.startTime));
    for (const action of group) {
      action.startTime = actualStart;
      executionFor(action).notice = null;
      processActionStart(run, action);
      if (action.arrow.kind !== "pass" && action.arrow.kind !== "handoff") movementStarted = true;
    }
  }
  if (movementStarted) resolveMovementOwners(run, run.actions, atMs);
  refreshActionSchedule(run);
}

function executionPath(points: CourtPoint[]): ExecutionPath {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + pointDistanceFeet(points[i - 1], points[i]));
  return { points, feetPoints: points.map(toCourtFeet), lengths, length: lengths.at(-1) ?? 0, progress: 0, closest: points[0] };
}
function authoredPath(action: BoundAction, start: CourtPoint, end = action.arrow.end) {
  return Array.from({ length: 33 }, (_, index) => routePoint(action, start, index / 32, end));
}
function pathPoint(path: ExecutionPath, distance: number) {
  for (let i = 1; i < path.points.length; i++) if (path.lengths[i] >= distance) {
    return lerpPoint(path.points[i - 1], path.points[i], clamp((distance - path.lengths[i - 1]) / Math.max(.001, path.lengths[i] - path.lengths[i - 1]), 0, 1));
  }
  return path.points.at(-1)!;
}
function followPath(run: SimulationRun, action: BoundAction, player: PlaybookMarker, points: CourtPoint[], priority = 3) {
  const state = executionFor(action);
  let path = state.paths.get(player.id);
  if (!path) { path = executionPath(points); state.paths.set(player.id, path); }
  const feet = toCourtFeet(player); let closestGap = Infinity, progress = path.progress, closest = path.closest;
  for (let i = 1; i < path.points.length; i++) {
    if (path.lengths[i] < path.progress - .25 || path.lengths[i - 1] > path.progress + 6) continue;
    const a = toCourtFeet(path.points[i - 1]), b = toCourtFeet(path.points[i]);
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
    const t = length2 ? clamp(((feet.x - a.x) * dx + (feet.y - a.y) * dy) / length2, 0, 1) : 0;
    const point = lerpPoint(path.points[i - 1], path.points[i], t), gap = pointDistanceFeet(point, player);
    if (gap < closestGap - 1e-6) { closestGap = gap; closest = point; progress = path.lengths[i - 1] + (path.lengths[i] - path.lengths[i - 1]) * t; }
  }
  path.progress = Math.max(path.progress, progress); path.closest = closest;
  const velocity = run.velocities.get(velocityKey("player", player.id)) ?? { x: 0, y: 0 };
  const lookAhead = isScreenAction(action) ? .8 + Math.hypot(velocity.x, velocity.y) * .05 : 1.3 + Math.hypot(velocity.x, velocity.y) * .12;
  const target = pathPoint(path, Math.min(path.length, path.progress + lookAhead));
  const key = velocityKey("player", player.id);
  run.motionIntents?.set(key, { key, point: feet, previousVelocity: velocity, velocity, speed: OFFENSE_MAX_SPEED_FT_PER_SECOND,
    acceleration: OFFENSE_ACCELERATION_FT_PER_SECOND, priority: pointDistanceFeet(player, path.points.at(-1)!) < .8 ? 8 : priority, corridor: { point: toCourtFeet(closest), radius: 3 },
    navigation: { id: `${action.arrow.id}:${action.sequence}:${player.id}:${state.phase}`, goal: path.feetPoints.at(-1)!, points: path.feetPoints, progress: path.progress, remaining: Math.max(0, path.length - path.progress) } });
  state.progress = Math.max(state.progress, path.length ? Math.min(1, path.progress / path.length) : 1);
  const phaseKey = `${state.phase}:${player.id}`;
  state.routeProgress.set(phaseKey, Math.max(state.routeProgress.get(phaseKey) ?? 0, path.length ? Math.min(1, path.progress / path.length) : 1));
  // Retain the overall authored-route progress as well as phase-specific
  // progress. Screen actions keep their approach/use/release clocks separate,
  // while a point selected on the drawn route still has a stable event source.
  state.routeProgress.set(`main:${player.id}`, Math.max(state.routeProgress.get(`main:${player.id}`) ?? 0, path.length ? Math.min(1, path.progress / path.length) : 1));
  return target;
}
function routeSpeed(run: SimulationRun, action: BoundAction, playerId: number, maximum: number) {
  const path = action.execution?.paths.get(playerId);
  if (!path) return maximum;
  const waiting = run.movementBuffers.solver.congestion.decisions.get(velocityKey("player", playerId));
  // A stalled route may still have a legal escape waypoint. Only cap an
  // actual hold; slowing a detour can prevent the player clearing the traffic.
  if (waiting && waiting.routeId === run.motionIntents?.get(velocityKey("player", playerId))?.navigation?.id && !waiting.waypoint) {
    const velocity = run.velocities.get(velocityKey("player", playerId));
    maximum = Math.min(maximum, Math.max(2, Math.hypot(velocity?.x ?? 0, velocity?.y ?? 0)));
  }
  // Brake before deliberate corners rather than overshooting and reversing.
  for (let i = 1; i < path.points.length - 1; i++) {
    const remaining = path.lengths[i] - path.progress;
    if (remaining < -.1 || remaining > 4) continue;
    const a = toCourtFeet(path.points[i - 1]), b = toCourtFeet(path.points[i]), c = toCourtFeet(path.points[i + 1]);
    const first = { x: b.x - a.x, y: b.y - a.y }, second = { x: c.x - b.x, y: c.y - b.y };
    const cosine = (first.x * second.x + first.y * second.y) / Math.max(.001, Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y));
    if (cosine < .8) maximum = Math.min(maximum, 3 + Math.max(0, remaining) * 2);
  }
  return maximum;
}
function screenUserPoints(action: BoundAction, start: CourtPoint, finish: CourtPoint) {
  const screen = toCourtFeet(action.arrow.end), from = toCourtFeet(start), to = toCourtFeet(finish);
  const dx = screen.x - from.x, dy = screen.y - from.y, length = Math.max(.01, Math.hypot(dx, dy));
  const side = action.actorId != null && action.actorId % 2 === 0 ? 1 : -1;
  const offset = { x: -dy / length * 2.4 * side, y: dx / length * 2.4 * side };
  const endDx = to.x - screen.x, endDy = to.y - screen.y, endLength = Math.max(.01, Math.hypot(endDx, endDy));
  return [start,
    clampCourt(fromCourtFeet({ x: screen.x - dx / length * 3 + offset.x, y: screen.y - dy / length * 3 + offset.y })),
    clampCourt(fromCourtFeet({ x: screen.x + offset.x, y: screen.y + offset.y })),
    clampCourt(fromCourtFeet({ x: screen.x + endDx / endLength * 3 + offset.x, y: screen.y + endDy / endLength * 3 + offset.y })), finish];
}
function screenUserId(action: BoundAction) {
  return action.arrow.kind === "off-ball-screen" || action.arrow.kind === "pin-down" ? action.recipientId : action.partnerId ?? null;
}
function isScreenAction(action: BoundAction) {
  return ["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "slip-screen"].includes(action.arrow.kind);
}
function screenFinish(action: BoundAction, hoop: CourtPoint) {
  return action.arrow.kind === "pick-pop" ? action.arrow.exit_target ?? action.arrow.end : pointToward(action.arrow.end, hoop, 8);
}
function screenUserFinish(action: BoundAction, hoop: CourtPoint) {
  return action.arrow.kind === "off-ball-screen" || action.arrow.kind === "pin-down"
    ? action.arrow.exit_target ?? offBallCutterTarget(action.arrow.end, hoop)
    : pointToward(action.arrow.end, hoop, action.arrow.kind === "pick-roll" || action.arrow.kind === "slip-screen" ? 10 : 8);
}
function prepareScreen(run: SimulationRun, action: BoundAction, timeMs: number, hoop: CourtPoint) {
  const state = executionFor(action), actor = markerForId(run.players, action.actorId), user = markerForId(run.players, screenUserId(action));
  if (!actionIsMoving(action)) return;
  if (!actor || !user) {
    blockAction(run, action, "obstructed", `Move ${action.sequence} lost an available screen participant`, timeMs);
    return;
  }
  if (action.arrow.kind === "slip-screen") { state.phase = "release"; return; }
  const velocity = run.velocities.get(velocityKey("player", actor.id)) ?? { x: 0, y: 0 };
  if (state.phase === "approach" && pointDistanceFeet(actor, action.arrow.end) <= .45 && Math.hypot(velocity.x, velocity.y) <= 1.5) {
    state.phase = "set"; state.setAtMs = timeMs;
  }
  if (state.phase === "set" && timeMs - (state.setAtMs ?? timeMs) >= 120) {
    state.phase = "use";
    if (user) state.paths.delete(user.id);
  }
  if (state.phase === "use") {
    if (user && pointDistanceFeet(user, actor) <= 4 && state.usedAtMs == null) state.usedAtMs = timeMs;
    switchAtInteraction(run, action, screenUserId(action));
    const path = user ? state.paths.get(user.id) : null;
    if (!user || (state.usedAtMs != null && pointDistanceFeet(user, actor) > 3 && ((path && path.progress >= path.length * .6) || (!path && timeMs - state.usedAtMs >= 150)))) {
      state.phase = "release"; state.releasedAtMs = timeMs;
      if (action.arrow.kind === "pick-roll" || action.arrow.kind === "pick-pop") state.paths.delete(actor.id);
    }
  }
}
function movementPoints(run: SimulationRun, action: BoundAction, player: PlaybookMarker, hoop: CourtPoint) {
  const state = executionFor(action), start = actionStartFor(run, action);
  if (!isScreenAction(action)) return authoredPath(action, start);
  if (action.arrow.kind === "slip-screen") return [start, action.arrow.end, screenFinish(action, hoop)];
  if (state.phase === "release" && (action.arrow.kind === "pick-roll" || action.arrow.kind === "pick-pop")) return [player, screenFinish(action, hoop)];
  return authoredPath(action, start);
}

function updateOffense(run: SimulationRun, timeMs: number, dt: number, hoop: CourtPoint) {
  const transfer = currentTransferAt(run, timeMs), prep = currentPrepAt(run, timeMs);
  const activeActions = run.actions.filter((action) => actionIsExecuting(action) && timeMs >= action.startTime && timeMs < action.startTime + action.durationMs);
  activeActions.forEach((action) => { if (isScreenAction(action)) prepareScreen(run, action, timeMs, hoop); });
  const handler = markerForId(run.players, run.ballHandlerId), ball = run.ball ?? handler ?? HOOP_POINT, drive = driveThreat(run, hoop);
  const owners = resolveMovementOwners(run, activeActions, timeMs);
  run.players = run.players.map((player) => {
    let target: CourtPoint | null = null, authoredTarget = false, maxSpeed = OFF_BALL_MAX_SPEED_FT_PER_SECOND;
    const movement = owners.get(player.id);
    const screen = activeActions.find((action) => actionIsMoving(action) && isScreenAction(action) && screenUserId(action) === player.id);
    if (movement) {
      target = followPath(run, movement, player, movementPoints(run, movement, player, hoop));
      const state = executionFor(movement);
      if (isScreenAction(movement) && movement.arrow.kind !== "slip-screen" && (state.phase === "set" || state.phase === "use")) {
        target = movement.arrow.end;
        const intent = run.motionIntents?.get(velocityKey("player", player.id)); if (intent) intent.priority = 100;
      }
      maxSpeed = Math.min(OFFENSE_MAX_SPEED_FT_PER_SECOND, Math.max(5, (state.paths.get(player.id)?.length ?? 0) / Math.max(.5, (movement.arrow.timing ?? 1.2)) * 1.3));
      maxSpeed = routeSpeed(run, movement, player.id, maxSpeed);
      authoredTarget = true;
    } else if (screen) {
      const state = executionFor(screen), finish = screenUserFinish(screen, hoop);
      const start = screen.arrow.kind === "off-ball-screen" || screen.arrow.kind === "pin-down" ? screen.recipientStart ?? player : screen.partnerStart ?? player;
      const points = screenUserPoints(screen, start, finish);
      target = followPath(run, screen, player, state.phase === "approach" || state.phase === "set" ? [start, points[1]] : [player, ...points.slice(1)]);
      maxSpeed = routeSpeed(run, screen, player.id, 10); authoredTarget = true;
    } else if (transfer?.recipientId === player.id || prep?.recipientId === player.id) {
      const action = transfer?.recipientId === player.id ? transfer : prep!;
      const override = run.recipientStartOverrides.get(action.arrow.id);
      const start = override?.point ?? action.recipientStart ?? player;
      target = followPath(run, action, player, [start, action.arrow.end]);
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND; authoredTarget = true;
    } else if (transfer?.arrow.kind === "handoff" && transfer.actorId === player.id) {
      const receiver = markerForId(run.players, transfer.recipientId);
      if (receiver) target = pointToward(receiver, player, 2.2);
      maxSpeed = OFF_BALL_MAX_SPEED_FT_PER_SECOND; authoredTarget = true;
    } else if (run.ballHandlerId !== player.id) {
      const recoveringId = run.ballState.kind === "loose" && run.settings.offenseMode !== "scripted" && run.ball ? run.players.slice().sort((a, b) => pointDistanceFeet(a, ball) - pointDistanceFeet(b, ball) || a.id - b.id)[0]?.id : null;
      target = recoveringId === player.id ? ball : offBallTarget(run, player, ball, timeMs, drive, hoop);
    }
    if (!target) { run.targetFilters.delete(velocityKey("player", player.id)); return coastMarker(run, "player", player, dt, OFFENSE_ACCELERATION_FT_PER_SECOND); }
    if (authoredTarget) run.targetFilters.delete(velocityKey("player", player.id));
    else target = smoothAITarget(run, "player", player, target, dt);
    return integrateMarker(run, "player", player, target, dt, maxSpeed, OFFENSE_ACCELERATION_FT_PER_SECOND);
  });
}

function resetCongestionPlanning(run: SimulationRun) {
  clearCongestionState(run.movementBuffers.solver.congestion);
  for (const action of run.actions) if (action.execution && actionIsExecuting(action)) delete action.execution.congestion;
}

function coordinateCourt(run: SimulationRun, dt: number) {
  const { intents, playerPositions, defenderPositions, solver } = run.movementBuffers;
  intents.length = 0;
  for (const intent of run.motionIntents?.values() ?? []) intents.push(intent);
  playerPositions.clear(); defenderPositions.clear();
  const resolved = coordinateMovement(intents, dt, courtBoundsFeet, run.movementOrder, solver);
  for (const action of run.actions) if (actionIsExecuting(action)) {
    const state = executionFor(action);
    delete state.congestion;
    for (const playerId of state.paths.keys()) {
      const key = velocityKey("player", playerId), decision = solver.congestion.decisions.get(key);
      const expectedRoute = `${action.arrow.id}:${action.sequence}:${playerId}:${state.phase}`;
      if (!decision || decision.routeId !== expectedRoute || decision.routeId !== run.motionIntents?.get(key)?.navigation?.id) continue;
      const rank = { detouring: 1, yielding: 2, blocked: 3 };
      if (!state.congestion || rank[decision.status] > rank[state.congestion.status]) state.congestion = {
        status: decision.status, playerId, blockers: [...decision.blockers], sinceMs: decision.sinceMs, reason: decision.reason,
      };
    }
  }
  intents.forEach((intent, index) => {
    const point = Math.hypot(resolved[index].velocity.x, resolved[index].velocity.y) < 1e-10 ? null : fromCourtFeet(resolved[index].point), id = Number(intent.key.split(":")[1]);
    run.velocities.set(intent.key, resolved[index].velocity);
    if (!point) return;
    (intent.key.startsWith("player:") ? playerPositions : defenderPositions).set(id, point);
  });
  if (playerPositions.size) run.players = run.players.map((player) => {
    const point = playerPositions.get(player.id);
    return point ? { ...player, ...point } : player;
  });
  if (defenderPositions.size) run.defenders = run.defenders.map((defender) => {
    const point = defenderPositions.get(defender.id);
    return point ? { ...defender, ...point } : defender;
  });
  intents.length = 0;
  playerPositions.clear(); defenderPositions.clear();
  run.motionIntents?.clear();
  run.motionIntents = undefined;
}

/** Reconcile external edits/missing participants before any new action claims possession. */
function reconcileBall(run: SimulationRun, atMs: number) {
  const ball = run.ballState;
  if ((ball.kind === "held" || ball.kind === "shot-setup") && !markerForId(run.players, ballController(ball))) {
    run.ballState = transitionBall(ball, { kind: "drop", atMs });
  } else if (isTransferBall(ball)) {
    const action = run.actionGraph.get(ball.transfer.actionKey);
    const giver = markerForId(run.players, ball.transfer.giverId);
    const receiver = markerForId(run.players, ball.transfer.receiverId);
    if (!action || !actionIsExecuting(action)) {
      run.ballState = transitionBall(ball, { kind: "interrupt", atMs, reason: "The active transfer was interrupted", giverPosition: giver ?? undefined });
      if (action) {
        const execution = executionFor(action);
        execution.phase = "interrupted"; execution.completedAtMs = atMs;
        execution.notice = "The active transfer was interrupted";
      }
    } else if (!receiver || ball.kind === "handoff-pending" && !giver) {
      blockAction(run, action, "obstructed", !receiver ? "The selected receiver is unavailable" : "The handoff giver is unavailable", atMs);
    }
  }
}

function updateBall(run: SimulationRun, timeMs: number, dt: number) {
  const ball = run.ballState;
  if (isTransferBall(ball)) {
    const transfer = currentTransferAt(run, timeMs)!;
    const giver = markerForId(run.players, ball.transfer.giverId), receiver = markerForId(run.players, ball.transfer.receiverId);
    if (ball.kind === "handoff-pending") {
      if (!giver || !receiver || pointDistanceFeet(giver, receiver) > 2.8) {
        if (giver) ball.position = { x: giver.x, y: giver.y };
        ball.velocity = { x: 0, y: 0 };
        return;
      }
      executionFor(transfer).usedAtMs ??= timeMs;
      switchAtInteraction(run, transfer, ball.transfer.receiverId);
    }
    const origin = ball.pathOverride ?? ball.transfer.release ?? { atMs: transfer.startTime, position: ball.position };
    const progress = clamp((timeMs - origin.atMs) / Math.max(1, transfer.startTime + transfer.durationMs - origin.atMs), 0, 1);
    const pathAction = { ...transfer, plannedStart: origin.position, controlOffset: transfer.controlOffset };
    integrateBall(run, routePoint(pathAction, origin.position, easeInOut(progress), receiver ?? transfer.arrow.end), dt);
    return;
  }
  if (ball.kind === "held") {
    const handler = markerForId(run.players, ball.holderId);
    if (handler) ball.position = { x: handler.x, y: handler.y };
    ball.velocity = { x: 0, y: 0 };
    return;
  }
  if (ball.kind !== "loose" || !ball.position) return;
  const recovery = run.players.map((player) => ({ player, gap: pointDistanceFeet(ball.position!, player) }))
    .sort((a, b) => a.gap - b.gap || a.player.id - b.player.id)[0];
  if (recovery && run.elapsedMs > ball.sinceMs + 1e-6 && recovery.gap <= LOOSE_BALL_CATCH_RADIUS_FEET) {
    run.ballState = transitionBall(ball, { kind: "recover", playerId: recovery.player.id, position: recovery.player });
    run.offBallAnchors.set(recovery.player.id, { x: recovery.player.x, y: recovery.player.y });
  } else {
    const speed = Math.hypot(ball.velocity.x, ball.velocity.y), nextSpeed = Math.max(0, speed - BALL_ACCELERATION_FT_PER_SECOND * dt);
    if (speed > .01) {
      ball.position = addFeet(ball.position, { x: ball.velocity.x / speed * nextSpeed * dt, y: ball.velocity.y / speed * nextSpeed * dt });
      ball.velocity = { x: ball.velocity.x / speed * nextSpeed, y: ball.velocity.y / speed * nextSpeed };
    }
  }
}

function updateDefense(run: SimulationRun, timeMs: number, dt: number, hoop: CourtPoint) {
  const { targets } = defensiveTargets(run, timeMs, hoop);
  run.defenders = run.defenders.map((defender, index) => {
    const target = targets[index] ?? defender;
    if (run.settings.defenseStrategy === "off") {
      run.targetFilters.delete(velocityKey("defender", defender.id));
      const velocity = run.velocities.get(velocityKey("defender", defender.id)) ?? { x: 0, y: 0 };
      const overlapping = [...run.players, ...run.defenders.filter((other) => other.id !== defender.id)].some((other) => pointDistanceFeet(defender, other) < 2);
      const correcting = overlapping || Math.hypot(velocity.x, velocity.y) > .001;
      const key = velocityKey("defender", defender.id);
      // Hold positions suppresses defensive reactions, but imported body
      // overlaps still need a gradual, bounded correction and braking.
      run.motionIntents?.set(key, { key, point: toCourtFeet(defender), velocity: { x: 0, y: 0 }, previousVelocity: velocity, speed: correcting ? Math.max(2, Math.hypot(velocity.x, velocity.y)) : 0, acceleration: correcting ? DEFENDER_ACCELERATION_FT_PER_SECOND : 0, priority: 5, frozen: !correcting });
      return defender;
    }
    const isRecovering = pointDistanceFeet(defender, target) > 8;
    const duty = run.defense.duties.get(defender.id);
    const focusPlayer = markerForId(run.players, duty?.playerId ?? null);
    const assignmentVelocity = focusPlayer
      ? run.velocities.get(velocityKey("player", focusPlayer.id)) ?? { x: 0, y: 0 }
      : { x: 0, y: 0 };
    const isTrackingMovement = Math.hypot(assignmentVelocity.x, assignmentVelocity.y) > 2.5;
    const shootingThreat = focusPlayer ? defensiveThreatRating(focusPlayer, hoop) : 3;
    const badgeResponse = (defenderHasBadge(defender, "lockdown") ? 1.4 : 0)
      + (run.helpDefenderId === defender.id && defenderHasBadge(defender, "helper") ? 1.2 : 0);
    const responseSpeed = clamp((isRecovering ? DEFENDER_MAX_SPEED_FT_PER_SECOND : isTrackingMovement ? 12 : 9)
      + (shootingThreat - 3) * 1.2 + badgeResponse, 5, DEFENDER_MAX_SPEED_FT_PER_SECOND);
    const responseAcceleration = DEFENDER_ACCELERATION_FT_PER_SECOND + (shootingThreat - 3) * 3
      + (defenderHasBadge(defender, "lockdown") ? 3 : 0)
      + (run.helpDefenderId === defender.id && defenderHasBadge(defender, "helper") ? 2 : 0);
    const movementTarget = smoothAITarget(run, "defender", defender, target, dt);
    return integrateMarker(
      run,
      "defender",
      defender,
      movementTarget,
      dt,
      responseSpeed,
      responseAcceleration,
    );
  });
}

function defenderIsGoalSide(defender: CourtPoint, player: CourtPoint, hoop: CourtPoint) {
  const defenderFeet = toCourtFeet(defender);
  const playerFeet = toCourtFeet(player);
  const hoopFeet = toCourtFeet(hoop);
  const toHoop = { x: hoopFeet.x - playerFeet.x, y: hoopFeet.y - playerFeet.y };
  const toDefender = { x: defenderFeet.x - playerFeet.x, y: defenderFeet.y - playerFeet.y };
  const hoopDistance = Math.hypot(toHoop.x, toHoop.y);
  const defenderDistance = Math.hypot(toDefender.x, toDefender.y);
  if (hoopDistance < 0.01 || defenderDistance < 0.01) return 0;
  return clamp((toDefender.x * toHoop.x + toDefender.y * toHoop.y) / (hoopDistance * defenderDistance), -1, 1);
}

function calculateOffBallQuality(
  players: PlaybookMarker[],
  ball: CourtPoint | null,
  settings: SimulationSettings,
  defenders: PlaybookMarker[],
  handlerId: number | null,
) {
  if (!ball || players.length < 2) return 0;
  const offBallPlayers = players.filter((player) => player.id !== handlerId);
  if (!offBallPlayers.length) return 0;
  const spacingScore = offBallPlayers.reduce((total, player) => {
    const gap = pointDistanceFeet(player, ball);
    return total + (1 - Math.min(1, Math.abs(gap - 24) / 30));
  }, 0) / offBallPlayers.length;
  const laneScore = offBallPlayers.length < 2 ? 1 : offBallPlayers.reduce((total, player, index) => {
    const nearest = Math.min(...offBallPlayers.filter((_, otherIndex) => otherIndex !== index).map((other) => pointDistanceFeet(player, other)));
    return total + Math.min(1, nearest / 12);
  }, 0) / offBallPlayers.length;
  const clearanceScore = !defenders.length ? 0.72 : offBallPlayers.reduce((total, player) => {
    const nearest = Math.min(...defenders.map((defender) => pointDistanceFeet(player, defender)));
    return total + Math.min(1, nearest / 11);
  }, 0) / offBallPlayers.length;
  const weight = settings.offenseOffBall === "off" ? [0.5, 0.3, 0.2] : [0.48, 0.3, 0.22];
  return Math.round(clamp((spacingScore * weight[0] + laneScore * weight[1] + clearanceScore * weight[2]) * 100, 0, 100));
}

function calculateDefensiveQuality(run: SimulationRun, hoop = HOOP_POINT) {
  const { players, defenders, assignments } = run;
  const handler = defensiveFocusPlayer(run, run.elapsedMs);
  if (!handler || !defenders.length) return 0;
  if (!isManScheme(run.activeDefenseScheme)) {
    const chaserForHandler = [...run.zoneChaserAssignments.entries()].find(([, playerId]) => playerId === handler.id)?.[0];
    const ballDefenderId = [...run.defense.duties.values()].find(d => d.role === "primary")?.defenderId
      ?? chaserForHandler ?? run.zoneBallDefenderId;
    const ballDefender = defenders.find((defender) => defender.id === ballDefenderId);
    const ballGap = ballDefender ? pointDistanceFeet(ballDefender, handler) : 40;
    const pressureDistance = 1 - Math.min(1, Math.abs(ballGap - 4.5) / 17);
    const pressureFront = ballDefender ? (defenderIsGoalSide(ballDefender, handler, hoop) + 1) / 2 : 0;
    const ballPressure = pressureDistance * 0.65 + pressureFront * 0.35;
    const anchors = zoneAnchors(run.activeDefenseScheme, hoop);
    const ballFeet = toCourtFeet(run.ball ?? handler);
    const zoneDefenders = defenders.filter((defender) => run.zoneAssignments.has(defender.id));
    const shapeScore = zoneDefenders.length
      ? zoneDefenders.reduce((total, defender) => {
          const slot = run.zoneAssignments.get(defender.id) ?? 0;
          const anchor = anchors[slot] ?? defender;
          const anchorFeet = toCourtFeet(anchor);
          const shifted = addFeet(anchor, { x: clamp((ballFeet.x - anchorFeet.x) * 0.28, -4.5, 4.5), y: 0 });
          return total + 1 - Math.min(1, pointDistanceFeet(defender, shifted) / 19);
        }, 0) / zoneDefenders.length
      : 0;
    const nonChaserPlayers = players.filter((player) => ![...run.zoneChaserAssignments.values()].includes(player.id));
    const threatContainment = nonChaserPlayers.length
      ? nonChaserPlayers.reduce((total, player) => {
          const nearest = Math.min(...defenders.map((defender) => pointDistanceFeet(defender, player)));
          const rating = defensiveThreatRating(player, hoop);
          return total + Math.max(0, 1 - nearest / (21 - rating * 0.8));
        }, 0) / nonChaserPlayers.length
      : shapeScore;
    const chaserScore = run.zoneChaserAssignments.size
      ? [...run.zoneChaserAssignments.entries()].reduce((total, [defenderId, playerId]) => {
          const defender = defenders.find((candidate) => candidate.id === defenderId);
          const player = markerForId(players, playerId);
          return total + (defender && player ? Math.max(0, 1 - Math.abs(pointDistanceFeet(defender, player) - 4.25) / 18) : 0);
        }, 0) / run.zoneChaserAssignments.size
      : 0;
    const helpSpot = helpSpotFor(handler, hoop, helpFinishingRating(handler));
    const paintHelp = defenders.length < 2
      ? 0.5
      : 1 - Math.min(1, Math.min(...defenders.filter((defender) => defender.id !== ballDefender?.id).map((defender) => pointDistanceFeet(defender, helpSpot))) / 24);
    return Math.round(clamp((ballPressure * 0.36 + shapeScore * 0.31 + threatContainment * 0.18 + Math.max(paintHelp, chaserScore) * 0.15) * 100, 0, 100));
  }
  const onBall = defenders.find((defender) => assignments.get(defender.id) === handler.id);
  const onBallGap = onBall ? pointDistanceFeet(onBall, handler) : 40;
  const onBallTargetGap = goalSideGapFor(handler, hoop, 3.75);
  const onBallDistanceScore = 1 - Math.min(1, Math.max(0, Math.abs(onBallGap - onBallTargetGap)) / 18);
  const onBallFrontScore = onBall ? (defenderIsGoalSide(onBall, handler, hoop) + 1) / 2 : 0;
  const onBallScore = onBallDistanceScore * 0.62 + onBallFrontScore * 0.38;
  const assignmentScore = defenders.reduce((total, defender) => {
    const player = markerForId(players, assignments.get(defender.id) ?? null) ?? handler;
    const goalSide = pointToward(player, hoop, goalSideGapFor(player, hoop, 3.75));
    const positionScore = 1 - Math.min(1, pointDistanceFeet(defender, goalSide) / 22);
    const frontScore = (defenderIsGoalSide(defender, player, hoop) + 1) / 2;
    return total + positionScore * 0.72 + frontScore * 0.28;
  }, 0) / defenders.length;
  const helpSpot = helpSpotFor(handler, hoop, helpFinishingRating(handler));
  const helpScore = defenders.length < 2
    ? 0.5
    : 1 - Math.min(1, Math.min(...defenders.filter((defender) => defender.id !== onBall?.id).map((defender) => pointDistanceFeet(defender, helpSpot))) / 24);
  const styleWeight = 1;
  return Math.round(clamp((onBallScore * 0.42 + assignmentScore * 0.38 + helpScore * 0.2) * 100 * styleWeight, 0, 100));
}

function calculateShotQuality(
  players: PlaybookMarker[], defenders: PlaybookMarker[], shooter: PlaybookMarker,
  offBallQuality: number, hoop = HOOP_POINT, context?: ShotMotionEvidence,
) {
  return scoreShot(players, defenders, shooter, offBallQuality, hoop, context, false);
}

/** Prospective reads share the release rules but never establish possession or
 * create a released record. All evidence is copied from this evaluation time. */
export function evaluateShotContext(
  players: PlaybookMarker[], defenders: PlaybookMarker[], shooter: PlaybookMarker,
  offBallQuality: number, hoop = HOOP_POINT, context?: ShotMotionEvidence,
): ShotReleaseContext {
  return scoreShot(players, defenders, shooter, offBallQuality, hoop, context, true);
}

function scoreShot(players: PlaybookMarker[], defenders: PlaybookMarker[], shooter: PlaybookMarker, offBallQuality: number, hoop: CourtPoint, context: ShotMotionEvidence | undefined, captureEvidence: true): ShotReleaseContext;
function scoreShot(players: PlaybookMarker[], defenders: PlaybookMarker[], shooter: PlaybookMarker, offBallQuality: number, hoop: CourtPoint, context: ShotMotionEvidence | undefined, captureEvidence: false): number;
function scoreShot(
  _players: PlaybookMarker[],
  defenders: PlaybookMarker[],
  shooter: PlaybookMarker,
  offBallQuality: number,
  hoop = HOOP_POINT,
  context: ShotMotionEvidence | undefined,
  captureEvidence: boolean,
): ShotReleaseContext | number {
  const atMs = context?.atMs ?? 0;
  const velocity = { ...context?.shooterVelocityFtPerSecond ?? { x: 0, y: 0 } };
  const speed = Math.hypot(velocity.x, velocity.y);
  const received = context?.catch && context.catch.atMs <= atMs ? {
    ...context.catch, position: { ...context.catch.position }, receiverVelocityFtPerSecond: { ...context.catch.receiverVelocityFtPerSecond },
    elapsedMs: atMs - context.catch.atMs, settled: atMs - context.catch.atMs >= 150 && speed <= 2.5,
  } : null;
  const recentCatch = !!received && received.elapsedMs <= 1150;
  const recentActions = context?.recentActions.map(action => ({ ...action })) ?? [];
  const recentMovement = speed >= 2.5 || recentActions.length > 0;
  const skill = shotSkillFor(shooter, hoop), rating = playerRating(shooter, skill);
  const distance = pointDistanceFeet(shooter, hoop), shooterFeet = toCourtFeet(shooter);
  const defendersEvidence = defenders.map(defender => {
    const gap = pointDistanceFeet(defender, shooter), feet = toCourtFeet(defender);
    const direction = gap > 1e-9 ? { x: (shooterFeet.x - feet.x) / gap, y: (shooterFeet.y - feet.y) / gap } : { x: 0, y: 0 };
    const dv = { ...context?.defenderVelocities.find(item => item.id === defender.id)?.velocityFtPerSecond ?? { x: 0, y: 0 } };
    const front = (defenderIsGoalSide(defender, shooter, hoop) + 1) / 2;
    const proximity = gap > 10 ? 0 : clamp((10 - gap) / 5, 0, 1);
    const pressure = Math.min(.22, (defenderHasBadge(defender, "lockdown") ? .16 * front * proximity : 0)
      + (defenderHasBadge(defender, "paint-protector") && skill === "finishing" ? .2 * front * proximity : 0)
      + (defenderHasBadge(defender, "helper") ? .08 * front * proximity : 0));
    return { id: defender.id, position: { x: defender.x, y: defender.y }, velocityFtPerSecond: dv, distanceFeet: gap,
      directionToShooter: direction, approachSpeedFtPerSecond: dv.x * direction.x + dv.y * direction.y,
      relativeClosingSpeedFtPerSecond: (dv.x - velocity.x) * direction.x + (dv.y - velocity.y) * direction.y,
      goalSide: front, badgePressure: pressure, badges: [...defender.badges ?? []] as DefensiveBadge[] };
  }).sort((a, b) => a.id - b.id);
  const rangeScore = 1 - Math.min(1, pointDistanceFeet(shooter, hoop) / 37);
  const closestDefenderGap = defenders.length
    ? Math.min(...defenders.map((defender) => pointDistanceFeet(defender, shooter)))
    : 19;
  const badgeContest = Math.max(0, ...defendersEvidence.map(defender => defender.badgePressure));
  const contestScore = clamp(Math.min(1, closestDefenderGap / 19) - badgeContest, 0, 1);
  const baseQuality = (rangeScore * 0.52 + contestScore * 0.28 + (offBallQuality / 100) * 0.2) * 100;
  const modifiers: Array<{ key: string; points: number; evidence: Record<string, string | number | boolean | null> }> = [];
  const add = (key: string, points: number, evidence: Record<string, string | number | boolean | null>) => {
    if (captureEvidence) modifiers.push({ key, points, evidence });
  };
  add("range", rangeScore * 52, { distanceFeet: distance, rangeScaleFeet: 37 });
  add("defender-space", Math.min(1, closestDefenderGap / 19) * 28, { closestDefenderGapFeet: closestDefenderGap, noDefenders: defenders.length === 0 });
  add("defender-badges", (contestScore - Math.min(1, closestDefenderGap / 19)) * 28, { badgeContest });
  add("spacing", offBallQuality * .2, { offBallQuality });
  add("shot-rating", (rating - 3) * 8, { skill, rating });
  let badgeBonus = 0;
  if (rating >= 2) {
    if (skill === "threePoint" && playerHasBadge(shooter, "deep-range") && distance > NBA_COURT_GEOMETRY.threePoint.radiusFeet + 0.5) {
      const bonus = clamp(2 + (distance - NBA_COURT_GEOMETRY.threePoint.radiusFeet) * 1.1, 0, 7);
      badgeBonus += bonus; add("deep-range", bonus, { distanceFeet: distance });
    }
    const badge = (name: OffensiveBadge, bonus: number, eligible: boolean, evidence: Record<string, string | number | boolean | null>) => {
      if (playerHasBadge(shooter, name)) { const awarded = eligible ? bonus : 0; badgeBonus += awarded; add(name, awarded, { eligible, ...evidence }); }
    };
    badge("catch-and-shoot", 6, recentCatch && !!received?.settled && skill !== "finishing", { catchAgeMs: received?.elapsedMs ?? null, settled: received?.settled ?? false });
    badge("off-dribble-creator", 5, recentMovement, { speedFtPerSecond: speed, executedMovementCount: recentActions.length });
    badge("rim-finisher", 7, skill === "finishing", { skill });
    badge("slasher", 3, skill === "finishing", { skill });
    badge("cutter", 3, skill === "finishing" && recentMovement, { skill, recentMovement });
    badge("roll-threat", 4, skill === "finishing" && recentMovement, { skill, recentMovement });
    badge("post-scorer", 4, skill === "midrange" && distance <= 14, { skill, distanceFeet: distance });
  }
  add("offensive-badge-cap", Math.min(10, badgeBonus) - badgeBonus, { uncappedBonus: badgeBonus, cap: 10 });
  // Bounded heuristics: lateral/retreating movement adds no closeout pressure.
  const closeout = defendersEvidence.map(d => ({ id: d.id, pressure: clamp(d.approachSpeedFtPerSecond / 15, 0, 1) * clamp((12 - d.distanceFeet) / 10, 0, 1) * 6 }))
    .sort((a, b) => b.pressure - a.pressure || a.id - b.id)[0];
  const closeoutPenalty = closeout?.pressure ?? 0;
  const movementPenalty = clamp((speed - 2.5) / 16.5, 0, 1) * (skill === "finishing" ? 2 : 4);
  const catchPenalty = recentCatch && !received?.settled ? 2 : 0;
  add("closeout-motion", -closeoutPenalty, { defenderId: closeout?.id ?? null, maxPenalty: 6 });
  add("shooter-motion", -movementPenalty, { speedFtPerSecond: speed, settledSpeedFeet: 2.5 });
  add("catch-settling", -catchPenalty, { catchAgeMs: received?.elapsedMs ?? null, settled: received?.settled ?? false, settlingMs: 150 });
  const adjustedQuality = baseQuality + (rating - 3) * 8 + Math.min(10, badgeBonus) - closeoutPenalty - movementPenalty - catchPenalty;
  const capped = rating === 1 ? Math.min(adjustedQuality, 40) : adjustedQuality;
  const quality = Math.round(clamp(capped, 0, 100));
  if (!captureEvidence) return quality;
  add("rating-cap", capped - adjustedQuality, { rating, cap: rating === 1 ? 40 : 100 });
  add("clamp-and-round", quality - capped, { min: 0, max: 100 });
  return freezeShotRelease({ version: 1, scale: "simulation-score", atMs,
    shooter: { id: shooter.id, position: { x: shooter.x, y: shooter.y }, velocityFtPerSecond: velocity,
      speedFtPerSecond: speed, skill, rating, badges: [...shooter.badges ?? []] as OffensiveBadge[] },
    hoop: { ...hoop }, distanceFeet: distance, offBallQuality, catch: received, recentActions,
    defenders: defendersEvidence, modifiers, unclampedQuality: adjustedQuality, quality });
}

function parabolicPoint(start: CourtPoint, end: CourtPoint, amount: number) {
  const progress = clamp(amount, 0, 1);
  const startSvg = courtPointToSvg(start);
  const endSvg = courtPointToSvg(end);
  const height = Math.min(110, Math.max(30, Math.hypot(endSvg.x - startSvg.x, endSvg.y - startSvg.y) * 0.22));
  return clampCourt(courtSvgToPoint({
    x: startSvg.x + (endSvg.x - startSvg.x) * progress,
    y: startSvg.y + (endSvg.y - startSvg.y) * progress - Math.sin(Math.PI * progress) * height,
  }));
}

function updateShot(run: SimulationRun, timeMs: number, hoop: CourtPoint) {
  if (!isShotBall(run.ballState)) {
    const shooter = markerForId(run.players, run.ballHandlerId);
    if (!shooter || !beginShot(run, shooter, hoop, timeMs)) {
      run.adaptiveReadLabel = "No controlled shot";
      run.adaptiveReadReason = "No player controlled the ball when the possession ended";
      return;
    }
  }
  let ball = run.ballState;
  if (!isShotBall(ball)) return;
  if (ball.kind === "shot-setup") {
    const shooter = markerForId(run.players, ball.shooterId);
    if (shooter && !ball.pathOverride) ball.position = { x: shooter.x, y: shooter.y };
    if (timeMs + 1e-6 < ball.releaseAtMs) return;
    if (!shooter) throw new Error("The shooter is unavailable at release");
    const offBall = calculateOffBallQuality(run.players, run.ball, run.settings, run.defenders, shooter.id);
    const releaseContext = evaluateShotContext(run.players, run.defenders, shooter, offBall, hoop, badgeShotContext(run, shooter, timeMs));
    ball = run.ballState = transitionBall(ball, { kind: "release-shot", atMs: timeMs, releaseContext });
  }
  if (!isShotBall(ball)) return;
  if (ball.kind === "shot-in-flight") {
    const origin = ball.pathOverride ? { ...ball.pathOverride, atMs: Math.max(ball.releaseAtMs, ball.pathOverride.atMs) } : { atMs: ball.releaseAtMs, position: ball.start };
    const progress = clamp((timeMs - origin.atMs) / Math.max(1, ball.resultAtMs - origin.atMs), 0, 1);
    ball.position = parabolicPoint(origin.position, hoop, progress);
    if (timeMs + 1e-6 >= ball.resultAtMs) run.ballState = transitionBall(ball, { kind: "finish-shot", atMs: timeMs });
  }
}

function nextTimeBoundary(run: SimulationRun, stepEnd: number) {
  let nextActionBoundary = stepEnd;
  const afterElapsed = run.elapsedMs + 1e-6;
  for (const action of run.actions) {
    const endTime = action.startTime + action.durationMs;
    if (action.startTime > afterElapsed) nextActionBoundary = Math.min(nextActionBoundary, action.startTime);
    if (endTime > afterElapsed) nextActionBoundary = Math.min(nextActionBoundary, endTime);
  }
  const ball = run.ballState;
  if (isShotBall(ball)) {
    const boundary = ball.kind === "shot-setup" ? ball.releaseAtMs : ball.kind === "shot-in-flight" ? ball.resultAtMs : Infinity;
    if (boundary > afterElapsed) nextActionBoundary = Math.min(nextActionBoundary, boundary);
  }
  const nextEarlyRead = !run.shotStart && run.nextEarlyReadMs > run.elapsedMs + 1e-6
    ? run.nextEarlyReadMs
    : Number.POSITIVE_INFINITY;
  return Math.min(
    stepEnd,
    run.durationMs,
    nextActionBoundary,
    nextEarlyRead,
    run.actionDurationMs > run.elapsedMs + 1e-6 ? run.actionDurationMs : Number.POSITIVE_INFINITY,
  );
}

function transferBallToRecipient(run: SimulationRun, nextTime: number, stepMs: number) {
  const ball = run.ballState;
  if (!isTransferBall(ball)) return;
  const transfer = currentTransferAt(run, nextTime)!;
  const receiver = markerForId(run.players, ball.transfer.receiverId);
  const giver = markerForId(run.players, ball.transfer.giverId);
  if (!receiver || ball.kind === "handoff-pending" && !giver) {
    blockAction(run, transfer, "obstructed", !receiver ? "The selected receiver is unavailable" : "The handoff giver is unavailable", nextTime);
    return;
  }
  const ready = (ball.kind !== "handoff-pending" || giver && pointDistanceFeet(giver, receiver) <= 2.8)
    && pointDistanceFeet(ball.position, receiver) <= TRANSFER_CATCH_RADIUS_FEET;
  if (ready && ball.kind === "pass-in-flight") ball.transfer.arrival ??= { atMs: nextTime, position: { ...ball.position } };
  if (nextTime < transfer.startTime + transfer.durationMs - 1e-6) return;
  if (ready) {
    run.ballState = transitionBall(ball, { kind: "catch", receiverId: receiver.id, atMs: nextTime,
      position: receiver, giverPosition: giver ?? undefined });
    const state = executionFor(transfer); state.phase = "completed"; state.progress = 1; state.completedAtMs = nextTime;
    run.lastReceiveAtMs.set(receiver.id, nextTime);
    run.lastCatchEvidence.set(receiver.id, freezeShotRelease({ atMs: nextTime, actionId: transfer.arrow.id,
      sequence: transfer.sequence, giverId: giver?.id ?? null, kind: ball.transfer.kind,
      position: { x: receiver.x, y: receiver.y },
      receiverVelocityFtPerSecond: { ...run.velocities.get(velocityKey("player", receiver.id)) ?? { x: 0, y: 0 } },
      nearestDefenderGapFeet: run.defenders.length ? Math.min(...run.defenders.map(defender => pointDistanceFeet(defender, receiver))) : null }));
    run.offBallAnchors.set(receiver.id, { x: receiver.x, y: receiver.y });
    return;
  }
  if (extendPhase(run, transfer, stepMs)) return;
  blockAction(run, transfer, "obstructed", ball.kind === "handoff-pending" ? "The players could not meet for the handoff" : "The receiver could not complete the catch", nextTime);
}

function extendPhase(run: SimulationRun, action: BoundAction, delta: number) {
  const state = executionFor(action);
  if (state.waitMs + delta > MAX_TRANSFER_WAIT_MS + 1e-6) return false;
  if (run.adaptiveContinuationStartedAtMs != null && (action.adaptiveReadLabel || action.automatic) && run.actionDurationMs + delta - run.adaptiveContinuationStartedAtMs > MAX_ADAPTIVE_WINDOW_MS) return false;
  state.waitMs += delta;
  action.durationMs += delta;
  refreshActionSchedule(run);
  return true;
}

function finalizeCompletedMovement(run: SimulationRun, previousTime: number, nextTime: number) {
  for (const action of run.actions) {
    if (action.arrow.kind === "pass" || action.arrow.kind === "handoff" || !actionIsExecuting(action)) continue;
    const end = action.startTime + action.durationMs;
    if (previousTime >= end || nextTime < end - 1e-6) continue;
    const state = executionFor(action), actor = markerForId(run.players, action.actorId);
    const target = isScreenAction(action) && (action.arrow.kind === "pick-roll" || action.arrow.kind === "pick-pop" || action.arrow.kind === "slip-screen") ? screenFinish(action, HOOP_POINT) : action.arrow.end;
    const user = isScreenAction(action) ? markerForId(run.players, screenUserId(action)) : null;
    const velocity = actor ? run.velocities.get(velocityKey("player", actor.id)) : null;
    const complete = actor && pointDistanceFeet(actor, target) <= .6 && Math.hypot(velocity?.x ?? 0, velocity?.y ?? 0) <= 2
      && (!isScreenAction(action) || (state.phase === "release" && (!user || pointDistanceFeet(user, screenUserFinish(action, HOOP_POINT)) <= .8)));
    if (complete) { state.phase = "completed"; state.completedAtMs = nextTime; state.progress = 1; }
    else if (extendPhase(run, action, SIMULATION_FIXED_STEP_MS)) continue;
    else {
      state.phase = "obstructed"; state.completedAtMs = nextTime;
      const traffic = [actor, user].some((participant) => participant && [...run.players.filter((player) => player.id !== participant.id), ...run.defenders].some((other) => pointDistanceFeet(participant, other) < 2.5));
      state.notice = state.congestion?.status === "blocked" ? `Move ${action.sequence} could not make progress through the reserved player traffic`
        : traffic ? `Move ${action.sequence} was blocked by nearby player traffic` : `Move ${action.sequence} did not finish within the allowed time`;
    }
    if (actor) run.offBallAnchors.set(actor.id, { x: actor.x, y: actor.y });
    if (user) run.offBallAnchors.set(user.id, { x: user.x, y: user.y });
  }
}

function advanceStep(run: SimulationRun, stepMs: number, hoop: CourtPoint) {
  invalidateRunRoutes(run);
  const startTime = run.elapsedMs;
  const endTime = Math.min(run.durationMs, startTime + stepMs);
  const dt = (endTime - startTime) / 1000;
  reconcileBall(run, startTime);
  startReadyActions(run, startTime);
  primeScreenCoverageLocks(run, startTime);
  recordActionStarts(run, startTime);
  const sampleTime = Math.max(startTime, endTime - 0.001);
  run.movementBuffers.intentMap.clear();
  run.motionIntents = run.movementBuffers.intentMap;
  if (startTime < run.actionDurationMs) {
    updateOffense(run, sampleTime, dt, hoop);
    updateDefense(run, sampleTime, dt, hoop);
    coordinateCourt(run, dt);
    // Motion first, then actual catch/failure, then dependent action starts.
    updateBall(run, endTime, dt);
    transferBallToRecipient(run, endTime, Math.max(endTime - startTime, SIMULATION_FIXED_STEP_MS));
    finalizeCompletedMovement(run, startTime, endTime);
  } else {
    run.players.forEach((player) => coastMarker(run, "player", player, dt, OFFENSE_ACCELERATION_FT_PER_SECOND));
    updateDefense(run, sampleTime, dt, hoop);
    coordinateCourt(run, dt);
    if (!isShotBall(run.ballState)) updateBall(run, endTime, dt);
    updateShot(run, endTime, hoop);
  }
  run.elapsedMs = endTime;
  startReadyActions(run, endTime);
  if (run.settings.offenseMode !== "scripted" && !run.shotStart && run.elapsedMs + 1e-6 >= run.nextEarlyReadMs) {
    if (!run.actions.some((action) => !action.automatic && actionIsExecuting(action) && action.startTime <= run.elapsedMs && action.startTime + action.durationMs > run.elapsedMs && isScreenAction(action) && action.execution?.phase !== "release")) startEarlyRead(run, hoop);
    if (!run.earlyReadInterrupted) run.nextEarlyReadMs += EARLY_READ_INTERVAL_MS;
  }
  const authoredActionsEnded = run.elapsedMs + 1e-6 >= run.plannedActionDurationMs
    && run.adaptiveContinuationStartedAtMs == null;
  const liveActionEnded = run.adaptiveContinuationStartedAtMs != null
    && run.elapsedMs + 1e-6 >= run.actionDurationMs;
  if (run.settings.offenseMode !== "scripted" && !run.shotStart && (authoredActionsEnded || liveActionEnded)) {
    resolveAdaptiveRead(run, hoop);
  }
  recordRouteHistory(run);
  run.frame = frameFor(run);
  executionAuditors.get(run)?.(inspectSimulationExecution(run));
}

/** Advance execution and recorded state without copying an interpolated display frame. */
export function advanceSimulationState(run: SimulationRun, deltaMs: number, settings: SimulationSettings = run.settings, hoop = HOOP_POINT): void {
  if (!Number.isFinite(deltaMs)) throw new TypeError("Simulation elapsed time must be finite");
  if (run.elapsedMs >= run.durationMs || deltaMs <= 0) return;
  assertSimulationSessionHoop(run, hoop);
  setSimulationRunSettings(run, settings);
  if (advanceRecordedSimulation(run, Math.min(deltaMs, MAX_SIMULATION_DELTA_MS))) return;
  run.accumulatorMs += Math.min(deltaMs, MAX_SIMULATION_DELTA_MS);
  while (run.elapsedMs < run.durationMs) {
    const stepMs = Math.min(SIMULATION_FIXED_STEP_MS, run.durationMs - run.elapsedMs);
    if (run.accumulatorMs + 1e-6 < stepMs) break;
    const tickStart = run.elapsedMs;
    const tickEnd = Math.min(run.durationMs, tickStart + stepMs);
    run.previousFrame = copyFrame(run.frame);
    while (run.elapsedMs + 1e-6 < tickEnd) {
      const boundary = nextTimeBoundary(run, tickEnd);
      const sliceMs = Math.max(0, boundary - run.elapsedMs);
      if (sliceMs <= 1e-6) break;
      advanceStep(run, sliceMs, hoop);
    }
    const advancedMs = run.elapsedMs - tickStart;
    if (advancedMs <= 1e-6) {
      run.accumulatorMs = 0;
      break;
    }
    run.accumulatorMs = Math.max(0, run.accumulatorMs - advancedMs);
  }
  if (run.durationMs - run.elapsedMs <= 1e-6) {
    if (run.elapsedMs !== run.durationMs) invalidateRunRoutes(run);
    run.elapsedMs = run.durationMs;
    run.accumulatorMs = 0;
    run.frame = frameFor(run);
  }
  recordSimulationAdvance(run, Math.min(deltaMs, MAX_SIMULATION_DELTA_MS));
}

export function advanceSimulationRun(run: SimulationRun, deltaMs: number, settings: SimulationSettings = run.settings, hoop = HOOP_POINT) {
  advanceSimulationState(run, deltaMs, settings, hoop);
  return getSimulationFrame(run);
}

/** Paused relocation preserves active transfer/shot identity. A free placement
 * only grants possession within the same catch radius used for loose balls. */
function relocatePausedBall(run: SimulationRun, point: CourtPoint) {
  const ball = run.ballState;
  if (isTransferBall(ball) || isShotBall(ball)) {
    ball.position = { ...point }; ball.velocity = { x: 0, y: 0 };
    ball.pathOverride = { atMs: run.elapsedMs, position: { ...point } };
  } else {
    const nearest = run.players.slice().sort((a, b) => pointDistanceFeet(a, point) - pointDistanceFeet(b, point) || a.id - b.id)[0];
    run.ballState = placedBall(point, nearest && pointDistanceFeet(nearest, point) <= LOOSE_BALL_CATCH_RADIUS_FEET ? nearest.id : null, run.elapsedMs);
  }
}

type PausedRelocation = { type: "player" | "defender" | "ball"; id: number | string; point: CourtPoint };

/** Clone the entire data graph together: actionGraph and ball transfers must
 * still reference their corresponding actions/evidence. Keep the live getters,
 * which derive possession and shot evidence from the candidate's ball state. */
function stagePausedRun(run: SimulationRun): SimulationRun {
  const descriptors = Object.getOwnPropertyDescriptors(run);
  const data: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if ("value" in descriptor) {
      if (!descriptor.writable) throw new Error("The paused simulation cannot accept edits");
      data[key] = descriptor.value;
    }
  }
  for (const action of run.actions) for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(action))) {
    if (!("value" in descriptor) || !descriptor.writable || !Object.isExtensible(action)) throw new Error("The paused action cannot accept edits");
  }
  const candidate = structuredClone(data) as SimulationRun;
  if (isShotBall(candidate.ballState)) freezeShotRelease(candidate.ballState.releaseContext);
  freezeShotRelease(candidate.frame.shotRelease);
  freezeShotRelease(candidate.previousFrame.shotRelease);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) Object.defineProperty(candidate, key, descriptor);
  }
  return candidate as SimulationRun;
}

/** Copy executable state as one graph, preserving Maps, action references and
 * pending-transfer aliases. Register cloned attributes with the rating caches. */
export function cloneSimulationExecution(run: SimulationRun): SimulationRun {
  const candidate = stagePausedRun(run);
  refreshSimulationAttributes(candidate.attributes, candidate.players, candidate.defenders);
  return candidate;
}

export function restoreSimulationExecution(run: SimulationRun, candidate: SimulationRun) {
  validatePausedRun(candidate);
  const fields = Object.entries(Object.getOwnPropertyDescriptors(candidate)).filter(([, descriptor]) => "value" in descriptor);
  const fieldNames = new Set(fields.map(([key]) => key));
  const removed = Object.entries(Object.getOwnPropertyDescriptors(run)).filter(([key, descriptor]) => "value" in descriptor && !fieldNames.has(key));
  for (const [key] of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(run, key);
    if (descriptor ? !descriptor.writable : !Object.isExtensible(run)) throw new Error("The simulation cannot accept restored state");
  }
  if (removed.some(([, descriptor]) => !descriptor.configurable)) throw new Error("The simulation cannot accept restored state");
  for (const [key] of removed) Reflect.deleteProperty(run, key);
  for (const [key, descriptor] of fields) Reflect.set(run, key, descriptor.value);
  runRouteCache.delete(run);
}

function validatePausedRun(run: SimulationRun) {
  const finite = (value: number) => { if (!Number.isFinite(value)) throw new Error("The paused edit produced invalid simulation state"); };
  const point = (value: CourtPoint) => { finite(value.x); finite(value.y); };
  for (const value of [run.elapsedMs, run.accumulatorMs, run.durationMs, run.routeRevision]) finite(value);
  for (const marker of [...run.players, ...run.defenders]) point(marker);
  if (run.ball) point(run.ball);
  point(run.ballState.velocity);
  for (const value of run.velocities.values()) point(value);
  for (const value of [...run.actionStartOverrides.values(), ...run.recipientStartOverrides.values()]) { finite(value.atMs); point(value.point); }
  for (const action of run.actions) {
    if (run.actionGraph.get(`${action.arrow.id}:${action.sequence}`) !== action) throw new Error("Paused action dependencies are inconsistent");
    finite(action.startTime); finite(action.durationMs);
    if (action.execution) {
      finite(action.execution.progress); finite(action.execution.waitMs);
      for (const path of action.execution.paths.values()) { finite(path.progress); finite(path.length); path.points.forEach(point); }
    }
  }
  if (isTransferBall(run.ballState)) {
    const transfer = run.ballState.transfer;
    if (run.actionGraph.get(transfer.actionKey)?.transfer !== transfer || transfer.outcome.kind !== "pending"
      || !run.players.some(player => player.id === transfer.receiverId)) throw new Error("The pending catch is inconsistent");
  }
  if (isShotBall(run.ballState)) {
    point(run.ballState.start); finite(run.ballState.quality); finite(run.ballState.releaseAtMs);
    if (run.ballState.releaseContext) {
      validateShotRelease(run.ballState.releaseContext);
      if (run.ballState.quality !== run.ballState.releaseContext.quality) throw new Error("The released shot evaluation is inconsistent");
    }
  }
  for (const marker of [...run.frame.players, ...run.frame.defenders]) point(marker);
  if (run.frame.ball) point(run.frame.ball);
  for (const value of [run.frame.shotQuality, run.frame.defensiveQuality, run.frame.offBallQuality]) finite(value);
}

/** Prepare and validate off to the side. No live field, cached frame, source
 * drawing or execution evidence is changed until the whole update is ready. */
function transactPausedSimulation(run: SimulationRun, draft: PlaybookDraft, hoop: CourtPoint, relocation?: PausedRelocation) {
  validatePlaybookDocument(draft);
  const next = stagePausedRun(run), source = run.source;
  next.source = structuredClone(draft);
  const movedPlayers = new Set<number>(), movedDefenders = new Set<number>();
  const changedPlayers = new Set<number>(), changedDefenders = new Set<number>();
  const attributes = ({ x: _x, y: _y, ...rest }: PlaybookMarker) => JSON.stringify(rest);
  const updateRoster = (live: PlaybookMarker[], before: PlaybookMarker[], edited: PlaybookMarker[], moved: Set<number>, changed: Set<number>, type: "player" | "defender") => live.map(marker => {
    const old = before.find(p => p.id === marker.id), replacement = edited.find(p => p.id === marker.id);
    const forced = relocation?.type === type && Number(relocation.id) === marker.id ? relocation.point : null;
    const positionChanged = forced || old && replacement && (old.x !== replacement.x || old.y !== replacement.y);
    const attributesChanged = old && replacement && attributes(old) !== attributes(replacement);
    if (positionChanged) moved.add(marker.id);
    if (positionChanged || attributesChanged) changed.add(marker.id);
    return { ...(attributesChanged ? replacement! : marker), ...(positionChanged ? forced ?? replacement! : { x: marker.x, y: marker.y }) };
  });
  next.players = updateRoster(next.players, source.players, next.source.players, movedPlayers, changedPlayers, "player");
  next.defenders = updateRoster(next.defenders, source.defenders, next.source.defenders, movedDefenders, changedDefenders, "defender");
  const ballPoint = relocation?.type === "ball" ? relocation.point : draft.ball && (source.ball?.x !== draft.ball.x || source.ball?.y !== draft.ball.y) ? draft.ball : null;
  if (relocation?.type === "player") next.source.players = next.source.players.map(p => p.id === Number(relocation.id) ? { ...p, ...relocation.point } : p);
  if (relocation?.type === "defender") next.source.defenders = next.source.defenders.map(p => p.id === Number(relocation.id) ? { ...p, ...relocation.point } : p);
  if (ballPoint) { next.source.ball = { ...ballPoint }; relocatePausedBall(next, ballPoint); }

  const affectedKeys = new Set<string>();
  for (const player of next.players) if (changedPlayers.has(player.id)) {
    const key = velocityKey("player", player.id); affectedKeys.add(key);
    next.targetFilters.delete(key); next.offBallDecisions?.delete(player.id);
    if (movedPlayers.has(player.id)) {
      next.offBallAnchors.set(player.id, { x: player.x, y: player.y });
      next.velocities.set(key, { x: 0, y: 0 });
      if (next.ballState.kind === "held" && next.ballHandlerId === player.id) {
        next.ballState.position = { x: player.x, y: player.y }; next.ballState.velocity = { x: 0, y: 0 };
      }
    }
  }
  for (const defender of next.defenders) if (changedDefenders.has(defender.id)) {
    const key = velocityKey("defender", defender.id); affectedKeys.add(key); next.targetFilters.delete(key);
    if (movedDefenders.has(defender.id)) next.velocities.set(key, { x: 0, y: 0 });
  }
  refreshSimulationAttributes(next.attributes, next.players, next.defenders);
  for (const player of next.players) if (changedPlayers.has(player.id)) next.offBallTargetSkills.set(player.id, offBallTargetSkill(player, hoop));

  const affectedScreens = new Set<string>();
  for (const action of next.actions) {
    if (!actionIsMoving(action)) continue; // Completed evidence is historical.
    const state = action.execution;
    const participants = [action.actorId, action.recipientId, action.partnerId];
    const moved = participants.some(id => id != null && movedPlayers.has(id));
    if (state && moved) {
      if (isScreenAction(action)) {
        state.paths.clear(); affectedScreens.add(action.arrow.id);
        // An unused screen moved away from its set point must approach again.
        if (movedPlayers.has(action.actorId!) && state.usedAtMs == null && (state.phase === "set" || state.phase === "use")) {
          state.phase = "approach"; delete state.setAtMs;
        }
        const userId = screenUserId(action), user = markerForId(next.players, userId);
        if (user && movedPlayers.has(user.id)) {
          if (action.recipientId === userId) action.recipientStart = { x: user.x, y: user.y };
          else action.partnerStart = { x: user.x, y: user.y };
        }
        for (const id of participants) if (id != null) affectedKeys.add(velocityKey("player", id));
      } else for (const id of movedPlayers) state.paths.delete(id);
      if (action.actorId != null && movedPlayers.has(action.actorId) && action.arrow.kind !== "pass" && action.arrow.kind !== "handoff" && actionIsExecuting(action)) {
        const actor = markerForId(next.players, action.actorId)!;
        next.actionStartOverrides.set(action.arrow.id, { atMs: next.elapsedMs, point: { x: actor.x, y: actor.y } });
      }
      if (action.recipientId != null && movedPlayers.has(action.recipientId) && (action.arrow.kind === "pass" || action.arrow.kind === "handoff")) {
        const receiver = markerForId(next.players, action.recipientId)!;
        next.recipientStartOverrides.set(action.arrow.id, { atMs: next.elapsedMs, point: { x: receiver.x, y: receiver.y } });
      }
    }
  }
  // Preserve assignment rotations and already-performed switches; only geometry
  // and coverage claims depending on the edited participants need rebuilding.
  for (const [id, lock] of next.screenCoverageLocks) if (affectedScreens.has(id) || lock && (changedPlayers.has(lock.screenerId) || changedPlayers.has(lock.screenedId)
    || changedDefenders.has(lock.screenerDefenderId) || changedDefenders.has(lock.screenedDefenderId))) {
    next.screenCoverageLocks.delete(id); affectedScreens.add(id);
    if (lock) for (const defenderId of [lock.screenerDefenderId, lock.screenedDefenderId]) { next.targetFilters.delete(velocityKey("defender", defenderId)); affectedKeys.add(velocityKey("defender", defenderId)); }
  }
  for (const [id, duty] of next.defense.duties) if (ballPoint || changedDefenders.has(id) || duty.playerId != null && changedPlayers.has(duty.playerId) || duty.actionId != null && affectedScreens.has(duty.actionId)) {
    next.defense.duties.delete(id); next.targetFilters.delete(velocityKey("defender", id)); affectedKeys.add(velocityKey("defender", id));
  }
  if (ballPoint) {
    next.offBallDecisions?.clear();
    for (const marker of [...next.players, ...next.defenders]) affectedKeys.add(velocityKey(next.players.includes(marker) ? "player" : "defender", marker.id));
  }
  const congestion = next.movementBuffers.solver.congestion;
  for (const key of affectedKeys) { congestion.agents.delete(key); congestion.decisions.delete(key); next.motionIntents?.delete(key); }
  for (const [key, decision] of congestion.decisions) if (decision.blockers.some(id => affectedKeys.has(id))) congestion.decisions.delete(key);
  for (const key of congestion.passages.keys()) if ((JSON.parse(key) as string[]).some(id => affectedKeys.has(id))) congestion.passages.delete(key);
  congestion.destinations = congestion.destinations.filter(reservation => !affectedKeys.has(reservation.owner));
  if (affectedKeys.size) congestion.nextPlanMs = 0;
  for (const action of next.actions) if (action.execution?.congestion && (affectedKeys.has(velocityKey("player", action.execution.congestion.playerId)) || action.execution.congestion.blockers.some(id => affectedKeys.has(id)))) delete action.execution.congestion;
  next.routeHistory = ballPoint ? [] : next.routeHistory?.map(sample => ({ ...sample, players: sample.players.filter(p => !movedPlayers.has(p.id)) }));
  invalidateRunRoutes(next);
  const beforeFrame = next.frame, previous = next.previousFrame;
  next.frame = frameFor(next);
  const samePlaybackPhase = (a: SimulationFrame, b: SimulationFrame) => a.activeSequence === b.activeSequence
    && a.activeActionLabel === b.activeActionLabel && a.ballHandlerId === b.ballHandlerId && a.ballPhase === b.ballPhase;
  // Preserve the fractional display step for untouched markers. Snapping every
  // previous position to the new frame would move them on an attribute-only edit.
  if (samePlaybackPhase(previous, beforeFrame) && samePlaybackPhase(beforeFrame, next.frame)) {
    const previousPosition = (marker: PlaybookMarker, roster: PlaybookMarker[], moved: Set<number>) => {
      const old = moved.has(marker.id) ? null : roster.find(p => p.id === marker.id);
      return old ? { ...marker, x: old.x, y: old.y } : marker;
    };
    next.previousFrame = { ...next.frame,
      players: next.players.map(marker => previousPosition(marker, previous.players, movedPlayers)),
      defenders: next.defenders.map(marker => previousPosition(marker, previous.defenders, movedDefenders)),
      ball: ballPoint || next.ballState.kind === "held" && movedPlayers.has(next.ballState.holderId) ? next.frame.ball : previous.ball,
    };
  } else next.previousFrame = next.frame;
  validatePausedRun(next);
  const display = getSimulationFrame(next); // Prepare even the returned copy before commit.
  // Prepare the commit lists before touching live state. Keep action identities
  // stable for observers holding a bound action through pause/edit/resume.
  const actionUpdates = next.actions.map((action, index) => ({ target: run.actions[index], value: action }));
  next.actions = run.actions;
  next.actionGraph = new Map(next.actions.map(action => [`${action.arrow.id}:${action.sequence}`, action]));
  const fields = Object.entries(Object.getOwnPropertyDescriptors(next)).filter(([, descriptor]) => "value" in descriptor);
  const routes = runRouteCache.get(next);
  // All targets are plain writable data properties (checked above). JavaScript
  // cannot run movement or observers between these synchronous assignments.
  for (const { target, value } of actionUpdates) Object.assign(target, value);
  for (const [key, descriptor] of fields) Reflect.set(run, key, descriptor.value);
  if (routes) runRouteCache.set(run, routes);
  return display;
}

export function editPausedSimulationMarker(run: SimulationRun, type: "player" | "defender" | "ball", id: number | string, point: CourtPoint, draft: PlaybookDraft = run.source) {
  validatePlaybookDocument(draft);
  if (!pausedDraftIsCompatible(run.source, draft)) throw new Error("The paused drawing changed its actions or participants. Restart playback to apply it");
  if (!["player", "defender", "ball"].includes(type) || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Choose a valid paused marker and court position");
  if (type !== "ball" && !(type === "player" ? run.players : run.defenders).some(marker => marker.id === Number(id))) throw new Error("The paused marker is no longer on the court");
  assertSimulationSessionHoop(run, HOOP_POINT);
  const relocation = { type, id, point: clampCourt(point) };
  const frame = transactPausedSimulation(run, draft, HOOP_POINT, relocation);
  recordSimulationEdit(run, relocation);
  return frame;
}

export function pausedDraftIsCompatible(source: PlaybookDraft, draft: PlaybookDraft) {
  return JSON.stringify(source.arrows) === JSON.stringify(draft.arrows)
    && JSON.stringify(source.players.map(p => p.id)) === JSON.stringify(draft.players.map(p => p.id))
    && JSON.stringify(source.defenders.map(p => p.id)) === JSON.stringify(draft.defenders.map(p => p.id))
    && Boolean(source.ball) === Boolean(draft.ball);
}

export function rebasePausedSimulation(run: SimulationRun, draft: PlaybookDraft, hoop = HOOP_POINT) {
  validatePlaybookDocument(draft);
  if (!pausedDraftIsCompatible(run.source, draft)) return false;
  assertSimulationSessionHoop(run, hoop);
  transactPausedSimulation(run, draft, hoop);
  recordSimulationEdit(run);
  return true;
}

export function simulationTimelineDuration(arrows: PlaybookArrow[]) {
  return buildActions({
    version: 1,
    id: "timeline",
    name: "timeline",
    defenders_visible: false,
    players: [],
    defenders: [],
    ball: null,
    arrows,
  }).actionDurationMs;
}
