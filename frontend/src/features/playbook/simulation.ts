import type { CourtPoint, PlaybookArrow, PlaybookDraft, PlaybookMarker, SimulationSettings } from "./types.ts";
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
  partnerId?: number | null;
  partnerStart?: CourtPoint | null;
};

type Velocity = { x: number; y: number };
type PositionOverride = { atMs: number; point: CourtPoint };

export type SimulationRun = {
  readonly actions: BoundAction[];
  readonly actionDurationMs: number;
  readonly durationMs: number;
  readonly assignments: Map<number, number>;
  readonly initialAssignments: Map<number, number>;
  readonly ephemeralDefenders: boolean;
  readonly switchedActions: Set<string>;
  readonly actionStarts: Map<string, CourtPoint>;
  readonly actionStartOverrides: Map<string, PositionOverride>;
  readonly transferStarts: Map<string, CourtPoint>;
  readonly offBallAnchors: Map<number, CourtPoint>;
  readonly velocities: Map<string, Velocity>;
  readonly recipientStartOverrides: Map<string, PositionOverride>;
  readonly shotDurationMs: number;
  source: PlaybookDraft;
  settings: SimulationSettings;
  players: PlaybookMarker[];
  defenders: PlaybookMarker[];
  ball: CourtPoint | null;
  ballHandlerId: number | null;
  helpDefenderId: number | null;
  elapsedMs: number;
  accumulatorMs: number;
  ballVelocity: Velocity;
  shotStart: CourtPoint | null;
  shotPathOverride: PositionOverride | null;
  shotShooterId: number | null;
  shotQualityAtRelease: number;
  frame: SimulationFrame;
};

export const SIMULATION_STEP_MS = 1000 / 30;
export const SIMULATION_SHOT_MS = 1500;
export const DEFENDER_MAX_SPEED_FT_PER_SECOND = 15;
const DEFENDER_ACCELERATION_FT_PER_SECOND = 28;
const OFFENSE_MAX_SPEED_FT_PER_SECOND = 19;
const OFFENSE_ACCELERATION_FT_PER_SECOND = 34;
const OFF_BALL_MAX_SPEED_FT_PER_SECOND = 12;
const ON_BALL_ANTICIPATION_SECONDS = 0.22;
const ON_BALL_ANTICIPATION_MAX_FEET = 3.25;
const OFF_BALL_ANTICIPATION_SECONDS = 0.14;
const OFF_BALL_ANTICIPATION_MAX_FEET = 2;
const BALL_MAX_SPEED_FT_PER_SECOND = 42;
const BALL_ACCELERATION_FT_PER_SECOND = 90;
const PASS_PREP_MS = 440;
const MIN_PLAY_DURATION_MS = 1200;
const MAX_COURT_PLAYERS = 5;
const HOOP_POINT = courtSvgToPoint(NBA_COURT_GEOMETRY.basket.center);

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

function routeControl(action: BoundAction, start: CourtPoint) {
  if (!action.controlOffset) return defaultControl(start, action.arrow.end);
  return clampCourt({
    x: start.x + action.controlOffset.x,
    y: start.y + action.controlOffset.y,
  });
}

