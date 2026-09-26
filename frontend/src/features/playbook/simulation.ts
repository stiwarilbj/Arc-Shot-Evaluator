import type { CourtPoint, DefenseScheme, DefensiveBadge, OffensiveBadge, PlayerSkillRatings, PlaybookArrow, PlaybookDraft, PlaybookMarker, SimulationSettings } from "./types.ts";
import { playerHasBadge } from "./badges.ts";
import { defenderHasBadge } from "./defensiveBadges.ts";
import {
  COURT_SCALE,
  COURT_VIEWBOX,
  NBA_COURT_GEOMETRY,
  courtPointToSvg,
  courtSvgToPoint,
} from "./courtGeometry.ts";

export type SimulationFrame = {
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
  shooterId: number | null;
  shotStart: CourtPoint | null;
  shotTarget: CourtPoint | null;
};

type BoundAction = {
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
  transferWaitMs?: number;
  transferFailed?: boolean;
};

type Velocity = { x: number; y: number };
type PositionOverride = { atMs: number; point: CourtPoint };
type ScreenCoverageLock = { screenerDefenderId: number; screenedDefenderId: number } | null;

export type SimulationRun = {
  actions: BoundAction[];
  actionDurationMs: number;
  durationMs: number;
  readonly assignments: Map<number, number>;
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
  readonly transferStarts: Map<string, CourtPoint>;
  readonly offBallAnchors: Map<number, CourtPoint>;
  readonly targetFilters: Map<string, CourtPoint>;
  readonly velocities: Map<string, Velocity>;
  readonly recipientStartOverrides: Map<string, PositionOverride>;
  readonly offBallTargetSkills: Map<number, OffBallTargetSkill | null>;
  readonly lastReceiveAtMs: Map<number, number>;
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
  ball: CourtPoint | null;
  ballHandlerId: number | null;
  helpDefenderId: number | null;
  helpThreatEndedAtMs: number | null;
  defensiveDriveThreatUntilMs: number;
  defensiveDriveThreatHandlerId: number | null;
  elapsedMs: number;
  accumulatorMs: number;
  ballVelocity: Velocity;
  shotStart: CourtPoint | null;
  shotPathOverride: PositionOverride | null;
  shotShooterId: number | null;
  shotQualityAtRelease: number;
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
const HELP_RELEASE_DELAY_MS = 220;
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
  auto: "Randomly choose an eligible scheme at the start of each possession.",
  "man-to-man": "Stay with assigned players and contain the ball in front.",
  "pack-line": "Guard assignments while off-ball defenders shade toward the paint.",
  "zone-2-3": "Two high defenders pressure the wings; three protect the lane and baseline.",
  "zone-3-2": "Three across the top close to shooters; two protect the low blocks.",
  "zone-1-3-1": "Pressure the top, cover three across the middle, and patrol the baseline.",
  "zone-2-1-2": "Two high defenders steer the ball toward a middle anchor and two low defenders.",
  "zone-1-2-2": "One high defender pressures the ball with two wings and two low defenders behind.",
  "matchup-1-1-3": "Two guards pressure high while three defenders protect the front line by area.",
  "box-and-one": "One defender tracks the top threat; four defenders hold a box zone.",
  "triangle-and-two": "Two defenders track the top threats; three defenders hold a triangle zone.",
};

const DEFENSE_SCHEME_ORDER: ResolvedDefenseScheme[] = [
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
    ? `${DEFENSE_SCHEME_LABELS[requested]} needs five defenders. Man-to-man is active for this possession.`
    : `${DEFENSE_SCHEME_LABELS[requested]} needs ${requested === "triangle-and-two" ? "two offensive players" : "one offensive player"}. Man-to-man is active for this possession.`;
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

function lerpPoint(start: CourtPoint, end: CourtPoint, amount: number): CourtPoint {
  const progress = clamp(amount, 0, 1);
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  };
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

function quadraticPoint(start: CourtPoint, end: CourtPoint, control: CourtPoint, amount: number) {
  const progress = clamp(amount, 0, 1);
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x,
    y: inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y,
  };
}

