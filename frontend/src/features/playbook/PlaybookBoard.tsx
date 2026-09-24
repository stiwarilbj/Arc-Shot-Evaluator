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
  Search,
  Send,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  Undo2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { createPlaybook, deletePlaybook, fetchPlaybooks, updatePlaybook } from "./api";
import { ArcSelect } from "../../components/ArcSelect";
import { OFFENSIVE_BADGE_ORDER, OFFENSIVE_BADGES } from "./badges";
import { DEFENSIVE_BADGE_ORDER, DEFENSIVE_BADGES } from "./defensiveBadges";
import { CourtMarkings } from "./CourtMarkings";
import { EMPTY_COURT, READY_SETUP, STARTER_PLAY_DETAILS, STARTER_PLAYS } from "./data";
import type { ArrowKind, AutomaticActionSettings, CourtPoint, DefenseScheme, DefensiveBadge, OffensiveBadge, PlayerSkillRatings, PlaybookArrow, PlaybookDocument, PlaybookDraft, PlaybookMarker, PlaybookTool, SimulationSettings } from "./types";
import { clonePlaybook, DEFAULT_SIMULATION_SETTINGS, pointDistance } from "./types";
import { COURT_VIEWBOX, clientPointToCourt, courtPointToSvg, courtSvgToPoint, NBA_COURT_GEOMETRY } from "./courtGeometry";
import {
  advanceSimulationRun,
  createSimulationRun,
  editPausedSimulationMarker,
  getSimulationFrame,
  placeDefendersGoalSide,
  rebasePausedSimulation,
  setSimulationRunSettings,
  SIMULATION_SHOT_MS,
  DEFENSE_SCHEME_DESCRIPTIONS,
  DEFENSE_SCHEME_LABELS,
  simulationTimelineDuration,
} from "./simulation";
import type { SimulationFrame, SimulationRun } from "./simulation";

type Selection = { type: "player" | "defender" | "ball" | "arrow"; id: number | string } | null;
type DragState = { type: "player" | "defender" | "ball" | "arrow-start" | "arrow-end" | "arrow-exit" | "arrow-control"; id: number | string; before: PlaybookDraft };
const TOOL_LABELS: Record<PlaybookTool, string> = {
  select: "Select / move",
  player: "Add offensive player",
  ball: "Add ball",
  movement: "Draw movement arrow",
  pass: "Draw pass arrow",
  screen: "Add screen action",
  handoff: "Add dribble handoff action",
  "pick-roll": "Add pick and roll action",
  "pick-pop": "Add pick and pop action",
  "off-ball-screen": "Add manual off-ball screen",
  "pin-down": "Add pin-down screen",
  "backdoor-cut": "Add backdoor cut",
  delete: "Delete selected object",
};

const HOOP_POINT = courtSvgToPoint(NBA_COURT_GEOMETRY.basket.center);
const DEFENSE_SCHEME_OPTIONS: Array<{ value: DefenseScheme; label: string; description: string }> = [
  { value: "auto", label: "Auto", description: DEFENSE_SCHEME_DESCRIPTIONS.auto },
  ...Object.entries(DEFENSE_SCHEME_LABELS).map(([value, label]) => ({
    value: value as Exclude<DefenseScheme, "auto">,
    label,
    description: DEFENSE_SCHEME_DESCRIPTIONS[value as Exclude<DefenseScheme, "auto">],
  })),
];

function clamp(value: number, min = 2, max = 98) {
  return Math.max(min, Math.min(max, value));
}

function pointFromPointer(event: ReactPointerEvent<SVGSVGElement>, svg: SVGSVGElement | null): CourtPoint | null {
  if (!svg) return null;
  const transform = svg.getScreenCTM();
  if (!transform) return null;
  const point = clientPointToCourt(event.clientX, event.clientY, transform);
  return point ? { x: clamp(point.x), y: clamp(point.y) } : null;
}

function markerPoint(marker: CourtPoint) {
  return courtPointToSvg(marker);
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
  if (selection.type === "player") {
    next.players = next.players.filter((marker) => marker.id !== selection.id);
    next.arrows = next.arrows.filter((arrow) => arrow.screener_id !== selection.id && arrow.cutter_id !== selection.id && arrow.handler_id !== selection.id && arrow.actor_id !== selection.id);
  }
  if (selection.type === "defender") next.defenders = next.defenders.filter((marker) => marker.id !== selection.id);
  if (selection.type === "ball") next.ball = null;
  if (selection.type === "arrow") next.arrows = next.arrows.filter((arrow) => arrow.id !== selection.id);
  return next;
}