function routePoint(action: BoundAction, start: CourtPoint, amount: number) {
  if (action.arrow.path !== "curve") return lerpPoint(start, action.arrow.end, amount);
  return quadraticPoint(start, action.arrow.end, routeControl(action, start), amount);
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
  const actions = orderedArrows(source.arrows).map(({ arrow, sequence }) => {
    const isTransfer = arrow.kind === "pass" || arrow.kind === "handoff";
    const isOffBallScreen = arrow.kind === "off-ball-screen";
    const usesNamedScreener = arrow.screener_id != null && (isOffBallScreen || arrow.kind === "screen" || arrow.kind === "pick-roll");
    const actorIndex = usesNamedScreener
      ? positions.findIndex((player) => player.id === arrow.screener_id)
      : isTransfer && ballHandlerId != null
        ? positions.findIndex((player) => player.id === ballHandlerId)
        : nearestPointIndex(positions, arrow.start);
    const actor = positions[actorIndex] ?? null;
    const recipientIndex = isOffBallScreen && arrow.cutter_id != null
      ? positions.findIndex((player) => player.id === arrow.cutter_id)
      : isTransfer ? nearestPointIndex(positions, arrow.end, actor?.id) : -1;
    const recipient = positions[recipientIndex] ?? null;
    const plannedStart = actor ? { x: actor.x, y: actor.y } : { ...arrow.start };
    const controlOffset = arrow.control
      ? { x: arrow.control.x - arrow.start.x, y: arrow.control.y - arrow.start.y }
      : null;
    const pathFeet = routeLength(arrow, plannedStart);
    const receiverFeet = recipient
      ? isOffBallScreen
        ? pointDistanceFeet(recipient, arrow.end) + pointDistanceFeet(arrow.end, offBallCutterTarget(arrow.end))
        : pointDistanceFeet(recipient, arrow.end)
      : 0;
    const authoredDuration = clamp(arrow.timing ?? 1.2, 0.5, 4) * 1000;
    const movesOnCourt = arrow.kind === "movement" || arrow.kind === "screen" || arrow.kind === "pick-roll" || isOffBallScreen;
    const minimumMovementDuration = movesOnCourt
      ? Math.max(pathFeet, isOffBallScreen ? receiverFeet : 0) * 1.5 / OFFENSE_MAX_SPEED_FT_PER_SECOND * 1000
      : 0;
    const minimumTransferDuration = isTransfer
      ? Math.max(
          (pathFeet * 1.5 / BALL_MAX_SPEED_FT_PER_SECOND) * 1000,
          (receiverFeet * 1.5 / OFFENSE_MAX_SPEED_FT_PER_SECOND) * 1000 - PASS_PREP_MS,
        )
      : 0;
    const durationMs = Math.max(authoredDuration, minimumMovementDuration, minimumTransferDuration);
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
      partnerId: (arrow.kind === "screen" || arrow.kind === "pick-roll") && actor?.id !== ballHandlerId ? ballHandlerId : null,
      partnerStart: (arrow.kind === "screen" || arrow.kind === "pick-roll") && actor?.id !== ballHandlerId && markerForId(positions, ballHandlerId)
        ? { ...markerForId(positions, ballHandlerId)! }
        : null,
    };
    cursor += durationMs;
    if (movesOnCourt && actorIndex >= 0) {
      const finish = arrow.kind === "pick-roll" ? pointToward(arrow.end, HOOP_POINT, 8) : arrow.end;
      positions[actorIndex] = { ...positions[actorIndex], ...finish };
    }
    if (isOffBallScreen && recipientIndex >= 0) {
      positions[recipientIndex] = { ...positions[recipientIndex], ...offBallCutterTarget(arrow.end) };
    } else if (isTransfer && recipientIndex >= 0) {
      positions[recipientIndex] = { ...positions[recipientIndex], ...arrow.end };
      ballHandlerId = recipient?.id ?? ballHandlerId;
    }
    return boundAction;
  });
  return { actions, actionDurationMs: Math.max(MIN_PLAY_DURATION_MS, cursor), ballHandlerId, finalPositions: positions };
}


function normalizeSettings(settings: SimulationSettings): SimulationSettings {
  return {
    offenseOffBall: settings.offenseOffBall,
    defenseStrategy: settings.defenseStrategy,
    offBallIntensity: settings.offBallIntensity,
    automaticActions: { ...settings.automaticActions },
  };
}

function defenderGap(player: PlaybookMarker, defenders: PlaybookMarker[]) {
  return defenders.length ? Math.min(...defenders.map((defender) => pointDistanceFeet(player, defender))) : Number.POSITIVE_INFINITY;
}