function defaultControl(start: CourtPoint, end: CourtPoint): CourtPoint {
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const offset = clamp(distance * 0.22, 5, 13);
  return clampCourt({
    x: midpoint.x + (dy * offset) / Math.max(1, distance),
    y: midpoint.y - (dx * offset) / Math.max(1, distance),
  });
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
      const isScreen = arrow.kind === "screen" || arrow.kind === "pick-roll" || arrow.kind === "pick-pop";
      const isOffBallScreen = arrow.kind === "off-ball-screen" || arrow.kind === "pin-down";
      const isCut = arrow.kind === "backdoor-cut";
      const usesNamedScreener = arrow.screener_id != null && (isOffBallScreen || isScreen);
      const actorIndex = usesNamedScreener
        ? phasePositions.findIndex((player) => player.id === arrow.screener_id)
        : isCut && arrow.actor_id != null
          ? phasePositions.findIndex((player) => player.id === arrow.actor_id)
          : isTransfer && phaseHandlerId != null
            ? phasePositions.findIndex((player) => player.id === phaseHandlerId)
            : nearestPointIndex(phasePositions, arrow.start);
      const actor = phasePositions[actorIndex] ?? null;
      const recipientIndex = isOffBallScreen && arrow.cutter_id != null
        ? phasePositions.findIndex((player) => player.id === arrow.cutter_id)
        : isTransfer ? nearestPointIndex(phasePositions, arrow.end, actor?.id) : -1;
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
      const durationMs = Math.max(authoredDuration, minimumMovementDuration, minimumTransferDuration);
      const partnerId = isScreen && actor?.id !== handler?.id ? handler?.id ?? null : null;
      const boundAction: BoundAction = {
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
      };
      actions.push(boundAction);
      phaseDuration = Math.max(phaseDuration, durationMs);

      // Routes are applied in diagram order. Screens still affect coverage if
      // their cutter already has a route in this simultaneous phase.
      if (movesOnCourt && actorIndex >= 0 && !routeClaims.has(actor?.id ?? -1)) {
        const finish = arrow.kind === "pick-roll"
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
  return { actions, actionDurationMs: Math.max(MIN_PLAY_DURATION_MS, cursor), ballHandlerId, finalPositions: positions };
}


function normalizeSettings(settings: SimulationSettings): SimulationSettings {
  return {
    offenseOffBall: settings.offenseOffBall,
    defenseScheme: settings.defenseScheme ?? "auto",
    defenseStrategy: settings.defenseStrategy,
    offBallIntensity: settings.offBallIntensity,
    automaticActions: { ...settings.automaticActions },
  };
}

function defenderGap(player: CourtPoint, defenders: PlaybookMarker[]) {
  return defenders.length ? Math.min(...defenders.map((defender) => pointDistanceFeet(player, defender))) : Number.POSITIVE_INFINITY;
}

function playerRating(player: PlaybookMarker, key: keyof PlayerSkillRatings) {
  const value = player.ratings?.[key] ?? 3;
  return Number.isInteger(value) ? clamp(value, 1, 5) : 3;
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

function recentlyMovedWithBall(run: SimulationRun, playerId: number, timeMs: number) {
  const velocity = run.velocities.get(velocityKey("player", playerId)) ?? { x: 0, y: 0 };
  if (Math.hypot(velocity.x, velocity.y) >= 2.5) return true;
  return run.actions.some((action) => action.actorId === playerId
    && ["movement", "pick-roll", "pick-pop", "backdoor-cut"].includes(action.arrow.kind)
    && action.startTime <= timeMs
    && timeMs - action.startTime <= 1800);
}

function badgeShotContext(run: SimulationRun, player: PlaybookMarker, timeMs: number) {
  const receivedAt = run.lastReceiveAtMs.get(player.id) ?? Number.NEGATIVE_INFINITY;
  return {
    recentCatch: timeMs - receivedAt >= 0 && timeMs - receivedAt <= 1150,
    recentMovement: recentlyMovedWithBall(run, player.id, timeMs),
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

function stopAuthoredActionsAt(run: SimulationRun, timeMs: number) {
  const hasContinuation = run.adaptiveContinuationStartedAtMs != null;
  run.actions = run.actions.flatMap((action) => {
    if (action.startTime >= timeMs - 1e-6) return [];
    const endTime = action.startTime + action.durationMs;
    if (endTime <= timeMs) return [action];
    return [{ ...action, durationMs: Math.max(0, timeMs - action.startTime) }];
  });
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

function beginShot(run: SimulationRun, player: PlaybookMarker, hoop: CourtPoint) {
  run.actionDurationMs = run.elapsedMs;
  run.durationMs = run.actionDurationMs + run.shotDurationMs;
  run.ballHandlerId = player.id;
  run.ball = { x: player.x, y: player.y };
  run.shotStart = { x: player.x, y: player.y };
  run.shotShooterId = player.id;
  const offBall = calculateOffBallQuality(run.players, run.shotStart, run.settings, run.defenders, player.id);
  run.shotQualityAtRelease = calculateShotQuality(run.players, run.defenders, player, offBall, hoop, badgeShotContext(run, player, run.elapsedMs));
}

function readReason(choice: LiveReadChoice, handler: PlaybookMarker, hoop: CourtPoint) {
  if (choice.kind === "pass") {
    const space = Number.isFinite(choice.receiverGap) ? `${choice.receiverGap.toFixed(1)} ft of space` : "open space";
    const rating = shotSkillRating(choice.player, hoop);
    return `Player ${choice.player.id} has ${space}, a clear passing lane, good floor spacing, and a ${rating}/5 shot rating for ${choice.expectedPoints.toFixed(2)} estimated points.`;
  }
  if (choice.kind === "drive") {
    return `Player ${handler.id} has a clear lane and a ${playerRating(handler, "finishing")}/5 finishing rating; the route projects ${choice.expectedPoints.toFixed(2)} points.`;
  }
  return `Player ${choice.player.id} has the best available shot at ${choice.expectedPoints.toFixed(2)} estimated points with ${choice.quality}% quality.`;
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
    run.adaptiveReadReason = "The play has no player in possession to continue the action.";
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
    run.adaptiveReadReason = "No player is available to finish the play.";
    return;
  }
  run.adaptiveReadLabel = run.adaptiveActionsTaken > 0 ? "Best shot after live reads" : "No safe continuation";
  run.adaptiveReadRoute = null;
  run.adaptiveReadReason = run.adaptiveActionsTaken > 0
    ? readReason(shotChoice, handler, hoop)
    : `Defenders cover the best passing and driving routes, so player ${shotChoice.player.id} takes the shot with the best available expected value.`;
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
  const activeActions = run.actions.filter((action) => !action.transferFailed
    && run.elapsedMs + 1e-6 >= action.startTime
    && run.elapsedMs < action.startTime + action.durationMs - 1e-6);
  const activeAction = activeActions.find((action) => !action.automatic) ?? activeActions[0];
  const actionLabels = activeActions.map(autoActionLabel);
  const shotElapsed = run.elapsedMs - run.actionDurationMs;
  const shotProgress = run.shotStart
    ? clamp(shotElapsed / run.shotDurationMs, 0, 1)
    : 0;
  const shotPhase: SimulationFrame["shotPhase"] = !run.shotStart
    ? "idle"
    : shotProgress < 0.18
      ? "setup"
      : shotProgress < 0.84
        ? "air"
        : "result";
  const shooter = markerForId(run.players, run.shotShooterId ?? run.ballHandlerId);
  const shotQuality = shooter ? run.shotQualityAtRelease || calculateShotQuality(run.players, run.defenders, shooter, 70) : 0;
  return {
    players: run.players.map((player) => ({ ...player })),
    defenders: run.defenders.map((defender) => ({ ...defender })),
    ball: run.ball ? { ...run.ball } : null,
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
    shooterId: run.shotShooterId,
    shotStart: run.shotStart ? { ...run.shotStart } : null,
    shotTarget: run.shotStart ? { ...HOOP_POINT } : null,
  };
}

function createInitialFrame(): SimulationFrame {
  return {
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
    shooterId: null,
    shotStart: null,
    shotTarget: null,
  };
}

export function createSimulationRun(source: PlaybookDraft, settings: SimulationSettings, hoop = HOOP_POINT): SimulationRun {
  const sourceCopy = structuredClone(source);
  const runSettings = normalizeSettings(settings);
  const players = sourceCopy.players.map((player) => ({ ...player }));
  const ephemeralDefenders = sourceCopy.defenders.length === 0;
  const defenders = createGoalSideDefenders(players, sourceCopy.defenders, hoop);
  const defenseSchemeResolution = chooseDefenseScheme(runSettings.defenseScheme, defenders.length, players.length);
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
  const manual = buildActions(sourceCopy);
  const actions = [...manual.actions];
  let actionDurationMs = manual.actionDurationMs;
  const projectedPlayers = manual.finalPositions.map((player) => ({ ...player }));
  const projectedHandlerId = manual.ballHandlerId;
  const projectedHandler = markerForId(projectedPlayers, projectedHandlerId);
  const projectedBall = projectedHandler ? { x: projectedHandler.x, y: projectedHandler.y } : sourceCopy.ball;
  const excludedForOnBall = new Set<number>();
  let nextSequence = Math.max(0, ...actions.map((action) => action.sequence)) + 1;

  if (runSettings.automaticActions.offBallScreen) {
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

  if (runSettings.automaticActions.screen || runSettings.automaticActions.handoff || runSettings.automaticActions.pickRoll) {
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
    actions,
    actionDurationMs,
    durationMs: actionDurationMs + SIMULATION_SHOT_MS,
    assignments,
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
    transferStarts: new Map(),
    offBallAnchors: new Map(players.map((player) => [player.id, { x: player.x, y: player.y }])),
    targetFilters: new Map(),
    velocities: new Map(),
    recipientStartOverrides: new Map(),
    offBallTargetSkills: new Map(players.map((player) => [player.id, offBallTargetSkill(player, hoop)])),
    lastReceiveAtMs: new Map(),
    source: sourceCopy,
    settings: runSettings,
    players,
    defenders,
    ball,
    ballHandlerId,
    helpDefenderId: null,
    helpThreatEndedAtMs: null,
    defensiveDriveThreatUntilMs: 0,
    defensiveDriveThreatHandlerId: initialHandlerId,
    elapsedMs: 0,
    accumulatorMs: 0,
    ballVelocity: { x: 0, y: 0 },
    shotStart: null,
    shotPathOverride: null,
    shotShooterId: null,
    shotQualityAtRelease: 0,
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
  if (formation) {
    const initialHandler = markerForId(players, ballHandlerId);
    if (initialHandler) {
      run.zoneBallDefenderId = [...zoneAssignments.entries()]
        .sort((a, b) => pointDistanceFeet(zoneAnchors(activeDefenseScheme, hoop)[a[1]], initialHandler)
          - pointDistanceFeet(zoneAnchors(activeDefenseScheme, hoop)[b[1]], initialHandler)
          || a[0] - b[0])[0]?.[0] ?? null;
    }
  }
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
  current.players = current.players.map((player) => {
    const previous = previousPlayers.get(player.id);
    return previous ? { ...player, ...lerpPoint(previous, player, progress) } : player;
  });
  current.defenders = current.defenders.map((defender) => {
    const previous = previousDefenders.get(defender.id);
    return previous ? { ...defender, ...lerpPoint(previous, defender, progress) } : defender;
  });
  if (run.previousFrame.ball && current.ball) current.ball = lerpPoint(run.previousFrame.ball, current.ball, progress);
  return current;
}

export function setSimulationRunSettings(run: SimulationRun, settings: SimulationSettings) {
  const previousStrategy = run.settings.defenseStrategy;
  const nextSettings = normalizeSettings(settings);
  if (previousStrategy === "switch" && nextSettings.defenseStrategy !== "switch") {
    run.assignments.clear();
    run.initialAssignments.forEach((playerId, defenderId) => run.assignments.set(defenderId, playerId));
  }
  nextSettings.defenseScheme = run.settings.defenseScheme;
  run.settings = nextSettings;
  run.frame = frameFor(run);
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
  if (distance < 0.02) return { point: { ...target }, velocity: { x: 0, y: 0 } };
  const brakingSpeed = Math.sqrt(2 * accelerationFeetPerSecond * distance);
  const desiredSpeed = Math.min(maxSpeedFeetPerSecond, brakingSpeed);
  const desired = { x: (dx / distance) * desiredSpeed, y: (dy / distance) * desiredSpeed };
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
  if (firstPlayerId == null || secondPlayerId == null || firstPlayerId === secondPlayerId) return;
  const firstDefender = run.defenders.find((defender) => run.assignments.get(defender.id) === firstPlayerId);
  const secondDefender = run.defenders.find((defender) => run.assignments.get(defender.id) === secondPlayerId);
  if (!firstDefender || !secondDefender) return;
  run.assignments.set(firstDefender.id, secondPlayerId);
  run.assignments.set(secondDefender.id, firstPlayerId);
}

function processActionStart(run: SimulationRun, action: BoundAction) {
  if (run.switchedActions.has(action.arrow.id)) return;
  run.switchedActions.add(action.arrow.id);
  if (run.settings.defenseStrategy !== "switch" || !isManScheme(run.activeDefenseScheme)) return;
  if (action.arrow.kind === "screen" || action.arrow.kind === "pick-roll" || action.arrow.kind === "pick-pop") {
    swapAssignments(run, action.actorId, action.partnerId ?? run.ballHandlerId);
  } else if (action.arrow.kind === "handoff") {
    swapAssignments(run, action.actorId, action.recipientId);
  } else if (action.arrow.kind === "off-ball-screen" || action.arrow.kind === "pin-down") {
    swapAssignments(run, action.actorId, action.recipientId);
  }
}

function currentActionAt(run: SimulationRun, timeMs: number) {
  return run.actions.find((action) => timeMs >= action.startTime - 1e-6 && timeMs < action.startTime + action.durationMs + 1e-6) ?? null;
}

function currentTransferAt(run: SimulationRun, timeMs: number) {
  return run.actions.find((action) =>
    (action.arrow.kind === "pass" || action.arrow.kind === "handoff")
    && action.recipientId != null
    && !action.transferFailed
    && timeMs >= action.startTime - 1e-6
    && timeMs < action.startTime + action.durationMs + 1e-6,
  ) ?? null;
}

function currentPrepAt(run: SimulationRun, timeMs: number) {
  return run.actions.find((action) => {
    if (action.recipientId == null || action.transferFailed || (action.arrow.kind !== "pass" && action.arrow.kind !== "handoff")) return false;
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
      if (action.transferFailed) return false;
      const kind = action.arrow.kind;
      if (kind === "handoff" && (isManScheme(run.activeDefenseScheme) || run.settings.defenseStrategy !== "switch")) return false;
      return (kind === "screen" || kind === "pick-roll" || kind === "pick-pop" || kind === "off-ball-screen" || kind === "pin-down" || kind === "handoff")
        && timeMs >= action.startTime
        && timeMs < action.startTime + action.durationMs;
    })
    .sort((a, b) => Number(Boolean(a.automatic)) - Number(Boolean(b.automatic)) || a.sequence - b.sequence || a.startTime - b.startTime);
}

function primeScreenCoverageLocks(run: SimulationRun, timeMs: number) {
  const activeScreens = screenCoverageActionsAt(run, timeMs);
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
    run.screenCoverageLocks.set(action.arrow.id, { screenerDefenderId, screenedDefenderId });
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
        let dx = aTarget.x - bTarget.x;
        let dy = aTarget.y - bTarget.y;
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
    if (timeMs < action.startTime || run.actionStarts.has(action.arrow.id)) return;
    const player = markerForId(run.players, action.actorId);
    if (player) run.actionStarts.set(action.arrow.id, { x: player.x, y: player.y });
  });
}

function activeTransferStart(run: SimulationRun, action: BoundAction) {
  const override = run.actionStartOverrides.get("ball:" + action.arrow.id);
  if (override) return override.point;
  const existing = run.transferStarts.get(action.arrow.id);
  if (existing) return existing;
  const start = run.ball ? { ...run.ball } : action.arrow.start;
  run.transferStarts.set(action.arrow.id, start);
  return start;
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
    const cycle = (timeMs / 1000 + player.id * 0.47) % 5.5;
    const cutAmount = cycle < 1.5
      ? cycle / 1.5
      : cycle < 3.2
        ? 1
        : clamp(1 - (cycle - 3.2) / 2.3, 0, 1);
    const cutPoint = pointToward(anchor, hoop, maxOffset * 0.8);
    const cutterWeight = clamp(
      clamp((playerRating(player, "finishing") - 1) / 2, 0, 1) * 0.55
        + (playerHasBadge(player, "cutter") ? 0.36 : 0)
        + (playerHasBadge(player, "slasher") ? 0.24 : 0)
        + (playerHasBadge(player, "rim-finisher") ? 0.18 : 0),
      0,
      0.82,
    );
    target = lerpPoint(target, cutPoint, cutAmount * cutterWeight);
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
  return offset > maxOffset && offset > 0
    ? pointToward(anchor, target, maxOffset)
    : clampCourt(target);
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

function defensiveTargets(run: SimulationRun, timeMs: number, hoop: CourtPoint) {
  const handler = markerForId(run.players, run.ballHandlerId) ?? run.players[0] ?? null;
  const activeAction = currentActionAt(run, timeMs);
  const isMan = isManScheme(run.activeDefenseScheme);
  const formation = zoneFormation(run.activeDefenseScheme);
  const screenCoverages = run.settings.defenseStrategy === "switch" && isMan ? [] : screenCoveragesAt(run, timeMs);
  const coverageByDefender = new Map<number, { coverage: ScreenCoverage; role: "screener" | "screened" }>();
  screenCoverages.forEach((coverage) => {
    coverageByDefender.set(run.defenders[coverage.screenerIndex].id, { coverage, role: "screener" });
    coverageByDefender.set(run.defenders[coverage.screenedIndex].id, { coverage, role: "screened" });
  });
  const transfer = currentTransferAt(run, timeMs);
  const drive = sustainedDefensiveDriveThreat(run, handler, timeMs, hoop);
  const strategy = run.settings.defenseStrategy;
  const anchors = formation ? zoneAnchors(run.activeDefenseScheme, hoop) : [];
  const zoneShapeTargets = new Map<number, CourtPoint>();
  if (formation && handler) {
    const ballPoint = run.ball ?? handler;
    const ballFeet = toCourtFeet(ballPoint);
    for (const [defenderId, slot] of run.zoneAssignments) {
      const anchor = anchors[slot];
      if (!anchor) continue;
      const anchorFeet = toCourtFeet(anchor);
      const slide = clamp((ballFeet.x - anchorFeet.x) * 0.28, -4.5, 4.5);
      let target = addFeet(anchor, { x: slide, y: 0 });
      const handlerDistanceToHoop = pointDistanceFeet(handler, hoop);
      if (handlerDistanceToHoop < 18) target = pointToward(target, hoop, clamp((18 - handlerDistanceToHoop) * 0.15, 0, 2.5));
      zoneShapeTargets.set(defenderId, target);
    }
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
  const handlerDefenderIndex = handler
    ? formation
      ? run.defenders.findIndex((defender) => defender.id === zoneBallDefenderId)
      : run.defenders.findIndex((defender) => run.assignments.get(defender.id) === handler.id)
    : -1;
  let helperIndex = -1;
  const helpStyle = strategy === "help" || strategy === "trap-rotate" || strategy === "protect-paint";
  const badgeHelpAvailable = run.defenders.some((defender) => defenderHasBadge(defender, "helper") || defenderHasBadge(defender, "paint-protector"));
  const finishingRating = handler ? helpFinishingRating(handler) : 3;
  const helpWeight = clamp(0.55 + finishingRating * 0.15, 0.7, 1.3);
  const helpSpot = handler ? helpSpotFor(handler, hoop, finishingRating) : hoop;
  if (drive) run.helpThreatEndedAtMs = null;
  else if (run.helpDefenderId != null) {
    if (run.helpThreatEndedAtMs == null) run.helpThreatEndedAtMs = timeMs;
    if (timeMs - run.helpThreatEndedAtMs >= HELP_RELEASE_DELAY_MS) {
      run.helpDefenderId = null;
      run.helpThreatEndedAtMs = null;
    }
  } else run.helpThreatEndedAtMs = null;
  if (drive && !helpStyle && !badgeHelpAvailable) run.helpDefenderId = null;
  if (drive && (helpStyle || badgeHelpAvailable)) {
    const currentHelperIndex = run.defenders.findIndex((defender) => defender.id === run.helpDefenderId);
    const currentHelperDefender = run.defenders[currentHelperIndex];
    const currentHelperAssignment = currentHelperIndex < 0 ? null : run.assignments.get(currentHelperDefender.id);
    const currentHelperIsChaser = currentHelperIndex >= 0 && run.zoneChaserAssignments.has(currentHelperDefender.id);
    const currentHelperMatchup = currentHelperIndex < 0 ? null : markerForId(run.players, currentHelperAssignment ?? null);
    const currentHelperProtectsThreat = currentHelperMatchup != null
      && pointDistanceFeet(currentHelperMatchup, hoop) > 19
      && pointDistanceFeet(currentHelperDefender, currentHelperMatchup) > 8
      && (playerRating(currentHelperMatchup, "threePoint") >= 4
        || playerHasBadge(currentHelperMatchup, "deep-range")
        || playerHasBadge(currentHelperMatchup, "catch-and-shoot"));
    const currentHelperUnavailable = currentHelperIndex < 0
      || currentHelperIsChaser
      || currentHelperIndex === handlerDefenderIndex
      || coverageByDefender.has(currentHelperDefender?.id ?? -1)
      || transfer?.recipientId === currentHelperAssignment
      || (isMan && currentHelperAssignment === handler?.id)
      || currentHelperProtectsThreat;
    if (currentHelperUnavailable) {
      run.helpDefenderId = null;
      const helperCandidates: Array<{ index: number; defender: PlaybookMarker; distance: number; helpRange: number; score: number; protectsShooter: boolean }> = [];
      run.defenders.forEach((defender, index) => {
        if (index === handlerDefenderIndex) return;
        if (formation && run.zoneChaserAssignments.has(defender.id)) return;
        if (coverageByDefender.has(defender.id)) return;
        const assignedPlayerId = run.assignments.get(defender.id);
        if (transfer?.recipientId === assignedPlayerId) return;
        const distance = pointDistanceFeet(defender, helpSpot);
        const slotAnchor = zoneAnchorFor(run, defender.id, hoop);
        const assignedPlayer = formation && slotAnchor
          ? run.players.filter((player) => ![...run.zoneChaserAssignments.values()].includes(player.id))
            .slice().sort((a, b) => pointDistanceFeet(slotAnchor, a) - pointDistanceFeet(slotAnchor, b) || a.id - b.id)[0]
          : markerForId(run.players, assignedPlayerId ?? null);
        const shootingThreat = assignedPlayer ? defensiveThreatRating(assignedPlayer, hoop) : 3;
        const perimeterRisk = assignedPlayer
          ? Math.max(0, playerRating(assignedPlayer, "threePoint") - 3) * 2
            + Number(playerHasBadge(assignedPlayer, "deep-range") || playerHasBadge(assignedPlayer, "catch-and-shoot")) * 2
          : 0;
        const badgePriority = Number(defenderHasBadge(defender, "helper")) * 4
          + Number(defenderHasBadge(defender, "paint-protector") && handler != null && pointDistanceFeet(handler, hoop) <= 18) * 2.5;
        const score = distance + (shootingThreat - 3) * 1.15 + perimeterRisk - badgePriority;
        const protectsShooter = assignedPlayer != null
          && pointDistanceFeet(assignedPlayer, hoop) > 19
          && pointDistanceFeet(defender, assignedPlayer) > 8
          && (playerRating(assignedPlayer, "threePoint") >= 4
            || playerHasBadge(assignedPlayer, "deep-range")
            || playerHasBadge(assignedPlayer, "catch-and-shoot"));
        const helpRange = defenderHasBadge(defender, "helper") ? 21
          : defenderHasBadge(defender, "paint-protector") ? 19 : 18;
        helperCandidates.push({ index, defender, distance, helpRange, score, protectsShooter });
      });
      const safeCandidates = helperCandidates.filter((candidate) => !candidate.protectsShooter && candidate.distance <= candidate.helpRange);
      const selectedHelper = safeCandidates.sort((a, b) => a.score - b.score || a.defender.id - b.defender.id)[0];
      helperIndex = selectedHelper?.index ?? -1;
      run.helpDefenderId = selectedHelper?.defender.id ?? null;
    } else {
      helperIndex = currentHelperIndex;
    }
    if (run.helpDefenderId == null) helperIndex = -1;
  }
  const transferDefenderIndex = transfer?.recipientId == null
    ? -1
    : formation
      ? coverageDefenderIndex(run, transfer.recipientId)
      : run.defenders.findIndex((defender) => run.assignments.get(defender.id) === transfer.recipientId);
  const targets = run.defenders.map((defender, index) => {
    const assignmentId = run.assignments.get(defender.id);
    const assignment = markerForId(run.players, assignmentId ?? null) ?? handler;
    if (!handler || !assignment || strategy === "off") return { ...defender };
    const isOnBall = index === handlerDefenderIndex;
    const hasPriorityDuty = isOnBall || coverageByDefender.has(defender.id) || run.zoneChaserAssignments.has(defender.id);
    const canRotateForHelp = !hasPriorityDuty;
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
          const candidates = run.players
            .filter((player) => ![...run.zoneChaserAssignments.values()].includes(player.id) && player.id !== handler.id)
            .map((player) => {
              const rating = defensiveThreatRating(player, hoop);
              const distance = pointDistanceFeet(target, player);
              return { player, distance, score: distance - (rating - 3) * 1.2 };
            })
            .sort((a, b) => a.score - b.score || a.player.id - b.player.id);
          const closeout = candidates[0];
          if (closeout && closeout.distance <= 15) {
            const closeoutGap = defenderGoalSideGapFor(defender, closeout.player, hoop, closeout.score < 8 ? 4.5 : 6.5);
            const closeoutPoint = defenderContainmentTarget(run, closeout.player, hoop, closeoutGap, false);
            target = lerpPoint(target, closeoutPoint, clamp(0.58 - closeout.distance * 0.018, 0.28, 0.58));
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
    if (canRotateForHelp && defenderHasBadge(defender, "paint-protector")) {
      const assignmentDistance = pointDistanceFeet(assignment, hoop);
      const assignmentThreat = defensiveThreatRating(assignment, hoop);
      if (assignmentDistance > 12 && assignmentThreat < 5.2) {
        const paintSpot = pointToward(assignment, hoop, Math.min(9, assignmentDistance * 0.46));
        target = lerpPoint(target, paintSpot, 0.18);
      }
    }
    if (canRotateForHelp && defenderHasBadge(defender, "helper")) {
      target = lerpPoint(target, helpSpot, drive ? 0.12 : 0.06);
    }
    if (canRotateForHelp && strategy === "help") {
      if (drive && index === helperIndex) target = lerpPoint(target, helpSpot, clamp((formation ? 0.48 : 0.62) * helpWeight, 0.3, 0.84));
      else if (drive) target = lerpPoint(target, helpSpot, (formation ? 0.12 : 0.08) * helpWeight);
    }
    if (canRotateForHelp && strategy === "trap-rotate") {
      if (drive && index === helperIndex) target = formation
        ? lerpPoint(target, pointToward(handler, hoop, 4.5), 0.68)
        : pointToward(handler, hoop, 4.5);
      else if (drive) target = lerpPoint(target, helpSpot, (formation ? 0.14 : 0.2) * helpWeight);
    }
    if (canRotateForHelp && strategy === "deny-lanes") {
      const ball = run.ball ?? handler;
      const laneTarget = formation ? lerpPoint(target, ball, 0.28) : lerpPoint(assignment, ball, 0.48);
      target = lerpPoint(target, laneTarget, formation ? 0.24 : 0.35);
    }
    if (canRotateForHelp && strategy === "protect-paint") {
      const paintAnchor = formation ? target : assignment;
      const paintSpot = pointToward(paintAnchor, hoop, Math.min(10, pointDistanceFeet(paintAnchor, hoop) * 0.4));
      target = lerpPoint(target, paintSpot, clamp((drive && index === helperIndex ? 0.82 : formation ? 0.28 : 0.55) * helpWeight, 0.25, 0.95));
    }
    if (drive && handler && canRotateForHelp) {
      const handlerDistance = pointDistanceFeet(handler, hoop);
      if (index === helperIndex && defenderHasBadge(defender, "helper")) {
        const pressureSpot = pointToward(handler, hoop, Math.min(5.5, handlerDistance * 0.34));
        target = lerpPoint(target, helpSpot, helpStyle ? 0.28 : 0.56);
        target = lerpPoint(target, pressureSpot, 0.16);
      }
      if (handlerDistance <= 16 && defenderHasBadge(defender, "paint-protector")) {
        const rimSpot = pointToward(handler, hoop, 4.5);
        target = lerpPoint(target, rimSpot, 0.36);
      }
    }
    if (canRotateForHelp && handler && playerHasBadge(handler, "playmaker")) {
      const likelyReceiver = formation
        ? run.players.filter((player) => player.id !== handler.id && ![...run.zoneChaserAssignments.values()].includes(player.id))
          .sort((a, b) => (defensiveThreatRating(b, hoop) - defensiveThreatRating(a, hoop)) || a.id - b.id)[0] ?? assignment
        : assignment;
      if (likelyReceiver.id !== handler.id) {
        const laneTarget = lerpPoint(handler, likelyReceiver, 0.44);
        target = lerpPoint(target, laneTarget, formation ? 0.1 : 0.12);
      }
    }
    if (canRotateForHelp && playerHasBadge(assignment, "post-scorer") && pointDistanceFeet(assignment, hoop) <= 19) {
      const postHelp = pointToward(assignment, hoop, Math.min(9.5, pointDistanceFeet(assignment, hoop) * 0.5));
      target = lerpPoint(target, postHelp, formation ? 0.12 : 0.16);
    }
    const rollAction = activeAction?.arrow.kind === "pick-roll" ? activeAction : null;
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
    if (!formation && activeAction && (activeAction.arrow.kind === "screen" || activeAction.arrow.kind === "pick-roll" || activeAction.arrow.kind === "pick-pop")
      && strategy === "contain" && (isOnBall || activeAction.partnerId === assignment.id)) {
      const start = activeAction.plannedStart ?? activeAction.arrow.start;
      const end = activeAction.arrow.end;
      const progress = clamp((timeMs - activeAction.startTime) / activeAction.durationMs, 0, 1);
      target = lerpPoint(target, lerpPoint(start, end, progress), 0.12);
    }
    const coverageRole = coverageByDefender.get(defender.id);
    if (coverageRole) {
      const { action, screenedId, screenerId } = coverageRole.coverage;
      if (action.arrow.kind === "handoff") {
        if (strategy === "switch") {
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
      const progress = clamp((timeMs - action.startTime) / action.durationMs, 0, 1);
      const screenedPlayer = markerForId(run.players, screenedId) ?? handler;
      const coverageScreener = markerForId(run.players, screenerId);
      if (coverageRole.role === "screener" && coverageScreener && playerHasBadge(coverageScreener, "screen-setter")) {
        target = lerpPoint(target, defenderContainmentTarget(run, coverageScreener, hoop, defenderGoalSideGapFor(defender, coverageScreener, hoop, 3), false), formation ? 0.18 : 0.28);
      }
      if (strategy === "switch" && formation) {
        const otherId = coverageRole.role === "screener" ? screenedId : screenerId;
        const other = markerForId(run.players, otherId);
        if (other) target = lerpPoint(target, defenderContainmentTarget(run, other, hoop, defenderGoalSideGapFor(defender, other, hoop, 4), other.id === handler.id), 0.62);
      } else if (strategy === "fight-over" && coverageRole.role === "screened") {
        const outsideRoute = pointToward(screenPoint, hoop, -3.25);
        const coverageWeight = formation ? 0.72 : 1;
        const routeTarget = progress < 0.48 ? outsideRoute : lerpPoint(outsideRoute, target, clamp((progress - 0.48) / 0.4, 0, 1));
        target = lerpPoint(target, routeTarget, coverageWeight);
      } else if (strategy === "go-under" && coverageRole.role === "screened") {
        const insideRoute = pointToward(screenPoint, hoop, 3.25);
        const coverageWeight = formation ? 0.72 : 1;
        const routeTarget = progress < 0.48 ? insideRoute : lerpPoint(insideRoute, target, clamp((progress - 0.48) / 0.4, 0, 1));
        target = lerpPoint(target, routeTarget, coverageWeight);
      } else if (strategy === "drop" && coverageRole.role === "screener") {
        const dropSpot = pointToward(screenPoint, hoop, 5.25);
        target = lerpPoint(target, dropSpot, (progress < 0.68 ? 0.78 : 0.2) * (formation ? 0.68 : 1));
      } else if ((strategy === "hedge" || strategy === "trap-rotate") && coverageRole.role === "screener") {
        const hedgeSpot = pointToward(screenPoint, screenedPlayer, 2.25);
        const hedgeAmount = strategy === "trap-rotate" ? 0.86 : 0.62;
        const recovery = progress < 0.52 ? 1 : clamp(1 - (progress - 0.52) / 0.38, 0, 1);
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
  const key = velocityKey(kind, marker.id);
  const velocity = run.velocities.get(key) ?? { x: 0, y: 0 };
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed < 0.02) {
    run.velocities.set(key, { x: 0, y: 0 });
    return marker;
  }
  const nextSpeed = Math.max(0, speed - deceleration * dt);
  const distance = ((speed + nextSpeed) / 2) * dt;
  run.velocities.set(key, { x: (velocity.x / speed) * nextSpeed, y: (velocity.y / speed) * nextSpeed });
  return {
    ...marker,
    ...addFeet(marker, { x: (velocity.x / speed) * distance, y: (velocity.y / speed) * distance }),
  };
}

function integrateBall(run: SimulationRun, target: CourtPoint, dt: number) {
  const current = run.ball ?? target;
  const moved = moveToward(current, target, run.ballVelocity, BALL_MAX_SPEED_FT_PER_SECOND, BALL_ACCELERATION_FT_PER_SECOND, dt);
  run.ball = moved.point;
  run.ballVelocity = moved.velocity;
}

function sampleMovementTarget(run: SimulationRun, action: BoundAction, timeMs: number) {
  const start = actionStartFor(run, action);
  const override = run.actionStartOverrides.get(action.arrow.id);
  const effectiveStart = override && timeMs >= override.atMs ? override : null;
  const progress = effectiveStart
    ? clamp((timeMs - effectiveStart.atMs) / (action.startTime + action.durationMs - effectiveStart.atMs), 0, 1)
    : clamp((timeMs - action.startTime) / action.durationMs, 0, 1);
  const easedProgress = easeInOut(progress);
  if (action.arrow.kind === "pick-roll" || action.arrow.kind === "pick-pop") {
    const screen = action.arrow.end;
    const roll = action.arrow.kind === "pick-pop"
      ? action.arrow.exit_target ?? screen
      : pointToward(screen, HOOP_POINT, 8);
    return easedProgress < 0.45
      ? lerpPoint(effectiveStart?.point ?? start, screen, easedProgress / 0.45)
      : lerpPoint(screen, roll, (easedProgress - 0.45) / 0.55);
  }
  return routePoint(action, effectiveStart?.point ?? start, easedProgress);
}

function sampleCutterTarget(action: BoundAction, timeMs: number) {
  const progress = easeInOut(clamp((timeMs - action.startTime) / action.durationMs, 0, 1));
  const start = action.recipientStart ?? action.arrow.start;
  const screen = action.arrow.end;
  const finish = action.arrow.kind === "pin-down"
    ? action.arrow.exit_target ?? screen
    : action.arrow.exit_target ?? offBallCutterTarget(screen);
  return progress < 0.5
    ? lerpPoint(start, screen, progress * 2)
    : lerpPoint(screen, finish, (progress - 0.5) * 2);
}

function actionActorTarget(run: SimulationRun, timeMs: number) {
  const action = currentActionAt(run, timeMs);
  if (!action || action.actorId == null) return null;
  if (action.arrow.kind === "pass" || action.arrow.kind === "handoff") return null;
  return { action, target: sampleMovementTarget(run, action, timeMs) };
}

function updateOffense(run: SimulationRun, timeMs: number, dt: number, hoop: CourtPoint) {
  const transfer = currentTransferAt(run, timeMs);
  const prep = currentPrepAt(run, timeMs);
  const activeActions = run.actions.filter((action) => timeMs >= action.startTime && timeMs < action.startTime + action.durationMs);
  const handler = markerForId(run.players, run.ballHandlerId);
  const ball = run.ball ?? handler ?? HOOP_POINT;
  const drive = driveThreat(run, hoop);
  run.players = run.players.map((player) => {
    let target: CourtPoint | null = null;
    let authoredTarget = false;
    let maxSpeed = OFF_BALL_MAX_SPEED_FT_PER_SECOND;
    const movement = activeActions.find((action) => action.actorId === player.id
      && action.arrow.kind !== "pass" && action.arrow.kind !== "handoff");
    const screen = activeActions.find((action) => (action.arrow.kind === "off-ball-screen" || action.arrow.kind === "pin-down")
      && (action.actorId === player.id || action.recipientId === player.id));
    const partner = activeActions.find((action) => action.partnerId === player.id
      && (action.arrow.kind === "screen" || action.arrow.kind === "pick-roll" || action.arrow.kind === "pick-pop"));
    if (movement) {
      target = sampleMovementTarget(run, movement, timeMs);
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
      authoredTarget = true;
    } else if (screen?.recipientId === player.id) {
      target = sampleCutterTarget(screen, timeMs);
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
      authoredTarget = true;
    } else if (partner?.partnerId === player.id) {
      const start = partner.partnerStart ?? player;
      const finish = pointToward(partner.arrow.end, hoop, partner.arrow.kind === "pick-roll" ? 10 : 8);
      const progress = easeInOut(clamp((timeMs - partner.startTime) / partner.durationMs, 0, 1));
      target = lerpPoint(start, finish, progress);
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
      authoredTarget = true;
    } else if (prep?.recipientId === player.id) {
      const prepWindow = Math.min(PASS_PREP_MS, Math.max(180, prep.durationMs * 0.42));
      const override = run.recipientStartOverrides.get(prep.arrow.id);
      const prepStart = override && timeMs >= override.atMs ? override.atMs : Math.max(0, prep.startTime - prepWindow);
      const start = override && timeMs >= override.atMs ? override.point : prep.recipientStart ?? player;
      const progress = clamp((timeMs - prepStart) / (prep.startTime + prep.durationMs - prepStart), 0, 1);
      target = lerpPoint(start, prep.arrow.end, easeInOut(progress));
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
      authoredTarget = true;
    } else if (transfer?.recipientId === player.id) {
      target = transfer.arrow.end;
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
      authoredTarget = true;
    } else if (run.ballHandlerId !== player.id) {
      target = offBallTarget(run, player, ball, timeMs, drive, hoop);
    }
    if (!target) {
      run.targetFilters.delete(velocityKey("player", player.id));
      return coastMarker(run, "player", player, dt, OFFENSE_ACCELERATION_FT_PER_SECOND);
    }
    if (authoredTarget) run.targetFilters.delete(velocityKey("player", player.id));
    else target = smoothAITarget(run, "player", player, target, dt);
    const moved = integrateMarker(run, "player", player, target, dt, maxSpeed, OFFENSE_ACCELERATION_FT_PER_SECOND);
    const completedMovement = movement && timeMs >= movement.startTime + movement.durationMs;
    const completedScreen = screen && timeMs >= screen.startTime + screen.durationMs;
    if (completedMovement || completedScreen) run.offBallAnchors.set(player.id, { x: moved.x, y: moved.y });
    return moved;
  });
}

function updateBall(run: SimulationRun, timeMs: number, dt: number) {
  const transfer = currentTransferAt(run, timeMs);
  if (transfer) {
    const start = activeTransferStart(run, transfer);
    const startOverride = run.actionStartOverrides.get("ball:" + transfer.arrow.id);
    const startTime = startOverride?.atMs ?? transfer.startTime;
    const progress = clamp((timeMs - startTime) / (transfer.startTime + transfer.durationMs - startTime), 0, 1);
    const pathAction = { ...transfer, plannedStart: start, controlOffset: transfer.controlOffset };
    const receiver = markerForId(run.players, transfer.recipientId);
    const target = routePoint(pathAction, start, easeInOut(progress), receiver ?? transfer.arrow.end);
    integrateBall(run, target, dt);
    return;
  }
  const handler = markerForId(run.players, run.ballHandlerId);
  if (handler) {
    run.ball = { x: handler.x, y: handler.y };
    run.ballVelocity = { x: 0, y: 0 };
    return;
  }
  const looseBall = run.ball;
  if (!looseBall || !run.players.length) return;
  const recovery = run.players
    .map((player) => ({ player, gap: pointDistanceFeet(looseBall, player) }))
    .sort((a, b) => a.gap - b.gap || a.player.id - b.player.id)[0];
  if (recovery.gap <= LOOSE_BALL_CATCH_RADIUS_FEET) {
    run.ballHandlerId = recovery.player.id;
    run.offBallAnchors.set(recovery.player.id, { x: recovery.player.x, y: recovery.player.y });
    run.ballVelocity = { x: 0, y: 0 };
  } else {
    integrateBall(run, recovery.player, dt);
  }
}

function updateDefense(run: SimulationRun, timeMs: number, dt: number, hoop: CourtPoint) {
  const { targets } = defensiveTargets(run, timeMs, hoop);
  const handler = markerForId(run.players, run.ballHandlerId);
  run.defenders = run.defenders.map((defender, index) => {
    const target = targets[index] ?? defender;
    if (run.settings.defenseStrategy === "off") {
      run.targetFilters.delete(velocityKey("defender", defender.id));
      const velocity = run.velocities.get(velocityKey("defender", defender.id)) ?? { x: 0, y: 0 };
      run.velocities.set(velocityKey("defender", defender.id), { x: velocity.x * 0.4, y: velocity.y * 0.4 });
      return defender;
    }
    const isRecovering = pointDistanceFeet(defender, target) > 8;
    const chaserId = run.zoneChaserAssignments.get(defender.id);
    const zoneAnchor = zoneAnchorFor(run, defender.id, hoop);
    const focusPlayer = chaserId != null
      ? markerForId(run.players, chaserId)
      : !isManScheme(run.activeDefenseScheme) && defender.id === run.zoneBallDefenderId
        ? handler
        : !isManScheme(run.activeDefenseScheme) && zoneAnchor
          ? run.players.slice().sort((a, b) => pointDistanceFeet(zoneAnchor, a) - pointDistanceFeet(zoneAnchor, b) || a.id - b.id)[0]
          : markerForId(run.players, run.assignments.get(defender.id) ?? null);
    const assignmentVelocity = focusPlayer
      ? run.velocities.get(velocityKey("player", focusPlayer.id)) ?? { x: 0, y: 0 }
      : { x: 0, y: 0 };
    const isTrackingMovement = Math.hypot(assignmentVelocity.x, assignmentVelocity.y) > 2.5;
    const shootingThreat = focusPlayer ? defensiveThreatRating(focusPlayer, HOOP_POINT) : 3;
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
  const { players, defenders, ballHandlerId, assignments } = run;
  if (!players.length || !defenders.length) return 0;
  const handler = markerForId(players, ballHandlerId) ?? players[0];
  if (!isManScheme(run.activeDefenseScheme)) {
    const chaserForHandler = [...run.zoneChaserAssignments.entries()].find(([, playerId]) => playerId === handler.id)?.[0];
    const ballDefenderId = chaserForHandler ?? run.zoneBallDefenderId;
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
  players: PlaybookMarker[],
  defenders: PlaybookMarker[],
  shooter: PlaybookMarker,
  offBallQuality: number,
  hoop = HOOP_POINT,
  context: { recentCatch?: boolean; recentMovement?: boolean } = {},
) {
  const rangeScore = 1 - Math.min(1, pointDistanceFeet(shooter, hoop) / 37);
  const closestDefenderGap = defenders.length
    ? Math.min(...defenders.map((defender) => pointDistanceFeet(defender, shooter)))
    : 19;
  const badgeContest = defenders.reduce((best, defender) => {
    const gap = pointDistanceFeet(defender, shooter);
    if (gap > 10) return best;
    const front = (defenderIsGoalSide(defender, shooter, hoop) + 1) / 2;
    const proximity = clamp((10 - gap) / 5, 0, 1);
    const lockdown = defenderHasBadge(defender, "lockdown") ? 0.16 * front * proximity : 0;
    const paintProtection = defenderHasBadge(defender, "paint-protector") && shotSkillFor(shooter, hoop) === "finishing"
      ? 0.2 * front * proximity
      : 0;
    const helperPressure = defenderHasBadge(defender, "helper") ? 0.08 * front * proximity : 0;
    return Math.max(best, Math.min(0.22, lockdown + paintProtection + helperPressure));
  }, 0);
  const contestScore = clamp(Math.min(1, closestDefenderGap / 19) - badgeContest, 0, 1);
  const baseQuality = (rangeScore * 0.52 + contestScore * 0.28 + (offBallQuality / 100) * 0.2) * 100;
  const skill = shotSkillFor(shooter, hoop);
  const rating = playerRating(shooter, skill);
  const distance = pointDistanceFeet(shooter, hoop);
  let badgeBonus = 0;
  if (rating >= 2) {
    if (skill === "threePoint" && playerHasBadge(shooter, "deep-range") && distance > NBA_COURT_GEOMETRY.threePoint.radiusFeet + 0.5) {
      badgeBonus += clamp(2 + (distance - NBA_COURT_GEOMETRY.threePoint.radiusFeet) * 1.1, 0, 7);
    }
    if (context.recentCatch && skill !== "finishing" && playerHasBadge(shooter, "catch-and-shoot")) badgeBonus += 6;
    if (context.recentMovement && playerHasBadge(shooter, "off-dribble-creator")) badgeBonus += 5;
    if (skill === "finishing" && playerHasBadge(shooter, "rim-finisher")) badgeBonus += 7;
    if (skill === "finishing" && playerHasBadge(shooter, "slasher")) badgeBonus += 3;
    if (skill === "finishing" && context.recentMovement && playerHasBadge(shooter, "cutter")) badgeBonus += 3;
    if (skill === "finishing" && context.recentMovement && playerHasBadge(shooter, "roll-threat")) badgeBonus += 4;
    if (skill === "midrange" && distance <= 14 && playerHasBadge(shooter, "post-scorer")) badgeBonus += 4;
  }
  const adjustedQuality = baseQuality + (rating - 3) * 8 + Math.min(10, badgeBonus);
  return Math.round(clamp(rating === 1 ? Math.min(adjustedQuality, 40) : adjustedQuality, 0, 100));
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

function updateShot(run: SimulationRun, timeMs: number, dt: number, hoop: CourtPoint) {
  if (!run.shotStart) {
    const shooter = markerForId(run.players, run.ballHandlerId) ?? run.players[nearestPointIndex(run.players, run.ball ?? hoop)] ?? null;
    if (!shooter) return;
    run.shotStart = run.ball ? { ...run.ball } : { x: shooter.x, y: shooter.y };
    run.shotShooterId = shooter.id;
    const offBall = calculateOffBallQuality(run.players, run.shotStart, run.settings, run.defenders, shooter.id);
    run.shotQualityAtRelease = calculateShotQuality(run.players, run.defenders, shooter, offBall, hoop, badgeShotContext(run, shooter, timeMs));
  }
  const path = run.shotPathOverride;
  const pathStartTime = path ? Math.max(run.actionDurationMs, path.atMs) : run.actionDurationMs;
  const pathStart = path?.point ?? run.shotStart;
  const shotProgress = clamp((timeMs - pathStartTime) / Math.max(1, run.actionDurationMs + run.shotDurationMs - pathStartTime), 0, 1);
  run.ball = parabolicPoint(pathStart, hoop, shotProgress);
  const shooter = markerForId(run.players, run.shotShooterId);
  if (shooter) updateDefense(run, timeMs, dt, hoop);
}

function nextTimeBoundary(run: SimulationRun, stepEnd: number) {
  const nextActionBoundary = run.actions.flatMap((action) => [action.startTime, action.startTime + action.durationMs])
    .filter((time) => time > run.elapsedMs + 1e-6)
    .reduce((best, time) => Math.min(best, time), stepEnd);
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

function transferBallToRecipient(run: SimulationRun, previousTime: number, nextTime: number, stepMs: number) {
  const transfer = run.actions.find((action) =>
    (action.arrow.kind === "pass" || action.arrow.kind === "handoff")
    && action.recipientId != null
    && !action.transferFailed
    && previousTime < action.startTime + action.durationMs
    && nextTime >= action.startTime + action.durationMs - 1e-6,
  );
  if (!transfer?.recipientId) return;
  const receiver = markerForId(run.players, transfer.recipientId);
  if (!receiver) {
    transfer.transferFailed = true;
    run.ballHandlerId = null;
    return;
  }
  if (run.ball && pointDistanceFeet(run.ball, receiver) <= TRANSFER_CATCH_RADIUS_FEET) {
    run.ballHandlerId = receiver.id;
    // Finish the catch at the receiver's live position. The bounded catch
    // radius prevents a long snap while keeping the ball attached next tick.
    run.ball = { x: receiver.x, y: receiver.y };
    run.ballVelocity = { x: 0, y: 0 };
    run.lastReceiveAtMs.set(receiver.id, nextTime);
    run.offBallAnchors.set(receiver.id, { x: receiver.x, y: receiver.y });
    return;
  }

  const previousEnd = transfer.startTime + transfer.durationMs;
  const waitMs = (transfer.transferWaitMs ?? 0) + stepMs;
  if (waitMs > MAX_TRANSFER_WAIT_MS) {
    transfer.transferFailed = true;
    run.ballHandlerId = null;
    return;
  }
  transfer.transferWaitMs = waitMs;
  transfer.durationMs += stepMs;
  run.actions.forEach((action) => {
    if (action !== transfer && action.sequence > transfer.sequence && action.startTime >= previousEnd - 1e-6) {
      action.startTime += stepMs;
    }
  });
  run.actionDurationMs += stepMs;
  if (previousEnd <= run.plannedActionDurationMs + 1e-6) run.plannedActionDurationMs += stepMs;
  run.durationMs += stepMs;
}

function finalizeCompletedMovement(run: SimulationRun, previousTime: number, nextTime: number) {
  run.actions.forEach((action) => {
    if (action.arrow.kind === "pass" || action.arrow.kind === "handoff") return;
    const endTime = action.startTime + action.durationMs;
    if (previousTime >= endTime || nextTime < endTime || action.actorId == null) return;
    const actor = markerForId(run.players, action.actorId);
    if (actor) run.offBallAnchors.set(actor.id, { x: actor.x, y: actor.y });
  });
}

function advanceStep(run: SimulationRun, stepMs: number, hoop: CourtPoint) {
  const startTime = run.elapsedMs;
  const endTime = Math.min(run.durationMs, startTime + stepMs);
  const dt = (endTime - startTime) / 1000;
  primeScreenCoverageLocks(run, startTime);
  run.actions.forEach((action) => {
    if (action.startTime >= startTime - 1e-6 && action.startTime < endTime - 1e-6) processActionStart(run, action);
  });
  recordActionStarts(run, startTime);
  const sampleTime = Math.max(startTime, endTime - 0.001);
  if (startTime < run.actionDurationMs) {
    updateOffense(run, sampleTime, dt, hoop);
    // Extend an uncaught transfer before sampling the ball path at the action
    // boundary. Otherwise currentTransferAt sees the old end time and briefly
    // snaps the ball back to its former handler while the pass waits to be caught.
    transferBallToRecipient(run, startTime, endTime, endTime - startTime);
    updateBall(run, sampleTime, dt);
    finalizeCompletedMovement(run, startTime, endTime);
  } else {
    updateShot(run, sampleTime, dt, hoop);
  }
  if (startTime < run.actionDurationMs) updateDefense(run, sampleTime, dt, hoop);
  run.elapsedMs = endTime;
  if (!run.shotStart && run.elapsedMs + 1e-6 >= run.nextEarlyReadMs) {
    startEarlyRead(run, hoop);
    if (!run.earlyReadInterrupted) run.nextEarlyReadMs += EARLY_READ_INTERVAL_MS;
  }
  const authoredActionsEnded = run.elapsedMs + 1e-6 >= run.plannedActionDurationMs
    && run.adaptiveContinuationStartedAtMs == null;
  const liveActionEnded = run.adaptiveContinuationStartedAtMs != null
    && run.elapsedMs + 1e-6 >= run.actionDurationMs;
  if (!run.shotStart && (authoredActionsEnded || liveActionEnded)) {
    resolveAdaptiveRead(run, hoop);
  }
  run.frame = frameFor(run);
}

export function advanceSimulationRun(run: SimulationRun, deltaMs: number, settings: SimulationSettings = run.settings, hoop = HOOP_POINT) {
  if (run.elapsedMs >= run.durationMs || deltaMs <= 0) return getSimulationFrame(run);
  setSimulationRunSettings(run, settings);
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
    run.elapsedMs = run.durationMs;
    run.accumulatorMs = 0;
    run.frame = frameFor(run);
  }
  return getSimulationFrame(run);
}

export function editPausedSimulationMarker(
  run: SimulationRun,
  type: "player" | "defender" | "ball",
  id: number | string,
  point: CourtPoint,
) {
  const nextPoint = clampCourt(point);
  if (type === "player") {
    run.players = run.players.map((player) => player.id === id ? { ...player, ...nextPoint } : player);
    const playerId = Number(id);
    run.offBallAnchors.set(playerId, { ...nextPoint });
    run.targetFilters.delete(velocityKey("player", playerId));
    run.velocities.set(velocityKey("player", playerId), { x: 0, y: 0 });
    const action = currentActionAt(run, run.elapsedMs);
    if (action?.actorId === playerId && action.arrow.kind !== "pass" && action.arrow.kind !== "handoff") {
      run.actionStartOverrides.set(action.arrow.id, { atMs: run.elapsedMs, point: { ...nextPoint } });
    }
    const transfer = currentTransferAt(run, run.elapsedMs);
    if (transfer?.recipientId === playerId) {
      run.recipientStartOverrides.set(transfer.arrow.id, { atMs: run.elapsedMs, point: { ...nextPoint } });
    }
    if (run.ballHandlerId === playerId && !currentTransferAt(run, run.elapsedMs)) {
      run.ball = { ...nextPoint };
      run.ballVelocity = { x: 0, y: 0 };
    }
  } else if (type === "defender") {
    const defenderId = Number(id);
    run.defenders = run.defenders.map((defender) => defender.id === defenderId ? { ...defender, ...nextPoint } : defender);
    run.targetFilters.delete(velocityKey("defender", defenderId));
    run.velocities.set(velocityKey("defender", defenderId), { x: 0, y: 0 });
  } else {
    run.ball = { ...nextPoint };
    run.ballVelocity = { x: 0, y: 0 };
    const handlerIndex = nearestPointIndex(run.players, nextPoint);
    run.ballHandlerId = run.players[handlerIndex]?.id ?? null;
    const transfer = currentTransferAt(run, run.elapsedMs);
    if (transfer) run.actionStartOverrides.set("ball:" + transfer.arrow.id, { atMs: run.elapsedMs, point: { ...nextPoint } });
    if (run.shotStart && run.elapsedMs >= run.actionDurationMs) {
      run.shotPathOverride = { atMs: run.elapsedMs, point: { ...nextPoint } };
    }
  }
  if (type === "player") {
    run.source.players = run.source.players.map((player) => player.id === Number(id) ? { ...player, ...nextPoint } : player);
  } else if (type === "defender") {
    run.source.defenders = run.source.defenders.map((defender) => defender.id === Number(id) ? { ...defender, ...nextPoint } : defender);
  } else {
    run.source.ball = { ...nextPoint };
  }
  run.frame = frameFor(run);
  run.previousFrame = run.frame;
  return getSimulationFrame(run);
}

export function rebasePausedSimulation(run: SimulationRun, draft: PlaybookDraft, hoop = HOOP_POINT) {
  const sourceBeforeEdit = run.source;
  const timelineChanged = JSON.stringify(sourceBeforeEdit.arrows) !== JSON.stringify(draft.arrows);
  const playerIdsChanged = JSON.stringify(sourceBeforeEdit.players.map((player) => player.id)) !== JSON.stringify(draft.players.map((player) => player.id));
  const defenderIdsChanged = JSON.stringify(sourceBeforeEdit.defenders.map((defender) => defender.id)) !== JSON.stringify(draft.defenders.map((defender) => defender.id));
  const ballPresenceChanged = Boolean(sourceBeforeEdit.ball) !== Boolean(draft.ball);
  if (timelineChanged || playerIdsChanged || defenderIdsChanged || ballPresenceChanged) return false;
  const ballChanged = draft.ball != null && (sourceBeforeEdit.ball?.x !== draft.ball.x || sourceBeforeEdit.ball?.y !== draft.ball.y);
  run.players = run.players.map((player) => {
    const edited = draft.players.find((candidate) => candidate.id === player.id);
    if (!edited) return player;
    const previousDraftPosition = sourceBeforeEdit.players.find((candidate) => candidate.id === player.id);
    if (previousDraftPosition && (edited.x !== previousDraftPosition.x || edited.y !== previousDraftPosition.y)) {
      run.offBallAnchors.set(player.id, { x: edited.x, y: edited.y });
      run.targetFilters.delete(velocityKey("player", player.id));
      run.velocities.set(velocityKey("player", player.id), { x: 0, y: 0 });
      const action = currentActionAt(run, run.elapsedMs);
      if (action?.actorId === player.id && action.arrow.kind !== "pass" && action.arrow.kind !== "handoff") {
        run.actionStartOverrides.set(action.arrow.id, { atMs: run.elapsedMs, point: { x: edited.x, y: edited.y } });
      }
      const receiverAction = currentTransferAt(run, run.elapsedMs) ?? currentPrepAt(run, run.elapsedMs);
      if (receiverAction?.recipientId === player.id) {
        run.recipientStartOverrides.set(receiverAction.arrow.id, { atMs: run.elapsedMs, point: { x: edited.x, y: edited.y } });
      }
      if (run.ballHandlerId === player.id && !currentTransferAt(run, run.elapsedMs)) run.ball = { x: edited.x, y: edited.y };
      return { ...edited };
    }
    return player;
  });
  run.defenders = run.defenders.map((defender) => {
    const edited = draft.defenders.find((candidate) => candidate.id === defender.id);
    if (!edited) return defender;
    const previousDraftPosition = sourceBeforeEdit.defenders.find((candidate) => candidate.id === defender.id);
    if (previousDraftPosition && (edited.x !== previousDraftPosition.x || edited.y !== previousDraftPosition.y)) {
      run.targetFilters.delete(velocityKey("defender", defender.id));
      run.velocities.set(velocityKey("defender", defender.id), { x: 0, y: 0 });
      return { ...edited };
    }
    return defender;
  });
  if (ballChanged && draft.ball) {
    run.ball = { ...draft.ball };
    run.ballVelocity = { x: 0, y: 0 };
    run.ballHandlerId = run.players[nearestPointIndex(run.players, draft.ball)]?.id ?? run.ballHandlerId;
    const transfer = currentTransferAt(run, run.elapsedMs);
    if (transfer) run.actionStartOverrides.set("ball:" + transfer.arrow.id, { atMs: run.elapsedMs, point: { ...draft.ball } });
    if (run.shotStart && run.elapsedMs >= run.actionDurationMs) {
      run.shotPathOverride = { atMs: run.elapsedMs, point: { ...draft.ball } };
    }
  }
  run.source = structuredClone(draft);
  run.frame = frameFor(run);
  run.previousFrame = run.frame;
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
