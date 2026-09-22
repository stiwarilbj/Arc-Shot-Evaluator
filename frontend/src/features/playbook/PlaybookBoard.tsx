import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BrainCircuit,
  Check,
  Circle,
  Copy,
  Download,
  Eraser,
  FolderOpen,
  Hand,
  MousePointer2,
  Pencil,
  Pause,
  Plus,
  Play,
  Redo2,
  Save,
  Send,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import { createPlaybook, deletePlaybook, fetchPlaybooks, updatePlaybook } from "./api";
import { EMPTY_COURT, READY_SETUP, STARTER_PLAYS, withDefenders } from "./data";
import type { ArrowKind, CourtPoint, PlaybookArrow, PlaybookDocument, PlaybookDraft, PlaybookMarker, PlaybookTool, SimulationSettings } from "./types";
import { clonePlaybook, DEFAULT_SIMULATION_SETTINGS, pointDistance } from "./types";

type Selection = { type: "player" | "defender" | "ball" | "arrow"; id: number | string } | null;
type DragState = { type: "player" | "defender" | "ball" | "arrow-start" | "arrow-end" | "arrow-control"; id: number | string; before: PlaybookDraft };
type SimulationFrame = {
  players: PlaybookMarker[];
  defenders: PlaybookMarker[];
  ball: CourtPoint | null;
  activeSequence: number | null;
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

type SimulationAction = {
  arrow: PlaybookArrow;
  sequence: number;
  actorId: number | null;
  recipientId: number | null;
  recipientStart: CourtPoint | null;
  startTime: number;
  durationMs: number;
};

const TOOL_LABELS: Record<PlaybookTool, string> = {
  select: "Select / move",
  player: "Add offensive player",
  ball: "Add ball",
  movement: "Draw movement arrow",
  pass: "Draw pass arrow",
  screen: "Add screen action",
  handoff: "Add dribble handoff action",
  "pick-roll": "Add pick and roll action",
  delete: "Delete selected object",
};

function clamp(value: number, min = 2, max = 98) {
  return Math.max(min, Math.min(max, value));
}

function pointFromPointer(event: ReactPointerEvent<SVGSVGElement>, svg: SVGSVGElement | null): CourtPoint | null {
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * 100),
    y: clamp(((event.clientY - rect.top) / rect.height) * 100),
  };
}

function markerPoint(marker: CourtPoint) {
  return { x: marker.x * 10, y: marker.y * 7.2 };
}