function automaticOffBallArrow(players: PlaybookMarker[], defenders: PlaybookMarker[], handlerId: number | null, sequence: number): PlaybookArrow | null {
  if (players.length < 3 || handlerId == null) return null;
  const cutters = players.filter((player) => player.id !== handlerId && defenderGap(player, defenders) <= 8)
    .sort((a, b) => defenderGap(a, defenders) - defenderGap(b, defenders) || a.id - b.id);
  for (const cutter of cutters) {
    const cutterDefender = defenders.slice().sort((a, b) => pointDistanceFeet(a, cutter) - pointDistanceFeet(b, cutter) || a.id - b.id)[0];
    if (!cutterDefender) continue;
    const screener = players.filter((player) => player.id !== handlerId && player.id !== cutter.id)
      .filter((player) => pointDistanceFeet(player, cutter) >= 4 && pointDistanceFeet(player, cutter) <= 16 && defenderGap(player, defenders) >= 4)
      .sort((a, b) => pointDistanceFeet(a, cutter) - pointDistanceFeet(b, cutter) || a.id - b.id)[0];
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
    .sort((a, b) => pointDistanceFeet(a, handler) - pointDistanceFeet(b, handler) || a.id - b.id)[0];
  if (settings.automaticActions.handoff && pressure <= 7 && receiver) {
    return { id: `auto-handoff-${sequence}`, kind: "handoff", sequence, timing: 1.15, start: { x: handler.x, y: handler.y }, end: { x: receiver.x, y: receiver.y } };
  }
  const screeners = teammates.filter((player) => pointDistanceFeet(player, handler) >= 4 && pointDistanceFeet(player, handler) <= 16)
    .sort((a, b) => pointDistanceFeet(a, handler) - pointDistanceFeet(b, handler) || a.id - b.id);
  for (const screener of screeners) {
    const screenPoint = pointToward(handler, screener, Math.min(3.5, pointDistanceFeet(handler, screener) * 0.45));
    const rollPoint = pointToward(screenPoint, hoop, 8);
    const rollClearance = defenderGap({ ...screener, ...rollPoint }, defenders);
    if (settings.automaticActions.pickRoll && pressure >= 3 && pressure <= 10 && pointDistanceFeet(handler, hoop) > 12 && rollClearance >= 3.5) {
      return { id: `auto-pick-roll-${sequence}`, kind: "pick-roll", sequence, timing: 1.3, start: { x: screener.x, y: screener.y }, end: screenPoint, screener_id: screener.id };
    }
    if (settings.automaticActions.screen && pressure <= 12) {
      return { id: `auto-screen-${sequence}`, kind: "screen", sequence, timing: 1.2, start: { x: screener.x, y: screener.y }, end: screenPoint, screener_id: screener.id };
    }
  }
  return null;
}

function autoActionLabel(action: BoundAction) {
  const prefix = action.automatic ? "Auto " : "";
  if (action.arrow.kind === "pass") return `${prefix}pass`;
  if (action.arrow.kind === "screen") return `${prefix}screen`;
  if (action.arrow.kind === "off-ball-screen") return `${prefix}off-ball screen`;
  if (action.arrow.kind === "handoff") return `${prefix}handoff`;
  if (action.arrow.kind === "pick-roll") return `${prefix}pick and roll`;
  return `${prefix}movement`;
}

function actionOverlapsPlayers(action: BoundAction, start: number, end: number, playerIds: Set<number>) {
  return action.startTime < end && action.startTime + action.durationMs > start
    && (playerIds.has(action.actorId ?? -1) || playerIds.has(action.recipientId ?? -1));
}

function bestDefensiveMatchups(players: PlaybookMarker[], defenders: PlaybookMarker[]) {
  if (!players.length || !defenders.length) return defenders.map(() => -1);
  const defenderCount = Math.min(players.length, defenders.length);
  if (defenderCount > 7) return defenders.map((_, index) => players[index % players.length].id);
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
    for (let playerIndex = 0; playerIndex < players.length; playerIndex += 1) {
      if (used.has(playerIndex)) continue;
      const nextCost = cost + pointDistanceFeet(defenders[defenderIndex], players[playerIndex]);
      if (nextCost >= bestCost) continue;
      used.add(playerIndex);
      assignments.push(playerIndex);
      visit(defenderIndex + 1, used, assignments, nextCost);
      assignments.pop();
      used.delete(playerIndex);
    }
  };
  visit(0, new Set<number>(), [], 0);
  return defenders.map((_, index) => {
    const assigned = best[index % Math.max(1, defenderCount)];
    return players[assigned]?.id ?? players[index % players.length].id;
  });
}

function createGoalSideDefenders(players: PlaybookMarker[], existing: PlaybookMarker[], hoop: CourtPoint) {
  if (existing.length) return existing.map((defender) => ({ ...defender }));
  return players.slice(0, MAX_COURT_PLAYERS).map((player, index) => ({
    id: index + 1,
    ...pointToward(player, hoop, 3.5),
  }));
}

export function placeDefendersGoalSide(players: PlaybookMarker[], defenders: PlaybookMarker[], hoop = HOOP_POINT) {
  const placed = createGoalSideDefenders(players, defenders, hoop);
  const matchups = bestDefensiveMatchups(players, placed);
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
  };
}