function isSameDraft(a: PlaybookDraft, b: PlaybookDraft) {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
  next.players = next.players.map((player) => ({
    ...player,
    badges: OFFENSIVE_BADGE_ORDER.filter((badge) => (player.badges ?? []).includes(badge)),
    ratings: {
      threePoint: Math.max(1, Math.min(5, Math.round(player.ratings?.threePoint ?? 3))),
      midrange: Math.max(1, Math.min(5, Math.round(player.ratings?.midrange ?? 3))),
      finishing: Math.max(1, Math.min(5, Math.round(player.ratings?.finishing ?? 3))),
    },
  }));
  next.defenders = next.defenders.map((defender) => ({
    ...defender,
    badges: DEFENSIVE_BADGE_ORDER.filter((badge) => (defender.badges ?? []).includes(badge)),
  }));
  next.arrows = next.arrows.map((arrow, index) => {
    const sequence = arrowSequence(arrow, index);
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
  const point = courtPointToSvg(lerpPoint(start, end, progress));
  const result = courtSvgToPoint({ x: point.x, y: point.y - Math.sin(Math.PI * progress) * 105 });
  return { x: clamp(result.x), y: clamp(result.y) };
}

function shotArcPath(start: CourtPoint, end: CourtPoint) {
  const from = markerPoint(start);
  const to = markerPoint(end);
  const control = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 105 };
  return `M${from.x} ${from.y} Q${control.x} ${control.y} ${to.x} ${to.y}`;
}

function defaultArrowControl(start: CourtPoint, end: CourtPoint): CourtPoint {
  const from = courtPointToSvg(start);
  const to = courtPointToSvg(end);
  const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const offset = Math.max(60, Math.min(140, distance * 0.22));
  const control = courtSvgToPoint({
    x: midpoint.x + dy * offset / Math.max(1, distance),
    y: midpoint.y - dx * offset / Math.max(1, distance),
  });
  return { x: clamp(control.x), y: clamp(control.y) };
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
  if (arrow.kind === "pick-pop" && arrow.exit_target) {
    const pop = markerPoint(arrow.exit_target);
    return `M${start.x} ${start.y} L${end.x} ${end.y} L${pop.x} ${pop.y}`;
  }
  if (arrow.path === "curve") {
    const control = markerPoint(arrowControl(arrow));
    return `M${start.x} ${start.y} Q${control.x} ${control.y} ${end.x} ${end.y}`;
  }
  return `M${start.x} ${start.y} L${end.x} ${end.y}`;
}

function screenCutterPath(arrow: PlaybookArrow, players: PlaybookMarker[]) {
  if (arrow.kind !== "off-ball-screen" && arrow.kind !== "pin-down") return null;
  const cutter = players.find((player) => player.id === arrow.cutter_id);
  if (!cutter) return null;
  const start = markerPoint(cutter);
  const screen = markerPoint(arrow.end);
  const hoop = courtSvgToPoint(NBA_COURT_GEOMETRY.basket.center);
  const distance = Math.hypot(hoop.x - arrow.end.x, hoop.y - arrow.end.y);
  const finishPoint = markerPoint(arrow.exit_target ?? {
    x: arrow.end.x + (hoop.x - arrow.end.x) * Math.min(1, 16 / Math.max(1, distance)),
    y: arrow.end.y + (hoop.y - arrow.end.y) * Math.min(1, 16 / Math.max(1, distance)),
  });
  return `M${start.x} ${start.y} L${screen.x} ${screen.y} L${finishPoint.x} ${finishPoint.y}`;
}

function nearestPlayerId(players: PlaybookMarker[], point: CourtPoint, excludeId?: number) {
  return players.filter((player) => player.id !== excludeId)
    .sort((left, right) => pointDistance(left, point) - pointDistance(right, point) || left.id - right.id)[0]?.id ?? null;
}

function actionLabel(kind: ArrowKind) {
  if (kind === "pass") return "Pass";
  if (kind === "screen") return "Screen";
  if (kind === "handoff") return "Dribble handoff";
  if (kind === "pick-roll") return "Pick and roll";
  if (kind === "pick-pop") return "Pick and pop";
  if (kind === "off-ball-screen") return "Off-ball screen";
  if (kind === "pin-down") return "Pin-down screen";
  if (kind === "backdoor-cut") return "Backdoor cut";
  return "Movement";
}

function actionClass(kind: ArrowKind) {
  if (kind === "pass" || kind === "handoff") return "pass-arrow";
  if (kind === "screen") return "screen-arrow";
  if (kind === "off-ball-screen") return "off-ball-screen-arrow";
  if (kind === "pick-roll") return "pick-roll-arrow";
  if (kind === "pick-pop") return "pick-pop-arrow";
  if (kind === "pin-down") return "pin-down-arrow";
  if (kind === "backdoor-cut") return "backdoor-cut-arrow";
  return "movement-arrow";
}

function actionMarker(kind: ArrowKind) {
  return kind === "pass" || kind === "handoff" ? "pass-arrow" : "movement-arrow";
}


const EMPTY_SIMULATION_FRAME: SimulationFrame = {
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
  const [offBallScreenSelection, setOffBallScreenSelection] = useState<{ screenerId: number | null; cutterId: number | null; screenPoint: CourtPoint | null }>({ screenerId: null, cutterId: null, screenPoint: null });
  const [pickPopSelection, setPickPopSelection] = useState<{ screenerId: number | null; handlerId: number | null; screenPoint: CourtPoint | null }>({ screenerId: null, handlerId: null, screenPoint: null });
  const [backdoorCutterId, setBackdoorCutterId] = useState<number | null>(null);
  const [autoActionsOpen, setAutoActionsOpen] = useState(false);
  const [defenseSchemesOpen, setDefenseSchemesOpen] = useState(false);
  const [defenderSkillsOpen, setDefenderSkillsOpen] = useState(false);
  const [defenderSkillsId, setDefenderSkillsId] = useState<number | null>(null);
  const [ratingsOpen, setRatingsOpen] = useState(false);
  const [playerSkillsTab, setPlayerSkillsTab] = useState<"ratings" | "badges">("ratings");
  const [ratingPlayerId, setRatingPlayerId] = useState<number | null>(null);
  const [saved, setSaved] = useState<PlaybookDocument[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [starterOpen, setStarterOpen] = useState(false);
  const [starterSearch, setStarterSearch] = useState("");
  const [starterCategory, setStarterCategory] = useState("All plays");
  const [replacement, setReplacement] = useState<PlaybookDraft | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [simulationPlaying, setSimulationPlaying] = useState(false);
  const [simulationElapsed, setSimulationElapsed] = useState(0);
  const [simulationFrameState, setSimulationFrameState] = useState<SimulationFrame | null>(null);
  const [simulationSettings, setSimulationSettings] = useState<SimulationSettings>(() => ({ ...DEFAULT_SIMULATION_SETTINGS }));
  const simulationSettingsRef = useRef(simulationSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [arrowFields, setArrowFields] = useState({ id: "", sequence: "", timing: "" });
  const simulationFrameRef = useRef<number | null>(null);
  const simulationRunRef = useRef<SimulationRun | null>(null);

  const selectedArrow = selected?.type === "arrow" ? draft.arrows.find((arrow) => arrow.id === selected.id) : null;
  const selectedRatingsPlayer = draft.players.find((player) => player.id === ratingPlayerId) ?? draft.players[0] ?? null;
  const selectedSkillsDefender = draft.defenders.find((defender) => defender.id === defenderSkillsId) ?? draft.defenders[0] ?? null;
  const selectedArrowSequence = selectedArrow ? arrowSequence(selectedArrow, draft.arrows.findIndex((arrow) => arrow.id === selectedArrow.id)) : null;
  const starterCategories = useMemo(() => ["All plays", ...new Set(STARTER_PLAYS.map((play) => STARTER_PLAY_DETAILS[play.name]?.category ?? "Other"))], []);
  const filteredStarterPlays = useMemo(() => {
    const query = starterSearch.trim().toLowerCase();
    return STARTER_PLAYS.filter((play) => {
      const details = STARTER_PLAY_DETAILS[play.name];
      const categoryMatches = starterCategory === "All plays" || details?.category === starterCategory;
      const queryMatches = !query || `${play.name} ${details?.category ?? ""} ${details?.description ?? ""}`.toLowerCase().includes(query);
      return categoryMatches && queryMatches;
    });
  }, [starterCategory, starterSearch]);
  const simulationFrame = simulationFrameState ?? EMPTY_SIMULATION_FRAME;
  const simulationDuration = simulationRunRef.current?.durationMs ?? simulationTimelineDuration(draft.arrows) + SIMULATION_SHOT_MS;
  const simulationActive = simulationRunRef.current !== null;
  const simulationComplete = simulationElapsed >= simulationDuration && simulationElapsed > 0;
  const simulationPaused = simulationActive && !simulationPlaying && !simulationComplete;
  const offBallQualityDisplay = draft.players.length === 0
    ? "—"
    : simulationActive
      ? `${simulationFrame.offBallQuality}%`
      : "70%";

  useEffect(() => {
    if (selectedArrow) setArrowFields({ id: selectedArrow.id, sequence: String(selectedArrowSequence ?? 1), timing: clampTiming(selectedArrow.timing ?? 1.2).toFixed(1) });
    else setArrowFields({ id: "", sequence: "", timing: "" });
  }, [selectedArrow?.id, selectedArrowSequence, selectedArrow?.timing]);

  useEffect(() => {
    if (!simulationPlaying) return;
    let previousTime = performance.now();
    const tick = (now: number) => {
      const run = simulationRunRef.current;
      if (!run) {
        setSimulationPlaying(false);
        return;
      }
      const delta = Math.max(0, Math.min(120, now - previousTime));
      previousTime = now;
      const before = run.elapsedMs;
      const frame = advanceSimulationRun(run, delta, simulationSettingsRef.current, HOOP_POINT);
      if (run.elapsedMs !== before) {
        setSimulationElapsed(run.elapsedMs);
        setSimulationFrameState(frame);
      }
      if (run.elapsedMs >= run.durationMs) {
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
  }, [simulationPlaying]);

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
    setSimulationFrameState(null);
    simulationRunRef.current = null;
  }

  function changeSimulationSetting<Key extends keyof SimulationSettings>(key: Key, value: SimulationSettings[Key]) {
    const next = { ...simulationSettingsRef.current, [key]: value };
    simulationSettingsRef.current = next;
    setSimulationSettings(next);
    if (simulationRunRef.current) {
      setSimulationRunSettings(simulationRunRef.current, next);
      setSimulationFrameState(getSimulationFrame(simulationRunRef.current));
    }
    setError(null);
  }

  function commit(next: PlaybookDraft, previous = draft, options: { preserveSimulation?: boolean } = {}) {
    if (isSameDraft(next, previous)) return;
    const timelineChanged = JSON.stringify(previous.arrows) !== JSON.stringify(next.arrows);
    const preserveSimulation = options.preserveSimulation ?? (simulationRunRef.current !== null && !simulationPlaying && !timelineChanged);
    if (!preserveSimulation) resetSimulation();
    else if (simulationRunRef.current) {
      const rebased = rebasePausedSimulation(simulationRunRef.current, next, HOOP_POINT);
      if (rebased) setSimulationFrameState(getSimulationFrame(simulationRunRef.current));
      else resetSimulation();
    }
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
    resetSimulation();
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
    resetSimulation();
    setDirty(true);
    setSelected(null);
    setStatus("idle");
  }

  function chooseTool(next: PlaybookTool) {
    setTool(next);
    if (next !== "off-ball-screen" && next !== "pin-down") setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
    if (next !== "pick-pop") setPickPopSelection({ screenerId: null, handlerId: null, screenPoint: null });
    if (next !== "backdoor-cut") setBackdoorCutterId(null);
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
    setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
    setPickPopSelection({ screenerId: null, handlerId: null, screenPoint: null });
    setBackdoorCutterId(null);
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

  function changeAutomaticAction<Key extends keyof AutomaticActionSettings>(key: Key, value: boolean) {
    changeSimulationSetting("automaticActions", { ...simulationSettingsRef.current.automaticActions, [key]: value });
  }

  function changePlayerRating(playerId: number, key: keyof PlayerSkillRatings, value: number) {
    const next = clonePlaybook(draft);
    next.players = next.players.map((player) => player.id === playerId
      ? { ...player, ratings: { threePoint: 3, midrange: 3, finishing: 3, ...player.ratings, [key]: Math.max(1, Math.min(5, Math.round(value))) } }
      : player);
    commit(next, draft, { preserveSimulation: false });
  }

  function togglePlayerBadge(playerId: number, badge: OffensiveBadge) {
    const next = clonePlaybook(draft);
    next.players = next.players.map((player) => {
      if (player.id !== playerId) return player;
      const badges = player.badges ?? [];
      return {
        ...player,
        badges: badges.includes(badge)
          ? badges.filter((current) => current !== badge)
          : OFFENSIVE_BADGE_ORDER.filter((current) => current === badge || badges.includes(current)),
      };
    });
    commit(next, draft, { preserveSimulation: false });
  }

  function toggleDefenderBadge(defenderId: number, badge: DefensiveBadge) {
    const next = clonePlaybook(draft);
    next.defenders = next.defenders.map((defender) => {
      if (defender.id !== defenderId) return defender;
      const badges = (defender.badges ?? []).filter((current): current is DefensiveBadge => DEFENSIVE_BADGE_ORDER.includes(current as DefensiveBadge));
      return {
        ...defender,
        badges: badges.includes(badge)
          ? badges.filter((current) => current !== badge)
          : DEFENSIVE_BADGE_ORDER.filter((current) => current === badge || badges.includes(current)),
      };
    });
    commit(next, draft, { preserveSimulation: false });
  }

  function adjustTeamRating(key: keyof PlayerSkillRatings, amount: -1 | 1) {
    if (!draft.players.length) return;
    const next = clonePlaybook(draft);
    next.players = next.players.map((player) => {
      const ratings = { threePoint: 3, midrange: 3, finishing: 3, ...player.ratings };
      return { ...player, ratings: { ...ratings, [key]: Math.max(1, Math.min(5, ratings[key] + amount)) } };
    });
    commit(next, draft, { preserveSimulation: false });
  }

  function startSimulation() {
    if (!draft.players.length) {
      setError("Add at least one offensive player before running a simulation.");
      return;
    }
    if (simulationPaused && simulationRunRef.current) {
      setSimulationPlaying(true);
      setError(null);
      focusBoard();
      return;
    }
    const run = createSimulationRun(draft, simulationSettingsRef.current, HOOP_POINT);
    simulationRunRef.current = run;
    setSimulationFrameState(getSimulationFrame(run));
    setSimulationElapsed(0);
    setSimulationPlaying(true);
    setError(null);
    focusBoard();
  }

  function applyAIDefense() {
    const next = clonePlaybook(draft);
    next.defenders_visible = true;
    next.defenders = placeDefendersGoalSide(next.players, next.defenders, HOOP_POINT);
    commit(next);
    setSelected(null);
    setError(null);
  }

  function addAuthoredArrow(arrow: PlaybookArrow) {
    const next = clonePlaybook(draft);
    next.arrows = [...next.arrows, arrow];
    commit(next);
    setSelected({ type: "arrow", id: arrow.id });
    setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
    setPickPopSelection({ screenerId: null, handlerId: null, screenPoint: null });
    setBackdoorCutterId(null);
    setTool("select");
  }

  function changeArrowSequence(arrowIdValue: string, requestedSequence: number) {
    if (!Number.isFinite(requestedSequence)) return;
    const next = clonePlaybook(draft);
    next.arrows = next.arrows.map((arrow) => arrow.id === arrowIdValue
      ? { ...arrow, sequence: Math.max(1, Math.min(30, Math.round(requestedSequence))) }
      : arrow);
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
    const marker: PlaybookMarker = { id, ...point, badges: [], ...(type === "player" ? { ratings: { threePoint: 3, midrange: 3, finishing: 3 } } : {}) };
    if (type === "player") next.players = [...next.players, marker];
    else next.defenders = [...next.defenders, marker];
    commit(next);
    setSelected({ type, id });
    if (type === "player") {
      setRatingPlayerId(id);
      setRatingsOpen(true);
    } else {
      setDefenderSkillsId(id);
      setDefenderSkillsOpen(true);
    }
    setTool("select");
  }

  function onBackgroundPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    const point = pointFromPointer(event, svgRef.current);
    if (!point) return;
    focusBoard();
    const nextSequence = Math.max(0, ...draft.arrows.map((arrow, index) => arrowSequence(arrow, index))) + 1;
    if (tool === "pick-pop") {
      const { screenerId, handlerId, screenPoint } = pickPopSelection;
      if (screenerId == null || handlerId == null) {
        setError("Select the screener and ball handler first.");
        return;
      }
      if (!screenPoint) {
        setPickPopSelection({ ...pickPopSelection, screenPoint: point });
        setError(null);
        return;
      }
      const screener = draft.players.find((player) => player.id === screenerId);
      if (!screener) {
        setError("The selected screener is no longer on the court.");
        return;
      }
      addAuthoredArrow({ id: arrowId(), kind: "pick-pop", start: { x: screener.x, y: screener.y }, end: screenPoint, exit_target: point, screener_id: screenerId, handler_id: handlerId, path: "straight", timing: 1.5, sequence: nextSequence });
      return;
    }
    if (tool === "off-ball-screen" || tool === "pin-down") {
      const { screenerId, cutterId, screenPoint } = offBallScreenSelection;
      if (screenerId == null || cutterId == null) {
        setError("Select a screener and cutter before placing the screen.");
        return;
      }
      const screener = draft.players.find((player) => player.id === screenerId);
      if (!screener) {
        setError("The selected screener is no longer on the court.");
        setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
        return;
      }
      if (tool === "pin-down" && !screenPoint) {
        setOffBallScreenSelection({ ...offBallScreenSelection, screenPoint: point });
        setError(null);
        return;
      }
      addAuthoredArrow({
        id: arrowId(),
        kind: tool,
        start: { x: screener.x, y: screener.y },
        end: screenPoint ?? point,
        ...(tool === "pin-down" ? { exit_target: point } : {}),
        screener_id: screenerId,
        cutter_id: cutterId,
        path: "straight",
        timing: 1.4,
        sequence: nextSequence,
      });
      return;
    }
    if (tool === "backdoor-cut") {
      if (backdoorCutterId == null) {
        setError("Select the cutter before placing the backdoor route.");
        return;
      }
      const cutter = draft.players.find((player) => player.id === backdoorCutterId);
      if (!cutter) {
        setError("The selected cutter is no longer on the court.");
        setBackdoorCutterId(null);
        return;
      }
      addAuthoredArrow({ id: arrowId(), kind: "backdoor-cut", start: { x: cutter.x, y: cutter.y }, end: point, actor_id: cutter.id, path: "straight", timing: 1.2, sequence: nextSequence });
      return;
    }
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
    const editingTimeline = drag.type === "arrow-start" || drag.type === "arrow-end" || drag.type === "arrow-exit" || drag.type === "arrow-control";
    if (editingTimeline && simulationActive) {
      resetSimulation();
    } else if (simulationRunRef.current && (simulationPaused || simulationPlaying)) {
      if (simulationPlaying) {
        setSimulationPlaying(false);
        setSimulationFrameState(getSimulationFrame(simulationRunRef.current));
      }
      if (drag.type === "ball") {
        setSimulationFrameState(editPausedSimulationMarker(simulationRunRef.current, "ball", "ball", point));
      } else if (drag.type === "player" || drag.type === "defender") {
        setSimulationFrameState(editPausedSimulationMarker(simulationRunRef.current, drag.type, drag.id, point));
      }
    }
    const next = clonePlaybook(drag.before);
    if (drag.type === "ball") next.ball = point;
    if (drag.type === "player") next.players = next.players.map((marker) => marker.id === drag.id ? { ...marker, ...point } : marker);
    if (drag.type === "defender") next.defenders = next.defenders.map((marker) => marker.id === drag.id ? { ...marker, ...point } : marker);
    if (drag.type === "arrow-start" || drag.type === "arrow-end") {
      next.arrows = next.arrows.map((arrow) => arrow.id === drag.id ? { ...arrow, [drag.type === "arrow-start" ? "start" : "end"]: point } : arrow);
    }
    if (drag.type === "arrow-exit") next.arrows = next.arrows.map((arrow) => arrow.id === drag.id ? { ...arrow, exit_target: point } : arrow);
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
          ...(kind === "screen" || kind === "pick-roll" ? {
            screener_id: nearestPlayerId(draft.players, drawStart),
            handler_id: draft.ball ? nearestPlayerId(draft.players, draft.ball, nearestPlayerId(draft.players, drawStart)) ?? undefined : undefined,
          } : {}),
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
    if (tool === "pick-pop") {
      if (selection.type !== "player") {
        setError("Choose offensive players for the screen and ball handler.");
        return;
      }
      const id = Number(selection.id);
      setError(null);
      if (pickPopSelection.screenerId == null) {
        setPickPopSelection({ screenerId: id, handlerId: null, screenPoint: null });
        setSelected(selection);
      } else if (pickPopSelection.handlerId == null) {
        if (pickPopSelection.screenerId === id) setError("Choose a different player as the ball handler.");
        else {
          setPickPopSelection({ ...pickPopSelection, handlerId: id });
          setSelected(selection);
        }
      } else {
        setError("Click the screen location, then the pop destination.");
      }
      return;
    }
    if (tool === "off-ball-screen" || tool === "pin-down") {
      if (selection.type !== "player") {
        setError("Choose offensive players for the screener and cutter.");
        return;
      }
      const id = Number(selection.id);
      setError(null);
      if (offBallScreenSelection.screenerId == null) {
        setOffBallScreenSelection({ screenerId: id, cutterId: null, screenPoint: null });
        setSelected(selection);
      } else if (offBallScreenSelection.cutterId == null) {
        if (offBallScreenSelection.screenerId === id) setError("Choose a different player as the cutter.");
        else {
          setOffBallScreenSelection({ ...offBallScreenSelection, cutterId: id });
          setSelected(selection);
        }
      } else {
        setError(tool === "pin-down" ? "Click the screen location, then the cutter destination." : "Click the screen location.");
      }
      return;
    }
    if (tool === "backdoor-cut") {
      if (selection.type !== "player") {
        setError("Choose an offensive player for the backdoor cut.");
        return;
      }
      setBackdoorCutterId(Number(selection.id));
      setSelected(selection);
      setError(null);
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
    if (selection.type === "player") {
      setRatingPlayerId(Number(selection.id));
      setRatingsOpen(true);
    } else if (selection.type === "defender") {
      setDefenderSkillsId(Number(selection.id));
      setDefenderSkillsOpen(true);
    }
    dragRef.current = { type: selection.type, id: selection.id, before: clonePlaybook(draft) };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function onArrowEndpointPointerDown(event: ReactPointerEvent<SVGElement>, arrow: PlaybookArrow, endpoint: "start" | "end" | "exit" | "control") {
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
    dragRef.current = { type: endpoint === "start" ? "arrow-start" : endpoint === "end" ? "arrow-end" : endpoint === "exit" ? "arrow-exit" : "arrow-control", id: arrow.id, before: clonePlaybook(draft) };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']") || event.nativeEvent.isComposing) return;
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
      setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
      setPickPopSelection({ screenerId: null, handlerId: null, screenPoint: null });
      setBackdoorCutterId(null);
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
    clone.querySelectorAll(".selection-handle, .drawing-preview, .adaptive-read-route").forEach((node) => node.remove());
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `.court-floor{fill:#151819}.court-line{fill:none;stroke:#d7d2c7;stroke-width:3}.court-dash{fill:none;stroke:#8f9692;stroke-width:2;stroke-dasharray:9 10}.movement-arrow,.screen-arrow,.off-ball-screen-arrow,.pick-roll-arrow,.pick-pop-arrow,.pin-down-arrow,.backdoor-cut-arrow,.screen-cutter-arrow,.pass-arrow{fill:none;stroke-width:3}.movement-arrow{stroke:#f3f1ec}.pass-arrow{stroke:#ee733f;stroke-dasharray:9 8}.screen-arrow{stroke:#73bff0;stroke-dasharray:3 7}.off-ball-screen-arrow,.pin-down-arrow{stroke:#b4a1e8;stroke-dasharray:5 5}.screen-cutter-arrow{stroke:#f3f1ec;stroke-dasharray:6 5;opacity:.82}.pick-roll-arrow{stroke:#ee733f;stroke-width:4}.pick-pop-arrow{stroke:#f3bd67;stroke-width:4}.backdoor-cut-arrow{stroke:#7fd2a1;stroke-dasharray:7 5;stroke-width:3.5}.arrow-sequence-badge{pointer-events:none}.arrow-sequence-badge circle{fill:#202426;stroke:#ee733f;stroke-width:2;vector-effect:non-scaling-stroke}.arrow-sequence-badge text{fill:#f3f1ec;font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace;text-anchor:middle;dominant-baseline:central}.offense-marker{fill:#ee733f;stroke:#fff2ea;stroke-width:2}.defense-marker{fill:none;stroke:#73bff0;stroke-width:3}.ball-marker{fill:#d96b38;stroke:#fff2ea;stroke-width:2}.marker-number{fill:#fff8f0;font:700 18px sans-serif;text-anchor:middle;dominant-baseline:central}.basket-mark{fill:none;stroke:#ee733f;stroke-width:4}#movement-arrow path{fill:#f3f1ec}#pass-arrow path{fill:#ee733f}`;
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
  const currentDefenseSchemeLabel = simulationFrame.activeDefenseScheme
    ? `${simulationFrame.defenseSchemeWasAutomatic ? "Auto · " : ""}${DEFENSE_SCHEME_LABELS[simulationFrame.activeDefenseScheme]}`
    : "No possession running";
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
          <button type="button" className={`preset-button ${draft.defenders_visible ? "is-active" : ""}`} onClick={() => {
            const next = clonePlaybook(draft);
            next.defenders_visible = !next.defenders_visible;
            if (next.defenders_visible && !next.defenders.length) {
              next.defenders = placeDefendersGoalSide(next.players, [], HOOP_POINT);
            }
            commit(next);
          }}>
            <UserRound size={17} /> <span>Defenders</span><i className={`toggle-dot ${draft.defenders_visible ? "is-on" : ""}`} />
          </button>
          <button type="button" className={`preset-button ${defenderSkillsOpen ? "is-active" : ""}`} aria-expanded={defenderSkillsOpen} aria-controls="defender-skills-panel" onClick={() => setDefenderSkillsOpen((open) => !open)}>
            <Shield size={17} /><span>Defender skills</span><i className={`toggle-dot ${defenderSkillsOpen ? "is-on" : ""}`} />
          </button>
          {defenderSkillsOpen ? <div id="defender-skills-panel" className="player-ratings-panel defender-skills-panel" role="group" aria-label="Defender skills">
            <div className="ratings-panel-heading ratings-player-heading"><strong>Defender</strong><span>Choose one</span></div>
            {draft.defenders.length ? <div className="ratings-player-list" role="group" aria-label="Select defender to edit">
              {draft.defenders.map((defender) => <button type="button" key={`defender-skill-${defender.id}`} className={selectedSkillsDefender?.id === defender.id ? "is-active" : ""} aria-pressed={selectedSkillsDefender?.id === defender.id} onClick={() => {
                setDefenderSkillsId(defender.id);
                setSelected({ type: "defender", id: defender.id });
              }}>Defender {defender.id}</button>)}
            </div> : <p className="ratings-empty">Turn on Defenders or use AI defense to add defenders first.</p>}
            {selectedSkillsDefender ? <>
              <div className="ratings-panel-heading defender-badge-heading"><strong>Defender {selectedSkillsDefender.id} badges</strong><span>{selectedSkillsDefender.badges?.filter((badge) => DEFENSIVE_BADGE_ORDER.includes(badge as DefensiveBadge)).length ?? 0} selected</span></div>
              <div className="player-badge-list" role="group" aria-label={`Defender ${selectedSkillsDefender.id} defensive badges`}>
                {DEFENSIVE_BADGE_ORDER.map((badge) => {
                  const assigned = selectedSkillsDefender.badges?.includes(badge) ?? false;
                  const details = DEFENSIVE_BADGES[badge];
                  return <button type="button" key={badge} className={`player-badge-option defender-badge-option ${assigned ? "is-selected" : ""}`} aria-label={`${details.label}, ${assigned ? "assigned" : "not assigned"} to Defender ${selectedSkillsDefender.id}`} aria-pressed={assigned} title={details.description} onClick={() => toggleDefenderBadge(selectedSkillsDefender.id, badge)}>
                    <span className="player-badge-copy"><strong>{details.label}</strong><small>{details.description}</small></span>
                    <span className="player-badge-state" aria-hidden="true">{assigned ? "On" : "Off"}</span>
                  </button>;
                })}
              </div>
              <small>Badges guide assignments and reactions in the next simulation run.</small>
            </> : null}
          </div> : null}
          <button type="button" className={`preset-button ${defenseSchemesOpen ? "is-active" : ""}`} aria-expanded={defenseSchemesOpen} aria-controls="defense-schemes-panel" onClick={() => setDefenseSchemesOpen((open) => !open)}>
            <ShieldCheck size={17} /><span>Defense schemes</span><i className={`toggle-dot ${simulationSettings.defenseScheme !== "auto" ? "is-on" : ""}`} />
          </button>
          {defenseSchemesOpen ? <div id="defense-schemes-panel" className="defense-schemes-panel" role="group" aria-label="Defensive scheme for the next possession">
            <label><span>Scheme</span><ArcSelect ariaLabel="Defensive scheme" className="arc-select--compact arc-select--full defense-scheme-select" value={simulationSettings.defenseScheme} options={DEFENSE_SCHEME_OPTIONS} onValueChange={(value) => changeSimulationSetting("defenseScheme", value as DefenseScheme)} /></label>
            <small>{simulationSettings.defenseScheme === "auto" ? "Auto draws an eligible scheme at random when a run starts." : `${DEFENSE_SCHEME_LABELS[simulationSettings.defenseScheme]} is set for the next run.`}</small>
            {simulationActive ? <small className="defense-scheme-active">Current: {currentDefenseSchemeLabel}</small> : null}
            {simulationActive && simulationFrame.defenseSchemeNotice ? <small className="defense-scheme-notice" role="status">{simulationFrame.defenseSchemeNotice}</small> : null}
          </div> : null}
          <button type="button" className={`preset-button ${autoActionsOpen ? "is-active" : ""}`} aria-expanded={autoActionsOpen} aria-controls="automatic-actions-panel" onClick={() => setAutoActionsOpen((open) => !open)}>
            <BrainCircuit size={17} /><span>Auto actions</span><i className={`toggle-dot ${Object.values(simulationSettings.automaticActions).every(Boolean) ? "is-on" : ""}`} />
          </button>
          {autoActionsOpen ? <div id="automatic-actions-panel" className="automatic-actions-panel" role="group" aria-label="Automatic offensive actions">
            <label><input type="checkbox" checked={simulationSettings.automaticActions.screen} onChange={(event) => changeAutomaticAction("screen", event.currentTarget.checked)} /><span>On-ball screens</span></label>
            <label><input type="checkbox" checked={simulationSettings.automaticActions.handoff} onChange={(event) => changeAutomaticAction("handoff", event.currentTarget.checked)} /><span>Handoffs</span></label>
            <label><input type="checkbox" checked={simulationSettings.automaticActions.pickRoll} onChange={(event) => changeAutomaticAction("pickRoll", event.currentTarget.checked)} /><span>Pick and rolls</span></label>
            <label><input type="checkbox" checked={simulationSettings.automaticActions.offBallScreen} onChange={(event) => changeAutomaticAction("offBallScreen", event.currentTarget.checked)} /><span>Off-ball screens</span></label>
            <small>Applied when the next simulation starts.</small>
          </div> : null}
          <button type="button" className={`preset-button ${ratingsOpen ? "is-active" : ""}`} aria-expanded={ratingsOpen} aria-controls="player-skills-panel" onClick={() => setRatingsOpen((open) => !open)}>
            <UsersRound size={17} /><span>Player skills</span><i className={`toggle-dot ${ratingsOpen ? "is-on" : ""}`} />
          </button>
          {ratingsOpen ? <div id="player-skills-panel" className="player-ratings-panel player-skills-panel" role="group" aria-label="Player skills">
            <div className="player-skills-tabs" role="tablist" aria-label="Player skill controls">
              <button type="button" id="player-ratings-tab" role="tab" aria-selected={playerSkillsTab === "ratings"} aria-controls="player-ratings-content" tabIndex={playerSkillsTab === "ratings" ? 0 : -1} className={playerSkillsTab === "ratings" ? "is-active" : ""} onClick={() => setPlayerSkillsTab("ratings")}>Ratings</button>
              <button type="button" id="player-badges-tab" role="tab" aria-selected={playerSkillsTab === "badges"} aria-controls="player-badges-content" tabIndex={playerSkillsTab === "badges" ? 0 : -1} className={playerSkillsTab === "badges" ? "is-active" : ""} onClick={() => setPlayerSkillsTab("badges")}>Badges</button>
            </div>
            <div className="ratings-panel-heading ratings-player-heading"><strong>Player</strong><span>Choose one</span></div>
            {draft.players.length ? <div className="ratings-player-list" role="group" aria-label="Select player to edit">
              {draft.players.map((player) => <button type="button" key={`rating-player-${player.id}`} className={selectedRatingsPlayer?.id === player.id ? "is-active" : ""} aria-pressed={selectedRatingsPlayer?.id === player.id} onClick={() => {
                setRatingPlayerId(player.id);
                setSelected({ type: "player", id: player.id });
              }}>Player {player.id}</button>)}
            </div> : <p className="ratings-empty">Add an offensive player to set ratings and badges.</p>}
            {playerSkillsTab === "ratings" ? <div id="player-ratings-content" role="tabpanel" aria-labelledby="player-ratings-tab" className="player-skill-tab-content">
              <div className="ratings-panel-heading"><strong>Team adjustment</strong><span>All players</span></div>
              {([
                ["threePoint", "3-point"],
                ["midrange", "Midrange"],
                ["finishing", "Finishing"],
              ] as Array<[keyof PlayerSkillRatings, string]>).map(([key, label]) => {
                const ratings = draft.players.map((player) => player.ratings?.[key] ?? 3);
                const average = ratings.length ? (ratings.reduce((total, rating) => total + rating, 0) / ratings.length).toFixed(1) : "—";
                return <div className="team-rating-row" key={`team-${key}`}>
                  <span>{label}</span>
                  <output aria-label={`Team average ${label} rating`}>{average}</output>
                  <button type="button" aria-label={`Decrease team ${label} rating by 1`} title={`Decrease every player's ${label} rating by 1`} disabled={!draft.players.length || ratings.every((rating) => rating <= 1)} onClick={() => adjustTeamRating(key, -1)}>−</button>
                  <button type="button" aria-label={`Increase team ${label} rating by 1`} title={`Increase every player's ${label} rating by 1`} disabled={!draft.players.length || ratings.every((rating) => rating >= 5)} onClick={() => adjustTeamRating(key, 1)}>+</button>
                </div>;
              })}
              {selectedRatingsPlayer ? ([
                ["threePoint", "3-point"],
                ["midrange", "Midrange"],
                ["finishing", "Finishing"],
              ] as Array<[keyof PlayerSkillRatings, string]>).map(([key, label]) => {
                const rating = selectedRatingsPlayer.ratings?.[key] ?? 3;
                return <div className="individual-rating-row" key={`player-${key}`}>
                  <span>{label}</span>
                  <div role="group" aria-label={`Player ${selectedRatingsPlayer.id} ${label} rating`} className="rating-scale">
                    {[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} aria-label={`Player ${selectedRatingsPlayer.id} ${label} rating ${value}`} aria-pressed={rating === value} className={rating === value ? "is-selected" : ""} onClick={() => changePlayerRating(selectedRatingsPlayer.id, key, value)}>{value}</button>)}
                  </div>
                </div>;
              }) : null}
              <small>Ratings range from 1 (low) to 5 (high). New players start at 3.</small>
            </div> : <div id="player-badges-content" role="tabpanel" aria-labelledby="player-badges-tab" className="player-skill-tab-content">
              {selectedRatingsPlayer ? <>
                <div className="ratings-panel-heading"><strong>Player {selectedRatingsPlayer.id} badges</strong><span>{selectedRatingsPlayer.badges?.length ?? 0} selected</span></div>
                <div className="player-badge-list" role="group" aria-label={`Player ${selectedRatingsPlayer.id} offensive badges`}>
                  {OFFENSIVE_BADGE_ORDER.map((badge) => {
                    const assigned = selectedRatingsPlayer.badges?.includes(badge) ?? false;
                    const details = OFFENSIVE_BADGES[badge];
                    return <button type="button" key={badge} className={`player-badge-option ${assigned ? "is-selected" : ""}`} aria-label={`${details.label}, ${assigned ? "assigned" : "not assigned"} to Player ${selectedRatingsPlayer.id}`} aria-pressed={assigned} title={details.description} onClick={() => togglePlayerBadge(selectedRatingsPlayer.id, badge)}>
                      <span className="player-badge-copy"><strong>{details.label}</strong><small>{details.description}</small></span>
                      <span className="player-badge-state" aria-hidden="true">{assigned ? "On" : "Off"}</span>
                    </button>;
                  })}
                </div>
                <small>Badges shape the next simulation run. Any combination can be assigned.</small>
              </> : <p className="ratings-empty">Add an offensive player to assign badges.</p>}
            </div>}
          </div> : null}
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
            <ToolButton active={tool === "pick-pop"} icon={<ArrowUpRight size={15} />} label="Pick & pop" title={TOOL_LABELS["pick-pop"]} onClick={() => chooseTool("pick-pop")} />
            <ToolButton active={tool === "off-ball-screen"} icon={<UsersRound size={15} />} label="Off-ball screen" title={TOOL_LABELS["off-ball-screen"]} onClick={() => chooseTool("off-ball-screen")} />
            <ToolButton active={tool === "pin-down"} icon={<UsersRound size={15} />} label="Pin-down" title={TOOL_LABELS["pin-down"]} onClick={() => chooseTool("pin-down")} />
            <ToolButton active={tool === "backdoor-cut"} icon={<ArrowUpRight size={15} />} label="Backdoor cut" title={TOOL_LABELS["backdoor-cut"]} onClick={() => chooseTool("backdoor-cut")} />
            <span className="toolbar-spacer" />
            <ToolButton icon={<BrainCircuit size={15} />} label="AI defense" title="Apply ARC defensive AI" onClick={applyAIDefense} />
            <ToolButton icon={simulationPlaying ? <Pause size={15} /> : <Play size={15} />} label={simulationPlaying ? "Pause" : simulationPaused ? "Resume" : "Play"} title={!draft.players.length ? "Add at least one offensive player before simulating" : simulationPlaying ? "Pause play simulation" : simulationPaused ? "Resume play simulation" : "Play simulation with defensive AI"} disabled={!draft.players.length && !simulationActive} onClick={() => {
              if (simulationPlaying) setSimulationPlaying(false);
              else startSimulation();
            }} />
            <ToolButton active={tool === "delete"} icon={<Eraser size={15} />} label="Delete" title={TOOL_LABELS.delete} onClick={() => chooseTool("delete")} />
            <ToolButton disabled={!history.length} icon={<Undo2 size={15} />} label="Undo" title="Undo last edit" onClick={undo} />
            <ToolButton disabled={!future.length} icon={<Redo2 size={15} />} label="Redo" title="Redo last edit" onClick={redo} />
          </div>
          <div className="playbook-simulation-bar" role="region" aria-label="Play simulation controls">
            <span className="simulation-ai-label"><ShieldCheck size={14} /> ARC defensive AI</span>
            {simulationActive && simulationFrame.activeDefenseScheme ? <span className="simulation-scheme-label" role="status"><ShieldCheck size={13} />{currentDefenseSchemeLabel}</span> : null}
            <span className="simulation-copy">{simulationPaused ? "Paused · edit the board, then resume" : simulationActive ? (simulationFrame.shotPhase === "setup" ? "Shot setup" : simulationFrame.shotPhase === "air" ? `Shot in air · ${Math.round(simulationFrame.shotProgress * 100)}%` : simulationFrame.shotPhase === "result" ? `${simulationFrame.shotResult === "made" ? "Made shot" : "Missed shot"} · ${simulationFrame.shotQuality}% quality` : simulationFrame.activeActionLabel ? `${simulationFrame.activeActionLabel} in progress` : simulationFrame.adaptiveReadLabel ? `Read: ${simulationFrame.adaptiveReadLabel}` : simulationFrame.activeSequence ? `Move ${simulationFrame.activeSequence} in progress` : "Defensive setup") : "Play to preview the sequence"}</span>
            {simulationActive && simulationFrame.adaptiveReadReason ? <span className="simulation-read-copy" role="status">{simulationFrame.adaptiveReadReason}</span> : null}
            {simulationActive && simulationFrame.defenseSchemeNotice ? <span className="simulation-scheme-notice" role="status">{simulationFrame.defenseSchemeNotice}</span> : null}
            <span className="simulation-quality" role="status">Off-ball quality <strong>{offBallQualityDisplay}</strong></span>
            <span className="simulation-quality" role="status">Defensive quality <strong>{simulationActive ? `${simulationFrame.defensiveQuality}%` : "—"}</strong></span>
            <button type="button" className={`simulation-settings-toggle ${settingsOpen ? "is-open" : ""}`} aria-expanded={settingsOpen} aria-controls="simulation-settings" onClick={() => setSettingsOpen((current) => !current)}><Settings2 size={14} />Settings</button>
            {selectedArrow ? <>
              <label className="sequence-editor"><span>Move order</span><input aria-label="Move order" type="number" min={1} max={Math.max(1, draft.arrows.length)} value={arrowFields.id === selectedArrow.id ? arrowFields.sequence : String(selectedArrowSequence ?? 1)} onChange={(event) => setArrowFields((current) => ({ ...current, id: selectedArrow.id, sequence: event.currentTarget.value }))} onBlur={() => { const value = Number(arrowFields.sequence); if (arrowFields.id === selectedArrow.id && Number.isFinite(value) && arrowFields.sequence.trim()) changeArrowSequence(selectedArrow.id, value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>Same number runs together</small></label>
              <div className="sequence-editor"><span>Path</span><ArcSelect ariaLabel="Arrow path" className="arc-select--compact playbook-path-select" value={selectedArrow.path ?? "straight"} options={[{ value: "straight", label: "Straight" }, { value: "curve", label: "Curved" }]} onValueChange={(value) => changeArrowPath(selectedArrow.id, value as "straight" | "curve")} /></div>
              <label className="sequence-editor"><span>Seconds</span><input aria-label="Action timing" type="number" min={0.5} max={4} step={0.1} value={arrowFields.id === selectedArrow.id ? arrowFields.timing : clampTiming(selectedArrow.timing ?? 1.2).toFixed(1)} onChange={(event) => setArrowFields((current) => ({ ...current, id: selectedArrow.id, timing: event.currentTarget.value }))} onBlur={() => { const value = Number(arrowFields.timing); if (arrowFields.id === selectedArrow.id && Number.isFinite(value) && arrowFields.timing.trim()) changeArrowTiming(selectedArrow.id, value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
            </> : null}
          </div>
          {settingsOpen ? <div id="simulation-settings" className="simulation-settings-panel" role="group" aria-label="Simulation settings">
            <div className="simulation-setting"><span>Offense off-ball</span><ArcSelect ariaLabel="Offense off-ball style" className="arc-select--compact playbook-offense-select" value={simulationSettings.offenseOffBall} options={[{ value: "read-react", label: "Read & react" }, { value: "cuts", label: "Structured cuts" }, { value: "spacing", label: "Spacing only" }, { value: "off", label: "Off" }]} onValueChange={(value) => changeSimulationSetting("offenseOffBall", value as SimulationSettings["offenseOffBall"])} /></div>
            <div className="simulation-setting simulation-defense-setting"><span>Coverage & emphasis</span><ArcSelect ariaLabel="Coverage and defensive emphasis" className="arc-select--compact playbook-defense-select" value={simulationSettings.defenseStrategy} options={[
              { value: "help", label: "Help & recover", description: "Send weak-side help to drives, then recover." },
              { value: "contain", label: "Contain & deny", description: "Contain the handler and stay close to each assignment." },
              { value: "switch", label: "Switch screens", description: "Exchange matchups when a screen or handoff starts." },
              { value: "fight-over", label: "Fight over top", description: "Keep matchups and route the screened defender over the screen." },
              { value: "go-under", label: "Go under", description: "Keep matchups and route the screened defender below the screen." },
              { value: "drop", label: "Drop coverage", description: "The screener's defender protects the lane while the handler is covered." },
              { value: "hedge", label: "Hedge & recover", description: "Show briefly at the screen, then return to the matchup." },
              { value: "trap-rotate", label: "Trap & rotate", description: "Bring extra pressure and rotate help behind the screen or drive." },
              { value: "deny-lanes", label: "Deny passing lanes", description: "Shade off-ball defenders toward passing lanes and close on receivers." },
              { value: "protect-paint", label: "Protect paint", description: "Keep help defenders closer to the basket and drive lane." },
              { value: "off", label: "Hold positions", description: "Keep defenders where they are drawn." },
            ]} onValueChange={(value) => changeSimulationSetting("defenseStrategy", value as SimulationSettings["defenseStrategy"])} /></div>
            <label className="simulation-setting simulation-setting-range"><span>Off-ball intensity <output>{simulationSettings.offBallIntensity}%</output></span><input aria-label="Off-ball intensity" type="range" min={0} max={100} step={1} value={simulationSettings.offBallIntensity} onChange={(event) => changeSimulationSetting("offBallIntensity", Number(event.currentTarget.value))} /></label>
            <span className="simulation-settings-note">The scheme sets the defensive shape. Coverage and emphasis change screen, help, pressure, and recovery behavior.</span>
          </div> : null}
          <div className="court-frame">
            <svg ref={svgRef} className="court-svg" viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Editable NBA half-court play diagram" onPointerDown={onBackgroundPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
              <defs>
                <pattern id="court-boards" width="80" height="80" patternUnits="userSpaceOnUse"><rect width="80" height="80" fill="var(--surface)" /><path d="M0 0h80M0 40h80" stroke="rgba(255,255,255,.022)" strokeWidth="1" /><path d="M40 0v80" stroke="rgba(255,255,255,.014)" strokeWidth="1" /></pattern>
                <marker id="movement-arrow" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto"><path d="M0 0 10 5 0 10z" fill="var(--text)" /></marker>
                <marker id="pass-arrow" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto"><path d="M0 0 10 5 0 10z" fill="var(--orange)" /></marker>
              </defs>
              <rect x="0" y="0" width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} rx="8" className="court-floor" fill="url(#court-boards)" />
              <CourtMarkings />
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
                  <title>Move {sequence} · {actionLabel(arrow.kind)}{arrow.screener_id != null ? ` · Player ${arrow.screener_id} screens for player ${arrow.handler_id ?? arrow.cutter_id ?? "the ball handler"}` : ""} · {clampTiming(arrow.timing ?? 1.2).toFixed(1)} seconds</title>
                  {screenCutterPath(arrow, draft.players) ? <path d={screenCutterPath(arrow, draft.players) as string} className="screen-cutter-arrow" markerEnd="url(#movement-arrow)" /> : null}
                  <path d={actionPath(arrow)} className={actionClass(arrow.kind)} markerEnd={`url(#${actionMarker(arrow.kind)})`} />
                  <g className="arrow-sequence-badge"><circle cx={badge.x} cy={badge.y} r="12" /><text x={badge.x} y={badge.y + 1}>{sequence}</text></g>
                  {active ? <><circle cx={start.x} cy={start.y} r="8" className="selection-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "start")} /><circle cx={end.x} cy={end.y} r="8" className="selection-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "end")} />{arrow.exit_target ? <circle cx={markerPoint(arrow.exit_target).x} cy={markerPoint(arrow.exit_target).y} r="8" className="selection-handle exit-target-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "exit")} /> : null}{arrow.path === "curve" ? <circle cx={control.x} cy={control.y} r="7" className="curve-handle" onPointerDown={(event) => onArrowEndpointPointerDown(event, arrow, "control")} /> : null}</> : null}
                </g>;
              })}
              {simulationActive && simulationFrame.adaptiveReadRoute ? (() => {
                const start = markerPoint(simulationFrame.adaptiveReadRoute.start);
                const end = markerPoint(simulationFrame.adaptiveReadRoute.end);
                const marker = simulationFrame.adaptiveReadRoute.kind === "pass" ? "pass-arrow" : "movement-arrow";
                return <path className={`adaptive-read-route adaptive-read-${simulationFrame.adaptiveReadRoute.kind}`} d={`M${start.x} ${start.y} L${end.x} ${end.y}`} markerEnd={`url(#${marker})`}><title>{simulationFrame.adaptiveReadLabel}: {simulationFrame.adaptiveReadReason}</title></path>;
              })() : null}
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
                const role = offBallScreenSelection.screenerId === marker.id ? "is-screen-screener" : offBallScreenSelection.cutterId === marker.id ? "is-screen-cutter" : pickPopSelection.screenerId === marker.id ? "is-screen-screener" : pickPopSelection.handlerId === marker.id ? "is-screen-cutter" : backdoorCutterId === marker.id ? "is-screen-cutter" : "";
                return <g key={`player-${marker.id}`} className={`offense-marker-group ${active ? "is-selected" : ""} ${role}`} onPointerDown={(event) => onMarkerPointerDown(event, { type: "player", id: marker.id })}>
                  <circle cx={point.x} cy={point.y} r="25" className="offense-marker" /><text x={point.x} y={point.y + 1} className="marker-number">{marker.id}</text>
                </g>;
              })}
              {(simulationActive ? simulationFrame.ball : draft.ball) ? <g className={`ball-marker-group ${selected?.type === "ball" ? "is-selected" : ""}`} style={{ pointerEvents: ["pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"].includes(tool) ? "none" : undefined }} onPointerDown={(event) => onMarkerPointerDown(event, { type: "ball", id: "ball" })}>
                <circle cx={markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).x} cy={markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).y} r="14" className="ball-marker" /><path d={`M${markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).x - 11} ${markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).y}h22M${markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).x} ${markerPoint((simulationActive ? simulationFrame.ball : draft.ball) as CourtPoint).y - 11}v22`} className="ball-seam" />
              </g> : null}
            </svg>
            <div className="court-hint">{tool === "select" ? "Select a marker to move it" : tool === "delete" ? "Select an object to delete" : tool === "player" ? "Click the court to place a player" : tool === "ball" ? "Click the court to place the ball" : tool === "pick-pop" ? pickPopSelection.screenerId == null ? "Select the screener" : pickPopSelection.handlerId == null ? "Select the ball handler" : pickPopSelection.screenPoint == null ? "Click the screen location" : "Click the pop destination" : tool === "pin-down" ? offBallScreenSelection.screenerId == null ? "Select the screener" : offBallScreenSelection.cutterId == null ? "Select the cutter" : offBallScreenSelection.screenPoint == null ? "Click the screen location" : "Click the cutter destination" : tool === "off-ball-screen" ? offBallScreenSelection.screenerId == null ? "Select the screener" : offBallScreenSelection.cutterId == null ? "Select the cutter" : "Click a spot to set the screen" : tool === "backdoor-cut" ? backdoorCutterId == null ? "Select the cutter" : "Click the basket route destination" : "Drag across the court to draw"}</div>
          </div>
          <div className="playbook-statusbar"><span><Hand size={14} /> {selected ? `${selected.type === "ball" ? "Ball" : selected.type === "arrow" ? `Move ${selectedArrowSequence ?? ""}` : `${selected.type === "defender" ? "Defender" : "Player"} ${selected.id}`} selected` : "Nothing selected"}</span><span>Arrows stay draggable · Arrow keys nudge · Shift for larger steps · Cmd/Ctrl Z to undo</span></div>
        </main>
        <aside className={`saved-plays-panel ${savedOpen ? "is-open" : ""}`} aria-label="Saved plays">
          <div className="saved-plays-heading"><div><span className="section-kicker">Local library</span><h2>Saved plays</h2></div><button type="button" className="icon-button" aria-label="Close saved plays" onClick={() => setSavedOpen(false)}><X size={17} /></button></div>
          {saved.length ? <div className="saved-play-list">{saved.map((play) => <SavedPlayCard key={play.id} play={play} active={draft.id === play.id} deletePending={deleteId === play.id} onOpen={() => requestLoad(clonePlaybook(play))} onDuplicate={() => duplicate(play)} onDelete={() => { if (window.confirm(`Delete ${play.name}?`)) void confirmDelete(play.id); }} />)}</div> : <div className="saved-empty"><FolderOpen size={20} /><p>Your saved diagrams will appear here.</p><button type="button" onClick={() => void saveDraft()}>Save this play</button></div>}
        </aside>
      </div>
      {starterOpen ? <div className="playbook-modal-backdrop" role="presentation" onMouseDown={() => setStarterOpen(false)}><section className="playbook-modal starter-modal" role="dialog" aria-modal="true" aria-labelledby="starter-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><span className="section-kicker">Start from a diagram</span><h2 id="starter-title">Starter plays</h2></div><button type="button" className="icon-button" onClick={() => setStarterOpen(false)} aria-label="Close starter plays"><X size={17} /></button></div>
        <label className="starter-search"><Search size={15} /><input type="search" aria-label="Search starter plays" placeholder="Search sets and actions" value={starterSearch} onChange={(event) => setStarterSearch(event.currentTarget.value)} /></label>
        <div className="starter-categories" role="group" aria-label="Filter starter plays by category">{starterCategories.map((category) => <button type="button" key={category} className={starterCategory === category ? "is-active" : ""} aria-pressed={starterCategory === category} onClick={() => setStarterCategory(category)}>{category}</button>)}</div>
        <div className="starter-grid">{filteredStarterPlays.map((play) => { const details = STARTER_PLAY_DETAILS[play.name]; return <button type="button" className="starter-card" key={play.name} onClick={() => { requestLoad(clonePlaybook(play)); setStarterOpen(false); }}><MiniCourt play={play} /><span className="starter-card-copy"><span className="starter-category-label">{details?.category}</span><strong>{play.name}</strong><span>{details?.description ?? "Edit this diagram"}</span></span></button>; })}{filteredStarterPlays.length === 0 ? <p className="starter-empty">No starter plays match that search.</p> : null}</div>
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
  return <svg className="mini-court" viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} aria-hidden="true">
    <rect x="0" y="0" width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} rx="5" className="mini-floor" />
    <CourtMarkings mini />
    {play.arrows.map((arrow, index) => {
      const badge = markerPoint(actionPointAt(arrow, 0.5));
      const sequence = arrowSequence(arrow, index);
      return <g key={arrow.id}>
        {screenCutterPath(arrow, play.players) ? <path d={screenCutterPath(arrow, play.players) as string} className="mini-screen-cutter" /> : null}
        <path d={actionPath(arrow)} className={arrow.kind === "pass" || arrow.kind === "handoff" ? "mini-pass" : arrow.kind === "screen" || arrow.kind === "off-ball-screen" || arrow.kind === "pin-down" ? "mini-screen" : arrow.kind === "pick-roll" || arrow.kind === "pick-pop" ? "mini-pick-roll" : "mini-move"} />
        <circle cx={badge.x} cy={badge.y} r="22" className="mini-sequence-badge" />
        <text x={badge.x} y={badge.y + 1} className="mini-sequence-number">{sequence}</text>
      </g>;
    })}
    {play.defenders_visible ? play.defenders.map((marker) => {
      const point = markerPoint(marker);
      return <path key={`d-${marker.id}`} d={`M${point.x - 7} ${point.y - 7}l14 14M${point.x + 7} ${point.y - 7}l-14 14`} className="mini-defense" />;
    }) : null}
    {play.players.map((marker) => {
      const point = markerPoint(marker);
      return <circle key={`p-${marker.id}`} cx={point.x} cy={point.y} r="16" className="mini-player" />;
    })}
    {play.ball ? <circle cx={markerPoint(play.ball).x} cy={markerPoint(play.ball).y} r="9" className="mini-ball" /> : null}
  </svg>;
}
