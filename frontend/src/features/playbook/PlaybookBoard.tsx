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
type DragState = { type: "player" | "defender" | "ball" | "arrow-start" | "arrow-end"; id: number | string; before: PlaybookDraft };
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
};

const TOOL_LABELS: Record<PlaybookTool, string> = {
  select: "Select / move",
  player: "Add offensive player",
  ball: "Add ball",
  movement: "Draw movement arrow",
  pass: "Draw pass arrow",
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
    return { ...arrow, sequence };
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

function nearestPointIndex(points: CourtPoint[], target: CourtPoint) {
  if (!points.length) return -1;
  return points.reduce((best, point, index) => pointDistance(point, target) < pointDistance(points[best], target) ? index : best, 0);
}

function buildSimulationActions(source: PlaybookDraft): SimulationAction[] {
  const positions = source.players.map((marker) => ({ ...marker }));
  return orderedArrows(source.arrows).map(({ arrow, sequence }) => {
    const actorIndex = nearestPointIndex(positions, arrow.start);
    const actorId = actorIndex >= 0 ? positions[actorIndex].id : null;
    if (arrow.kind === "movement" && actorIndex >= 0) positions[actorIndex] = { ...positions[actorIndex], ...arrow.end };
    const recipientIndex = arrow.kind === "pass" ? nearestPointIndex(positions, arrow.end) : -1;
    const recipient = recipientIndex >= 0 ? positions[recipientIndex] : null;
    const recipientId = recipient?.id ?? null;
    const recipientStart = recipient ? { x: recipient.x, y: recipient.y } : null;
    if (arrow.kind === "pass" && recipientIndex >= 0) positions[recipientIndex] = { ...positions[recipientIndex], ...arrow.end };
    return { arrow, sequence, actorId, recipientId, recipientStart };
  });
}

function offBallTarget(marker: PlaybookMarker, index: number, players: PlaybookMarker[], ball: CourtPoint | null, phase: number, settings: SimulationSettings) {
  if (!ball || players.length < 2 || settings.offenseOffBall === "off") return marker;
  const handlerIndex = nearestPointIndex(players, ball);
  if (index === handlerIndex) return marker;
  const intensity = Math.max(0, Math.min(1, settings.offBallIntensity / 100));
  const angle = (index - handlerIndex) * 1.2 + phase * 0.38;
  const radius = 18 + intensity * 9;
  const spacing = { x: clamp(ball.x + Math.cos(angle) * radius), y: clamp(ball.y + Math.sin(angle) * radius * 0.8) };
  const rotatingCutter = (Math.floor(phase) + 1) % players.length;
  const cutting = settings.offenseOffBall === "cuts" || (settings.offenseOffBall === "read-react" && Math.floor(phase) % 3 === 1);
  const target = cutting && index === rotatingCutter
    ? { x: clamp(50 + (index % 2 ? 1 : -1) * (13 + index * 2)), y: clamp(24 + (index % 3) * 11) }
    : spacing;
  const blend = easeInOut(Math.min(1, 0.16 + intensity * 0.5));
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
function defensiveTargets(players: PlaybookMarker[], ball: CourtPoint | null, defenders: PlaybookMarker[], settings: SimulationSettings, elapsed: number) {
  if (!players.length || settings.defenseOffBall === "off") return defenders.map((defender) => ({ x: defender.x, y: defender.y }));
  const ballThreatIndex = ball ? nearestPointIndex(players, ball) : 0;
  const phase = Math.floor(elapsed / SIMULATION_STEP_MS);
  const helpSpot = ball ? lerpPoint(ball, HOOP_POINT, 0.34) : HOOP_POINT;
  return defenders.map((defender, index) => {
    const assignment = players[(index + (settings.defenseOffBall === "switch" ? phase : 0)) % players.length] ?? players[0];
    let target: CourtPoint = assignment;
    if (index === 0 || index === ballThreatIndex) target = ball ? lerpPoint(assignment, ball, 0.48) : assignment;
    else if (settings.defenseOffBall === "help") target = lerpPoint(assignment, helpSpot, index === 1 ? 0.62 : 0.38);
    else if (settings.defenseOffBall === "switch") target = lerpPoint(assignment, ball ?? assignment, 0.2);
    else target = lerpPoint(assignment, ball ?? assignment, 0.16);
    const lateral = ((index % 3) - 1) * 3.6;
    return { x: clamp(target.x + lateral), y: clamp(target.y + (index % 2 ? 2.2 : -2.2)) };
  });
}

function defensiveQuality(players: PlaybookMarker[], defenders: PlaybookMarker[], ball: CourtPoint | null, settings: SimulationSettings) {
  if (!players.length || !defenders.length) return 0;
  const handlerIndex = ball ? nearestPointIndex(players, ball) : 0;
  const handler = players[handlerIndex] ?? players[0];
  const onBallGap = Math.min(...defenders.map((defender) => pointDistance(defender, ball ?? handler)));
  const onBallScore = 1 - Math.min(1, onBallGap / 36);
  const assignmentScore = defenders.reduce((total, defender, index) => {
    const assignment = players[(index + (settings.defenseOffBall === "switch" ? 1 : 0)) % players.length];
    return total + (1 - Math.min(1, pointDistance(defender, assignment) / 48));
  }, 0) / defenders.length;
  const helpSpot = ball ? lerpPoint(ball, HOOP_POINT, 0.34) : HOOP_POINT;
  const helpScore = defenders.length < 2 ? 0.5 : 1 - Math.min(1, Math.min(...defenders.slice(1).map((defender) => pointDistance(defender, helpSpot))) / 44);
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
  const actionDuration = Math.max(1, actions.length) * SIMULATION_STEP_MS;
  const players = source.players.map((marker) => ({ ...marker }));
  const baseDefenders = source.defenders.map((marker) => ({ ...marker }));
  const defenders = baseDefenders.map((marker) => ({ ...marker }));
  let ball = source.ball ? { ...source.ball } : source.players[0] ? { x: source.players[0].x, y: source.players[0].y } : null;
  let activeSequence: number | null = null;
  const explicitIds = new Set<number>();
  actions.forEach((action, index) => {
    const startTime = index * SIMULATION_STEP_MS;
    const arrowProgress = easeInOut(Math.max(0, Math.min(1, (elapsed - startTime) / SIMULATION_STEP_MS)));
    if (action.arrow.kind === "movement") {
      if (elapsed >= startTime && action.actorId != null) {
        const playerIndex = players.findIndex((marker) => marker.id === action.actorId);
        if (playerIndex >= 0) players[playerIndex] = { ...players[playerIndex], ...lerpPoint(action.arrow.start, action.arrow.end, arrowProgress) };
        explicitIds.add(action.actorId);
        if (arrowProgress < 1) activeSequence = action.sequence;
      }
      return;
    }
    const prepStart = Math.max(0, startTime - PASS_PREP_MS);
    if (action.recipientId != null && elapsed >= prepStart) {
      const recipientIndex = players.findIndex((marker) => marker.id === action.recipientId);
      if (recipientIndex >= 0) players[recipientIndex] = { ...players[recipientIndex], ...lerpPoint(action.recipientStart ?? players[recipientIndex], action.arrow.end, easeInOut((elapsed - prepStart) / PASS_PREP_MS)) };
      explicitIds.add(action.recipientId);
    }
    if (elapsed >= startTime) {
      ball = lerpPoint(action.arrow.start, action.arrow.end, arrowProgress);
      if (arrowProgress < 1) activeSequence = action.sequence;
    }
  });

  const phase = elapsed / SIMULATION_STEP_MS;
  const shapedPlayers = elapsed <= actionDuration
    ? players.map((marker, index) => explicitIds.has(marker.id) ? marker : offBallTarget(marker, index, players, ball, phase, settings))
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
  const targets = defensiveTargets(shapedPlayers, releasePoint, baseDefenders, settings, elapsed);
  const defenderProgress = settings.defenseOffBall === "off" ? 0 : easeInOut(Math.max(0, Math.min(1, (elapsed - 140) / (SIMULATION_STEP_MS * 1.6))));
  defenders.forEach((defender, index) => {
    const target = targets[index];
    if (target) {
      const point = lerpPoint(defender, target, defenderProgress);
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
  const simulationDuration = Math.max(1, draft.arrows.length) * SIMULATION_STEP_MS + SHOT_PHASE_MS;
  const simulationActive = simulationPlaying || simulationElapsed > 0;
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
    resetSimulation();
    setError(null);
  }

  function commit(next: PlaybookDraft, previous = draft) {
    if (isSameDraft(next, previous)) return;
    resetSimulation();
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
    setSimulationElapsed(0);
    setSimulationPlaying(true);
    setError(null);
    focusBoard();
  }

  function applyAIDefense() {
    const source = withDefenders(draft, true);
    const targets = defensiveTargets(source.players, source.ball, source.defenders, simulationSettings, 0);
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
    if (tool === "movement" || tool === "pass") {
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
    setDraft(next);
    setDirty(true);
    setStatus("idle");
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (drawStart && drawEnd) {
      if (pointDistance(drawStart, drawEnd) > 3) {
        const next = clonePlaybook(draft);
        const kind: ArrowKind = tool === "pass" ? "pass" : "movement";
        const newArrow: PlaybookArrow = {
          id: arrowId(),
          kind,
          start: drawStart,
          end: drawEnd,
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

  function onArrowEndpointPointerDown(event: ReactPointerEvent<SVGElement>, arrow: PlaybookArrow, endpoint: "start" | "end") {
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
    dragRef.current = { type: endpoint === "start" ? "arrow-start" : "arrow-end", id: arrow.id, before: clonePlaybook(draft) };
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
    style.textContent = `.court-floor{fill:#151819}.court-line{fill:none;stroke:#d7d2c7;stroke-width:3}.court-dash{fill:none;stroke:#8f9692;stroke-width:2;stroke-dasharray:9 10}.movement-arrow{fill:none;stroke:#f3f1ec;stroke-width:3}.pass-arrow{fill:none;stroke:#ee733f;stroke-width:3;stroke-dasharray:9 8}.offense-marker{fill:#ee733f;stroke:#fff2ea;stroke-width:2}.defense-marker{fill:none;stroke:#73bff0;stroke-width:3}.ball-marker{fill:#d96b38;stroke:#fff2ea;stroke-width:2}.marker-number{fill:#fff8f0;font:700 18px sans-serif;text-anchor:middle;dominant-baseline:central}.basket-mark{fill:none;stroke:#ee733f;stroke-width:4}#movement-arrow path{fill:#f3f1ec}#pass-arrow path{fill:#ee733f}`;
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
  const titleStatus = status === "saving" ? "Saving…" : status === "saved" ? "Saved locally" : status === "error" ? "Save failed" : dirty ? "Unsaved changes" : "Ready to edit";

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
            <span className="toolbar-spacer" />
            <ToolButton icon={<BrainCircuit size={15} />} label="AI defense" title="Apply ARC defensive AI" onClick={applyAIDefense} />
            <ToolButton icon={simulationPlaying ? <Pause size={15} /> : <Play size={15} />} label={simulationPlaying ? "Pause" : "Play"} title={simulationPlaying ? "Pause play simulation" : "Play simulation with defensive AI"} onClick={() => {
              if (simulationPlaying) setSimulationPlaying(false);
              else startSimulation();
            }} />
            <ToolButton active={tool === "delete"} icon={<Eraser size={15} />} label="Delete" title={TOOL_LABELS.delete} onClick={() => chooseTool("delete")} />
            <ToolButton disabled={!history.length} icon={<Undo2 size={15} />} label="Undo" title="Undo last edit" onClick={undo} />
            <ToolButton disabled={!future.length} icon={<Redo2 size={15} />} label="Redo" title="Redo last edit" onClick={redo} />
          </div>
          <div className="playbook-simulation-bar" role="region" aria-label="Play simulation controls">
            <span className="simulation-ai-label"><ShieldCheck size={14} /> ARC defensive AI</span>
            <span className="simulation-copy">{simulationActive ? (simulationFrame.shotPhase === "setup" ? "Shot setup" : simulationFrame.shotPhase === "air" ? `Shot in air · ${Math.round(simulationFrame.shotProgress * 100)}%` : simulationFrame.shotPhase === "result" ? `${simulationFrame.shotResult === "made" ? "Made shot" : "Missed shot"} · ${simulationFrame.shotQuality}% quality` : simulationFrame.activeSequence ? `Move ${simulationFrame.activeSequence} in progress` : "Defensive setup") : "Play to preview the sequence"}</span>
            <span className="simulation-quality" role="status">Off-ball quality <strong>{simulationActive ? `${simulationFrame.offBallQuality}%` : "—"}</strong></span>
            <span className="simulation-quality" role="status">Defensive quality <strong>{simulationActive ? `${simulationFrame.defensiveQuality}%` : "—"}</strong></span>
            <button type="button" className={`simulation-settings-toggle ${settingsOpen ? "is-open" : ""}`} aria-expanded={settingsOpen} aria-controls="simulation-settings" onClick={() => setSettingsOpen((current) => !current)}><Settings2 size={14} />Settings</button>
            {selectedArrow ? <label className="sequence-editor"><span>Move order</span><input aria-label="Move order" type="number" min={1} max={Math.max(1, draft.arrows.length)} value={selectedArrowSequence ?? 1} onChange={(event) => changeArrowSequence(selectedArrow.id, Number(event.currentTarget.value))} /><small>1 = first</small></label> : null}
          </div>
          {settingsOpen ? <div id="simulation-settings" className="simulation-settings-panel" role="group" aria-label="Simulation settings">
            <label className="simulation-setting"><span>Offense off-ball</span><select aria-label="Offense off-ball style" value={simulationSettings.offenseOffBall} onChange={(event) => changeSimulationSetting("offenseOffBall", event.currentTarget.value as SimulationSettings["offenseOffBall"])}><option value="read-react">Read &amp; react</option><option value="cuts">Structured cuts</option><option value="spacing">Spacing only</option><option value="off">Off</option></select></label>
            <label className="simulation-setting"><span>Defense off-ball</span><select aria-label="Defense off-ball style" value={simulationSettings.defenseOffBall} onChange={(event) => changeSimulationSetting("defenseOffBall", event.currentTarget.value as SimulationSettings["defenseOffBall"])}><option value="help">Help &amp; recover</option><option value="contain">Contain &amp; deny</option><option value="switch">Switch reads</option><option value="off">Hold positions</option></select></label>
            <label className="simulation-setting simulation-setting-range"><span>Off-ball intensity <output>{simulationSettings.offBallIntensity}%</output></span><input aria-label="Off-ball intensity" type="range" min={0} max={100} step={1} value={simulationSettings.offBallIntensity} onChange={(event) => changeSimulationSetting("offBallIntensity", Number(event.currentTarget.value))} /></label>
            <span className="simulation-settings-note">Passes wait for the receiver to arrive; the final action ends with a contested shot.</span>
          </div> : null}
          <div className="court-frame">
            <svg ref={svgRef} className="court-svg" viewBox="0 0 1000 720" preserveAspectRatio="none" role="img" aria-label="Editable half court play diagram" onPointerDown={onBackgroundPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
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
                const active = selected?.type === "arrow" && selected.id === arrow.id;
                const sequence = arrowSequence(arrow, arrowIndex);
                const badgeX = (start.x + end.x) / 2;
                const badgeY = (start.y + end.y) / 2;
                return <g key={arrow.id} onPointerDown={(event) => onMarkerPointerDown(event, { type: "arrow", id: arrow.id })} className={`play-arrow-group ${active ? "is-selected" : ""}`}>
                  <title>Move {sequence} · {arrow.kind === "pass" ? "Pass" : "Movement"}</title>
                  <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className={arrow.kind === "pass" ? "pass-arrow" : "movement-arrow"} markerEnd={`url(#${arrow.kind === "pass" ? "pass-arrow" : "movement-arrow"})`} />
                  <g className="arrow-sequence-badge"><circle cx={badgeX} cy={badgeY} r="12" /><text x={badgeX} y={badgeY + 1}>{sequence}</text></g>
                  {active ? <><circle cx={start.x} cy={start.y} r="8" className="selection-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "start")} /><circle cx={end.x} cy={end.y} r="8" className="selection-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "end")} /></> : null}
                </g>;
              })}
              {drawStart && drawEnd ? <line x1={markerPoint(drawStart).x} y1={markerPoint(drawStart).y} x2={markerPoint(drawEnd).x} y2={markerPoint(drawEnd).y} className={`drawing-preview ${tool === "pass" ? "pass-arrow" : "movement-arrow"}`} markerEnd={`url(#${tool === "pass" ? "pass-arrow" : "movement-arrow"})`} /> : null}
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
    <button type="button" className="saved-play-open" onClick={onOpen}><MiniCourt play={play} /><strong>{play.name}</strong><span>{new Date(play.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></button>
    <div className="saved-play-actions"><button type="button" aria-label={`Duplicate ${play.name}`} title="Duplicate" onClick={onDuplicate}><Copy size={14} /></button><button type="button" aria-label={`Delete ${play.name}`} title="Delete" disabled={deletePending} onClick={onDelete}><Trash2 size={14} /></button></div>
  </article>;
}

function MiniCourt({ play }: { play: PlaybookDocument | PlaybookDraft }) {
  return <svg className="mini-court" viewBox="0 0 1000 720" aria-hidden="true"><rect x="0" y="0" width="1000" height="720" rx="5" className="mini-floor" /><rect x="24" y="24" width="952" height="672" className="mini-line" /><path d="M330 24v208h340V24M285 24v318a215 215 0 0 0 430 0V24" className="mini-line" /><path d="M405 232a95 95 0 0 0 190 0" className="mini-dash" /><path d="M430 111h140v10M482 140q18 28 36 0" className="mini-basket" />{play.arrows.map((arrow) => <line key={arrow.id} x1={arrow.start.x * 10} y1={arrow.start.y * 7.2} x2={arrow.end.x * 10} y2={arrow.end.y * 7.2} className={arrow.kind === "pass" ? "mini-pass" : "mini-move"} />)}{play.defenders_visible ? play.defenders.map((marker) => <path key={`d-${marker.id}`} d={`M${marker.x * 10 - 7} ${marker.y * 7.2 - 7}l14 14M${marker.x * 10 + 7} ${marker.y * 7.2 - 7}l-14 14`} className="mini-defense" />) : null}{play.players.map((marker) => <circle key={`p-${marker.id}`} cx={marker.x * 10} cy={marker.y * 7.2} r="16" className="mini-player" />)}{play.ball ? <circle cx={play.ball.x * 10} cy={play.ball.y * 7.2} r="9" className="mini-ball" /> : null}</svg>;
}