function frameFor(run: SimulationRun): SimulationFrame {
  const activeActions = run.actions.filter((action) => run.elapsedMs >= action.startTime && run.elapsedMs < action.startTime + action.durationMs);
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
    defensiveQuality: calculateDefensiveQuality(run.players, run.defenders, run.ballHandlerId, run.assignments, HOOP_POINT),
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
  const assignments = new Map<number, number>();
  bestDefensiveMatchups(players, defenders).forEach((playerId, index) => assignments.set(defenders[index].id, playerId));
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
    switchedActions: new Set(),
    actionStarts: new Map(),
    actionStartOverrides: new Map(),
    transferStarts: new Map(),
    offBallAnchors: new Map(players.map((player) => [player.id, { x: player.x, y: player.y }])),
    velocities: new Map(),
    recipientStartOverrides: new Map(),
    source: sourceCopy,
    settings: runSettings,
    players,
    defenders,
    ball,
    ballHandlerId,
    helpDefenderId: null,
    elapsedMs: 0,
    accumulatorMs: 0,
    ballVelocity: { x: 0, y: 0 },
    shotStart: null,
    shotPathOverride: null,
    shotShooterId: null,
    shotQualityAtRelease: 0,
    shotDurationMs: SIMULATION_SHOT_MS,
    frame: createInitialFrame(),
  };
  run.frame = frameFor(run);
  return run;
}

export function getSimulationFrame(run: SimulationRun) {
  return copyFrame(run.frame);
}