function arrowId() {
  return `arrow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function draftPayload(draft: PlaybookDraft): PlaybookDraft {
  return normalizeDraft(draft);
}

function markerCount(draft: PlaybookDraft, type: "player" | "defender") {
  return type === "player" ? draft.players.length : draft.defenders.length;
}

function replacePoint(draft: PlaybookDraft, selection: Selection, point: CourtPoint): PlaybookDraft {
  if (!selection) return draft;
  const next = clonePlaybook(draft);
  if (selection.type === "ball") next.ball = point;
  if (selection.type === "player") next.players = next.players.map((marker) => marker.id === selection.id ? { ...marker, ...point } : marker);
  if (selection.type === "defender") next.defenders = next.defenders.map((marker) => marker.id === selection.id ? { ...marker, ...point } : marker);
  if (selection.type === "arrow") next.arrows = next.arrows.map((arrow) => arrow.id === selection.id ? { ...arrow, end: point } : arrow);
  return next;
}

function clampTiming(value: number) {
  return Math.max(0.5, Math.min(4, Number.isFinite(value) ? value : 1.2));
}

function removeSelection(draft: PlaybookDraft, selection: Selection): PlaybookDraft {
  if (!selection) return draft;
  const next = clonePlaybook(draft);
  if (selection.type === "player") next.players = next.players.filter((marker) => marker.id !== selection.id);
  if (selection.type === "defender") next.defenders = next.defenders.filter((marker) => marker.id !== selection.id);
  if (selection.type === "ball") next.ball = null;
  if (selection.type === "arrow") next.arrows = next.arrows.filter((arrow) => arrow.id !== selection.id);
  return next;
}

function isSameDraft(a: PlaybookDraft, b: PlaybookDraft) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const SIMULATION_STEP_MS = 1200;
const PASS_PREP_MS = 440;
const SHOT_PHASE_MS = 1500;
const HOOP_POINT: CourtPoint = { x: 50, y: 18.75 };

function arrowSequence(arrow: PlaybookArrow, index: number) {
  return Number.isInteger(arrow.sequence) && (arrow.sequence ?? 0) > 0 ? arrow.sequence as number : index + 1;
}

function orderedArrows(arrows: PlaybookArrow[]) {
  return arrows
    .map((arrow, index) => ({ arrow, index, sequence: arrowSequence(arrow, index) }))
    .sort((left, right) => left.sequence - right.sequence || left.index - right.index);
}

function normalizeDraft(source: PlaybookDraft) {
  const next = clonePlaybook(source);
  const used = new Set<number>();
  next.arrows = next.arrows.map((arrow, index) => {
    let sequence = arrowSequence(arrow, index);
    while (used.has(sequence)) sequence += 1;
    used.add(sequence);
    const path = arrow.path === "curve" ? "curve" : "straight";
    const control = arrow.control ?? defaultArrowControl(arrow.start, arrow.end);
    return { ...arrow, sequence, path, timing: clampTiming(arrow.timing ?? 1.2), control };
  });
  return next;
}

function lerpPoint(start: CourtPoint, end: CourtPoint, amount: number): CourtPoint {
  const progress = Math.max(0, Math.min(1, amount));
  return {
    x: clamp(start.x + (end.x - start.x) * progress),
    y: clamp(start.y + (end.y - start.y) * progress),
  };
}

function easeInOut(amount: number) {
  const progress = Math.max(0, Math.min(1, amount));
  return progress * progress * (3 - 2 * progress);
}

function parabolicPoint(start: CourtPoint, end: CourtPoint, amount: number) {
  const progress = Math.max(0, Math.min(1, amount));
  const point = lerpPoint(start, end, progress);
  return { x: point.x, y: clamp(point.y - Math.sin(Math.PI * progress) * 14) };
}

function shotArcPath(start: CourtPoint, end: CourtPoint) {
  const from = markerPoint(start);
  const to = markerPoint(end);
  const control = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 105 };
  return `M${from.x} ${from.y} Q${control.x} ${control.y} ${to.x} ${to.y}`;
}

function defaultArrowControl(start: CourtPoint, end: CourtPoint): CourtPoint {
  const midpoint = lerpPoint(start, end, 0.5);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const offset = Math.max(6, Math.min(14, Math.hypot(dx, dy) * 0.22));
  return { x: clamp(midpoint.x + dy * offset / Math.max(1, Math.hypot(dx, dy))), y: clamp(midpoint.y - dx * offset / Math.max(1, Math.hypot(dx, dy))) };
}

function arrowControl(arrow: PlaybookArrow) {
  return arrow.control ?? defaultArrowControl(arrow.start, arrow.end);
}

function quadraticPoint(start: CourtPoint, end: CourtPoint, control: CourtPoint, amount: number): CourtPoint {
  const progress = Math.max(0, Math.min(1, amount));
  const inverse = 1 - progress;
  return {
    x: clamp(inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x),
    y: clamp(inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y),
  };
}

function actionPointAt(arrow: PlaybookArrow, amount: number) {
  return arrow.path === "curve" ? quadraticPoint(arrow.start, arrow.end, arrowControl(arrow), amount) : lerpPoint(arrow.start, arrow.end, amount);
}

function actionPath(arrow: PlaybookArrow) {
  const start = markerPoint(arrow.start);
  const end = markerPoint(arrow.end);
  if (arrow.path === "curve") {
    const control = markerPoint(arrowControl(arrow));
    return `M${start.x} ${start.y} Q${control.x} ${control.y} ${end.x} ${end.y}`;
  }
  return `M${start.x} ${start.y} L${end.x} ${end.y}`;
}

function actionLabel(kind: ArrowKind) {
  if (kind === "pass") return "Pass";
  if (kind === "screen") return "Screen";
  if (kind === "handoff") return "Dribble handoff";
  if (kind === "pick-roll") return "Pick and roll";
  return "Movement";
}

function actionClass(kind: ArrowKind) {
  if (kind === "pass" || kind === "handoff") return "pass-arrow";
  if (kind === "screen") return "screen-arrow";
  if (kind === "pick-roll") return "pick-roll-arrow";
  return "movement-arrow";
}

function actionMarker(kind: ArrowKind) {
  return kind === "pass" || kind === "handoff" ? "pass-arrow" : "movement-arrow";
}

function nearestPointIndex(points: CourtPoint[], target: CourtPoint) {
  if (!points.length) return -1;
  return points.reduce((best, point, index) => pointDistance(point, target) < pointDistance(points[best], target) ? index : best, 0);
}

function actionDurationMs(arrow: PlaybookArrow) {
  return Math.round(clampTiming(arrow.timing ?? 1.2) * 1000);
}

function simulationTimelineDuration(arrows: PlaybookArrow[]) {
  const total = orderedArrows(arrows).reduce((sum, { arrow }) => sum + actionDurationMs(arrow), 0);
  return Math.max(SIMULATION_STEP_MS, total);
}

function buildSimulationActions(source: PlaybookDraft): SimulationAction[] {
  const positions = source.players.map((marker) => ({ ...marker }));
  let cursor = 0;
  return orderedArrows(source.arrows).map(({ arrow, sequence }) => {
    const actorIndex = nearestPointIndex(positions, arrow.start);
    const actorId = actorIndex >= 0 ? positions[actorIndex].id : null;
    const movementLike = arrow.kind === "movement" || arrow.kind === "screen" || arrow.kind === "pick-roll";
    const transferLike = arrow.kind === "pass" || arrow.kind === "handoff";
    if (movementLike && actorIndex >= 0) positions[actorIndex] = { ...positions[actorIndex], ...arrow.end };
    const recipientIndex = transferLike ? nearestPointIndex(positions, arrow.end) : -1;
    const recipient = recipientIndex >= 0 ? positions[recipientIndex] : null;
    const recipientId = recipient?.id ?? null;
    const recipientStart = recipient ? { x: recipient.x, y: recipient.y } : null;
    if (transferLike && recipientIndex >= 0) positions[recipientIndex] = { ...positions[recipientIndex], ...arrow.end };
    const durationMs = actionDurationMs(arrow);
    const action = { arrow, sequence, actorId, recipientId, recipientStart, startTime: cursor, durationMs };
    cursor += durationMs;
    return action;
  });
}

const FIVE_OUT_SPOTS: CourtPoint[] = [
  { x: 50, y: 51 },
  { x: 29, y: 56 },
  { x: 71, y: 56 },
  { x: 14, y: 32 },
  { x: 86, y: 32 },
];

function bestDefensiveMatchups(players: PlaybookMarker[], defenders: PlaybookMarker[]) {
  if (!players.length || !defenders.length) return defenders.map(() => -1);
  const defenderCount = Math.min(players.length, defenders.length);
  if (defenderCount > 7) return defenders.map((_, index) => index % players.length);
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
      const nextCost = cost + pointDistance(defenders[defenderIndex], players[playerIndex]);
      if (nextCost >= bestCost) continue;
      used.add(playerIndex);
      assignments.push(playerIndex);
      visit(defenderIndex + 1, used, assignments, nextCost);
      assignments.pop();
      used.delete(playerIndex);
    }
  };
  visit(0, new Set<number>(), [], 0);
  return defenders.map((_, index) => best[index % Math.max(1, defenderCount)] ?? index % players.length);
}

function offBallTarget(
  marker: PlaybookMarker,
  index: number,
  players: PlaybookMarker[],
  ball: CourtPoint | null,
  phase: number,
  settings: SimulationSettings,
  defenders: PlaybookMarker[],
) {
  if (!ball || players.length < 2 || settings.offenseOffBall === "off") return marker;
  const handlerIndex = nearestPointIndex(players, ball);
  if (index === handlerIndex) return marker;
  const intensity = Math.max(0, Math.min(1, settings.offBallIntensity / 100));
  const handler = players[handlerIndex] ?? players[0];
  const home = FIVE_OUT_SPOTS[(marker.id - 1) % FIVE_OUT_SPOTS.length];
  const pressured = defenders.length > 0 && Math.min(...defenders.map((defender) => pointDistance(defender, handler))) < 18;
  const drivingLane = ball.y > 43 && Math.abs(ball.x - 50) < 22;
  let target = { ...home };

  // If a teammate attacks the paint, fill the nearest open perimeter role
  // instead of following the ball into the same lane.
  if (ball.y < 41) target.y = Math.max(24, target.y - 5);
  if (drivingLane && Math.abs(target.x - ball.x) < 18) target.x = target.x < 50 ? 14 : 86;

  const offBallPlayers = players.filter((player) => player.id !== handler.id);
  const cutterOffset = Math.floor(phase / 5.5) % Math.max(1, offBallPlayers.length);
  const cutter = offBallPlayers[cutterOffset];
  const shouldCut = settings.offenseOffBall === "cuts"
    || (settings.offenseOffBall === "read-react" && (pressured || drivingLane));
  if (shouldCut && cutter?.id === marker.id) {
    const cutPhase = phase % 5.5;
    const rimSide = marker.x < ball.x ? -1 : 1;
    const rimCut = { x: clamp(50 + rimSide * 7), y: 25 };
    const weakCorner = { x: rimSide < 0 ? 86 : 14, y: 31 };
    if (cutPhase < 2.1) target = lerpPoint(home, rimCut, easeInOut(cutPhase / 2.1));
    else if (cutPhase < 3.7) target = lerpPoint(rimCut, weakCorner, easeInOut((cutPhase - 2.1) / 1.6));
    else target = lerpPoint(weakCorner, home, easeInOut((cutPhase - 3.7) / 1.8));
  } else if (settings.offenseOffBall === "spacing") {
    // Spacing-only players lift or sink along their home lane as the ball moves.
    target.y = clamp(target.y + Math.max(-5, Math.min(5, (ball.y - 56) * 0.12)));
  }

  // Preserve a playable passing lane and stop off-ball routes from bunching up.
  if (pointDistance(target, ball) < 17) {
    const side = target.x < ball.x ? -1 : 1;
    target = { x: clamp(target.x + side * 10), y: clamp(target.y + (target.y > ball.y ? 5 : -5)) };
  }
  const blend = easeInOut(Math.min(0.92, 0.12 + intensity * 0.66));
  return { ...marker, ...lerpPoint(marker, target, blend) };
}

function offBallMovementQuality(players: PlaybookMarker[], ball: CourtPoint | null, settings: SimulationSettings) {
  if (!ball || players.length < 2) return 0;
  if (settings.offenseOffBall === "off") return 42;
  const handlerIndex = nearestPointIndex(players, ball);
  const offBallPlayers = players.filter((_, index) => index !== handlerIndex);
  if (!offBallPlayers.length) return 0;
  const ideal = 18 + Math.max(0, Math.min(1, settings.offBallIntensity / 100)) * 9;
  const spacingScore = offBallPlayers.reduce((total, player) => total + (1 - Math.min(1, Math.abs(pointDistance(player, ball) - ideal) / 30)), 0) / offBallPlayers.length;
  const laneScore = offBallPlayers.length < 2 ? 1 : offBallPlayers.reduce((total, player, index) => {
    const nearest = Math.min(...offBallPlayers.filter((_, otherIndex) => otherIndex !== index).map((other) => pointDistance(player, other)));
    return total + Math.min(1, nearest / 24);
  }, 0) / offBallPlayers.length;
  return Math.round(Math.max(0, Math.min(100, (spacingScore * 0.7 + laneScore * 0.3) * 100)));
}

/** ARC defensive AI is local and deterministic so the same saved play behaves identically on FastAPI and GitHub Pages. */
function defensiveTargets(players: PlaybookMarker[], ball: CourtPoint | null, defenders: PlaybookMarker[], settings: SimulationSettings, elapsed: number, actions: SimulationAction[] = []) {
  if (!players.length || settings.defenseOffBall === "off") return defenders.map((defender) => ({ x: defender.x, y: defender.y }));
  const ballThreatIndex = ball ? nearestPointIndex(players, ball) : 0;
  const ballHandler = players[ballThreatIndex] ?? players[0];
  const matchups = bestDefensiveMatchups(players, defenders);
  const assignmentIndexes = [...matchups];
  const liveAction = actions.find((action) => elapsed >= action.startTime && elapsed < action.startTime + action.durationMs);
  const isScreenAction = liveAction?.arrow.kind === "screen" || liveAction?.arrow.kind === "pick-roll";

  // Switch the two guards involved in a screen or handoff; keep the rest of
  // the floor matched instead of rotating every defender on a timer.
  if (settings.defenseOffBall === "switch" && liveAction && (isScreenAction || liveAction.arrow.kind === "handoff")) {
    const firstId = liveAction.actorId;
    const secondId = isScreenAction ? ballHandler.id : liveAction.recipientId;
    const firstIndex = assignmentIndexes.findIndex((playerIndex) => players[playerIndex]?.id === firstId);
    const secondIndex = assignmentIndexes.findIndex((playerIndex) => players[playerIndex]?.id === secondId);
    if (firstIndex >= 0 && secondIndex >= 0 && firstIndex !== secondIndex) {
      [assignmentIndexes[firstIndex], assignmentIndexes[secondIndex]] = [assignmentIndexes[secondIndex], assignmentIndexes[firstIndex]];
    }
  }

  const helpSpot = ball ? lerpPoint(ball, HOOP_POINT, 0.38) : HOOP_POINT;
  const liveActionPoint = liveAction ? actionPointAt(liveAction.arrow, (elapsed - liveAction.startTime) / liveAction.durationMs) : null;
  const handlerDefenderIndex = assignmentIndexes.findIndex((playerIndex) => players[playerIndex]?.id === ballHandler.id);
  const helpDefenderIndex = assignmentIndexes.reduce((best, playerIndex, defenderIndex) => {
    if (defenderIndex === handlerDefenderIndex || playerIndex < 0) return best;
    if (best < 0) return defenderIndex;
    const current = players[assignmentIndexes[best]];
    const candidate = players[playerIndex];
    return pointDistance(candidate, ball ?? ballHandler) > pointDistance(current, ball ?? ballHandler) ? defenderIndex : best;
  }, -1);

  return defenders.map((defender, index) => {
    const assignedIndex = assignmentIndexes[index];
    const assignment = players[assignedIndex] ?? ballHandler;
    const isOnBall = assignment.id === ballHandler.id;
    const rimSide = assignment.x < 50 ? -1 : 1;
    let target: CourtPoint = isOnBall
      ? { x: clamp((ball ?? ballHandler).x + rimSide * 3.5), y: clamp((ball ?? ballHandler).y - 5.5) }
      : lerpPoint(assignment, HOOP_POINT, settings.defenseOffBall === "contain" ? 0.14 : 0.22);

    // The help defender tags the drive lane, then the remaining guards stay
    // goal-side and close enough to recover to their own matchup.
    if (settings.defenseOffBall === "help" && index === helpDefenderIndex) {
      target = lerpPoint(target, helpSpot, ball && ball.y > 42 ? 0.52 : 0.28);
    } else if (!isOnBall && settings.defenseOffBall === "help" && ball) {
      target = lerpPoint(target, ball, 0.12);
    }

    if (liveActionPoint && liveAction) {
      if (isScreenAction && (isOnBall || index === helpDefenderIndex)) {
        const response = liveAction.arrow.kind === "pick-roll" ? (isOnBall ? 0.48 : 0.32) : (isOnBall ? 0.32 : 0.18);
        target = lerpPoint(target, liveActionPoint, response);
      }
      if (liveAction.arrow.kind === "handoff" && (isOnBall || assignment.id === liveAction.recipientId)) {
        target = lerpPoint(target, liveActionPoint, isOnBall ? 0.38 : 0.24);
      }
    }
    return { ...defender, ...lerpPoint(defender, target, 0.9) };
  });
}

function defensiveQuality(players: PlaybookMarker[], defenders: PlaybookMarker[], ball: CourtPoint | null, settings: SimulationSettings) {
  if (!players.length || !defenders.length) return 0;
  const handlerIndex = ball ? nearestPointIndex(players, ball) : 0;
  const handler = players[handlerIndex] ?? players[0];
  const matchups = bestDefensiveMatchups(players, defenders);
  const handlerDefenderIndex = matchups.findIndex((playerIndex) => players[playerIndex]?.id === handler.id);
  const onBallGap = handlerDefenderIndex >= 0
    ? pointDistance(defenders[handlerDefenderIndex], ball ?? handler)
    : Math.min(...defenders.map((defender) => pointDistance(defender, ball ?? handler)));
  const onBallScore = 1 - Math.min(1, Math.max(0, onBallGap - 7) / 34);
  const assignmentScore = defenders.reduce((total, defender, index) => {
    const assignment = players[matchups[index]] ?? handler;
    const goalSide = assignment.id === handler.id ? (ball ?? handler) : lerpPoint(assignment, HOOP_POINT, 0.18);
    return total + (1 - Math.min(1, pointDistance(defender, goalSide) / 42));
  }, 0) / defenders.length;
  const helpSpot = ball ? lerpPoint(ball, HOOP_POINT, 0.34) : HOOP_POINT;
  const offBallDefenders = defenders.filter((_, index) => index !== handlerDefenderIndex);
  const helpScore = offBallDefenders.length < 1 ? 0.5 : 1 - Math.min(1, Math.min(...offBallDefenders.map((defender) => pointDistance(defender, helpSpot))) / 44);
  const contestScore = ball ? 1 - Math.min(1, Math.min(...defenders.map((defender) => pointDistance(defender, ball))) / 46) : 0.5;
  const styleWeight = settings.defenseOffBall === "off" ? 0.65 : 1;
  return Math.round(Math.max(0, Math.min(100, (onBallScore * 0.38 + assignmentScore * 0.3 + helpScore * 0.17 + contestScore * 0.15) * 100 * styleWeight)));
}

function shotQuality(players: PlaybookMarker[], defenders: PlaybookMarker[], ball: CourtPoint | null, offBallQuality: number, shooterId: number | null = null) {
  if (!players.length || !ball) return 0;
  const shooter = (shooterId == null ? null : players.find((player) => player.id === shooterId)) ?? players[nearestPointIndex(players, ball)] ?? players[0];
  const rangeScore = 1 - Math.min(1, pointDistance(shooter, HOOP_POINT) / 74);
  const closestDefenderGap = defenders.length ? Math.min(...defenders.map((defender) => pointDistance(defender, shooter))) : 38;
  const contestScore = Math.min(1, closestDefenderGap / 38);
  return Math.round(Math.max(0, Math.min(100, (rangeScore * 0.52 + contestScore * 0.28 + (offBallQuality / 100) * 0.2) * 100)));
}

function simulateDraft(source: PlaybookDraft, elapsed: number, settings: SimulationSettings): SimulationFrame {
  const actions = buildSimulationActions(source);
  const actionDuration = simulationTimelineDuration(source.arrows);
  const players = source.players.map((marker) => ({ ...marker }));
  const baseDefenders = source.defenders.map((marker) => ({ ...marker }));
  const defenders = baseDefenders.map((marker) => ({ ...marker }));
  let ball = source.ball ? { ...source.ball } : source.players[0] ? { x: source.players[0].x, y: source.players[0].y } : null;
  let activeSequence: number | null = null;
  const explicitIds = new Set<number>();
  actions.forEach((action) => {
    const startTime = action.startTime;
    const arrowProgress = easeInOut(Math.max(0, Math.min(1, (elapsed - startTime) / action.durationMs)));
    if (action.arrow.kind === "movement" || action.arrow.kind === "screen" || action.arrow.kind === "pick-roll") {
      if (elapsed >= startTime && action.actorId != null) {
        const playerIndex = players.findIndex((marker) => marker.id === action.actorId);
        if (playerIndex >= 0) players[playerIndex] = { ...players[playerIndex], ...actionPointAt(action.arrow, arrowProgress) };
        explicitIds.add(action.actorId);
        if (arrowProgress < 1) activeSequence = action.sequence;
      }
      return;
    }
    const prepWindow = Math.min(PASS_PREP_MS, Math.max(180, action.durationMs * 0.42));
    const prepStart = Math.max(0, startTime - prepWindow);
    if (action.recipientId != null && elapsed >= prepStart) {
      const recipientIndex = players.findIndex((marker) => marker.id === action.recipientId);
      if (recipientIndex >= 0) players[recipientIndex] = { ...players[recipientIndex], ...actionPointAt({ ...action.arrow, start: action.recipientStart ?? players[recipientIndex] }, easeInOut((elapsed - prepStart) / prepWindow)) };
      explicitIds.add(action.recipientId);
    }
    if (elapsed >= startTime) {
      ball = actionPointAt(action.arrow, arrowProgress);
      if (arrowProgress < 1) activeSequence = action.sequence;
    }
  });

  const phase = elapsed / 1000;
  const shapedPlayers = elapsed <= actionDuration
    ? players.map((marker, index) => explicitIds.has(marker.id) ? marker : offBallTarget(marker, index, players, ball, phase, settings, baseDefenders))
    : players;
  let shotPhase: SimulationFrame["shotPhase"] = "idle";
  let shotProgress = 0;
  let shotResult: SimulationFrame["shotResult"] = "pending";
  let shooterId: number | null = null;
  let shotStart: CourtPoint | null = null;
  const shotTarget = shapedPlayers.length && ball ? HOOP_POINT : null;
  const shotElapsed = elapsed - actionDuration;
  if (shotTarget && shotElapsed >= 0) {
    const shooter = shapedPlayers[nearestPointIndex(shapedPlayers, ball as CourtPoint)] ?? shapedPlayers[0];
    shooterId = shooter.id;
    shotStart = { x: ball!.x, y: ball!.y };
    shotProgress = Math.max(0, Math.min(1, shotElapsed / SHOT_PHASE_MS));
    if (shotProgress < 0.18) shotPhase = "setup";
    else if (shotProgress < 0.84) {
      shotPhase = "air";
      ball = parabolicPoint(shotStart, shotTarget, (shotProgress - 0.18) / 0.66);
    } else {
      shotPhase = "result";
      ball = { ...shotTarget };
    }
  }
  const releasePoint = shotStart ?? ball;
  const targets = defensiveTargets(shapedPlayers, releasePoint, baseDefenders, settings, elapsed, actions);
  const defenderProgress = settings.defenseOffBall === "off" ? 0 : easeInOut(Math.max(0, Math.min(1, (elapsed - 140) / (SIMULATION_STEP_MS * 1.6))));
  defenders.forEach((defender, index) => {
    const target = targets[index];
    if (target) {
      const point = lerpPoint(baseDefenders[index], target, defenderProgress);
      defenders[index] = { ...defender, ...point };
    }
  });
  const offBallScore = offBallMovementQuality(shapedPlayers, releasePoint, settings);
  const defenseScore = defensiveQuality(shapedPlayers, defenders, releasePoint, settings);
  const finalShotQuality = shotQuality(shapedPlayers, defenders, releasePoint, offBallScore, shooterId);
  if (shotPhase === "result") shotResult = finalShotQuality >= 68 ? "made" : "missed";
  return {
    players: shapedPlayers,
    defenders,
    ball,
    activeSequence,
    defensiveQuality: defenseScore,
    offBallQuality: offBallScore,
    shotPhase,
    shotProgress,
    shotResult,
    shotQuality: finalShotQuality,
    shooterId,
    shotStart,
    shotTarget,
  };
}

export function PlaybookBoard() {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [draft, setDraft] = useState<PlaybookDraft>(() => clonePlaybook(READY_SETUP));
  const [history, setHistory] = useState<PlaybookDraft[]>([]);
  const [future, setFuture] = useState<PlaybookDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Selection>(null);
  const [tool, setTool] = useState<PlaybookTool>("select");
  const [drawStart, setDrawStart] = useState<CourtPoint | null>(null);
  const [drawEnd, setDrawEnd] = useState<CourtPoint | null>(null);
  const [saved, setSaved] = useState<PlaybookDocument[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [starterOpen, setStarterOpen] = useState(false);
  const [replacement, setReplacement] = useState<PlaybookDraft | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [simulationPlaying, setSimulationPlaying] = useState(false);
  const [simulationElapsed, setSimulationElapsed] = useState(0);
  const [simulationSettings, setSimulationSettings] = useState<SimulationSettings>(() => ({ ...DEFAULT_SIMULATION_SETTINGS }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const simulationFrameRef = useRef<number | null>(null);

  const selectedArrow = selected?.type === "arrow" ? draft.arrows.find((arrow) => arrow.id === selected.id) : null;
  const selectedArrowSequence = selectedArrow ? arrowSequence(selectedArrow, draft.arrows.findIndex((arrow) => arrow.id === selectedArrow.id)) : null;
  const simulationDuration = simulationTimelineDuration(draft.arrows) + SHOT_PHASE_MS;
  const simulationActive = simulationPlaying || simulationElapsed > 0;
  const simulationComplete = simulationElapsed >= simulationDuration && simulationElapsed > 0;
  const simulationPaused = simulationActive && !simulationPlaying && !simulationComplete;
  const simulationFrame = useMemo(() => simulateDraft(draft, simulationElapsed, simulationSettings), [draft, simulationElapsed, simulationSettings]);

  useEffect(() => {
    if (!simulationPlaying) return;
    const startedAt = performance.now() - simulationElapsed;
    const tick = (now: number) => {
      const elapsed = Math.min(simulationDuration, now - startedAt);
      setSimulationElapsed(elapsed);
      if (elapsed >= simulationDuration) {
        setSimulationPlaying(false);
        simulationFrameRef.current = null;
        return;
      }
      simulationFrameRef.current = window.requestAnimationFrame(tick);
    };
    simulationFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (simulationFrameRef.current != null) window.cancelAnimationFrame(simulationFrameRef.current);
      simulationFrameRef.current = null;
    };
  }, [simulationPlaying, simulationDuration]);

  useEffect(() => {
    fetchPlaybooks().then(setSaved).catch(() => setError("Saved plays are unavailable until the local server is running."));
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, [dirty]);

  function focusBoard() {
    rootRef.current?.focus();
  }

  function resetSimulation() {
    setSimulationPlaying(false);
    setSimulationElapsed(0);
  }

  function changeSimulationSetting<Key extends keyof SimulationSettings>(key: Key, value: SimulationSettings[Key]) {
    setSimulationSettings((current) => ({ ...current, [key]: value }));
    if (simulationPlaying || simulationElapsed === 0) resetSimulation();
    setError(null);
  }

  function commit(next: PlaybookDraft, previous = draft, options: { preserveSimulation?: boolean } = {}) {
    if (isSameDraft(next, previous)) return;
    const preserveSimulation = options.preserveSimulation ?? (simulationElapsed > 0 && !simulationPlaying);
    if (!preserveSimulation) resetSimulation();
    setHistory((current) => [...current.slice(-39), clonePlaybook(previous)]);
    setFuture([]);
    setDraft(next);
    setDirty(true);
    setStatus("idle");
    setError(null);
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((current) => current.slice(0, -1));
    setFuture((current) => [clonePlaybook(draft), ...current]);
    setDraft(previous);
    setDirty(true);
    setSelected(null);
    setStatus("idle");
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture((current) => current.slice(1));
    setHistory((current) => [...current, clonePlaybook(draft)]);
    setDraft(next);
    setDirty(true);
    setSelected(null);
    setStatus("idle");
  }

  function chooseTool(next: PlaybookTool) {
    setTool(next);
    setDrawStart(null);
    setDrawEnd(null);
    focusBoard();
  }

  function loadDraft(next: PlaybookDraft) {
    setDraft(normalizeDraft(next));
    setHistory([]);
    setFuture([]);
    setSelected(null);
    setTool("select");
    setDrawStart(null);
    setDrawEnd(null);
    setDirty(false);
    setStatus("idle");
    setError(null);
    resetSimulation();
  }

  function requestLoad(next: PlaybookDraft) {
    if (dirty) setReplacement(next);
    else loadDraft(next);
  }

  async function saveDraft() {
    setStatus("saving");
    setError(null);
    try {
      const result = draft.id.startsWith("draft-") ? await createPlaybook(draftPayload(draft)) : await updatePlaybook(draftPayload(draft));
      setDraft(clonePlaybook(result));
      setDirty(false);
      setSaved((current) => [result, ...current.filter((play) => play.id !== result.id)]);
      setStatus("saved");
      return true;
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Play could not be saved. Your draft is still here.");
      return false;
    }
  }

  function startSimulation() {
    if (!draft.defenders.length) {
      // A play can be simulated from any starting option; the first run adds
      // the standard five defensive markers so the AI has a full matchup.
      commit(withDefenders(draft, true));
    }
    if (simulationComplete) setSimulationElapsed(0);
    setSimulationPlaying(true);
    setError(null);
    focusBoard();
  }

  function applyAIDefense() {
    const source = withDefenders(draft, true);
    const targets = defensiveTargets(source.players, source.ball, source.defenders, simulationSettings, 0, buildSimulationActions(source));
    const next = clonePlaybook(source);
    next.defenders = source.defenders.map((defender, index) => ({ ...defender, ...(targets[index] ?? {}) }));
    commit(next);
    setSelected(null);
    setError(null);
  }

  function changeArrowSequence(arrowIdValue: string, requestedSequence: number) {
    if (!Number.isFinite(requestedSequence)) return;
    const current = orderedArrows(draft.arrows);
    const selectedIndex = current.findIndex(({ arrow }) => arrow.id === arrowIdValue);
    if (selectedIndex < 0) return;
    const targetIndex = Math.max(0, Math.min(current.length - 1, Math.round(requestedSequence) - 1));
    const [item] = current.splice(selectedIndex, 1);
    current.splice(targetIndex, 0, item);
    const next = clonePlaybook(draft);
    next.arrows = current.map(({ arrow }, index) => ({ ...arrow, sequence: index + 1 }));
    commit(next);
    setSelected({ type: "arrow", id: arrowIdValue });
  }

  function changeArrowPath(arrowIdValue: string, path: "straight" | "curve") {
    const next = clonePlaybook(draft);
    next.arrows = next.arrows.map((arrow) => arrow.id === arrowIdValue
      ? { ...arrow, path, control: path === "curve" ? arrowControl(arrow) : arrow.control }
      : arrow);
    commit(next);
    setSelected({ type: "arrow", id: arrowIdValue });
  }

  function changeArrowTiming(arrowIdValue: string, requestedTiming: number) {
    if (!Number.isFinite(requestedTiming)) return;
    const next = clonePlaybook(draft);
    next.arrows = next.arrows.map((arrow) => arrow.id === arrowIdValue ? { ...arrow, timing: clampTiming(requestedTiming) } : arrow);
    commit(next);
    setSelected({ type: "arrow", id: arrowIdValue });
  }

  function duplicate(play: PlaybookDocument) {
    const copy = { ...clonePlaybook(play), id: `draft-copy-${Date.now()}`, name: `${play.name} copy`, created_at: undefined, updated_at: undefined };
    if (dirty) setReplacement(copy);
    else {
      loadDraft(copy);
      setDirty(true);
    }
    setSavedOpen(false);
  }

  async function confirmDelete(id: string) {
    setDeleteId(id);
    try {
      await deletePlaybook(id);
      setSaved((current) => current.filter((play) => play.id !== id));
      if (draft.id === id) loadDraft(clonePlaybook(READY_SETUP));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Play could not be deleted.");
    } finally {
      setDeleteId(null);
    }
  }

  function addMarker(point: CourtPoint, type: "player" | "defender") {
    if (markerCount(draft, type) >= 5) {
      setError(`You can place up to five ${type === "player" ? "offensive players" : "defenders"}.`);
      return;
    }
    const collection = type === "player" ? draft.players : draft.defenders;
    const id = Math.max(0, ...collection.map((marker) => marker.id)) + 1;
    const next = clonePlaybook(draft);
    const marker = { id, ...point };
    if (type === "player") next.players = [...next.players, marker];
    else next.defenders = [...next.defenders, marker];
    commit(next);
    setSelected({ type, id });
    setTool("select");
  }

  function onBackgroundPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    const point = pointFromPointer(event, svgRef.current);
    if (!point) return;
    focusBoard();
    if (tool === "player") return addMarker(point, "player");
    if (tool === "ball") {
      if (draft.ball) setError("This play already has a ball. Select it and press Delete to replace it.");
      else {
        const next = clonePlaybook(draft);
        next.ball = point;
        commit(next);
        setSelected({ type: "ball", id: "ball" });
        setTool("select");
      }
      return;
    }
    if (tool === "movement" || tool === "pass" || tool === "screen" || tool === "handoff" || tool === "pick-roll") {
      setDrawStart(point);
      setDrawEnd(point);
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === "select") setSelected(null);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const point = pointFromPointer(event, svgRef.current);
    if (!point) return;
    if (drawStart) {
      setDrawEnd(point);
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const next = clonePlaybook(drag.before);
    if (drag.type === "ball") next.ball = point;
    if (drag.type === "player") next.players = next.players.map((marker) => marker.id === drag.id ? { ...marker, ...point } : marker);
    if (drag.type === "defender") next.defenders = next.defenders.map((marker) => marker.id === drag.id ? { ...marker, ...point } : marker);
    if (drag.type === "arrow-start" || drag.type === "arrow-end") {
      next.arrows = next.arrows.map((arrow) => arrow.id === drag.id ? { ...arrow, [drag.type === "arrow-start" ? "start" : "end"]: point } : arrow);
    }
    if (drag.type === "arrow-control") next.arrows = next.arrows.map((arrow) => arrow.id === drag.id ? { ...arrow, path: "curve", control: point } : arrow);
    setDraft(next);
    setDirty(true);
    setStatus("idle");
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (drawStart && drawEnd) {
      if (pointDistance(drawStart, drawEnd) > 3) {
        const next = clonePlaybook(draft);
        const kind: ArrowKind = tool === "pass" ? "pass" : tool === "screen" ? "screen" : tool === "handoff" ? "handoff" : tool === "pick-roll" ? "pick-roll" : "movement";
        const newArrow: PlaybookArrow = {
          id: arrowId(),
          kind,
          start: drawStart,
          end: drawEnd,
          path: "straight",
          timing: kind === "screen" || kind === "pick-roll" ? 1.4 : 1.2,
          sequence: Math.max(0, ...draft.arrows.map((arrow, index) => arrowSequence(arrow, index))) + 1,
        };
        next.arrows = [...next.arrows, newArrow];
        commit(next);
        setSelected({ type: "arrow", id: newArrow.id });
      }
      setDrawStart(null);
      setDrawEnd(null);
      svgRef.current?.releasePointerCapture(event.pointerId);
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      const finished = clonePlaybook(draft);
      if (!isSameDraft(finished, drag.before)) {
        setHistory((current) => [...current.slice(-39), clonePlaybook(drag.before)]);
        setFuture([]);
      }
      dragRef.current = null;
      svgRef.current?.releasePointerCapture(event.pointerId);
    }
  }

  function onMarkerPointerDown(event: ReactPointerEvent<SVGElement>, selection: Selection) {
    event.stopPropagation();
    focusBoard();
    if (!selection) return;
    if (tool === "delete") {
      commit(removeSelection(draft, selection));
      setSelected(null);
      setTool("select");
      return;
    }
    // Lines remain editable from every toolbar mode. This keeps an accidental
    // tool choice from trapping the user in a mode before an arrow can be
    // pulled to a new endpoint; player and defender markers still require
    // Select so clicks in placement modes remain predictable.
    if (selection.type === "arrow") {
      setSelected(selection);
      dragRef.current = { type: "arrow-end", id: selection.id, before: clonePlaybook(draft) };
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }
    if (tool !== "select") return;
    setSelected(selection);
    dragRef.current = { type: selection.type, id: selection.id, before: clonePlaybook(draft) };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function onArrowEndpointPointerDown(event: ReactPointerEvent<SVGElement>, arrow: PlaybookArrow, endpoint: "start" | "end" | "control") {
    event.stopPropagation();
    focusBoard();
    if (tool === "delete") {
      commit(removeSelection(draft, { type: "arrow", id: arrow.id }));
      setSelected(null);
      setTool("select");
      return;
    }
    // Endpoint handles follow the same always-draggable rule as the arrow
    // stroke, including while another drawing tool is active.
    setSelected({ type: "arrow", id: arrow.id });
    dragRef.current = { type: endpoint === "start" ? "arrow-start" : endpoint === "end" ? "arrow-end" : "arrow-control", id: arrow.id, before: clonePlaybook(draft) };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === "Escape") {
      setSelected(null);
      setDrawStart(null);
      setDrawEnd(null);
      setTool("select");
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selected) {
        event.preventDefault();
        commit(removeSelection(draft, selected));
        setSelected(null);
      }
      return;
    }
    if (!selected || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const amount = event.shiftKey ? 2 : 0.75;
    const delta = { x: event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0, y: event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0 };
    const currentPoint = selected.type === "ball" ? draft.ball : selected.type === "player" ? draft.players.find((marker) => marker.id === selected.id) : selected.type === "defender" ? draft.defenders.find((marker) => marker.id === selected.id) : draft.arrows.find((arrow) => arrow.id === selected.id)?.end;
    if (currentPoint) commit(replacePoint(draft, selected, { x: clamp(currentPoint.x + delta.x), y: clamp(currentPoint.y + delta.y) }));
  }

  function exportPng() {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", "1600");
    clone.setAttribute("height", "1152");
    clone.querySelectorAll(".selection-handle, .drawing-preview").forEach((node) => node.remove());
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `.court-floor{fill:#151819}.court-line{fill:none;stroke:#d7d2c7;stroke-width:3}.court-dash{fill:none;stroke:#8f9692;stroke-width:2;stroke-dasharray:9 10}.movement-arrow,.screen-arrow,.pick-roll-arrow,.pass-arrow{fill:none;stroke-width:3}.movement-arrow{stroke:#f3f1ec}.pass-arrow{stroke:#ee733f;stroke-dasharray:9 8}.screen-arrow{stroke:#73bff0;stroke-dasharray:3 7}.pick-roll-arrow{stroke:#ee733f;stroke-width:4}.offense-marker{fill:#ee733f;stroke:#fff2ea;stroke-width:2}.defense-marker{fill:none;stroke:#73bff0;stroke-width:3}.ball-marker{fill:#d96b38;stroke:#fff2ea;stroke-width:2}.marker-number{fill:#fff8f0;font:700 18px sans-serif;text-anchor:middle;dominant-baseline:central}.basket-mark{fill:none;stroke:#ee733f;stroke-width:4}#movement-arrow path{fill:#f3f1ec}#pass-arrow path{fill:#ee733f}`;
    clone.prepend(style);
    const serialized = new XMLSerializer().serializeToString(clone);
    const image = new Image();
    const svgUrl = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml" }));
    image.onload = () => {
      URL.revokeObjectURL(svgUrl);
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1232;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#0d0f10";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#f3f1ec";
      context.font = "600 30px Inter, Arial, sans-serif";
      context.fillText(draft.name || "ARC play", 48, 48);
      context.drawImage(image, 0, 80, canvas.width, 1152);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const link = document.createElement("a");
        link.download = `${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "arc-play"}.png`;
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      setError("PNG export could not render this diagram.");
    };
    image.src = svgUrl;
  }

  const visibleArrows = useMemo(() => draft.arrows, [draft.arrows]);
  const titleStatus = status === "saving" ? "Saving…" : status === "saved" ? `Saved · ${draft.arrows.length} actions` : status === "error" ? "Save failed" : dirty ? "Unsaved changes" : "Ready to edit";

  return (
    <div ref={rootRef} className="playbook-page" tabIndex={-1} onKeyDown={onKeyDown} onPointerDownCapture={(event) => {
      const target = event.target as HTMLElement;
      if (!target.closest("button, input, textarea, select")) focusBoard();
    }}>
      <div className="playbook-header">
        <div className="playbook-title-group">
          <div className="play-name-input-wrap">
            <input aria-label="Play name" value={draft.name} maxLength={80} onChange={(event) => {
              const next = clonePlaybook(draft);
              next.name = event.currentTarget.value;
              setDraft(next);
              setDirty(true);
              setStatus("idle");
            }} />
            <Pencil size={14} aria-hidden="true" />
          </div>
          <span className={`play-save-status play-status-${status}`}><i />{titleStatus}</span>
        </div>
        <div className="playbook-header-actions">
          <button type="button" className="button button-subtle" onClick={() => setSavedOpen(true)}><FolderOpen size={16} />Saved plays</button>
          <button type="button" className="button button-outline" onClick={exportPng}><Download size={16} />Export PNG</button>
          <button type="button" className="button button-primary" onClick={() => void saveDraft()} disabled={status === "saving"}><Save size={16} />{status === "saving" ? "Saving…" : "Save play"}</button>
        </div>
      </div>
      {error ? <div className="playbook-alert" role="alert">{error}</div> : null}
      <div className="playbook-layout">
        <aside className="playbook-presets" aria-label="Playbook starting options">
          <PresetButton active={draft.name === "Ready setup" && !draft.arrows.length} icon={<Shield size={17} />} label="Ready setup" onClick={() => requestLoad(clonePlaybook(READY_SETUP))} />
          <PresetButton active={starterOpen} icon={<FolderOpen size={17} />} label="Starter plays" onClick={() => setStarterOpen(true)} />
          <PresetButton active={!draft.players.length && !draft.ball} icon={<Circle size={17} />} label="Empty court" onClick={() => requestLoad(clonePlaybook(EMPTY_COURT))} />
          <button type="button" className={`preset-button ${draft.defenders_visible ? "is-active" : ""}`} onClick={() => commit(withDefenders(draft, !draft.defenders_visible))}>
            <UserRound size={17} /> <span>Defenders</span><i className={`toggle-dot ${draft.defenders_visible ? "is-on" : ""}`} />
          </button>
          <p className="playbook-help">Drag markers to set positions. Select an arrow to adjust its endpoint. Use Delete or the toolbar to clean up.</p>
        </aside>
        <main className="playbook-editor">
          <div className="playbook-toolbar" role="toolbar" aria-label="Playbook drawing tools">
            <ToolButton active={tool === "select"} icon={<MousePointer2 size={15} />} label="Select" title={TOOL_LABELS.select} onClick={() => chooseTool("select")} />
            <ToolButton active={tool === "player"} icon={<UserRound size={15} />} label="Add player" title={TOOL_LABELS.player} onClick={() => chooseTool("player")} />
            <ToolButton active={tool === "ball"} icon={<Circle size={15} />} label="Add ball" title={TOOL_LABELS.ball} onClick={() => chooseTool("ball")} />
            <ToolButton active={tool === "movement"} icon={<ArrowUpRight size={15} />} label="Movement" title={TOOL_LABELS.movement} onClick={() => chooseTool("movement")} />
            <ToolButton active={tool === "pass"} icon={<Send size={15} />} label="Pass" title={TOOL_LABELS.pass} onClick={() => chooseTool("pass")} />
            <ToolButton active={tool === "screen"} icon={<Shield size={15} />} label="Screen" title={TOOL_LABELS.screen} onClick={() => chooseTool("screen")} />
            <ToolButton active={tool === "handoff"} icon={<Hand size={15} />} label="Handoff" title={TOOL_LABELS.handoff} onClick={() => chooseTool("handoff")} />
            <ToolButton active={tool === "pick-roll"} icon={<ArrowUpRight size={15} />} label="Pick & roll" title={TOOL_LABELS["pick-roll"]} onClick={() => chooseTool("pick-roll")} />
            <span className="toolbar-spacer" />
            <ToolButton icon={<BrainCircuit size={15} />} label="AI defense" title="Apply ARC defensive AI" onClick={applyAIDefense} />
            <ToolButton icon={simulationPlaying ? <Pause size={15} /> : <Play size={15} />} label={simulationPlaying ? "Pause" : simulationPaused ? "Resume" : "Play"} title={simulationPlaying ? "Pause play simulation" : simulationPaused ? "Resume play simulation" : "Play simulation with defensive AI"} onClick={() => {
              if (simulationPlaying) setSimulationPlaying(false);
              else startSimulation();
            }} />
            <ToolButton active={tool === "delete"} icon={<Eraser size={15} />} label="Delete" title={TOOL_LABELS.delete} onClick={() => chooseTool("delete")} />
            <ToolButton disabled={!history.length} icon={<Undo2 size={15} />} label="Undo" title="Undo last edit" onClick={undo} />
            <ToolButton disabled={!future.length} icon={<Redo2 size={15} />} label="Redo" title="Redo last edit" onClick={redo} />
          </div>
          <div className="playbook-simulation-bar" role="region" aria-label="Play simulation controls">
            <span className="simulation-ai-label"><ShieldCheck size={14} /> ARC defensive AI</span>
            <span className="simulation-copy">{simulationPaused ? "Paused · edit the board, then resume" : simulationActive ? (simulationFrame.shotPhase === "setup" ? "Shot setup" : simulationFrame.shotPhase === "air" ? `Shot in air · ${Math.round(simulationFrame.shotProgress * 100)}%` : simulationFrame.shotPhase === "result" ? `${simulationFrame.shotResult === "made" ? "Made shot" : "Missed shot"} · ${simulationFrame.shotQuality}% quality` : simulationFrame.activeSequence ? `Move ${simulationFrame.activeSequence} in progress` : "Defensive setup") : "Play to preview the sequence"}</span>
            <span className="simulation-quality" role="status">Off-ball quality <strong>{simulationActive ? `${simulationFrame.offBallQuality}%` : "—"}</strong></span>
            <span className="simulation-quality" role="status">Defensive quality <strong>{simulationActive ? `${simulationFrame.defensiveQuality}%` : "—"}</strong></span>
            <button type="button" className={`simulation-settings-toggle ${settingsOpen ? "is-open" : ""}`} aria-expanded={settingsOpen} aria-controls="simulation-settings" onClick={() => setSettingsOpen((current) => !current)}><Settings2 size={14} />Settings</button>
            {selectedArrow ? <>
              <label className="sequence-editor"><span>Move order</span><input aria-label="Move order" type="number" min={1} max={Math.max(1, draft.arrows.length)} value={selectedArrowSequence ?? 1} onChange={(event) => changeArrowSequence(selectedArrow.id, Number(event.currentTarget.value))} /><small>1 = first</small></label>
              <label className="sequence-editor"><span>Path</span><select aria-label="Arrow path" value={selectedArrow.path ?? "straight"} onChange={(event) => changeArrowPath(selectedArrow.id, event.currentTarget.value as "straight" | "curve")}><option value="straight">Straight</option><option value="curve">Curved</option></select></label>
              <label className="sequence-editor"><span>Seconds</span><input aria-label="Action timing" type="number" min={0.5} max={4} step={0.1} value={clampTiming(selectedArrow.timing ?? 1.2).toFixed(1)} onChange={(event) => changeArrowTiming(selectedArrow.id, Number(event.currentTarget.value))} /></label>
            </> : null}
          </div>
          {settingsOpen ? <div id="simulation-settings" className="simulation-settings-panel" role="group" aria-label="Simulation settings">
            <label className="simulation-setting"><span>Offense off-ball</span><select aria-label="Offense off-ball style" value={simulationSettings.offenseOffBall} onChange={(event) => changeSimulationSetting("offenseOffBall", event.currentTarget.value as SimulationSettings["offenseOffBall"])}><option value="read-react">Read &amp; react</option><option value="cuts">Structured cuts</option><option value="spacing">Spacing only</option><option value="off">Off</option></select></label>
            <label className="simulation-setting"><span>Defense off-ball</span><select aria-label="Defense off-ball style" value={simulationSettings.defenseOffBall} onChange={(event) => changeSimulationSetting("defenseOffBall", event.currentTarget.value as SimulationSettings["defenseOffBall"])}><option value="help">Help &amp; recover</option><option value="contain">Contain &amp; deny</option><option value="switch">Switch reads</option><option value="off">Hold positions</option></select></label>
            <label className="simulation-setting simulation-setting-range"><span>Off-ball intensity <output>{simulationSettings.offBallIntensity}%</output></span><input aria-label="Off-ball intensity" type="range" min={0} max={100} step={1} value={simulationSettings.offBallIntensity} onChange={(event) => changeSimulationSetting("offBallIntensity", Number(event.currentTarget.value))} /></label>
            <span className="simulation-settings-note">Receivers arrive before passes; screens and handoffs pull defenders into the action; the final action ends with a contested shot.</span>
          </div> : null}
          <div className="court-frame">
            <svg ref={svgRef} className="court-svg" viewBox="0 0 1000 720" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Editable half court play diagram" onPointerDown={onBackgroundPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
              <defs>
                <pattern id="court-boards" width="80" height="80" patternUnits="userSpaceOnUse"><rect width="80" height="80" fill="var(--surface)" /><path d="M0 0h80M0 40h80" stroke="rgba(255,255,255,.022)" strokeWidth="1" /><path d="M40 0v80" stroke="rgba(255,255,255,.014)" strokeWidth="1" /></pattern>
                <marker id="movement-arrow" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto"><path d="M0 0 10 5 0 10z" fill="var(--text)" /></marker>
                <marker id="pass-arrow" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto"><path d="M0 0 10 5 0 10z" fill="var(--orange)" /></marker>
              </defs>
              <rect x="0" y="0" width="1000" height="720" rx="8" className="court-floor" fill="url(#court-boards)" />
              <rect x="24" y="24" width="952" height="672" rx="3" className="court-line" />
              <path d="M330 24v208h340V24M330 232h340M405 24v208M595 24v208" className="court-line" />
              <path d="M405 232a95 95 0 0 0 190 0M405 232a95 95 0 0 1 190 0" className="court-dash" />
              <path d="M285 24v318a215 215 0 0 0 430 0V24" className="court-line" />
              <path d="M285 342a215 215 0 0 0 430 0" className="court-line" />
              <path d="M430 111h140v10H430z" className="basket-mark" /><circle cx="500" cy="135" r="18" className="basket-mark" /><path d="M482 140q18 28 36 0" className="court-line" />
              {simulationFrame.shotPhase !== "idle" && simulationFrame.shotStart && simulationFrame.shotTarget ? <path d={shotArcPath(simulationFrame.shotStart, simulationFrame.shotTarget)} className="shot-arc" /> : null}
              {visibleArrows.map((arrow, arrowIndex) => {
                const start = markerPoint(arrow.start);
                const end = markerPoint(arrow.end);
                const control = markerPoint(arrowControl(arrow));
                const active = selected?.type === "arrow" && selected.id === arrow.id;
                const sequence = arrowSequence(arrow, arrowIndex);
                const badgePoint = actionPointAt(arrow, 0.5);
                const badge = markerPoint(badgePoint);
                return <g key={arrow.id} onPointerDown={(event) => onMarkerPointerDown(event, { type: "arrow", id: arrow.id })} className={`play-arrow-group ${active ? "is-selected" : ""}`}>
                  <title>Move {sequence} · {actionLabel(arrow.kind)} · {clampTiming(arrow.timing ?? 1.2).toFixed(1)} seconds</title>
                  <path d={actionPath(arrow)} className={actionClass(arrow.kind)} markerEnd={`url(#${actionMarker(arrow.kind)})`} />
                  <g className="arrow-sequence-badge"><circle cx={badge.x} cy={badge.y} r="12" /><text x={badge.x} y={badge.y + 1}>{sequence}</text></g>
                  {active ? <><circle cx={start.x} cy={start.y} r="8" className="selection-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "start")} /><circle cx={end.x} cy={end.y} r="8" className="selection-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "end")} />{arrow.path === "curve" ? <circle cx={control.x} cy={control.y} r="7" className="curve-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "control")} /> : null}</> : null}
                </g>;
              })}
              {drawStart && drawEnd ? <path d={actionPath({ id: "preview", kind: tool === "pass" ? "pass" : tool === "screen" ? "screen" : tool === "handoff" ? "handoff" : tool === "pick-roll" ? "pick-roll" : "movement", start: drawStart, end: drawEnd, path: "straight" })} className={`drawing-preview ${actionClass(tool === "pass" ? "pass" : tool === "screen" ? "screen" : tool === "handoff" ? "handoff" : tool === "pick-roll" ? "pick-roll" : "movement")}`} markerEnd={`url(#${actionMarker(tool === "pass" ? "pass" : tool === "screen" ? "screen" : tool === "handoff" ? "handoff" : tool === "pick-roll" ? "pick-roll" : "movement")})`} /> : null}
              {(draft.defenders_visible || simulationActive) ? (simulationActive ? simulationFrame.defenders : draft.defenders).map((marker) => {
                const point = markerPoint(marker);
                const active = selected?.type === "defender" && selected.id === marker.id;
                return <g key={`defender-${marker.id}`} className={`defense-marker ${active ? "is-selected" : ""}`} onPointerDown={(event) => onMarkerPointerDown(event, { type: "defender", id: marker.id })}>
                  <circle cx={point.x} cy={point.y} r="24" className="defense-marker-ring" /><path d={`M${point.x - 10} ${point.y - 10}l20 20M${point.x + 10} ${point.y - 10}l-20 20`} className="defense-marker" /><text x={point.x} y={point.y + 39} className="marker-caption">D{marker.id}</text>
                </g>;
              }) : null}
              {(simulationActive ? simulationFrame.players : draft.players).map((marker) => {
                const point = markerPoint(marker);
                const active = selected?.type === "player" && selected.id === marker.id;
                return <g key={`player-${marker.id}`} className={`offense-marker-group ${active ? "is-selected" : ""}`} onPointerDown={(event) => onMarkerPointerDown(event, { type: "player", id: marker.id })}>
                  <circle cx={point.x} cy={point.y} r="25" className="offense-marker" /><text x={point.x} y={point.y + 1} className="marker-number">{marker.id}</text>
                </g>;
              })}
              {(simulationActive ? simulationFrame.ball : draft.ball) ? <g className={`ball-marker-group ${selected?.type === "ball" ? "is-selected" : ""}`} onPointerDown={(event) => onMarkerPointerDown(event, { type: "ball", id: "ball" })}>
                <circle cx={markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).x} cy={markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).y} r="14" className="ball-marker" /><path d={`M${markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).x - 11} ${markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).y}h22M${markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).x} ${markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).y - 11}v22`} className="ball-seam" />
              </g> : null}
            </svg>
            <div className="court-hint">{tool === "select" ? "Select a marker to move it" : tool === "delete" ? "Select an object to delete" : tool === "player" ? "Click the court to place a player" : tool === "ball" ? "Click the court to place the ball" : "Drag across the court to draw"}</div>
          </div>
          <div className="playbook-statusbar"><span><Hand size={14} /> {selected ? `${selected.type === "ball" ? "Ball" : selected.type === "arrow" ? `Move ${selectedArrowSequence ?? ""}` : `${selected.type === "defender" ? "Defender" : "Player"} ${selected.id}`} selected` : "Nothing selected"}</span><span>Arrows stay draggable · Arrow keys nudge · Shift for larger steps · Cmd/Ctrl Z to undo</span></div>
        </main>
        <aside className={`saved-plays-panel ${savedOpen ? "is-open" : ""}`} aria-label="Saved plays">
          <div className="saved-plays-heading"><div><span className="section-kicker">Local library</span><h2>Saved plays</h2></div><button type="button" className="icon-button" aria-label="Close saved plays" onClick={() => setSavedOpen(false)}><X size={17} /></button></div>
          {saved.length ? <div className="saved-play-list">{saved.map((play) => <SavedPlayCard key={play.id} play={play} active={draft.id === play.id} deletePending={deleteId === play.id} onOpen={() => requestLoad(clonePlaybook(play))} onDuplicate={() => duplicate(play)} onDelete={() => { if (window.confirm(`Delete ${play.name}?`)) void confirmDelete(play.id); }} />)}</div> : <div className="saved-empty"><FolderOpen size={20} /><p>Your saved diagrams will appear here.</p><button type="button" onClick={() => void saveDraft()}>Save this play</button></div>}
        </aside>
      </div>
      {starterOpen ? <div className="playbook-modal-backdrop" role="presentation" onMouseDown={() => setStarterOpen(false)}><section className="playbook-modal" role="dialog" aria-modal="true" aria-labelledby="starter-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><span className="section-kicker">Start from a diagram</span><h2 id="starter-title">Starter plays</h2></div><button type="button" className="icon-button" onClick={() => setStarterOpen(false)} aria-label="Close starter plays"><X size={17} /></button></div>
        <div className="starter-grid">{STARTER_PLAYS.map((play) => <button type="button" className="starter-card" key={play.name} onClick={() => { requestLoad(clonePlaybook(play)); setStarterOpen(false); }}><MiniCourt play={play} /><strong>{play.name}</strong><span>Edit this diagram</span></button>)}</div>
      </section></div> : null}
      {replacement ? <div className="playbook-modal-backdrop" role="presentation"><section className="playbook-modal replacement-modal" role="dialog" aria-modal="true" aria-labelledby="replace-title"><div className="modal-heading"><div><span className="section-kicker">Unsaved draft</span><h2 id="replace-title">Replace this play?</h2></div></div><p>Your current diagram has changes. Save it before opening the new starting point, or discard the draft.</p><div className="modal-actions"><button type="button" className="button button-subtle" onClick={() => setReplacement(null)}>Cancel</button><button type="button" className="button button-outline" onClick={() => { const next = replacement; void saveDraft().then((didSave) => { if (didSave) { loadDraft(next); setReplacement(null); } }); }}>Save then replace</button><button type="button" className="button button-primary" onClick={() => { loadDraft(replacement); setReplacement(null); }}>Discard changes</button></div></section></div> : null}
    </div>
  );
}

function PresetButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button type="button" className={`preset-button ${active ? "is-active" : ""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function ToolButton({ active = false, disabled = false, icon, label, title, onClick }: { active?: boolean; disabled?: boolean; icon: React.ReactNode; label: string; title: string; onClick: () => void }) {
  return <button type="button" className={`tool-button ${active ? "is-active" : ""}`} disabled={disabled} title={title} aria-label={title} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function SavedPlayCard({ play, active, deletePending, onOpen, onDuplicate, onDelete }: { play: PlaybookDocument; active: boolean; deletePending: boolean; onOpen: () => void; onDuplicate: () => void; onDelete: () => void }) {
  return <article className={`saved-play-card ${active ? "is-active" : ""}`}>
    <button type="button" className="saved-play-open" onClick={onOpen}><MiniCourt play={play} /><strong>{play.name}</strong><span className="saved-play-meta">{play.arrows.length} saved {play.arrows.length === 1 ? "action" : "actions"} · {new Date(play.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></button>
    <div className="saved-play-actions"><button type="button" aria-label={`Duplicate ${play.name}`} title="Duplicate" onClick={onDuplicate}><Copy size={14} /></button><button type="button" aria-label={`Delete ${play.name}`} title="Delete" disabled={deletePending} onClick={onDelete}><Trash2 size={14} /></button></div>
  </article>;
}

function MiniCourt({ play }: { play: PlaybookDocument | PlaybookDraft }) {
  return <svg className="mini-court" viewBox="0 0 1000 720" aria-hidden="true"><rect x="0" y="0" width="1000" height="720" rx="5" className="mini-floor" /><rect x="24" y="24" width="952" height="672" className="mini-line" /><path d="M330 24v208h340V24M285 24v318a215 215 0 0 0 430 0V24" className="mini-line" /><path d="M405 232a95 95 0 0 0 190 0" className="mini-dash" /><path d="M430 111h140v10M482 140q18 28 36 0" className="mini-basket" />{play.arrows.map((arrow) => <path key={arrow.id} d={actionPath(arrow)} className={arrow.kind === "pass" || arrow.kind === "handoff" ? "mini-pass" : arrow.kind === "screen" ? "mini-screen" : arrow.kind === "pick-roll" ? "mini-pick-roll" : "mini-move"} />)}{play.defenders_visible ? play.defenders.map((marker) => <path key={`d-${marker.id}`} d={`M${marker.x * 10 - 7} ${marker.y * 7.2 - 7}l14 14M${marker.x * 10 + 7} ${marker.y * 7.2 - 7}l-14 14`} className="mini-defense" />) : null}{play.players.map((marker) => <circle key={`p-${marker.id}`} cx={marker.x * 10} cy={marker.y * 7.2} r="16" className="mini-player" />)}{play.ball ? <circle cx={play.ball.x * 10} cy={play.ball.y * 7.2} r="9" className="mini-ball" /> : null}</svg>;
}