export function setSimulationRunSettings(run: SimulationRun, settings: SimulationSettings) {
  const previousStrategy = run.settings.defenseStrategy;
  const nextSettings = normalizeSettings(settings);
  if (previousStrategy === "switch" && nextSettings.defenseStrategy !== "switch") {
    run.assignments.clear();
    run.initialAssignments.forEach((playerId, defenderId) => run.assignments.set(defenderId, playerId));
  }
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

function nearestDefenderToPlayer(run: SimulationRun, playerId: number) {
  const player = markerForId(run.players, playerId);
  if (!player) return -1;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  run.defenders.forEach((defender, index) => {
    if (run.assignments.get(defender.id) !== playerId) return;
    const distance = pointDistanceFeet(defender, player);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
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
  if (run.settings.defenseStrategy !== "switch") return;
  if (action.arrow.kind === "screen" || action.arrow.kind === "pick-roll") {
    swapAssignments(run, action.actorId, action.partnerId ?? run.ballHandlerId);
  } else if (action.arrow.kind === "handoff") {
    swapAssignments(run, action.actorId, action.recipientId);
  } else if (action.arrow.kind === "off-ball-screen") {
    swapAssignments(run, action.actorId, action.recipientId);
  }
}

function currentActionAt(run: SimulationRun, timeMs: number) {
  return run.actions.find((action) => timeMs >= action.startTime && timeMs < action.startTime + action.durationMs) ?? null;
}

function currentTransferAt(run: SimulationRun, timeMs: number) {
  return run.actions.find((action) =>
    (action.arrow.kind === "pass" || action.arrow.kind === "handoff")
    && timeMs >= action.startTime
    && timeMs < action.startTime + action.durationMs,
  ) ?? null;
}

function currentPrepAt(run: SimulationRun, timeMs: number) {
  return run.actions.find((action) => {
    if (action.recipientId == null || (action.arrow.kind !== "pass" && action.arrow.kind !== "handoff")) return false;
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

function screenCoveragesAt(run: SimulationRun, timeMs: number) {
  const activeScreens = run.actions
    .filter((action) => {
      const kind = action.arrow.kind;
      return (kind === "screen" || kind === "pick-roll" || kind === "off-ball-screen")
        && timeMs >= action.startTime
        && timeMs < action.startTime + action.durationMs;
    })
    .sort((a, b) => Number(Boolean(a.automatic)) - Number(Boolean(b.automatic)) || a.sequence - b.sequence || a.startTime - b.startTime);
  const usedPlayers = new Set<number>();
  const usedDefenders = new Set<number>();
  const coverages: ScreenCoverage[] = [];
  for (const action of activeScreens) {
    const screenerId = action.actorId;
    const screenedId = action.arrow.kind === "off-ball-screen" ? action.recipientId : action.partnerId ?? run.ballHandlerId;
    if (screenerId == null || screenedId == null || screenerId === screenedId || usedPlayers.has(screenerId) || usedPlayers.has(screenedId)) continue;
    const screenerIndex = run.defenders.findIndex((defender) => run.assignments.get(defender.id) === screenerId);
    const screenedIndex = run.defenders.findIndex((defender) => run.assignments.get(defender.id) === screenedId);
    if (screenerIndex < 0 || screenedIndex < 0 || screenerIndex === screenedIndex) continue;
    const screenerDefenderId = run.defenders[screenerIndex].id;
    const screenedDefenderId = run.defenders[screenedIndex].id;
    if (usedDefenders.has(screenerDefenderId) || usedDefenders.has(screenedDefenderId)) continue;
    usedPlayers.add(screenerId);
    usedPlayers.add(screenedId);
    usedDefenders.add(screenerDefenderId);
    usedDefenders.add(screenedDefenderId);
    coverages.push({ action, screenerIndex, screenedIndex, screenerId, screenedId });
  }
  return coverages;
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
    target = lerpPoint(target, cutPoint, cutAmount * 0.55);
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
  return towardHoopSpeed > 2.5 && distance < 30;
}

function helpSpotFor(handler: PlaybookMarker, hoop: CourtPoint) {
  return pointToward(handler, hoop, Math.min(9, pointDistanceFeet(handler, hoop) * 0.34));
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
  const screenCoverages = run.settings.defenseStrategy === "switch" ? [] : screenCoveragesAt(run, timeMs);
  const coverageByDefender = new Map<number, { coverage: ScreenCoverage; role: "screener" | "screened" }>();
  screenCoverages.forEach((coverage) => {
    coverageByDefender.set(run.defenders[coverage.screenerIndex].id, { coverage, role: "screener" });
    coverageByDefender.set(run.defenders[coverage.screenedIndex].id, { coverage, role: "screened" });
  });
  const transfer = currentTransferAt(run, timeMs);
  const drive = handler ? driveThreat(run, hoop) : false;
  const helpSpot = handler ? helpSpotFor(handler, hoop) : hoop;
  const handlerDefenderIndex = handler ? nearestDefenderToPlayer(run, handler.id) : -1;
  let helperIndex = -1;
  const strategy = run.settings.defenseStrategy;
  const helpStyle = strategy === "help" || strategy === "trap-rotate" || strategy === "protect-paint";
  if (!drive || !helpStyle) run.helpDefenderId = null;
  if (drive && helpStyle) {
    const currentHelperIndex = run.defenders.findIndex((defender) => defender.id === run.helpDefenderId);
    const currentHelperAssignment = currentHelperIndex < 0
      ? null
      : run.assignments.get(run.defenders[currentHelperIndex].id);
    if (currentHelperIndex < 0 || currentHelperAssignment === handler?.id) {
      let helperDistance = Number.POSITIVE_INFINITY;
      run.defenders.forEach((defender, index) => {
        if (index === handlerDefenderIndex) return;
        const assignedPlayerId = run.assignments.get(defender.id);
        if (transfer?.recipientId === assignedPlayerId) return;
        const distance = pointDistanceFeet(defender, helpSpot);
        if (distance < helperDistance) {
          helperIndex = index;
          helperDistance = distance;
        }
      });
      if (helperDistance <= 18) run.helpDefenderId = run.defenders[helperIndex]?.id ?? null;
    } else {
      helperIndex = currentHelperIndex;
    }
    if (run.helpDefenderId == null) helperIndex = -1;
  }
  const targets = run.defenders.map((defender, index) => {
    const assignmentId = run.assignments.get(defender.id);
    const assignment = markerForId(run.players, assignmentId ?? null) ?? handler;
    if (!handler || !assignment || strategy === "off") return { ...defender };
    const isOnBall = assignment.id === handler.id;
    const goalSideGap = strategy === "trap-rotate" && drive ? 2.75 : 3.75;
    const playerToGuard = isOnBall ? handler : assignment;
    let target = defenderContainmentTarget(run, playerToGuard, hoop, goalSideGap, isOnBall);
    if (!isOnBall && strategy === "help") {
      if (drive && index === helperIndex) target = lerpPoint(target, helpSpot, 0.62);
      else if (drive) target = lerpPoint(target, helpSpot, 0.08);
    }
    if (!isOnBall && strategy === "trap-rotate") {
      if (drive && index === helperIndex) target = pointToward(handler, hoop, 4.5);
      else if (drive) target = lerpPoint(target, helpSpot, 0.2);
    }
    if (!isOnBall && strategy === "deny-lanes") {
      const ball = run.ball ?? handler;
      target = lerpPoint(target, lerpPoint(assignment, ball, 0.48), 0.35);
    }
    if (!isOnBall && strategy === "protect-paint") {
      const paintSpot = pointToward(assignment, hoop, Math.min(10, pointDistanceFeet(assignment, hoop) * 0.4));
      target = lerpPoint(target, paintSpot, drive && index === helperIndex ? 0.82 : 0.55);
    }
    if (transfer?.recipientId === assignment.id) {
      const progress = clamp((timeMs - transfer.startTime) / transfer.durationMs, 0, 1);
      target = lerpPoint(target, assignment, 0.3 + progress * 0.4);
    }
    if (activeAction && (activeAction.arrow.kind === "screen" || activeAction.arrow.kind === "pick-roll")
      && strategy === "contain" && (isOnBall || activeAction.partnerId === assignment.id)) {
      const start = activeAction.plannedStart ?? activeAction.arrow.start;
      const end = activeAction.arrow.end;
      const progress = clamp((timeMs - activeAction.startTime) / activeAction.durationMs, 0, 1);
      target = lerpPoint(target, lerpPoint(start, end, progress), 0.12);
    }
    const coverageRole = coverageByDefender.get(defender.id);
    if (coverageRole) {
      const { action, screenedId } = coverageRole.coverage;
      const screenPoint = action.arrow.end;
      const progress = clamp((timeMs - action.startTime) / action.durationMs, 0, 1);
      const screenedPlayer = markerForId(run.players, screenedId) ?? handler;
      if (strategy === "fight-over" && coverageRole.role === "screened") {
        const outsideRoute = pointToward(screenPoint, hoop, -3.25);
        target = progress < 0.48 ? outsideRoute : lerpPoint(outsideRoute, target, clamp((progress - 0.48) / 0.4, 0, 1));
      } else if (strategy === "go-under" && coverageRole.role === "screened") {
        const insideRoute = pointToward(screenPoint, hoop, 3.25);
        target = progress < 0.48 ? insideRoute : lerpPoint(insideRoute, target, clamp((progress - 0.48) / 0.4, 0, 1));
      } else if (strategy === "drop" && coverageRole.role === "screener") {
        const dropSpot = pointToward(screenPoint, hoop, 5.25);
        target = lerpPoint(target, dropSpot, progress < 0.68 ? 0.78 : 0.2);
      } else if ((strategy === "hedge" || strategy === "trap-rotate") && coverageRole.role === "screener") {
        const hedgeSpot = pointToward(screenPoint, screenedPlayer, 2.25);
        const hedgeAmount = strategy === "trap-rotate" ? 0.86 : 0.62;
        const recovery = progress < 0.52 ? 1 : clamp(1 - (progress - 0.52) / 0.38, 0, 1);
        target = lerpPoint(target, hedgeSpot, hedgeAmount * recovery);
      }
    }
    return clampCourt(target);
  });
  return { targets, drive, helperIndex, handlerDefenderIndex, helpSpot };
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
  if (action.arrow.kind === "pick-roll") {
    const screen = action.arrow.end;
    const roll = pointToward(screen, HOOP_POINT, 8);
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
  const finish = offBallCutterTarget(screen);
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
    let maxSpeed = OFF_BALL_MAX_SPEED_FT_PER_SECOND;
    const movement = activeActions.find((action) => action.actorId === player.id
      && action.arrow.kind !== "pass" && action.arrow.kind !== "handoff");
    const screen = activeActions.find((action) => action.arrow.kind === "off-ball-screen"
      && (action.actorId === player.id || action.recipientId === player.id));
    const partner = activeActions.find((action) => action.automatic && action.partnerId === player.id
      && (action.arrow.kind === "screen" || action.arrow.kind === "pick-roll"));
    if (movement) {
      target = sampleMovementTarget(run, movement, timeMs);
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
    } else if (screen?.recipientId === player.id) {
      target = sampleCutterTarget(screen, timeMs);
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
    } else if (partner?.partnerId === player.id) {
      const start = partner.partnerStart ?? player;
      const finish = pointToward(partner.arrow.end, hoop, partner.arrow.kind === "pick-roll" ? 10 : 8);
      const progress = easeInOut(clamp((timeMs - partner.startTime) / partner.durationMs, 0, 1));
      target = lerpPoint(start, finish, progress);
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
    } else if (prep?.recipientId === player.id) {
      const prepWindow = Math.min(PASS_PREP_MS, Math.max(180, prep.durationMs * 0.42));
      const override = run.recipientStartOverrides.get(prep.arrow.id);
      const prepStart = override && timeMs >= override.atMs ? override.atMs : Math.max(0, prep.startTime - prepWindow);
      const start = override && timeMs >= override.atMs ? override.point : prep.recipientStart ?? player;
      const progress = clamp((timeMs - prepStart) / (prep.startTime + prep.durationMs - prepStart), 0, 1);
      target = lerpPoint(start, prep.arrow.end, easeInOut(progress));
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
    } else if (transfer?.recipientId === player.id) {
      target = transfer.arrow.end;
      maxSpeed = OFFENSE_MAX_SPEED_FT_PER_SECOND;
    } else if (run.ballHandlerId !== player.id) {
      target = offBallTarget(run, player, ball, timeMs, drive, hoop);
    }
    if (!target) return coastMarker(run, "player", player, dt, OFFENSE_ACCELERATION_FT_PER_SECOND);
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
    const target = routePoint(pathAction, start, easeInOut(progress));
    integrateBall(run, target, dt);
    return;
  }
  const handler = markerForId(run.players, run.ballHandlerId);
  if (handler) {
    run.ball = { x: handler.x, y: handler.y };
    run.ballVelocity = { x: 0, y: 0 };
  }
}

function updateDefense(run: SimulationRun, timeMs: number, dt: number, hoop: CourtPoint) {
  const { targets } = defensiveTargets(run, timeMs, hoop);
  run.defenders = run.defenders.map((defender, index) => {
    const target = targets[index] ?? defender;
    if (run.settings.defenseStrategy === "off") {
      const velocity = run.velocities.get(velocityKey("defender", defender.id)) ?? { x: 0, y: 0 };
      run.velocities.set(velocityKey("defender", defender.id), { x: velocity.x * 0.4, y: velocity.y * 0.4 });
      return defender;
    }
    const isRecovering = pointDistanceFeet(defender, target) > 8;
    const assignment = markerForId(run.players, run.assignments.get(defender.id) ?? null);
    const assignmentVelocity = assignment
      ? run.velocities.get(velocityKey("player", assignment.id)) ?? { x: 0, y: 0 }
      : { x: 0, y: 0 };
    const isTrackingMovement = Math.hypot(assignmentVelocity.x, assignmentVelocity.y) > 2.5;
    return integrateMarker(
      run,
      "defender",
      defender,
      target,
      dt,
      isRecovering ? DEFENDER_MAX_SPEED_FT_PER_SECOND : isTrackingMovement ? 12 : 9,
      DEFENDER_ACCELERATION_FT_PER_SECOND,
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

function calculateDefensiveQuality(
  players: PlaybookMarker[],
  defenders: PlaybookMarker[],
  handlerId: number | null,
  assignments: Map<number, number>,
  hoop: CourtPoint,
) {
  if (!players.length || !defenders.length) return 0;
  const handler = markerForId(players, handlerId) ?? players[0];
  const onBall = defenders.find((defender) => assignments.get(defender.id) === handler.id);
  const onBallGap = onBall ? pointDistanceFeet(onBall, handler) : 40;
  const onBallDistanceScore = 1 - Math.min(1, Math.max(0, onBallGap - 2) / 18);
  const onBallFrontScore = onBall ? (defenderIsGoalSide(onBall, handler, hoop) + 1) / 2 : 0;
  const onBallScore = onBallDistanceScore * 0.62 + onBallFrontScore * 0.38;
  const assignmentScore = defenders.reduce((total, defender) => {
    const player = markerForId(players, assignments.get(defender.id) ?? null) ?? handler;
    const goalSide = pointToward(player, hoop, 3.75);
    const positionScore = 1 - Math.min(1, pointDistanceFeet(defender, goalSide) / 22);
    const frontScore = (defenderIsGoalSide(defender, player, hoop) + 1) / 2;
    return total + positionScore * 0.72 + frontScore * 0.28;
  }, 0) / defenders.length;
  const helpSpot = helpSpotFor(handler, hoop);
  const helpScore = defenders.length < 2
    ? 0.5
    : 1 - Math.min(1, Math.min(...defenders.filter((defender) => defender.id !== onBall?.id).map((defender) => pointDistanceFeet(defender, helpSpot))) / 24);
  const styleWeight = 1;
  return Math.round(clamp((onBallScore * 0.42 + assignmentScore * 0.38 + helpScore * 0.2) * 100 * styleWeight, 0, 100));
}

function calculateShotQuality(players: PlaybookMarker[], defenders: PlaybookMarker[], shooter: PlaybookMarker, offBallQuality: number) {
  const rangeScore = 1 - Math.min(1, pointDistanceFeet(shooter, HOOP_POINT) / 37);
  const closestDefenderGap = defenders.length
    ? Math.min(...defenders.map((defender) => pointDistanceFeet(defender, shooter)))
    : 19;
  const contestScore = Math.min(1, closestDefenderGap / 19);
  return Math.round(clamp((rangeScore * 0.52 + contestScore * 0.28 + (offBallQuality / 100) * 0.2) * 100, 0, 100));
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
    run.shotQualityAtRelease = calculateShotQuality(run.players, run.defenders, shooter, offBall);
  }
  const path = run.shotPathOverride;
  const pathStartTime = path ? Math.max(run.actionDurationMs, path.atMs) : run.actionDurationMs;
  const pathStart = path?.point ?? run.shotStart;
  const shotProgress = clamp((timeMs - pathStartTime) / Math.max(1, run.actionDurationMs + run.shotDurationMs - pathStartTime), 0, 1);
  run.ball = parabolicPoint(pathStart, hoop, shotProgress);
  const shooter = markerForId(run.players, run.shotShooterId);
  if (shooter) {
    const { targets } = defensiveTargets(run, timeMs, hoop);
    run.defenders = run.defenders.map((defender, index) => integrateMarker(
      run,
      "defender",
      defender,
      targets[index] ?? defender,
      dt,
      DEFENDER_MAX_SPEED_FT_PER_SECOND,
      DEFENDER_ACCELERATION_FT_PER_SECOND,
    ));
  }
}

function nextTimeBoundary(run: SimulationRun, stepEnd: number) {
  const nextActionBoundary = run.actions.flatMap((action) => [action.startTime, action.startTime + action.durationMs])
    .filter((time) => time > run.elapsedMs + 1e-6)
    .reduce((best, time) => Math.min(best, time), stepEnd);
  return Math.min(
    stepEnd,
    run.durationMs,
    nextActionBoundary,
    run.actionDurationMs > run.elapsedMs ? run.actionDurationMs : Number.POSITIVE_INFINITY,
  );
}

function transferBallToRecipient(run: SimulationRun, previousTime: number, nextTime: number) {
  const transfer = run.actions.find((action) =>
    (action.arrow.kind === "pass" || action.arrow.kind === "handoff")
    && action.recipientId != null
    && previousTime < action.startTime + action.durationMs
    && nextTime >= action.startTime + action.durationMs,
  );
  if (transfer?.recipientId != null) {
    run.ballHandlerId = transfer.recipientId;
    const receiver = markerForId(run.players, transfer.recipientId);
    if (receiver) run.offBallAnchors.set(receiver.id, { x: receiver.x, y: receiver.y });
  }
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
  run.actions.forEach((action) => {
    if (action.startTime >= startTime - 1e-6 && action.startTime < endTime - 1e-6) processActionStart(run, action);
  });
  recordActionStarts(run, startTime);
  const sampleTime = Math.max(startTime, endTime - 0.001);
  if (startTime < run.actionDurationMs) {
    updateOffense(run, sampleTime, dt, hoop);
    updateBall(run, sampleTime, dt);
    transferBallToRecipient(run, startTime, endTime);
    finalizeCompletedMovement(run, startTime, endTime);
  } else {
    updateShot(run, sampleTime, dt, hoop);
  }
  if (startTime < run.actionDurationMs) updateDefense(run, sampleTime, dt, hoop);
  run.elapsedMs = endTime;
  if (run.elapsedMs >= run.actionDurationMs && !run.shotStart) {
    const shooter = markerForId(run.players, run.ballHandlerId) ?? run.players[nearestPointIndex(run.players, run.ball ?? hoop)] ?? null;
    if (shooter) {
      run.shotStart = run.ball ? { ...run.ball } : { x: shooter.x, y: shooter.y };
      run.shotShooterId = shooter.id;
      const offBall = calculateOffBallQuality(run.players, run.shotStart, run.settings, run.defenders, shooter.id);
      run.shotQualityAtRelease = calculateShotQuality(run.players, run.defenders, shooter, offBall);
    }
  }
  run.frame = frameFor(run);
}

export function advanceSimulationRun(run: SimulationRun, deltaMs: number, settings: SimulationSettings = run.settings, hoop = HOOP_POINT) {
  if (run.elapsedMs >= run.durationMs || deltaMs <= 0) return getSimulationFrame(run);
  setSimulationRunSettings(run, settings);
  run.accumulatorMs += deltaMs;
  while (run.accumulatorMs >= SIMULATION_STEP_MS && run.elapsedMs < run.durationMs) {
    const stepEnd = Math.min(run.elapsedMs + SIMULATION_STEP_MS, run.durationMs);
    const boundary = nextTimeBoundary(run, stepEnd);
    const stepMs = Math.max(0.01, boundary - run.elapsedMs);
    advanceStep(run, stepMs, hoop);
    run.accumulatorMs -= stepMs;
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
