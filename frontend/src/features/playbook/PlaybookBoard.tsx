import { validatePlaybookDocument } from "./documentValidation.ts";
import { compareSavedPlaybooks } from "./playbookOrder";
import { CreationAttemptError } from "./creationAttempt.ts";
import { ArrowVisibilityControl, useArrowVisibility } from "./ArrowVisibilityControl";
import { routeVisible } from "./arrowVisibility";
import { CourtRoutes } from "./CourtRoutes";
import { authoredCourtRoutes } from "./simulation";
import { TimingMixerPanel } from "./TimingMixerPanel";
import { hasTimingPlan, moveTimingGroup, projectPointToRoute, resizeActionMinimum, sampleAuthoredCourtRoute, shiftConnectedTiming, snapTimingMs } from "./timingMixer.ts";
import type { PlaybookTimingWait } from "./types";
import { PocketActionsPanel, type PocketPlacementRequest } from "./PocketActionsPanel.tsx";
import { buildPocketInsertion } from "./pocketActions.ts";
import { ReadCoachAuthorPanel, ReadCoachPracticeView, readCoachSnapshotFrame } from "./ReadCoachViews.tsx";
import { RoleRehearsalView } from "./RoleRehearsalView.tsx";
import { PlayFlipbookView } from "./PlayFlipbookView.tsx";
import { authoredRoleCueTemplates } from "./roleRehearsal.ts";
import { checkPlaybookJsonText } from "./jsonIntake.ts";
import { SpacingGateLayer, spacingGateStatusSymbol, spacingGateStatusText, type SpacingGateDragKind } from "./SpacingGateLayer.tsx";
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BrainCircuit,
  Check,
  Circle,
  CircleHelp,
  Copy,
  CornerDownRight,
  Download,
  Eraser,
  FolderOpen,
  Hand,
  Images,
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
  Square,
  Target,
  Trash2,
  Undo2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { createPlaybook, deletePlaybook, fetchPlaybooks, subscribePlaybooks, updatePlaybook } from "./api";
import { createPlaybookDraftSession, playbookContentKey } from "./playbookDraftSession";
import { createFrameBatch } from "./frameBatch";
import { editPlaybookPoint } from "./editPlaybookPoint";
import { exportPlaybookPng } from "./exportPlaybookPng";
import { clamp, markerPoint, arrowSequence, lerpPoint, defaultArrowControl, arrowControl, actionPointAt, actionPath, screenCutterPath } from "./playbookPaths";
import { prepareMiniCourt } from "./miniCourtGeometry";
import { applyEditedPath, branchActionStatus, createBranchFromAction, flattenPlaybookPath, MAX_PLAYBOOK_BRANCHES, orderedActions as orderBranchActions, pocketInsertionBranchTarget, resolvePlaybookPath } from "./playbookBranches.ts";
import { ArcSelect } from "../../components/ArcSelect";
import { OFFENSIVE_BADGE_ORDER, OFFENSIVE_BADGES } from "./badges";
import { DEFENSIVE_BADGE_ORDER, DEFENSIVE_BADGES } from "./defensiveBadges";
import { CourtMarkings } from "./CourtMarkings";
import { EMPTY_COURT, READY_SETUP, STARTER_PLAY_DETAILS, STARTER_PLAYS } from "./data";
import type { ArrowKind, AutomaticActionSettings, CourtPoint, DefenseScheme, DefensiveBadge, OffensiveBadge, PlayerSkillRatings, PlaybookArrow, PlaybookBranch, PlaybookDocument, PlaybookDraft, PlaybookMarker, PlaybookTool, PlayFlipbookStory, ReadCoachCheckpoint, RoleCuePhase, SimulationSettings, SpacingGate, SpacingGateEvent, SpacingGateResult } from "./types";
import { clonePlaybook, DEFAULT_SIMULATION_SETTINGS, pointDistance } from "./types";
import { COURT_VIEWBOX, clientPointToCourt, courtPointToSvg, courtSvgToPoint, NBA_COURT_GEOMETRY } from "./courtGeometry";
import {
  bindAuthoredActions,
  authoredStateBeforeSequence,
  pausedDraftIsCompatible,
  placeDefendersGoalSide,
  SIMULATION_SHOT_MS,
  DEFENSE_SCHEME_DESCRIPTIONS,
  DEFENSE_SCHEME_LABELS,
  simulationTimelineDuration,
} from "./simulation";
import type { SimulationFrame } from "./simulation";
import { createPlaybookSimulationClient, type PlaybookSimulationClient } from "./playbookSimulationClient";
import type { SimulationCapture, SimulationView } from "./playbookSimulationProtocol";

type Selection = { type: "player" | "defender" | "ball" | "arrow"; id: number | string } | null;
type PointerSample = { clientX: number; clientY: number; pointerId: number };
type PointerGesture = PointerSample & { moved: boolean };
type DragState = PointerGesture & { type: "player" | "defender" | "ball" | "arrow-start" | "arrow-end" | "arrow-exit" | "arrow-control"; id: number | string; before: PlaybookDraft; historyBefore: PlaybookDraft; historyBranchId: string | null };
type SpacingGateDrag = PointerGesture & { gateId: string; kind: SpacingGateDragKind; before: PlaybookDraft; branchId: string | null; start: CourtPoint; original: SpacingGate };
type DraftHistoryEntry = { draft: PlaybookDraft; branchId: string | null };
function pointerGesture(event: PointerSample): PointerGesture {
  return { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, moved: false };
}
const TOOL_LABELS: Record<PlaybookTool, string> = {
  select: "Select / move",
  player: "Add offensive player",
  ball: "Add ball",
  movement: "Draw movement arrow",
  pass: "Draw pass arrow",
  screen: "Add screen action",
  "slip-screen": "Add a slip screen that rolls straight to the basket",
  handoff: "Add dribble handoff action",
  "pick-roll": "Add pick and roll action",
  "pick-pop": "Add pick and pop action",
  "off-ball-screen": "Add manual off-ball screen",
  "pin-down": "Add pin-down screen",
  "backdoor-cut": "Add backdoor cut",
  "spacing-gate": "Place a spacing gate area",
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

function pointFromPointer(event: Pick<PointerSample, "clientX" | "clientY">, svg: SVGSVGElement | null): CourtPoint | null {
  if (!svg) return null;
  const transform = svg.getScreenCTM();
  if (!transform) return null;
  const point = clientPointToCourt(event.clientX, event.clientY, transform);
  return point ? { x: clamp(point.x), y: clamp(point.y) } : null;
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
  return editPlaybookPoint(draft, { type: selection.type === "arrow" ? "arrow-end" : selection.type, id: selection.id }, point);
}

function clampTiming(value: number) {
  return Math.max(0.5, Math.min(4, Number.isFinite(value) ? value : 1.2));
}

function clampSpacingGate(gate: SpacingGate): SpacingGate {
  const next = structuredClone(gate);
  if (next.area.shape === "circle") {
    const maxRadius = 23.5;
    next.area.radiusFeet = Math.max(0.5, Math.min(maxRadius, next.area.radiusFeet));
    const r = next.area.radiusFeet;
    next.area.center.x = clamp(next.area.center.x, r * 2, 100 - r * 2);
    next.area.center.y = clamp(next.area.center.y, r / 0.47, 100 - r / 0.47);
  } else {
    next.area.widthFeet = Math.max(1, Math.min(50, next.area.widthFeet));
    next.area.heightFeet = Math.max(1, Math.min(47, next.area.heightFeet));
    next.area.center.x = clamp(next.area.center.x, next.area.widthFeet, 100 - next.area.widthFeet);
    next.area.center.y = clamp(next.area.center.y, next.area.heightFeet / 0.94, 100 - next.area.heightFeet / 0.94);
  }
  return next;
}

function spacingGateEventOptions(action?: PlaybookArrow): Array<{ value: SpacingGateEvent; label: string }> {
  const options: Array<{ value: SpacingGateEvent; label: string }> = [{ value: "start", label: "Action starts" }, { value: "complete", label: "Action completes" }];
  if (!action) return options;
  if (action.kind === "pass" || action.kind === "handoff") options.push({ value: "catch", label: "Confirmed catch" });
  if (["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"].includes(action.kind)) options.push({ value: "screen-set", label: "Screen is set" });
  if (["screen", "slip-screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "handoff"].includes(action.kind)) options.push({ value: "screen-use", label: "Screen is used" });
  options.push({ value: "route-point", label: "Player reaches a route point" });
  return options;
}

function spacingGateOutcomeTime(result: SpacingGateResult) {
  return result.firstViolationAtMs ?? result.checkedAtMs ?? result.triggerAtMs ?? 0;
}

function spacingGateTimeDescription(gate: SpacingGate) {
  const event = gate.trigger.event === "start" ? "action start" : gate.trigger.event === "complete" ? "action completion"
    : gate.trigger.event === "catch" ? "confirmed catch" : gate.trigger.event === "screen-set" ? "screen set"
      : gate.trigger.event === "screen-use" ? "screen use" : "route point";
  return `${gate.beforeSeconds || gate.afterSeconds ? `${gate.beforeSeconds.toFixed(1)}s before through ${gate.afterSeconds.toFixed(1)}s after ` : "At "}${event}`;
}

function timingIdentity(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

function removeSelection(draft: PlaybookDraft, selection: Selection): PlaybookDraft {
  if (!selection) return draft;
  const next = clonePlaybook(draft);
  if (selection.type === "player") {
    next.players = next.players.filter((marker) => marker.id !== selection.id);
    const withoutPlayer = (arrows: PlaybookArrow[]) => arrows.filter((arrow) => arrow.screener_id !== selection.id && arrow.cutter_id !== selection.id && arrow.handler_id !== selection.id && arrow.actor_id !== selection.id && arrow.recipient_id !== selection.id);
    next.arrows = withoutPlayer(next.arrows);
    next.branches = next.branches?.map((branch) => ({ ...branch, continuation: withoutPlayer(branch.continuation) }));
  }
  if (selection.type === "defender") next.defenders = next.defenders.filter((marker) => marker.id !== selection.id);
  if (selection.type === "ball") next.ball = null;
  if (selection.type === "arrow") next.arrows = next.arrows.filter((arrow) => arrow.id !== selection.id);
  return next;
}

function timingConnectionEditError(previous: PlaybookDraft, next: PlaybookDraft) {
  const paths = [null, ...(next.branches ?? []).map((branch) => branch.id)];
  const signature = (arrow: PlaybookArrow | undefined) => arrow ? JSON.stringify({
    id: arrow.id, kind: arrow.kind, sequence: arrow.sequence ?? 1, path: arrow.path ?? "straight",
    start: arrow.start, end: arrow.end, control: arrow.control ?? null, exit_target: arrow.exit_target ?? null,
    actor_id: arrow.actor_id ?? null, recipient_id: arrow.recipient_id ?? null,
    screener_id: arrow.screener_id ?? null, handler_id: arrow.handler_id ?? null, cutter_id: arrow.cutter_id ?? null,
  }) : null;
  for (const branchId of paths) {
    const before = resolvePlaybookPath(previous, branchId).play.arrows;
    const after = resolvePlaybookPath(next, branchId).play.arrows;
    const oldById = new Map(before.map((arrow) => [arrow.id, arrow]));
    const newById = new Map(after.map((arrow) => [arrow.id, arrow]));
    for (const dependent of after) for (const wait of dependent.timingPlan?.waits ?? []) {
      const oldSource = oldById.get(wait.actionId), newSource = newById.get(wait.actionId);
      if (!oldSource) continue;
      if (!newSource || signature(oldSource) !== signature(newSource)) {
        const message = `Move ${oldSource.sequence ?? "?"} is connected to a Wait until event. Remove or retarget that wait before changing or deleting this action`;
        return message;
      }
    }
  }
  return null;
}

function spacingGateEditError(previous: PlaybookDraft, next: PlaybookDraft) {
  const nextById = new Map((next.spacingGates?.gates ?? []).map((gate) => [gate.id, gate]));
  const findAction = (play: PlaybookDraft, gate: SpacingGate) => gate.scope === "shared"
    ? play.arrows.find((arrow) => arrow.id === gate.trigger.actionId)
    : play.branches?.find((branch) => branch.id === gate.branchId)?.continuation.find((arrow) => arrow.id === gate.trigger.actionId);
  for (const before of previous.spacingGates?.gates ?? []) {
    const after = nextById.get(before.id);
    if (!after) continue; // Explicit gate deletion accompanies the destructive edit
    if (after.playerId !== before.playerId || JSON.stringify(after.trigger) !== JSON.stringify(before.trigger)) continue; // Explicit reassignment or retargeting
    if (!next.players.some((player) => player.id === before.playerId)) return `Spacing gate ${before.id} is assigned to Player ${before.playerId}. Retarget or remove that gate before removing the player`;
    const oldAction = findAction(previous, before), newAction = findAction(next, after);
    if (!newAction) return `Spacing gate ${before.id} points to an action that no longer exists. Retarget or remove that gate first`;
    if (oldAction && (oldAction.kind !== newAction.kind || oldAction.actor_id !== newAction.actor_id || oldAction.recipient_id !== newAction.recipient_id
      || oldAction.screener_id !== newAction.screener_id || oldAction.handler_id !== newAction.handler_id || oldAction.cutter_id !== newAction.cutter_id)) {
      return `Spacing gate ${before.id} depends on this action’s participants or type. Retarget or remove that gate before changing the action`;
    }
    if (before.trigger.event === "route-point" && oldAction && JSON.stringify({ start: oldAction.start, end: oldAction.end, control: oldAction.control, exit_target: oldAction.exit_target, path: oldAction.path })
      !== JSON.stringify({ start: newAction.start, end: newAction.end, control: newAction.control, exit_target: newAction.exit_target, path: newAction.path })) {
      return `Spacing gate ${before.id} is pinned to this route. Choose a new route point or remove that gate before editing the route`;
    }
  }
  return null;
}

function isSameDraft(a: PlaybookDraft, b: PlaybookDraft) {
  return JSON.stringify(a) === JSON.stringify(b);
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
  next.branches = next.branches?.map((branch) => ({ ...branch, continuation: branch.continuation.map((arrow, index) => ({
    ...arrow, sequence: arrowSequence(arrow, index), path: arrow.path === "curve" ? "curve" : "straight",
    timing: clampTiming(arrow.timing ?? 1.2), control: arrow.control ?? defaultArrowControl(arrow.start, arrow.end),
  })) }));
  return next;
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





function nearestPlayerId(players: PlaybookMarker[], point: CourtPoint, excludeId?: number) {
  return players.filter((player) => player.id !== excludeId)
    .sort((left, right) => pointDistance(left, point) - pointDistance(right, point) || left.id - right.id)[0]?.id ?? null;
}

function actionLabel(kind: ArrowKind) {
  if (kind === "pass") return "Pass";
  if (kind === "screen") return "Screen";
  if (kind === "slip-screen") return "Slip screen";
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
  if (kind === "slip-screen") return "slip-screen-arrow";
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

export function PlaybookBoard({ onTestInCounterLab, onDraftChange, requestedPlay, active = true, view = "edit", rolePlayerId = null, onViewChange }: {
  onTestInCounterLab?: (play: PlaybookDraft) => void;
  onDraftChange?: (play: PlaybookDraft) => void;
  requestedPlay?: { requestId: string; play: PlaybookDraft } | null;
  active?: boolean;
  view?: "edit" | "practice" | "role" | "flipbook";
  rolePlayerId?: number | null;
  onViewChange?: (view: "edit" | "practice" | "role" | "flipbook", playerId?: number | null) => void;
}) {
  const arrowVisibility = useArrowVisibility();
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const spacingGateDragRef = useRef<SpacingGateDrag | null>(null);
  const drawingRef = useRef<PointerGesture & { start: CourtPoint; end: CourtPoint } | null>(null);
  const applyPointerRef = useRef<(sample: PointerSample) => void>(() => {});
  const [pointerMoves] = useState(() => createFrameBatch<PointerSample>(
    (sample) => applyPointerRef.current(sample),
    (callback) => window.requestAnimationFrame(callback),
    (id) => window.cancelAnimationFrame(id),
  ));
  const [draftSession] = useState(() => createPlaybookDraftSession(clonePlaybook(READY_SETUP), (play) => playbookContentKey(normalizeDraft(play))));
  const [draft, setDraftState] = useState<PlaybookDraft>(() => draftSession.current);
  const [history, setHistory] = useState<DraftHistoryEntry[]>([]);
  const [future, setFuture] = useState<DraftHistoryEntry[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [pocketSelectionMode, setPocketSelectionMode] = useState(false);
  const [pocketSelectedIds, setPocketSelectedIds] = useState<string[]>([]);
  const [pocketPreviewArrows, setPocketPreviewArrows] = useState<PlaybookArrow[]>([]);
  const [pocketPreviewBallHandlerId, setPocketPreviewBallHandlerId] = useState<number | null>(null);
  const [pocketPreviewPlayerIds, setPocketPreviewPlayerIds] = useState<number[]>([]);
  const [renamingBranchId, setRenamingBranchId] = useState<string | null>(null);
  const [branchLabelValue, setBranchLabelValue] = useState("");
  const [compareMain, setCompareMain] = useState(false);
  const [timingOpen, setTimingOpen] = useState(false);
  const [timingPreviewActionId, setTimingPreviewActionId] = useState<string | null>(null);
  const [routePointPick, setRoutePointPick] = useState<{ actionId: string; sourceId: string; playerId: number; routePhase: "main" | "approach" | "use" | "release" } | null>(null);
  const [spacingGateRoutePick, setSpacingGateRoutePick] = useState<string | null>(null);
  const [selectedSpacingGateId, setSelectedSpacingGateId] = useState<string | null>(null);
  const [spacingGateListOpen, setSpacingGateListOpen] = useState(false);
  const [showSpacingGates, setShowSpacingGates] = useState(true);
  const branchLabelInput = useRef<HTMLInputElement>(null);
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
  const [replacement, setReplacementState] = useState<PlaybookDraft | null>(null);
  const replacementRef = useRef<PlaybookDraft | null>(null);
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
  const simulationClientRef = useRef<PlaybookSimulationClient | null>(null);
  const [simulationView, setSimulationView] = useState<SimulationView | null>(null);
  const [readCoachCapture, setReadCoachCapture] = useState<SimulationCapture | null>(null);
  const [readCoachEditing, setReadCoachEditing] = useState<ReadCoachCheckpoint | null>(null);
  const [flipbookCapture, setFlipbookCapture] = useState<SimulationCapture | null>(null);
  const flipbookNavigationPendingRef = useRef(false);
  const [flipbookHistoryRevision, setFlipbookHistoryRevision] = useState(0);
  const previewClientRef = useRef<PlaybookSimulationClient | null>(null);
  const readCoachPreviewFrameRef = useRef<number | null>(null);
  const previewCancelRef = useRef<(() => void) | null>(null);
  const lastSimulationViewRef = useRef<SimulationView | null>(null);
  const simulationDrawingRef = useRef<PlaybookDraft | null>(null);
  applyPointerRef.current = applyPointerPosition;

  const interruptPointerRef = useRef(() => {});
  interruptPointerRef.current = interruptPointerInteraction;
  useEffect(() => {
    const interrupt = () => interruptPointerRef.current();
    const onVisibilityChange = () => { if (document.hidden) interrupt(); };
    window.addEventListener("blur", interrupt);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", interrupt);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      pointerMoves.cancel();
      const interaction = drawingRef.current ?? dragRef.current ?? spacingGateDragRef.current;
      drawingRef.current = null;
      dragRef.current = null;
      spacingGateDragRef.current = null;
      if (interaction && svgRef.current?.hasPointerCapture(interaction.pointerId)) svgRef.current.releasePointerCapture(interaction.pointerId);
    };
  }, [pointerMoves]);
  useEffect(() => { if (!active) interruptPointerRef.current(); }, [active]);

  function setDraft(next: PlaybookDraft) {
    setDraftState(draftSession.edit(canonicalizeActiveDraft(next)));
    setDirty(draftSession.dirty);
  }

  function setReplacement(next: PlaybookDraft | null) {
    replacementRef.current = next;
    setReplacementState(next);
  }

  const activePath = useMemo(() => resolvePlaybookPath(draft, activeBranchId), [draft, activeBranchId]);
  const activeDraft = activePath.play;
  const timingActive = hasTimingPlan(activeDraft);
  const timingBindings = useMemo(() => bindAuthoredActions(activeDraft), [activeDraft]);
  const selectedArrow = selected?.type === "arrow" ? activeDraft.arrows.find((arrow) => arrow.id === selected.id) : null;
  const selectedSpacingGate = activeDraft.spacingGates?.gates.find((gate) => gate.id === selectedSpacingGateId) ?? null;
  const selectedSpacingGateAction = selectedSpacingGate ? activeDraft.arrows.find((arrow) => arrow.id === selectedSpacingGate.trigger.actionId) ?? null : null;
  const spacingGateResults = simulationFrameState?.spacingGateResults ?? [];
  const selectedSpacingGateResult = selectedSpacingGate ? spacingGateResults.find((result) => result.gateId === selectedSpacingGate.id) : null;
  const selectedRatingsPlayer = draft.players.find((player) => player.id === ratingPlayerId) ?? draft.players[0] ?? null;
  const selectedSkillsDefender = draft.defenders.find((defender) => defender.id === defenderSkillsId) ?? draft.defenders[0] ?? null;
  const selectedParticipants = useMemo(() => selectedArrow ? bindAuthoredActions(activeDraft).find((action) => action.arrow.id === selectedArrow.id) : null, [activeDraft, selectedArrow?.id]);
  const selectedArrowSequence = selectedArrow ? arrowSequence(selectedArrow, activeDraft.arrows.findIndex((arrow) => arrow.id === selectedArrow.id)) : null;
  const sharedBoundarySequence = activeBranchId
    ? Math.min(...activeDraft.arrows.filter((arrow) => !activePath.sharedIds.has(arrow.id)).map((arrow, index) => arrowSequence(arrow, index)), Math.max(0, ...activeDraft.arrows.map((arrow, index) => arrowSequence(arrow, index))) + 1)
    : null;
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
  const draftDuration = useMemo(() => simulationTimelineDuration(activeDraft.arrows) + SIMULATION_SHOT_MS, [activeDraft.arrows]);
  const simulationDuration = simulationView?.durationMs ?? draftDuration;
  const simulationActive = simulationFrameState !== null;
  const simulationInterrupted = simulationActive && simulationClientRef.current === null;
  const simulationSession = simulationView?.session ?? null;
  const simulationComplete = simulationElapsed >= simulationDuration && simulationElapsed > 0;
  const simulationPaused = simulationClientRef.current !== null && !simulationPlaying && !simulationComplete;
  const offBallQualityDisplay = draft.players.length === 0
    ? "—"
    : simulationActive
      ? `${simulationFrame.offBallQuality}%`
      : "70%";

  function cloneActiveDraft() { return clonePlaybook(activeDraft); }

  function canonicalizeActiveDraft(next: PlaybookDraft, source: PlaybookDraft = draftSession.current, branchId = activeBranchId) {
    const canonical = applyEditedPath(source, branchId, next, resolvePlaybookPath(source, branchId));
    const validPlayers = new Set(canonical.players.map((player) => player.id));
    const removeUnbound = (arrows: PlaybookArrow[]) => arrows.filter((arrow) => [arrow.actor_id, arrow.recipient_id, arrow.screener_id, arrow.cutter_id, arrow.handler_id].every((id) => id == null || validPlayers.has(id)));
    canonical.arrows = removeUnbound(canonical.arrows);
    canonical.branches = canonical.branches?.map((branch) => ({ ...branch, continuation: removeUnbound(branch.continuation) }));
    return canonical;
  }

  function initializeTimingFamily(source: PlaybookDraft) {
    const original = clonePlaybook(source);
    const mainStarts = new Map(bindAuthoredActions(resolvePlaybookPath(original, null).play).map((action) => [action.arrow.id, snapTimingMs(action.startTime)]));
    const branchStarts = new Map((original.branches ?? []).map((branch) => [branch.id,
      new Map(bindAuthoredActions(resolvePlaybookPath(original, branch.id).play).map((action) => [action.arrow.id, snapTimingMs(action.startTime)]))]));
    const next = clonePlaybook(source);
    next.arrows = next.arrows.map((arrow) => ({ ...arrow, timingPlan: arrow.timingPlan ?? { startAtMs: Math.min(120_000, mainStarts.get(arrow.id) ?? 0) } }));
    next.branches = next.branches?.map((branch) => {
      const starts = branchStarts.get(branch.id) ?? new Map<string, number>();
      return { ...branch, continuation: branch.continuation.map((arrow) => ({ ...arrow, timingPlan: arrow.timingPlan ?? { startAtMs: Math.min(120_000, starts.get(arrow.id) ?? mainStarts.get(arrow.id) ?? 0) } })) };
    });
    return next;
  }

  function commitTimingEdit(edit: (arrows: PlaybookArrow[], bindings: ReturnType<typeof bindAuthoredActions>) => PlaybookArrow[]) {
    const base = timingActive ? clonePlaybook(draft) : initializeTimingFamily(draft);
    const oldPath = resolvePlaybookPath(base, activeBranchId);
    const edited = clonePlaybook(oldPath.play);
    edited.arrows = edit(edited.arrows, bindAuthoredActions(edited));
    const next = applyEditedPath(base, activeBranchId, edited, oldPath);
    return commitCanonical(next, draft, activeBranchId);
  }

  function changeTimingStart(actionId: string, requestedStartAtMs: number) {
    if (!Number.isFinite(requestedStartAtMs)) return;
    commitTimingEdit((arrows, bindings) => {
      const previous = arrows.find((arrow) => arrow.id === actionId)?.timingPlan?.startAtMs ?? 0;
      const delta = snapTimingMs(requestedStartAtMs) - previous;
      const moved = moveTimingGroup(arrows, actionId, requestedStartAtMs);
      return shiftConnectedTiming(moved, bindings, actionId, delta);
    });
  }

  function changeTimingDuration(actionId: string, seconds: number) {
    if (!Number.isFinite(seconds)) return;
    commitTimingEdit((arrows, bindings) => {
      const arrow = arrows.find((candidate) => candidate.id === actionId);
      if (!arrow) return arrows;
      const nextDuration = Math.max(.5, Math.min(4, seconds));
      const delta = Math.round((nextDuration - (arrow.timing ?? 1.2)) * 1000);
      const resized = arrows.map((candidate) => candidate.id === actionId ? resizeActionMinimum(candidate, nextDuration) : candidate);
      return shiftConnectedTiming(resized, bindings, actionId, delta);
    });
  }

  function toggleTimingSync(firstId: string, secondId?: string) {
    commitTimingEdit((arrows) => {
      if (!secondId) {
        const current = arrows.find((arrow) => arrow.id === firstId)?.timingPlan?.syncId;
        return current ? arrows.map((arrow) => arrow.timingPlan?.syncId === current ? { ...arrow, timingPlan: { ...arrow.timingPlan!, syncId: undefined } } : arrow) : arrows;
      }
      const first = arrows.find((arrow) => arrow.id === firstId), second = arrows.find((arrow) => arrow.id === secondId);
      if (!first || !second) return arrows;
      const oldGroups = new Set([first.timingPlan?.syncId, second.timingPlan?.syncId].filter((value): value is string => Boolean(value)));
      const startAtMs = first.timingPlan?.startAtMs ?? second.timingPlan?.startAtMs ?? 0;
      const syncId = timingIdentity("sync");
      return arrows.map((arrow) => arrow.id === firstId || arrow.id === secondId || oldGroups.has(arrow.timingPlan?.syncId ?? "")
        ? { ...arrow, timingPlan: { ...(arrow.timingPlan ?? { startAtMs }), startAtMs, syncId } }
        : arrow);
    });
  }

  function togglePocketSelection(actionId: string, extend = false) {
    setPocketSelectedIds((current) => {
      const selectedIds = extend || pocketSelectionMode ? current : [];
      return selectedIds.includes(actionId) ? selectedIds.filter((id) => id !== actionId) : [...selectedIds, actionId];
    });
    setPocketSelectionMode(true);
  }

  function insertPocket(request: PocketPlacementRequest): boolean {
    try {
      const targetBranchId = pocketInsertionBranchTarget(activeBranchId, sharedBoundarySequence, request.beforeSequence, request.insertShared);
      const timingBase = timingActive ? clonePlaybook(draft) : initializeTimingFamily(draft);
      const oldPath = resolvePlaybookPath(timingBase, targetBranchId);
      const state = authoredStateBeforeSequence(oldPath.play, request.beforeSequence);
      const bindings = bindAuthoredActions(oldPath.play);
      const boundary = request.beforeSequence == null ? null : bindings.filter((action) => action.sequence === request.beforeSequence);
      const baseStartAtMs = boundary?.length
        ? Math.min(...boundary.map((action) => action.startTime))
        : Math.max(0, ...bindings.map((action) => action.startTime + action.durationMs));
      const insertion = buildPocketInsertion({
        source: oldPath.play,
        pocket: request.pocket,
        assignments: request.assignments,
        transform: request.transform,
        beforeSequence: request.beforeSequence,
        currentPositions: state.players,
        currentBallHandlerId: state.ballHandlerId,
        includeConnectionPass: request.includeConnectionPass,
        baseStartAtMs,
      });
      const inserted = new Set(insertion.insertedIds);
      const authoredBindings = bindAuthoredActions({ ...oldPath.play, arrows: insertion.arrows });
      const shifted = shiftConnectedTiming(insertion.arrows, authoredBindings, insertion.insertedIds, insertion.durationMs)
        .map((arrow) => inserted.has(arrow.id) ? insertion.arrows.find((candidate) => candidate.id === arrow.id)! : arrow);
      const edited = clonePlaybook(oldPath.play);
      edited.arrows = shifted;
      const next = applyEditedPath(timingBase, targetBranchId, edited, oldPath);
      validatePlaybookDocument(next);
      if (!commitCanonical(next, draft, activeBranchId)) return false;
      setSimulationPlaying(false);
      resetSimulation();
      setTimingOpen(true);
      setPocketSelectedIds([]);
      setPocketSelectionMode(false);
      setPocketPreviewArrows([]);
      setPocketPreviewBallHandlerId(null);
      setPocketPreviewPlayerIds([]);
      setSelected({ type: "arrow", id: insertion.firstActionId });
      setTool("select");
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pocket combination could not be inserted");
      return false;
    }
  }

  function addTimingWait(actionId: string, wait: PlaybookTimingWait) {
    const committed = commitTimingEdit((arrows) => arrows.map((arrow) => arrow.id === actionId
      ? { ...arrow, timingPlan: { ...(arrow.timingPlan ?? { startAtMs: 0 }), waits: [...(arrow.timingPlan?.waits ?? []), wait] } }
      : arrow));
    setRoutePointPick(null);
    return committed;
  }

  function removeTimingWait(actionId: string, waitId: string) {
    commitTimingEdit((arrows) => arrows.map((arrow) => arrow.id === actionId && arrow.timingPlan
      ? { ...arrow, timingPlan: { ...arrow.timingPlan, waits: arrow.timingPlan.waits?.filter((wait) => wait.id !== waitId) } }
      : arrow));
  }

  function beginRoutePointWait(actionId: string, sourceId: string, playerId: number, routePhase: "main" | "approach" | "use" | "release") {
    if (simulationPlaying) pauseSimulation();
    setRoutePointPick({ actionId, sourceId, playerId, routePhase });
    setError(null);
    focusBoard();
  }

  function recordHistory(snapshot: PlaybookDraft, branchId: string | null) {
    setHistory((current) => [...current.slice(-39), { draft: clonePlaybook(snapshot), branchId }]);
    setFuture([]);
  }

  useEffect(() => {
    if (renamingBranchId) branchLabelInput.current?.focus();
  }, [renamingBranchId]);

  useEffect(() => {
    if (selectedArrow) setArrowFields({ id: selectedArrow.id, sequence: String(selectedArrowSequence ?? 1), timing: clampTiming(selectedArrow.timing ?? 1.2).toFixed(1) });
    else setArrowFields({ id: "", sequence: "", timing: "" });
  }, [selectedArrow?.id, selectedArrowSequence, selectedArrow?.timing]);

  useEffect(() => {
    if (!simulationPlaying) return;
    let previousTime = performance.now();
    const tick = (now: number) => {
      const client = simulationClientRef.current;
      if (!client) {
        setSimulationPlaying(false);
        return;
      }
      if (document.hidden) {
        pauseSimulation();
        return;
      }
      const delta = Math.max(0, Math.min(50, now - previousTime));
      previousTime = now;
      // Clock and transport only. All execution and interpolation happen in
      // the worker, with one outstanding request and bounded clock debt.
      client.advance(delta);
      simulationFrameRef.current = window.requestAnimationFrame(tick);
    };
    simulationFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (simulationFrameRef.current != null) window.cancelAnimationFrame(simulationFrameRef.current);
      simulationFrameRef.current = null;
    };
  }, [simulationPlaying]);

  useEffect(() => {
    const hidden = () => { if (document.hidden) pauseSimulation(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { document.removeEventListener("visibilitychange", hidden); simulationClientRef.current?.dispose(); simulationClientRef.current = null; };
  }, []);

  useEffect(() => {
    let mounted = true;
    const refresh = () => { void fetchPlaybooks().then((plays) => { if (mounted) setSaved(plays); }).catch((caught: unknown) => { if (mounted) setError(caught instanceof Error ? caught.message : "Saved plays are unavailable. Retry when the server is running"); }); };
    refresh();
    const unsubscribe = subscribePlaybooks(refresh);
    return () => { mounted = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (savedOpen) void fetchPlaybooks().then(setSaved).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Saved plays could not be loaded"));
  }, [savedOpen]);

  useEffect(() => {
    onDraftChange?.(flattenPlaybookPath(draft, activeBranchId, activePath.branch?.label));
  }, [draft, activeBranchId, activePath.branch?.label, onDraftChange]);

  useEffect(() => {
    if (requestedPlay) requestLoad(clonePlaybook(requestedPlay.play));
    // The request id allows the same saved play to be opened more than once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedPlay?.requestId]);

  useEffect(() => {
    if (!active && simulationPlaying) pauseSimulation();
  }, [active, simulationPlaying]);
  useEffect(() => {
    if (!active || view !== "edit") pauseSimulation();
  }, [active, view]);
  useEffect(() => () => {
    previewCancelRef.current?.();
    previewClientRef.current?.dispose();
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

  function simulationDrawing(source: PlaybookDraft, branchId = activeBranchId) {
    const executable = flattenPlaybookPath(source, branchId);
    const gates = resolvePlaybookPath(source, branchId).play.spacingGates;
    if (gates) executable.spacingGates = structuredClone(gates);
    return executable;
  }

  function resetSimulation() {
    simulationClientRef.current?.dispose();
    simulationClientRef.current = null;
    simulationDrawingRef.current = null;
    lastSimulationViewRef.current = null;
    setSimulationView(null);
    setSimulationPlaying(false);
    setSimulationElapsed(0);
    setSimulationFrameState(null);
  }

  function pauseSimulation() {
    simulationClientRef.current?.playback(false);
    setSimulationPlaying(false);
  }

  function changeSimulationSetting<Key extends keyof SimulationSettings>(key: Key, value: SimulationSettings[Key]) {
    const next = { ...simulationSettingsRef.current, [key]: value };
    simulationSettingsRef.current = next;
    setSimulationSettings(next);
    simulationClientRef.current?.settings(next);
    setError(null);
  }

  function seekSimulation(timeMs: number) {
    if (!simulationClientRef.current) return;
    simulationClientRef.current.seek(timeMs);
    setSimulationPlaying(false);
    setError(null);
  }

  function captureReadCheckpoint(existing?: ReadCoachCheckpoint) {
    const client = simulationClientRef.current;
    if (!client) {
      setError("Start a simulation, then pause while a player holds the ball. You can seek past a catch or back before a shot and try again");
      return;
    }
    setReadCoachEditing(existing ?? null);
    setReadCoachCapture(null);
    setError(null);
    setSimulationPlaying(false);
    client.capture();
  }

  function buildFlipbook() {
    const view = lastSimulationViewRef.current;
    const client = simulationClientRef.current;
    const executable = simulationDrawing(draft, activeBranchId);
    const sameDrawing = simulationDrawingRef.current != null && JSON.stringify(simulationDrawingRef.current) === JSON.stringify(executable);
    setFlipbookCapture(null);
    setError(null);
    if (client && view && sameDrawing && view.session.recordedUntilMs > 0
      && view.session.recordedUntilMs >= view.durationMs - 1
      && Math.abs(view.session.positionMs - view.session.recordedUntilMs) < 1e-5) {
      flipbookNavigationPendingRef.current = true;
      client.playback(false);
      setSimulationPlaying(false);
      client.captureFlipbook();
      return;
    }
    flipbookNavigationPendingRef.current = false;
    pauseSimulation();
    onViewChange?.("flipbook");
  }

  function updateFlipbookStory(story: PlayFlipbookStory | null) {
    const next = clonePlaybook(draft);
    const remaining = (next.flipbooks?.stories ?? []).filter((item) => item.endingId !== activeBranchId);
    if (story) remaining.push(structuredClone(story));
    if (remaining.length) next.flipbooks = { version: 1, stories: remaining };
    else delete next.flipbooks;
    validatePlaybookDocument(next);
    checkPlaybookJsonText(JSON.stringify(next));
    if (isSameDraft(next, draft)) return true;
    recordHistory(clonePlaybook(draft), activeBranchId);
    setDraftState(draftSession.edit(next));
    setDirty(draftSession.dirty);
    setStatus("idle");
    setError(null);
    return true;
  }

  function openSavedReadCheckpoint(checkpoint: ReadCoachCheckpoint) {
    setReadCoachEditing(checkpoint);
    setReadCoachCapture({ session: checkpoint.session, frame: readCoachSnapshotFrame(checkpoint.snapshot) });
  }

  function saveReadCheckpoint(checkpoint: ReadCoachCheckpoint, previousId?: string) {
    const next = clonePlaybook(draft);
    const current = next.readCoach?.checkpoints ?? [];
    const checkpoints = previousId
      ? current.map((item) => item.id === previousId ? checkpoint : item)
      : [...current, checkpoint];
    commit({ ...next, readCoach: { version: 1, checkpoints } });
    setReadCoachCapture(null); setReadCoachEditing(null);
  }

  function deleteReadCheckpoint(checkpointId: string) {
    const next = clonePlaybook(draft);
    const checkpoints = (next.readCoach?.checkpoints ?? []).filter((item) => item.id !== checkpointId);
    const updated = { ...next };
    if (checkpoints.length) updated.readCoach = { version: 1, checkpoints };
    else delete updated.readCoach;
    commit(updated);
  }

  function previewReadChoice(checkpoint: ReadCoachCheckpoint, choiceId: string, onFrame: (frame: SimulationFrame) => void) {
    return new Promise<void>((resolve, reject) => {
      previewCancelRef.current?.();
      previewClientRef.current?.dispose();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (readCoachPreviewFrameRef.current != null) window.cancelAnimationFrame(readCoachPreviewFrameRef.current);
        readCoachPreviewFrameRef.current = null;
        previewClientRef.current?.dispose(); previewClientRef.current = null;
        previewCancelRef.current = null;
        if (error) reject(error); else resolve();
      };
      previewCancelRef.current = () => finish(new Error("Choice preview was cancelled · the lesson is unchanged"));
      try {
        const selectedChoice = checkpoint.choices.find((choice) => choice.id === choiceId);
        let finalFrame: SimulationFrame | null = null;
        const client = createPlaybookSimulationClient({ sessionId: crypto.randomUUID(),
          onState: (simulation) => {
            if (previewClientRef.current !== client) return;
            finalFrame = simulation.frame;
            onFrame(simulation.frame);
            if (!simulation.playing) {
              const diagnostics = new Map((finalFrame.execution ?? []).map((action) => [action.actionId, action]));
              const failed = (selectedChoice?.arrows ?? []).filter((arrow) => diagnostics.get(arrow.id)?.phase !== "completed");
              if (failed.length) {
                const detail = failed.map((arrow) => {
                  const status = diagnostics.get(arrow.id);
                  return status?.notice || `${arrow.kind.replaceAll("-", " ")} is ${status?.phase ?? "not bound"}`;
                }).join(" · ");
                finish(new Error(`This continuation did not execute cleanly: ${detail}. Adjust the route or participants and preview it again`));
              } else finish();
            }
          },
          onFailure: (message) => finish(new Error(message)),
        });
        previewClientRef.current = client;
        client.startReadChoice(checkpoint, choiceId);
        let previous = performance.now();
        const tick = (now: number) => {
          if (settled || previewClientRef.current !== client) return;
          if (!active || document.hidden) { finish(new Error("Choice preview paused because Playbook is hidden")); return; }
          client.advance(Math.max(0, Math.min(50, now - previous))); previous = now;
          readCoachPreviewFrameRef.current = window.requestAnimationFrame(tick);
        };
        readCoachPreviewFrameRef.current = window.requestAnimationFrame(tick);
      } catch (cause) { finish(cause instanceof Error ? cause : new Error("Choice preview could not start")); }
    });
  }

  // Validate the drawing synchronously. The worker stages compatible execution
  // edits atomically; transport failures preserve the user's editable draft.
  function handoffCanonicalDraft(next: PlaybookDraft, preserveSimulation: boolean, branchId = activeBranchId) {
    try {
      validatePlaybookDocument(next);
      const executable = simulationDrawing(next, branchId);
      if (preserveSimulation && simulationClientRef.current && simulationDrawingRef.current && pausedDraftIsCompatible(simulationDrawingRef.current, executable)) {
        simulationClientRef.current.edit(executable);
        simulationDrawingRef.current = executable;
      } else resetSimulation();
      setDraftState(draftSession.edit(next));
      setDirty(draftSession.dirty);
      setStatus("idle");
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The paused edit could not be applied. Your previous drawing is intact");
      return false;
    }
  }

  function handoffDraft(next: PlaybookDraft, preserveSimulation: boolean) {
    return handoffCanonicalDraft(canonicalizeActiveDraft(next), preserveSimulation);
  }

  function commit(next: PlaybookDraft, previous = draft) {
    const canonical = canonicalizeActiveDraft(next, previous);
    if (isSameDraft(canonical, previous)) return true;
    return commitCanonical(canonical, previous, activeBranchId);
  }

  function commitCanonical(next: PlaybookDraft, previous = draft, branchId = activeBranchId, keepRecording = false) {
    if (isSameDraft(next, previous)) return true;
    const gateError = spacingGateEditError(previous, next);
    if (gateError) { setError(gateError); return false; }
    const connectionError = timingConnectionEditError(previous, next);
    if (connectionError) { setError(connectionError); return false; }
    const before = clonePlaybook(previous);
    const preserveSimulation = simulationClientRef.current !== null && (keepRecording || !simulationPlaying);
    if (!handoffCanonicalDraft(next, preserveSimulation, branchId)) return false;
    recordHistory(before, activeBranchId);
    return true;
  }

  function saveRoleCue(cue: { playerId: number; actionId: string; phase: RoleCuePhase; text: string | null; signature: string }) {
    try {
      const next = clonePlaybook(draft);
      const scope = activeBranchId && !activePath.sharedIds.has(cue.actionId) ? "ending" : "shared";
      const branchId = scope === "ending" ? activeBranchId! : undefined;
      const key = (item: { playerId: number; actionId: string; phase: RoleCuePhase; scope: string; branchId?: string }) => item.playerId === cue.playerId && item.actionId === cue.actionId && item.phase === cue.phase && item.scope === scope && item.branchId === branchId;
      const cues = (next.roleCues?.cues ?? []).filter((item) => !key(item));
      if (cue.text !== null) cues.push({ playerId: cue.playerId, actionId: cue.actionId, phase: cue.phase, scope, ...(branchId ? { branchId } : {}), text: cue.text, signature: cue.signature });
      // Keep an explicit empty lesson after Reset wording so storage can tell
      // this feature-aware removal from an older client omitting the field.
      next.roleCues = { version: 1, cues };
      validatePlaybookDocument(next);
      recordHistory(clonePlaybook(draft), activeBranchId);
      setDraftState(draftSession.edit(next));
      setDirty(draftSession.dirty);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cue wording could not be saved");
    }
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    const before = clonePlaybook(draft);
    if (!handoffCanonicalDraft(previous.draft, simulationClientRef.current !== null && !simulationPlaying, previous.branchId)) return;
    setHistory((current) => current.slice(0, -1));
    setFuture((current) => [{ draft: before, branchId: activeBranchId }, ...current]);
    setActiveBranchId(previous.branchId);
    setSelected(null);
    setFlipbookHistoryRevision((revision) => revision + 1);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    const before = clonePlaybook(draft);
    if (!handoffCanonicalDraft(next.draft, simulationClientRef.current !== null && !simulationPlaying, next.branchId)) return;
    setFuture((current) => current.slice(1));
    setHistory((current) => [...current, { draft: before, branchId: activeBranchId }]);
    setActiveBranchId(next.branchId);
    setSelected(null);
    setFlipbookHistoryRevision((revision) => revision + 1);
  }

  function chooseTool(next: PlaybookTool) {
    if (drawingRef.current || dragRef.current || spacingGateDragRef.current) interruptPointerInteraction();
    setSpacingGateRoutePick(null);
    setTool(next);
    if (next !== "off-ball-screen" && next !== "pin-down") setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
    if (next !== "pick-pop") setPickPopSelection({ screenerId: null, handlerId: null, screenPoint: null });
    if (next !== "backdoor-cut") setBackdoorCutterId(null);
    setDrawStart(null);
    setDrawEnd(null);
    focusBoard();
  }

  function loadDraft(next: PlaybookDraft) {
    interruptPointerInteraction();
    setDraftState(draftSession.load(normalizeDraft(next), next.id.startsWith("draft-copy-")));
    dragRef.current = null;
    setHistory([]);
    setFuture([]);
    setActiveBranchId(null);
    setRenamingBranchId(null);
    setCompareMain(false);
    setRoutePointPick(null);
    setSpacingGateRoutePick(null);
    setSelectedSpacingGateId(null);
    setTimingPreviewActionId(null);
    setSelected(null);
    setTool("select");
    setDrawStart(null);
    setDrawEnd(null);
    setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
    setPickPopSelection({ screenerId: null, handlerId: null, screenPoint: null });
    setBackdoorCutterId(null);
    setDirty(draftSession.dirty);
    setStatus("idle");
    setError(null);
    resetSimulation();
  }

  function selectBranch(branchId: string | null) {
    if (branchId === activeBranchId) return;
    interruptPointerInteraction();
    resetSimulation();
    setSelected(null);
    setRenamingBranchId(null);
    setCompareMain(false);
    setRoutePointPick(null);
    setSpacingGateRoutePick(null);
    setSelectedSpacingGateId(null);
    setTimingPreviewActionId(null);
    setActiveBranchId(branchId);
  }

  function createBranch(actionId: string) {
    if ((draft.branches?.length ?? 0) >= MAX_PLAYBOOK_BRANCHES) {
      setError("This play already has eight endings");
      return;
    }
    try {
      const labelNumber = (draft.branches ?? []).reduce((max, branch) => {
        const match = /^Ending (\d+)$/i.exec(branch.label.trim());
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0) + 1;
      const branch = createBranchFromAction(draft, actionId, labelNumber);
      const next = clonePlaybook(draft);
      next.branches = [...(next.branches ?? []), branch];
      const copiedIds = new Set(branch.continuation.map((arrow) => arrow.id));
      const copiedGates = (next.spacingGates?.gates ?? []).flatMap((gate) => gate.scope === "shared" && copiedIds.has(gate.trigger.actionId)
        ? [{ ...structuredClone(gate), id: timingIdentity("gate"), scope: "ending" as const, branchId: branch.id }]
        : []);
      if (copiedGates.length) next.spacingGates = { version: 1, gates: [...(next.spacingGates?.gates ?? []), ...copiedGates] };
      const branchTemplates = authoredRoleCueTemplates(resolvePlaybookPath(next, branch.id).play);
      const copiedCues = (next.roleCues?.cues ?? []).flatMap((cue) => {
        if (cue.scope !== "shared" || !copiedIds.has(cue.actionId)) return [];
        const template = branchTemplates.find((item) => item.actionId === cue.actionId && item.playerId === cue.playerId && item.phase === cue.phase);
        return template ? [{ ...cue, scope: "ending" as const, branchId: branch.id, signature: template.signature }] : [];
      });
      if (copiedCues.length) next.roleCues = { version: 1, cues: [...(next.roleCues?.cues ?? []), ...copiedCues] };
      commitCanonical(next, draft, null);
      selectBranch(branch.id);
      setRenamingBranchId(branch.id);
      setBranchLabelValue(branch.label);
      setSelected(null);
      setError(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "This ending could not be created"); }
  }

  function saveBranchLabel() {
    if (!renamingBranchId) return;
    const value = branchLabelValue.trim();
    if (!value || Array.from(value).length > 40) {
      setError("Ending labels must contain 1–40 characters");
      branchLabelInput.current?.focus();
      return;
    }
    if (draft.branches?.find((branch) => branch.id === renamingBranchId)?.label === value) {
      setRenamingBranchId(null);
      return;
    }
    const next = clonePlaybook(draft);
    next.branches = (next.branches ?? []).map((branch) => branch.id === renamingBranchId ? { ...branch, label: value } : branch);
    commitCanonical(next, draft, activeBranchId);
    setRenamingBranchId(null);
    setError(null);
  }

  function deleteBranch(branchId: string) {
    const branch = draft.branches?.find((item) => item.id === branchId);
    const hasWalkthrough = draft.flipbooks?.stories.some((story) => story.endingId === branchId) ?? false;
    if (!branch || !window.confirm(hasWalkthrough
      ? `Delete ${branch.label} and its frozen walkthrough?`
      : `Delete ${branch.label}?`)) return;
    const next = clonePlaybook(draft);
    next.branches = (next.branches ?? []).filter((item) => item.id !== branchId);
    if (next.roleCues) {
      const cues = next.roleCues.cues.filter((cue) => cue.scope !== "ending" || cue.branchId !== branchId);
      next.roleCues = { version: 1, cues };
    }
    if (next.spacingGates) next.spacingGates = { version: 1, gates: next.spacingGates.gates.filter((gate) => gate.scope !== "ending" || gate.branchId !== branchId) };
    if (next.flipbooks) {
      const stories = next.flipbooks.stories.filter((story) => story.endingId !== branchId);
      if (stories.length) next.flipbooks = { version: 1, stories };
      else delete next.flipbooks;
    }
    commitCanonical(next, draft, activeBranchId);
    if (activeBranchId === branchId) selectBranch(null);
  }

  function requestLoad(next: PlaybookDraft) {
    if (dirty) setReplacement(next);
    else loadDraft(next);
  }

  async function saveDraft() {
    const request = draftSession.beginSave();
    if (!request) return false;
    setStatus("saving");
    setError(null);
    try {
      const payload = draftPayload(request.draft);
      const result = payload.id.startsWith("draft-") ? await createPlaybook(payload, request.creationId) : await updatePlaybook(payload);
      setSaved((current) => [result, ...current.filter((play) => play.id !== result.id)].sort(compareSavedPlaybooks));
      const applied = draftSession.completeSave(request, result);
      if (!applied) return false;
      setDraftState(applied.draft);
      setDirty(draftSession.dirty);
      setStatus(draftSession.dirty ? "idle" : "saved");
      // Save-then-replace may proceed only when every current edit was saved.
      return applied.unchanged ? request : null;
    } catch (caught) {
      if (draftSession.failSave(request, caught instanceof CreationAttemptError && caught.retainAttempt)) {
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "Play could not be saved. Your draft is still here");
      }
      return false;
    }
  }

  function changeAutomaticAction<Key extends keyof AutomaticActionSettings>(key: Key, value: boolean) {
    changeSimulationSetting("automaticActions", { ...simulationSettingsRef.current.automaticActions, [key]: value });
  }

  function changePlayerRating(playerId: number, key: keyof PlayerSkillRatings, value: number) {
    const next = cloneActiveDraft();
    next.players = next.players.map((player) => player.id === playerId
      ? { ...player, ratings: { threePoint: 3, midrange: 3, finishing: 3, ...player.ratings, [key]: Math.max(1, Math.min(5, Math.round(value))) } }
      : player);
    commit(next, draft);
  }

  function togglePlayerBadge(playerId: number, badge: OffensiveBadge) {
    const next = cloneActiveDraft();
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
    commit(next, draft);
  }

  function toggleDefenderBadge(defenderId: number, badge: DefensiveBadge) {
    const next = cloneActiveDraft();
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
    commit(next, draft);
  }

  function adjustTeamRating(key: keyof PlayerSkillRatings, amount: -1 | 1) {
    if (!draft.players.length) return;
    const next = cloneActiveDraft();
    next.players = next.players.map((player) => {
      const ratings = { threePoint: 3, midrange: 3, finishing: 3, ...player.ratings };
      return { ...player, ratings: { ...ratings, [key]: Math.max(1, Math.min(5, ratings[key] + amount)) } };
    });
    commit(next, draft);
  }

  function startSimulation() {
    if (!draft.players.length) {
      setError("Add at least one offensive player before running a simulation");
      return;
    }
    if (simulationPaused && simulationClientRef.current) {
      simulationClientRef.current.playback(true);
      setSimulationPlaying(true);
      setError(null);
      focusBoard();
      return;
    }
    // Keep the last acknowledged court while a replacement worker starts. A
    // startup failure must not discard the last successful display either.
    simulationClientRef.current?.dispose();
    simulationClientRef.current = null;
    try {
      const client = createPlaybookSimulationClient({ sessionId: crypto.randomUUID(),
        onState: (view) => {
          if (simulationClientRef.current !== client) return;
          lastSimulationViewRef.current = view;
          setSimulationView(view);
          setSimulationFrameState(view.frame);
          setSimulationElapsed(view.session.positionMs);
          setSimulationPlaying(view.playing);
          simulationSettingsRef.current = view.settings;
          setSimulationSettings(view.settings);
        },
        onCapture: (capture) => {
          if (simulationClientRef.current !== client) return;
          setReadCoachCapture(capture);
          setSimulationFrameState(capture.frame);
          setSimulationElapsed(capture.session.positionMs);
        },
        onFlipbookCapture: (capture) => {
          if (simulationClientRef.current !== client || !flipbookNavigationPendingRef.current) return;
          flipbookNavigationPendingRef.current = false;
          setFlipbookCapture(capture);
          onViewChange?.("flipbook");
        },
        onCommandError: (_type, message) => {
          setSimulationPlaying(false);
          setError(message);
        },
        onFailure: (message) => {
          if (simulationClientRef.current !== client) return;
          simulationClientRef.current = null;
          setSimulationPlaying(false);
          setSimulationFrameState(lastSimulationViewRef.current?.frame ?? null);
          setError(message);
        },
      });
      simulationClientRef.current = client;
      const executable = simulationDrawing(draft, activeBranchId);
      simulationDrawingRef.current = executable;
      client.start(executable, simulationSettingsRef.current);
      setSimulationPlaying(true);
      setError(null);
    } catch {
      setSimulationPlaying(false);
      setError("Playback worker could not start. Your drawing is intact. Press Play to retry");
    }
    focusBoard();
  }

  function applyAIDefense() {
    const next = cloneActiveDraft();
    next.defenders_visible = true;
    next.defenders = placeDefendersGoalSide(next.players, next.defenders, HOOP_POINT);
    commit(next);
    setSelected(null);
    setError(null);
  }

  function addAuthoredArrow(arrow: PlaybookArrow) {
    const next = cloneActiveDraft();
    const latestFinish = timingActive
      ? Math.max(0, ...timingBindings.map((action) => action.startTime + action.durationMs))
      : 0;
    const authored = timingActive
      ? { ...arrow, timingPlan: { startAtMs: Math.min(120_000, snapTimingMs(latestFinish)) } }
      : arrow;
    next.arrows = [...next.arrows, authored];
    commit(next);
    setSelected({ type: "arrow", id: arrow.id });
    setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
    setPickPopSelection({ screenerId: null, handlerId: null, screenPoint: null });
    setBackdoorCutterId(null);
    setTool("select");
  }

  function changeArrowSequence(arrowIdValue: string, requestedSequence: number) {
    if (!Number.isFinite(requestedSequence)) return;
    const next = cloneActiveDraft();
    next.arrows = next.arrows.map((arrow) => arrow.id === arrowIdValue
      ? { ...arrow, sequence: Math.max(1, Math.min(30, Math.round(requestedSequence))) }
      : arrow);
    commit(next);
    setSelected({ type: "arrow", id: arrowIdValue });
  }

  function changeArrowPath(arrowIdValue: string, path: "straight" | "curve") {
    const next = cloneActiveDraft();
    next.arrows = next.arrows.map((arrow) => arrow.id === arrowIdValue
      ? { ...arrow, path, control: path === "curve" ? arrowControl(arrow) : arrow.control }
      : arrow);
    commit(next);
    setSelected({ type: "arrow", id: arrowIdValue });
  }

  function changeArrowParticipant(id: string, field: "actor_id" | "recipient_id", value: string) {
    const next = cloneActiveDraft();
    next.arrows = next.arrows.map((arrow) => {
      if (arrow.id !== id) return arrow;
      const updated = { ...arrow, [field]: value === "auto" ? undefined : Number(value) };
      if (updated.actor_id != null && updated.actor_id === updated.recipient_id) updated.recipient_id = undefined;
      return updated;
    });
    commit(next);
  }

  function changeArrowTiming(arrowIdValue: string, requestedTiming: number) {
    if (!Number.isFinite(requestedTiming)) return;
    const next = cloneActiveDraft();
    next.arrows = next.arrows.map((arrow) => arrow.id === arrowIdValue ? { ...arrow, timing: clampTiming(requestedTiming) } : arrow);
    commit(next);
    setSelected({ type: "arrow", id: arrowIdValue });
  }

  function duplicate(play: PlaybookDocument) {
    const copy = { ...clonePlaybook(play), id: `draft-copy-${Date.now()}`, name: `${play.name} copy`, created_at: undefined, updated_at: undefined };
    if (dirty) setReplacement(copy);
    else {
      loadDraft(copy);
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
      setError(caught instanceof Error ? caught.message : "Play could not be deleted");
    } finally {
      setDeleteId(null);
    }
  }

  function addMarker(point: CourtPoint, type: "player" | "defender") {
    if (markerCount(draft, type) >= 5) {
      setError(`You can place up to five ${type === "player" ? "offensive players" : "defenders"}`);
      return;
    }
    const collection = type === "player" ? draft.players : draft.defenders;
    const id = Math.max(0, ...collection.map((marker) => marker.id)) + 1;
    const next = cloneActiveDraft();
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

  function commitSpacingGatePath(nextPath: PlaybookDraft, before = draftSession.current, branchId = activeBranchId) {
    const canonical = canonicalizeActiveDraft(nextPath, before, branchId);
    pauseSimulation();
    return commitCanonical(canonical, before, branchId, true);
  }

  function updateSpacingGate(gateId: string, update: (gate: SpacingGate) => SpacingGate) {
    const before = clonePlaybook(draftSession.current);
    const path = resolvePlaybookPath(before, activeBranchId).play;
    const gate = path.spacingGates?.gates.find((candidate) => candidate.id === gateId);
    if (!gate) { setError("This spacing gate is no longer available"); return false; }
    const next = clonePlaybook(path);
    next.spacingGates = { version: 1, gates: (next.spacingGates?.gates ?? []).map((candidate) => candidate.id === gateId ? clampSpacingGate(update(structuredClone(candidate))) : candidate) };
    const saved = commitSpacingGatePath(next, before);
    if (saved) { setSelectedSpacingGateId(gateId); setError(null); }
    return saved;
  }

  function placeSpacingGate(point: CourtPoint) {
    if (draft.spacingGates?.gates.length === 30) { setError("A play can contain at most 30 spacing gates"); return; }
    if (!activeDraft.players.length) { setError("Add an offensive player before placing a spacing gate"); return; }
    const action = activeDraft.arrows.find((arrow) => arrow.id === selectedArrow?.id) ?? orderBranchActions(activeDraft.arrows)[0];
    if (!action) { setError("Draw an action before placing a spacing gate"); return; }
    const playerId = nearestPlayerId(activeDraft.players, point);
    if (playerId == null) return;
    const shared = !activeBranchId || activePath.sharedIds.has(action.id);
    const gate: SpacingGate = clampSpacingGate({
      id: timingIdentity("gate"), playerId,
      area: { shape: "circle", center: { ...point }, radiusFeet: 3 },
      rule: "inside", trigger: { actionId: action.id, event: "start" }, beforeSeconds: 0, afterSeconds: 0,
      scope: shared ? "shared" : "ending", ...(!shared && activeBranchId ? { branchId: activeBranchId } : {}),
    });
    const next = cloneActiveDraft();
    next.spacingGates = { version: 1, gates: [...(next.spacingGates?.gates ?? []), gate] };
    if (commitSpacingGatePath(next)) { setSelectedSpacingGateId(gate.id); setSelected({ type: "arrow", id: action.id }); setSpacingGateListOpen(true); setTool("select"); setError(null); }
  }

  function deleteSpacingGate(gateId: string) {
    const next = cloneActiveDraft();
    const gates = (next.spacingGates?.gates ?? []).filter((gate) => gate.id !== gateId);
    if (gates.length) next.spacingGates = { version: 1, gates };
    else delete next.spacingGates;
    if (commitSpacingGatePath(next)) { if (selectedSpacingGateId === gateId) setSelectedSpacingGateId(null); setSpacingGateRoutePick(null); }
  }

  function selectSpacingGate(gate: SpacingGate) {
    setSelectedSpacingGateId(gate.id);
    setSpacingGateRoutePick(null);
    setSelected({ type: "arrow", id: gate.trigger.actionId });
    setTool("select");
  }

  function beginSpacingGateDrag(event: ReactPointerEvent<SVGGElement>, gateId: string, kind: SpacingGateDragKind) {
    if (spacingGateDragRef.current || dragRef.current || drawingRef.current) return;
    const point = pointFromPointer(event, svgRef.current);
    const gate = activeDraft.spacingGates?.gates.find((candidate) => candidate.id === gateId);
    if (!point || !gate) return;
    const before = clonePlaybook(draftSession.current);
    spacingGateDragRef.current = { ...pointerGesture(event), gateId, kind, before, branchId: activeBranchId, start: point, original: structuredClone(gate) };
    svgRef.current?.setPointerCapture(event.pointerId);
    pauseSimulation();
  }

  function beginSpacingGateRoutePick(gate: SpacingGate) {
    if (simulationPlaying) pauseSimulation();
    const playerId = gate.trigger.routePlayerId ?? gate.playerId;
    const route = authoredRoutes.find((candidate) => candidate.actionId === gate.trigger.actionId && candidate.playerId === playerId);
    if (!route) { setError(`Player ${playerId} has no authored route for this action`); return; }
    setSpacingGateRoutePick(gate.id);
    setError(null);
    focusBoard();
  }

  function onSpacingGateRoutePointPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!spacingGateRoutePick) return;
    event.preventDefault(); event.stopPropagation();
    const point = pointFromPointer(event, svgRef.current);
    const gate = activeDraft.spacingGates?.gates.find((candidate) => candidate.id === spacingGateRoutePick);
    const playerId = gate?.trigger.routePlayerId ?? gate?.playerId;
    const route = gate && playerId != null ? authoredRoutes.find((candidate) => candidate.actionId === gate.trigger.actionId && candidate.playerId === playerId) : null;
    if (!point || !gate || !route) { setSpacingGateRoutePick(null); setError("The linked route is no longer available. Choose it again"); return; }
    // Gate events use the engine's physical-foot route progress, so the point
    // picker projects with the same 50 ft × 47 ft court metric.
    const projected = projectPointToRoute(point, sampleAuthoredCourtRoute(route), { x: 0.5, y: 0.47 });
    if (projected.distance > 5) { setError("Click closer to the player’s route to place the spacing checkpoint"); return; }
    const committed = updateSpacingGate(gate.id, (current) => ({ ...current, trigger: { actionId: current.trigger.actionId, event: "route-point", routePlayerId: playerId,
      routePhase: "main", routeSegment: projected.segment, progress: Math.max(.001, Math.min(.999, Math.round(projected.progress * 10000) / 10000)) } }));
    if (committed) { setSpacingGateRoutePick(null); setError(null); }
  }

  function onBackgroundPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragRef.current || drawingRef.current) return;
    const point = pointFromPointer(event, svgRef.current);
    if (!point) return;
    focusBoard();
    const nextSequence = Math.max(0, ...activeDraft.arrows.map((arrow, index) => arrowSequence(arrow, index))) + 1;
    if (tool === "spacing-gate") { placeSpacingGate(point); return; }
    if (tool === "pick-pop") {
      const { screenerId, handlerId, screenPoint } = pickPopSelection;
      if (screenerId == null || handlerId == null) {
        setError("Select the screener and ball handler first");
        return;
      }
      if (!screenPoint) {
        setPickPopSelection({ ...pickPopSelection, screenPoint: point });
        setError(null);
        return;
      }
      const screener = draft.players.find((player) => player.id === screenerId);
      if (!screener) {
        setError("The selected screener is no longer on the court");
        return;
      }
      addAuthoredArrow({ id: arrowId(), kind: "pick-pop", start: { x: screener.x, y: screener.y }, end: screenPoint, exit_target: point, screener_id: screenerId, handler_id: handlerId, path: "straight", timing: 1.5, sequence: nextSequence });
      return;
    }
    if (tool === "off-ball-screen" || tool === "pin-down") {
      const { screenerId, cutterId, screenPoint } = offBallScreenSelection;
      if (screenerId == null || cutterId == null) {
        setError("Select a screener and cutter before placing the screen");
        return;
      }
      const screener = draft.players.find((player) => player.id === screenerId);
      if (!screener) {
        setError("The selected screener is no longer on the court");
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
        setError("Select the cutter before placing the backdoor route");
        return;
      }
      const cutter = draft.players.find((player) => player.id === backdoorCutterId);
      if (!cutter) {
        setError("The selected cutter is no longer on the court");
        setBackdoorCutterId(null);
        return;
      }
      addAuthoredArrow({ id: arrowId(), kind: "backdoor-cut", start: { x: cutter.x, y: cutter.y }, end: point, actor_id: cutter.id, path: "straight", timing: 1.2, sequence: nextSequence });
      return;
    }
    if (tool === "player") return addMarker(point, "player");
    if (tool === "ball") {
      if (draft.ball) setError("This play already has a ball. Select it and press Delete to replace it");
      else {
        const next = cloneActiveDraft();
        next.ball = point;
        commit(next);
        setSelected({ type: "ball", id: "ball" });
        setTool("select");
      }
      return;
    }
    if (tool === "movement" || tool === "pass" || tool === "screen" || tool === "slip-screen" || tool === "handoff" || tool === "pick-roll") {
      drawingRef.current = { start: point, end: point, ...pointerGesture(event) };
      setDrawStart(point);
      setDrawEnd(point);
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === "select") setSelected(null);
  }

  function onTimingRoutePointPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!routePointPick) return;
    event.preventDefault(); event.stopPropagation();
    const point = pointFromPointer(event, svgRef.current);
    const source = activeDraft.arrows.find((arrow) => arrow.id === routePointPick.sourceId);
    if (!point || !source) {
      setError("The selected route is no longer available. Choose it again");
      setRoutePointPick(null);
      return;
    }
    const authoredRoute = authoredRoutes.find((candidate) => candidate.actionId === source.id && candidate.playerId === routePointPick.playerId);
    if (!authoredRoute) {
      setError("The selected player has no authored route in this move. Choose a participant with a visible route");
      return;
    }
    const route = sampleAuthoredCourtRoute(authoredRoute);
    const projected = projectPointToRoute(point, route);
    if (projected.distance > 5) {
      setError("Click closer to the selected player's route to place the wait point");
      return;
    }
    const committed = addTimingWait(routePointPick.actionId, {
      id: timingIdentity("wait"),
      actionId: source.id,
      event: "route-point",
      playerId: routePointPick.playerId,
      routePhase: routePointPick.routePhase,
      routeSegment: projected.segment,
      progress: Math.max(.001, Math.min(.999, Math.round(projected.progress * 10000) / 10000)),
    });
    setSelected({ type: "arrow", id: routePointPick.actionId });
    if (committed) setError(null);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const interaction = spacingGateDragRef.current ?? drawingRef.current ?? dragRef.current;
    if (interaction?.pointerId !== event.pointerId) return;
    if (!interaction.moved && interaction.clientX === event.clientX && interaction.clientY === event.clientY) return;
    interaction.moved = true;
    pointerMoves.queue({ clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId });
  }

  function applyPointerPosition(sample: PointerSample) {
    const gateDrag = spacingGateDragRef.current;
    if (gateDrag?.pointerId === sample.pointerId) {
      const point = pointFromPointer(sample, svgRef.current);
      if (!point) return;
      const path = resolvePlaybookPath(gateDrag.before, gateDrag.branchId).play;
      const gate = path.spacingGates?.gates.find((candidate) => candidate.id === gateDrag.gateId);
      if (!gate) return;
      let changed: SpacingGate = structuredClone(gate);
      if (gateDrag.kind === "move") {
        const dx = point.x - gateDrag.start.x, dy = point.y - gateDrag.start.y;
        changed.area.center = { x: gate.area.center.x + dx, y: gate.area.center.y + dy };
      } else if (changed.area.shape === "circle") {
        const centerFeetX = changed.area.center.x * 0.5, centerFeetY = changed.area.center.y * 0.47;
        const pointerFeetX = point.x * 0.5, pointerFeetY = point.y * 0.47;
        changed.area.radiusFeet = Math.max(0.5, Math.hypot(pointerFeetX - centerFeetX, pointerFeetY - centerFeetY));
      } else {
        changed.area.widthFeet = Math.max(1, Math.abs(point.x - changed.area.center.x));
        changed.area.heightFeet = Math.max(1, Math.abs(point.y - changed.area.center.y) * 0.47);
      }
      changed = clampSpacingGate(changed);
      const nextPath = clonePlaybook(path);
      nextPath.spacingGates = { version: 1, gates: (nextPath.spacingGates?.gates ?? []).map((candidate) => candidate.id === gateDrag.gateId ? changed : candidate) };
      const canonical = canonicalizeActiveDraft(nextPath, gateDrag.before, gateDrag.branchId);
      draftSession.edit(canonical); setDraftState(canonical); setDirty(draftSession.dirty); setStatus("idle");
      gateDrag.moved = true;
      return;
    }
    const interaction = drawingRef.current ?? dragRef.current;
    if (interaction?.pointerId !== sample.pointerId) return;
    const point = pointFromPointer(sample, svgRef.current);
    if (!point) return;
    if (drawingRef.current) {
      drawingRef.current.end = point;
      setDrawEnd(point);
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    // Construct the drawing before the run changes; the engine validates and
    // commits this same draft together with the marker's live relocation.
    const next = editPlaybookPoint(drag.before, drag, point);
    const canonical = canonicalizeActiveDraft(next, draftSession.current, drag.historyBranchId);
    try {
      validatePlaybookDocument(canonical);
      const executable = simulationDrawing(canonical, drag.historyBranchId);
      const editingTimeline = drag.type === "arrow-start" || drag.type === "arrow-end" || drag.type === "arrow-exit" || drag.type === "arrow-control";
      const client = simulationClientRef.current;
      if (editingTimeline && simulationActive) resetSimulation();
      else if (client) {
        if (drag.type === "ball" || drag.type === "player" || drag.type === "defender") {
          client.edit(executable, { type: drag.type, id: drag.id, point });
          simulationDrawingRef.current = executable;
          setSimulationPlaying(false);
          // Immediate drag feedback only; the acknowledged worker snapshot
          // replaces it. Never use this optimistic view as executable state.
          setSimulationFrameState((frame) => frame ? { ...frame,
            ...(drag.type === "ball" ? { ball: point } : { [drag.type === "player" ? "players" : "defenders"]: frame[drag.type === "player" ? "players" : "defenders"].map(marker => marker.id === drag.id ? { ...marker, ...point } : marker) }),
          } : frame);
        }
      }
      setDraftState(draftSession.edit(canonical));
      setDirty(draftSession.dirty);
      setStatus("idle");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The paused marker could not be moved");
    }
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const interaction = spacingGateDragRef.current ?? drawingRef.current ?? dragRef.current;
    if (interaction?.pointerId !== event.pointerId) return;
    // React state may not have rendered the last move yet. Flush synchronously
    // and read the session/ref values before creating the single undo entry.
    if (interaction.moved || interaction.clientX !== event.clientX || interaction.clientY !== event.clientY) {
      pointerMoves.flush({ clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId });
    } else pointerMoves.flush();
    const gateDrag = spacingGateDragRef.current;
    if (gateDrag) {
      const after = clonePlaybook(draftSession.current);
      clearPointerInteraction();
      if (!isSameDraft(after, gateDrag.before)) {
        if (commitCanonical(after, gateDrag.before, gateDrag.branchId, true)) setSelectedSpacingGateId(gateDrag.gateId);
      }
      return;
    }
    const currentDraft = draftSession.current;
    const drawing = drawingRef.current;
    if (drawing) {
      const { start, end } = drawing;
      if (pointDistance(start, end) > 3) {
        const pathBefore = resolvePlaybookPath(currentDraft, activeBranchId).play;
        const next = clonePlaybook(pathBefore);
        const kind: ArrowKind = tool === "pass" ? "pass" : tool === "screen" ? "screen" : tool === "slip-screen" ? "slip-screen" : tool === "handoff" ? "handoff" : tool === "pick-roll" ? "pick-roll" : "movement";
        const newArrow: PlaybookArrow = {
          id: arrowId(),
          kind,
          start,
          end,
          path: "straight",
          timing: kind === "screen" || kind === "slip-screen" || kind === "pick-roll" ? 1.4 : 1.2,
          sequence: Math.max(0, ...pathBefore.arrows.map((arrow, index) => arrowSequence(arrow, index))) + 1,
          ...(kind === "screen" || kind === "slip-screen" || kind === "pick-roll" ? {
            screener_id: nearestPlayerId(currentDraft.players, start),
            handler_id: currentDraft.ball ? nearestPlayerId(currentDraft.players, currentDraft.ball, nearestPlayerId(currentDraft.players, start)) ?? undefined : undefined,
          } : {}),
        };
        const binding = bindAuthoredActions({ ...pathBefore, arrows: [...pathBefore.arrows, newArrow] }).find((action) => action.arrow.id === newArrow.id);
        if (binding?.actorId != null) newArrow.actor_id = binding.actorId;
        if ((kind === "pass" || kind === "handoff") && binding?.recipientId != null) newArrow.recipient_id = binding.recipientId;
        next.arrows = [...next.arrows, newArrow];
        commit(next, currentDraft);
        setSelected({ type: "arrow", id: newArrow.id });
      }
      clearPointerInteraction();
      return;
    }
    finishExistingDrag();
    clearPointerInteraction();
  }

  function finishExistingDrag() {
    const drag = dragRef.current;
    if (drag && !isSameDraft(draftSession.current, drag.historyBefore)) {
      recordHistory(drag.historyBefore, drag.historyBranchId);
    }
  }

  function clearPointerInteraction() {
    const interaction = drawingRef.current ?? dragRef.current ?? spacingGateDragRef.current;
    pointerMoves.cancel();
    // Clear ownership before releasing capture: lostpointercapture also interrupts.
    drawingRef.current = null;
    dragRef.current = null;
    spacingGateDragRef.current = null;
    setDrawStart(null);
    setDrawEnd(null);
    if (interaction && svgRef.current?.hasPointerCapture(interaction.pointerId)) svgRef.current.releasePointerCapture(interaction.pointerId);
  }

  function interruptPointerInteraction(pointerId?: number) {
    const gateDrag = spacingGateDragRef.current;
    const interaction = drawingRef.current ?? dragRef.current ?? gateDrag;
    if (pointerId !== undefined && interaction?.pointerId !== pointerId) return;
    if (gateDrag) {
      draftSession.edit(gateDrag.before); setDraftState(gateDrag.before); setDirty(draftSession.dirty);
    }
    // Preserve displayed edits with one undo step; discard queued positions
    // and unfinished drawings instead of committing a cancelled action.
    finishExistingDrag();
    clearPointerInteraction();
    setOffBallScreenSelection({ screenerId: null, cutterId: null, screenPoint: null });
    setPickPopSelection({ screenerId: null, handlerId: null, screenPoint: null });
    setBackdoorCutterId(null);
  }

  function onPointerInterrupted(event: ReactPointerEvent<SVGSVGElement>) {
    interruptPointerInteraction(event.pointerId);
  }

  function onPocketDragOver(event: ReactDragEvent<SVGSVGElement>) {
    if (!event.dataTransfer.types.includes("application/x-arc-pocket-action")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onPocketDrop(event: ReactDragEvent<SVGSVGElement>) {
    const id = event.dataTransfer.getData("application/x-arc-pocket-action");
    if (!id) return;
    event.preventDefault();
    const anchor = pointFromPointer(event, event.currentTarget);
    if (!anchor) return;
    window.dispatchEvent(new CustomEvent("arc-pocket-action-drop", { detail: { id, anchor } }));
  }

  function onMarkerPointerDown(event: ReactPointerEvent<SVGElement>, selection: Selection) {
    event.stopPropagation();
    if (dragRef.current || drawingRef.current || spacingGateDragRef.current) return;
    focusBoard();
    if (!selection) return;
    if (selection.type === "arrow" && (pocketSelectionMode || event.shiftKey)) {
      event.preventDefault();
      togglePocketSelection(String(selection.id), event.shiftKey || pocketSelectionMode);
      return;
    }
    if (tool === "delete") {
      commit(removeSelection(cloneActiveDraft(), selection));
      setSelected(null);
      setTool("select");
      return;
    }
    // Marker groups stop propagation so they can be dragged in Select mode.
    // Route gate placement through this handler as well as the court's empty
    // background handler, otherwise clicking the player itself is swallowed.
    if (tool === "spacing-gate") {
      if (selection.type === "player") {
        const point = pointFromPointer(event, svgRef.current);
        if (point) placeSpacingGate(point);
      } else if (selection.type === "arrow") {
        setSelected(selection);
      } else {
        setError("Spacing gates can only track offensive players");
      }
      return;
    }
    if (tool === "pick-pop") {
      if (selection.type !== "player") {
        setError("Choose offensive players for the screen and ball handler");
        return;
      }
      const id = Number(selection.id);
      setError(null);
      if (pickPopSelection.screenerId == null) {
        setPickPopSelection({ screenerId: id, handlerId: null, screenPoint: null });
        setSelected(selection);
      } else if (pickPopSelection.handlerId == null) {
        if (pickPopSelection.screenerId === id) setError("Choose a different player as the ball handler");
        else {
          setPickPopSelection({ ...pickPopSelection, handlerId: id });
          setSelected(selection);
        }
      } else {
        setError("Click the screen location, then the pop destination");
      }
      return;
    }
    if (tool === "off-ball-screen" || tool === "pin-down") {
      if (selection.type !== "player") {
        setError("Choose offensive players for the screener and cutter");
        return;
      }
      const id = Number(selection.id);
      setError(null);
      if (offBallScreenSelection.screenerId == null) {
        setOffBallScreenSelection({ screenerId: id, cutterId: null, screenPoint: null });
        setSelected(selection);
      } else if (offBallScreenSelection.cutterId == null) {
        if (offBallScreenSelection.screenerId === id) setError("Choose a different player as the cutter");
        else {
          setOffBallScreenSelection({ ...offBallScreenSelection, cutterId: id });
          setSelected(selection);
        }
      } else {
        setError(tool === "pin-down" ? "Click the screen location, then the cutter destination" : "Click the screen location");
      }
      return;
    }
    if (tool === "backdoor-cut") {
      if (selection.type !== "player") {
        setError("Choose an offensive player for the backdoor cut");
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
      dragRef.current = { type: "arrow-end", id: selection.id, before: cloneActiveDraft(), historyBefore: clonePlaybook(draftSession.current), historyBranchId: activeBranchId, ...pointerGesture(event) };
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
    dragRef.current = { type: selection.type, id: selection.id, before: cloneActiveDraft(), historyBefore: clonePlaybook(draftSession.current), historyBranchId: activeBranchId, ...pointerGesture(event) };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function onArrowEndpointPointerDown(event: ReactPointerEvent<SVGElement>, arrow: PlaybookArrow, endpoint: "start" | "end" | "exit" | "control") {
    event.stopPropagation();
    if (dragRef.current || drawingRef.current) return;
    focusBoard();
    if (tool === "delete") {
      commit(removeSelection(cloneActiveDraft(), { type: "arrow", id: arrow.id }));
      setSelected(null);
      setTool("select");
      return;
    }
    // Endpoint handles follow the same always-draggable rule as the arrow
    // stroke, including while another drawing tool is active.
    setSelected({ type: "arrow", id: arrow.id });
    dragRef.current = { type: endpoint === "start" ? "arrow-start" : endpoint === "end" ? "arrow-end" : endpoint === "exit" ? "arrow-exit" : "arrow-control", id: arrow.id, before: cloneActiveDraft(), historyBefore: clonePlaybook(draftSession.current), historyBranchId: activeBranchId, ...pointerGesture(event) };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      interruptPointerInteraction();
      if (spacingGateRoutePick) {
        event.preventDefault();
        setSpacingGateRoutePick(null);
        setError(null);
        setTool("select");
        return;
      }
      if (pocketSelectionMode) {
        event.preventDefault();
        setPocketSelectionMode(false);
        setPocketSelectedIds([]);
        setPocketPreviewArrows([]);
        setPocketPreviewBallHandlerId(null);
        setPocketPreviewPlayerIds([]);
        setSelected(null);
        setTool("select");
        return;
      }
    }
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
        commit(removeSelection(cloneActiveDraft(), selected));
        setSelected(null);
      }
      return;
    }
    if (!selected || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const amount = event.shiftKey ? 2 : 0.75;
    const delta = { x: event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0, y: event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0 };
    const currentPoint = selected.type === "ball" ? activeDraft.ball : selected.type === "player" ? activeDraft.players.find((marker) => marker.id === selected.id) : selected.type === "defender" ? activeDraft.defenders.find((marker) => marker.id === selected.id) : activeDraft.arrows.find((arrow) => arrow.id === selected.id)?.end;
    if (currentPoint) commit(replacePoint(activeDraft, selected, { x: clamp(currentPoint.x + delta.x), y: clamp(currentPoint.y + delta.y) }));
  }

  async function exportPng() {
    setError(null);
    try {
      const svg = svgRef.current;
      if (!svg) throw new Error("PNG export could not find the court. Please try again");
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", "1600");
      clone.setAttribute("height", "1152");
      clone.style.setProperty("--orange", "#ee733f");
      clone.style.setProperty("--muted", "#b3b9b5");
      clone.querySelectorAll(".selection-handle, .drawing-preview, .adaptive-read-route, .marker-hit-target, .spacing-gate-result-label, .spacing-gate-center-handle, .spacing-gate-resize-handle").forEach((node) => node.remove());
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = `.shared-court-route{fill:none;stroke:#ee733f;stroke-width:2;stroke-dasharray:6 4}.shared-court-route.route-adjustment{stroke:#b3b9b5;stroke-width:1.5;stroke-dasharray:2 4}.shared-court-route.route-shot{stroke-dasharray:3 5}.court-floor{fill:#151819}.court-line{fill:none;stroke:#d7d2c7;stroke-width:3}.court-dash{fill:none;stroke:#8f9692;stroke-width:2;stroke-dasharray:9 10}.movement-arrow,.screen-arrow,.off-ball-screen-arrow,.pick-roll-arrow,.pick-pop-arrow,.pin-down-arrow,.backdoor-cut-arrow,.screen-cutter-arrow,.pass-arrow{fill:none;stroke-width:3}.movement-arrow{stroke:#f3f1ec}.pass-arrow{stroke:#ee733f;stroke-dasharray:9 8}.screen-arrow{stroke:#73bff0;stroke-dasharray:3 7}.off-ball-screen-arrow,.pin-down-arrow{stroke:#b4a1e8;stroke-dasharray:5 5}.screen-cutter-arrow{stroke:#f3f1ec;stroke-dasharray:6 5;opacity:.82}.pick-roll-arrow{stroke:#ee733f;stroke-width:4}.pick-pop-arrow{stroke:#f3bd67;stroke-width:4}.backdoor-cut-arrow{stroke:#7fd2a1;stroke-dasharray:7 5;stroke-width:3.5}.arrow-sequence-badge{pointer-events:none}.arrow-sequence-badge circle{fill:#202426;stroke:#ee733f;stroke-width:2;vector-effect:non-scaling-stroke}.arrow-sequence-badge text{fill:#f3f1ec;font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace;text-anchor:middle;dominant-baseline:central}.offense-marker{fill:#ee733f;stroke:#fff2ea;stroke-width:2}.defense-marker{fill:none;stroke:#73bff0;stroke-width:3}.ball-marker{fill:#d96b38;stroke:#fff2ea;stroke-width:2}.simulation-defender-number{fill:#73bff0;stroke:none;font:700 18px sans-serif;text-anchor:middle;dominant-baseline:central}.marker-number{fill:#fff8f0;font:700 18px sans-serif;text-anchor:middle;dominant-baseline:central}.marker-caption{fill:#b3b9b5;stroke:none;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;text-anchor:middle}.basket-mark{fill:none;stroke:#ee733f;stroke-width:4}#movement-arrow path{fill:#f3f1ec}#pass-arrow path{fill:#ee733f}`;
      style.textContent += `.spacing-gate-area{fill:#ee733f24;stroke:#ee733f;stroke-width:2.2;stroke-dasharray:8 5;vector-effect:non-scaling-stroke}.spacing-gate-met .spacing-gate-area{stroke:#74d39b}.spacing-gate-missed .spacing-gate-area{fill:#ff776c2e;stroke:#ff776c}.spacing-gate-not-evaluated .spacing-gate-area{stroke:#a8b0ad;stroke-dasharray:3 5}.spacing-gate-label rect{fill:#151819;stroke:#7b8581;stroke-width:1}.spacing-gate-label text{fill:#f3f1ec;font:700 10px ui-monospace,monospace;text-anchor:middle;dominant-baseline:central}.spacing-gate-instruction{fill:#f3f1ec;stroke:#151819;stroke-width:3px;paint-order:stroke;font:700 10px sans-serif;text-anchor:middle;dominant-baseline:central}`;
      if (simulationActive) style.textContent += ".marker-number,.simulation-defender-number{font-size:26px}";
      clone.prepend(style);
      const exportName = activePath.branch ? `${draft.name} — ${activePath.branch.label}` : draft.name;
      if (activePath.branch) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", "36"); label.setAttribute("y", "54"); label.setAttribute("class", "playbook-export-ending-label");
        label.textContent = activePath.branch.label;
        clone.append(label);
        style.textContent += ".playbook-export-ending-label{fill:#ee733f;font:700 22px sans-serif} .is-compare-route .shared-court-route{stroke:#b3b9b5;stroke-dasharray:8 7;opacity:.42}";
      }
      await exportPlaybookPng(clone, exportName);
    } catch (caught) {
      setError(caught instanceof Error && caught.message.startsWith("PNG export")
        ? caught.message : "PNG export failed. Please try again");
    }
  }

  const authoredRoutes = useMemo(() => authoredCourtRoutes(activeDraft), [activeDraft]);
  const mainRoutes = useMemo(() => authoredCourtRoutes(draft), [draft]);
  const changedMainActionIds = useMemo(() => new Set(mainRoutes.flatMap((route) => {
    const id = route.actionId;
    if (!id) return [];
    const status = branchActionStatus(activeDraft.arrows, draft.arrows, id);
    return status ? [id] : [];
  })), [mainRoutes, activeDraft.arrows, draft.arrows]);
  const removedMainActionIds = useMemo(() => new Set(draft.arrows.filter((arrow) => !activeDraft.arrows.some((candidate) => candidate.id === arrow.id)).map((arrow) => arrow.id)), [draft.arrows, activeDraft.arrows]);
  const compareRoutes = activeBranchId && compareMain
    ? mainRoutes.filter((route) => route.actionId && (changedMainActionIds.has(route.actionId) || removedMainActionIds.has(route.actionId)))
    : [];
  const currentBranch = activePath.branch;
  const missingForkAnchors = currentBranch?.fork.actionIds.filter((id) => !draft.arrows.some((arrow) => arrow.id === id)) ?? [];
  const forkNotice = missingForkAnchors.length
    ? missingForkAnchors.length < (currentBranch?.fork.actionIds.length ?? 0)
      ? "A simultaneous fork move was removed; the remaining move keeps this fork"
      : "The fork now follows the deleted Main move group"
    : null;
  const editingArrowId = !simulationPlaying && selected?.type === "arrow" ? selected.id : null;
  const timingPreviewRoute = authoredRoutes.find((route) => route.actionId === (routePointPick?.sourceId ?? timingPreviewActionId)
    && (routePointPick ? route.playerId === routePointPick.playerId : route.id.endsWith(":actor"))) ?? null;
  const spacingGateRoutePreview = spacingGateRoutePick ? (() => {
    const gate = activeDraft.spacingGates?.gates.find((candidate) => candidate.id === spacingGateRoutePick);
    const routePlayerId = gate?.trigger.routePlayerId ?? gate?.playerId;
    return gate && routePlayerId != null ? authoredRoutes.find((route) => route.actionId === gate.trigger.actionId && route.playerId === routePlayerId) ?? null : null;
  })() : null;
  const visibleArrows = activeDraft.arrows.filter((arrow) => arrow.id === editingArrowId || (!simulationActive && authoredRoutes.some((route) => route.actionId === arrow.id && route.id.endsWith(":actor") && routeVisible(route, arrowVisibility))));
  const currentDefenseSchemeLabel = simulationFrame.activeDefenseScheme
    ? `${simulationFrame.defenseSchemeWasAutomatic ? "Auto · " : ""}${DEFENSE_SCHEME_LABELS[simulationFrame.activeDefenseScheme]}`
    : "No possession running";
  const titleStatus = status === "saving" ? "Saving…" : status === "saved" ? `Saved · ${activeDraft.arrows.length} actions` : status === "error" ? "Save failed" : dirty ? "Unsaved changes" : "Ready to edit";

  if (view === "practice") return <ReadCoachPracticeView lesson={draft.readCoach} visibility={arrowVisibility} onExit={() => onViewChange?.("edit")} active={active} />;
  if (view === "role") {
    const rolePlay = flattenPlaybookPath(draft, activeBranchId);
    if (activeDraft.spacingGates) rolePlay.spacingGates = structuredClone(activeDraft.spacingGates);
    return <RoleRehearsalView play={rolePlay} cueSource={draft} branchId={activeBranchId}
    branchLabel={activePath.branch?.label ?? null} sharedIds={activePath.sharedIds} playerId={rolePlayerId} settings={simulationSettings}
    visibility={arrowVisibility} active={active} onViewChange={(nextView, playerId) => onViewChange?.(nextView, playerId)} onCueChange={saveRoleCue} />;
  }
  if (view === "flipbook") {
    const story = draft.flipbooks?.stories.find((item) => item.endingId === activeBranchId);
    return <PlayFlipbookView source={simulationDrawing(draft, activeBranchId)} settings={simulationSettings} visibility={arrowVisibility}
      endingId={activeBranchId} endingLabel={activePath.branch?.label ?? "Main"} story={story} initialCapture={flipbookCapture}
      active={active} onExit={() => { setFlipbookCapture(null); onViewChange?.("edit"); }}
      onChange={updateFlipbookStory} onSavePlay={() => { void saveDraft(); }} onUndo={undo} onRedo={redo}
      canUndo={history.length > 0} canRedo={future.length > 0} historyRevision={flipbookHistoryRevision} />;
  }

  return (
    <div ref={rootRef} className="playbook-page" tabIndex={-1} onKeyDown={onKeyDown} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) interruptPointerInteraction();
    }} onPointerDownCapture={(event) => {
      const target = event.target as HTMLElement;
      if (!target.closest("button, input, textarea, select")) focusBoard();
    }}>
      <div className="playbook-header">
        <div className="playbook-title-group">
          <div className="play-name-input-wrap">
            <input aria-label="Play name" value={draft.name} maxLength={80} onChange={(event) => {
              const next = cloneActiveDraft();
              next.name = event.currentTarget.value;
              setDraft(next);
              setStatus("idle");
            }} />
            <Pencil size={14} aria-hidden="true" />
          </div>
          <span className={`play-save-status play-status-${status}`}><i />{titleStatus}</span>
        </div>
        <div className="playbook-header-actions">
          <button type="button" className="button button-outline" onClick={() => onViewChange?.("practice")}><BrainCircuit size={16} />Practice reads{draft.readCoach?.checkpoints.length ? ` · ${draft.readCoach.checkpoints.length}` : ""}</button>
          <button type="button" className="button button-subtle" onClick={() => setSavedOpen(true)}><FolderOpen size={16} />Saved plays</button>
          <button type="button" className="button button-outline" onClick={exportPng}><Download size={16} />Export PNG</button>
          <button type="button" className="button button-outline" onClick={buildFlipbook}><Images size={16} />Build a walkthrough</button>
          {onTestInCounterLab ? <button type="button" className="button button-outline" onClick={() => onTestInCounterLab(flattenPlaybookPath(draft, activeBranchId, activePath.branch?.label))}><ShieldCheck size={16} />Test in Counter Lab</button> : null}
          <button type="button" className="button button-primary" onClick={() => void saveDraft()} disabled={status === "saving"}><Save size={16} />{status === "saving" ? "Saving…" : "Save play"}</button>
        </div>
      </div>
      {error ? <div className="playbook-alert" role="alert">{error}</div> : null}
      <div className="playbook-layout">
        <aside className="playbook-presets" aria-label="Playbook starting options">
          <PresetButton active={draft.name === "Ready setup" && !draft.arrows.length} icon={<Shield size={17} />} label="Ready setup" onClick={() => requestLoad(clonePlaybook(READY_SETUP))} />
          <PresetButton active={starterOpen} icon={<FolderOpen size={17} />} label="Starter plays" onClick={() => setStarterOpen(true)} />
          <PresetButton active={!draft.players.length && !draft.ball} icon={<Circle size={17} />} label="Empty court" onClick={() => requestLoad(clonePlaybook(EMPTY_COURT))} />
          <PocketActionsPanel source={activeDraft} selectedIds={pocketSelectedIds} selectionMode={pocketSelectionMode} onSelectionModeChange={(value) => { setPocketSelectionMode(value); if (!value) setPocketSelectedIds([]); }} onSelectionChange={setPocketSelectedIds} onInsert={insertPocket} onBeginPlacement={pauseSimulation} onPreview={(arrows, ballHandlerId) => { setPocketPreviewArrows(arrows); setPocketPreviewBallHandlerId(ballHandlerId); setPocketPreviewPlayerIds([...new Set(arrows.flatMap((arrow) => [arrow.actor_id, arrow.recipient_id, arrow.screener_id, arrow.handler_id, arrow.cutter_id].filter((id): id is number => id != null)))]); }} onError={setError} sharedBoundarySequence={sharedBoundarySequence} />
          <details className="playbook-action-list"><summary>Actions · {activeDraft.arrows.length}</summary><div role="group" aria-label="Edit play actions">{activeDraft.arrows.map((arrow, index) => {
            const sharedIn = (draft.branches ?? []).filter((branch) => resolvePlaybookPath(draft, branch.id).sharedIds.has(arrow.id)).length;
            const isShared = activeBranchId ? activePath.sharedIds.has(arrow.id) : sharedIn > 0;
            const affected = sharedIn + 1;
            const branchStatus = activeBranchId ? branchActionStatus(activeDraft.arrows, draft.arrows, arrow.id) : null;
            return <div className="playbook-action-row" key={arrow.id}>
              {pocketSelectionMode ? <label className="pocket-action-checkbox"><input type="checkbox" checked={pocketSelectedIds.includes(arrow.id)} onChange={() => togglePocketSelection(arrow.id)} aria-label={`Select Move ${arrowSequence(arrow, index)} for a pocket action`} />Include</label> : null}
              <button type="button" aria-pressed={selected?.type === "arrow" && selected.id === arrow.id} onClick={() => { setSimulationPlaying(false); chooseTool("select"); setSelected({ type: "arrow", id: arrow.id }); }}><strong>Move {arrowSequence(arrow, index)}</strong><span>{actionLabel(arrow.kind)}</span>{branchStatus ? <em className={`branch-action-badge branch-action-${branchStatus}`}>{branchStatus === "added" ? "Added" : "Changed"}</em> : null}{isShared ? <small>Shared opening · edits affect Main + {sharedIn} ending{sharedIn === 1 ? "" : "s"}</small> : null}</button>
              {!activeBranchId ? <button type="button" className="branch-create-action" disabled={(draft.branches?.length ?? 0) >= MAX_PLAYBOOK_BRANCHES} title={(draft.branches?.length ?? 0) >= MAX_PLAYBOOK_BRANCHES ? "A play can have at most eight endings" : `Create a branch before Move ${arrowSequence(arrow, index)}`} onClick={() => createBranch(arrow.id)}>Create a branch here</button> : null}
            </div>;
          })}</div>{activePath.branch && !activePath.branch.continuation.length ? <p>No ending actions yet</p> : !activeDraft.arrows.length ? <p>No actions drawn yet</p> : <p>Select an action to edit it, even when its arrow is hidden</p>}</details>
          <button type="button" className={`preset-button spacing-gate-visibility ${showSpacingGates ? "is-active" : ""}`} aria-pressed={showSpacingGates} onClick={() => setShowSpacingGates((current) => !current)}>
            <Target size={17} /><span>Show spacing gates</span><i className={`toggle-dot ${showSpacingGates ? "is-on" : ""}`} />
          </button>
          <section className="spacing-gate-library" aria-label="Spacing gates">
            <button type="button" className="spacing-gate-library-toggle" aria-expanded={spacingGateListOpen} onClick={() => setSpacingGateListOpen((open) => !open)}><span>Spacing gates</span><span>{activeDraft.spacingGates?.gates.length ?? 0}</span><span aria-hidden="true">{spacingGateListOpen ? "−" : "+"}</span></button>
            {spacingGateListOpen ? <div className="spacing-gate-library-list">
              {(activeDraft.spacingGates?.gates ?? []).map((gate, index) => {
                const result = spacingGateResults.find((item) => item.gateId === gate.id);
                return <button type="button" key={gate.id} className={`spacing-gate-list-item ${selectedSpacingGateId === gate.id ? "is-selected" : ""}`} onClick={() => selectSpacingGate(gate)}>
                  <span className={`spacing-gate-status-dot status-${result?.status ?? "pending"}`} aria-hidden="true">{spacingGateStatusSymbol(result?.status)}</span>
                  <span><strong>Gate {index + 1} · Player {gate.playerId}</strong><small>{gate.instruction || `${gate.rule === "inside" ? "Stay inside" : "Stay outside"} · ${spacingGateTimeDescription(gate)}`}</small></span>
                  <span className="spacing-gate-status-text">{spacingGateStatusText(result?.status)}</span>
                </button>;
              })}
              {!(activeDraft.spacingGates?.gates.length) ? <p>Choose an action, then select Spacing gate and click an offensive player</p> : null}
            </div> : null}
          </section>
          {selectedSpacingGate ? <section className="spacing-gate-inspector" aria-label="Selected spacing gate">
            <header><div><span className="section-kicker">Spacing gate</span><strong>Player {selectedSpacingGate.playerId} · {spacingGateTimeDescription(selectedSpacingGate)}</strong></div><button type="button" className="icon-button" aria-label="Delete spacing gate" title="Delete spacing gate" onClick={() => deleteSpacingGate(selectedSpacingGate.id)}><Trash2 size={15} /></button></header>
            {selectedSpacingGateResult ? <button type="button" className={`spacing-gate-result-card status-${selectedSpacingGateResult.status}`} disabled={selectedSpacingGateResult.checkedAtMs === null} onClick={() => { if (selectedSpacingGateResult.checkedAtMs !== null) seekSimulation(spacingGateOutcomeTime(selectedSpacingGateResult)); }}>
              <strong><span aria-hidden="true">{spacingGateStatusSymbol(selectedSpacingGateResult.status)}</span>{spacingGateStatusText(selectedSpacingGateResult.status)}</strong>
              <small>{selectedSpacingGateResult.reason ?? (selectedSpacingGateResult.firstViolationAtMs !== null ? `First violation · ${(selectedSpacingGateResult.firstViolationAtMs / 1000).toFixed(2)}s` : selectedSpacingGateResult.checkedAtMs !== null ? `Checked · ${(selectedSpacingGateResult.checkedAtMs / 1000).toFixed(2)}s` : "Play the possession to evaluate this expectation")}</small>
            </button> : <p className="spacing-gate-pending-note">Play the possession to evaluate this expectation</p>}
            <label><span>Player</span><select aria-label="Spacing gate player" value={String(selectedSpacingGate.playerId)} onChange={(event) => updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, playerId: Number(event.currentTarget.value) }))}>{activeDraft.players.map((player) => <option key={player.id} value={player.id}>Player {player.id}</option>)}</select></label>
            <label><span>Checkpoint action</span><select aria-label="Spacing gate checkpoint action" value={selectedSpacingGate.trigger.actionId} onChange={(event) => {
              const actionId = event.currentTarget.value;
              const action = activeDraft.arrows.find((arrow) => arrow.id === actionId);
              if (!action) return;
              const shared = !activeBranchId || activePath.sharedIds.has(action.id);
              updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, scope: shared ? "shared" : "ending", ...(shared ? { branchId: undefined } : { branchId: activeBranchId ?? undefined }), trigger: { actionId, event: "start" } }));
            }}>{activeDraft.arrows.map((action, index) => <option key={action.id} value={action.id}>Move {arrowSequence(action, index)} · {actionLabel(action.kind)}</option>)}</select></label>
            <label><span>Milestone</span><select aria-label="Spacing gate milestone" value={spacingGateRoutePick === selectedSpacingGate.id ? "route-point" : selectedSpacingGate.trigger.event} onChange={(event) => {
              const value = event.currentTarget.value as SpacingGateEvent;
              if (value === "route-point") { beginSpacingGateRoutePick(selectedSpacingGate); return; }
              setSpacingGateRoutePick(null);
              updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, trigger: { actionId: gate.trigger.actionId, event: value } }));
            }}>{spacingGateEventOptions(selectedSpacingGateAction ?? undefined).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            {selectedSpacingGate.trigger.event === "route-point" || spacingGateRoutePick === selectedSpacingGate.id ? <div className="spacing-gate-route-pick">
              <label><span>Route player</span><select aria-label="Spacing checkpoint route player" value={String(selectedSpacingGate.trigger.routePlayerId ?? selectedSpacingGate.playerId)} onChange={(event) => updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, trigger: { ...gate.trigger, routePlayerId: Number(event.currentTarget.value) } }))}>{activeDraft.players.filter((player) => authoredRoutes.some((route) => route.actionId === selectedSpacingGate.trigger.actionId && route.playerId === player.id)).map((player) => <option key={player.id} value={player.id}>Player {player.id}</option>)}</select></label>
              <button type="button" className={`button ${spacingGateRoutePick === selectedSpacingGate.id ? "button-primary" : "button-outline"}`} onClick={() => spacingGateRoutePick === selectedSpacingGate.id ? setSpacingGateRoutePick(null) : beginSpacingGateRoutePick(selectedSpacingGate)}>{spacingGateRoutePick === selectedSpacingGate.id ? "Click a point on the highlighted route" : "Choose route point"}</button>
            </div> : null}
            <div className="spacing-gate-fields">
              <label><span>Area</span><select aria-label="Spacing gate area shape" value={selectedSpacingGate.area.shape} onChange={(event) => updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, area: event.currentTarget.value === "circle" ? { shape: "circle", center: gate.area.center, radiusFeet: 3 } : { shape: "rectangle", center: gate.area.center, widthFeet: 6, heightFeet: 8 } }))}><option value="circle">Circle</option><option value="rectangle">Rectangle</option></select></label>
              <label><span>Rule</span><select aria-label="Spacing gate rule" value={selectedSpacingGate.rule} onChange={(event) => updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, rule: event.currentTarget.value as SpacingGate["rule"] }))}><option value="inside">Stay inside</option><option value="outside">Stay outside</option></select></label>
              <label><span>Center X · ft</span><input key={`${selectedSpacingGate.id}-cx-${selectedSpacingGate.area.center.x}`} aria-label="Spacing gate center X in feet" type="number" min="0" max="50" step="0.1" defaultValue={(selectedSpacingGate.area.center.x * 0.5).toFixed(1)} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value)) updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, area: { ...gate.area, center: { ...gate.area.center, x: value * 2 } } })); }} /></label>
              <label><span>Center Y · ft</span><input key={`${selectedSpacingGate.id}-cy-${selectedSpacingGate.area.center.y}`} aria-label="Spacing gate center Y in feet" type="number" min="0" max="47" step="0.1" defaultValue={(selectedSpacingGate.area.center.y * 0.47).toFixed(1)} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value)) updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, area: { ...gate.area, center: { ...gate.area.center, y: value / 0.47 } } })); }} /></label>
              {selectedSpacingGate.area.shape === "circle" ? <label><span>Radius · ft</span><input key={`${selectedSpacingGate.id}-r-${selectedSpacingGate.area.radiusFeet}`} aria-label="Spacing gate radius in feet" type="number" min="0.5" max="23.5" step="0.1" defaultValue={selectedSpacingGate.area.radiusFeet.toFixed(1)} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value)) updateSpacingGate(selectedSpacingGate.id, (gate) => gate.area.shape === "circle" ? ({ ...gate, area: { ...gate.area, radiusFeet: value } }) : gate); }} /></label> : <><label><span>Width · ft</span><input key={`${selectedSpacingGate.id}-w-${selectedSpacingGate.area.widthFeet}`} aria-label="Spacing gate width in feet" type="number" min="1" max="50" step="0.1" defaultValue={selectedSpacingGate.area.widthFeet.toFixed(1)} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value)) updateSpacingGate(selectedSpacingGate.id, (gate) => gate.area.shape === "rectangle" ? ({ ...gate, area: { ...gate.area, widthFeet: value } }) : gate); }} /></label><label><span>Height · ft</span><input key={`${selectedSpacingGate.id}-h-${selectedSpacingGate.area.heightFeet}`} aria-label="Spacing gate height in feet" type="number" min="1" max="47" step="0.1" defaultValue={selectedSpacingGate.area.heightFeet.toFixed(1)} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value)) updateSpacingGate(selectedSpacingGate.id, (gate) => gate.area.shape === "rectangle" ? ({ ...gate, area: { ...gate.area, heightFeet: value } }) : gate); }} /></label></>}
              <label><span>Before · sec</span><input key={`${selectedSpacingGate.id}-before-${selectedSpacingGate.beforeSeconds}`} aria-label="Spacing gate hold seconds before checkpoint" type="number" min="0" max="5" step="0.1" defaultValue={selectedSpacingGate.beforeSeconds.toFixed(1)} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value)) updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, beforeSeconds: value })); }} /></label>
              <label><span>After · sec</span><input key={`${selectedSpacingGate.id}-after-${selectedSpacingGate.afterSeconds}`} aria-label="Spacing gate hold seconds after checkpoint" type="number" min="0" max="5" step="0.1" defaultValue={selectedSpacingGate.afterSeconds.toFixed(1)} onBlur={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value)) updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, afterSeconds: value })); }} /></label>
            </div>
            <label><span>Instruction · optional</span><input key={`${selectedSpacingGate.id}-instruction-${selectedSpacingGate.instruction ?? ""}`} aria-label="Spacing gate instruction" maxLength={120} defaultValue={selectedSpacingGate.instruction ?? ""} onBlur={(event) => updateSpacingGate(selectedSpacingGate.id, (gate) => ({ ...gate, instruction: event.currentTarget.value.trim() || undefined }))} placeholder="Keep the corner clear" /></label>
            <small>Gate checks only observe the recorded player center · They never affect movement or the result of the play</small>
          </section> : null}
          <section className="read-coach-library" aria-label="Read Coach checkpoints">
            <header><strong>Read Coach</strong><span>{draft.readCoach?.checkpoints.length ?? 0}</span></header>
            {(draft.readCoach?.checkpoints ?? []).map((checkpoint, index) => <article className="read-coach-library-item" key={checkpoint.id}>
              <strong>{index + 1}. {checkpoint.question}</strong>
              <div><button type="button" onClick={() => openSavedReadCheckpoint(checkpoint)}>Edit lesson</button><button type="button" onClick={() => captureReadCheckpoint(checkpoint)}>Replace captured situation</button><button type="button" aria-label={`Delete checkpoint ${index + 1}`} onClick={() => deleteReadCheckpoint(checkpoint.id)}>Delete</button></div>
            </article>)}
            {!(draft.readCoach?.checkpoints.length) ? <p>Pause a live play while the ball is held to teach its next read</p> : null}
          </section>
          <button type="button" className={`preset-button ${draft.defenders_visible ? "is-active" : ""}`} onClick={() => {
            const next = cloneActiveDraft();
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
            </div> : <p className="ratings-empty">Turn on Defenders or use AI defense to add defenders first</p>}
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
              <small>Badges guide assignments and reactions. Paused edits apply when you resume</small>
            </> : null}
          </div> : null}
          <button type="button" className={`preset-button ${defenseSchemesOpen ? "is-active" : ""}`} aria-expanded={defenseSchemesOpen} aria-controls="defense-schemes-panel" onClick={() => setDefenseSchemesOpen((open) => !open)}>
            <ShieldCheck size={17} /><span>Defense schemes</span><i className={`toggle-dot ${simulationSettings.defenseScheme !== "auto" ? "is-on" : ""}`} />
          </button>
          {defenseSchemesOpen ? <div id="defense-schemes-panel" className="defense-schemes-panel" role="group" aria-label="Defensive scheme for the next possession">
            <label><span>Scheme</span><ArcSelect ariaLabel="Defensive scheme" className="arc-select--compact arc-select--full defense-scheme-select" value={simulationSettings.defenseScheme} options={DEFENSE_SCHEME_OPTIONS} onValueChange={(value) => changeSimulationSetting("defenseScheme", value as DefenseScheme)} /></label>
            <small>{simulationSettings.defenseScheme === "auto" ? "Auto draws an eligible scheme at random when a run starts" : `${DEFENSE_SCHEME_LABELS[simulationSettings.defenseScheme]} is set for the next run`}</small>
            {simulationActive ? <small className="defense-scheme-active">Current: {currentDefenseSchemeLabel}</small> : null}
            {simulationActive && simulationFrame.execution?.some((action) => action.notice) ? <span className="simulation-movement-notice" role="status">{simulationFrame.execution.filter((action) => action.notice).at(-1)?.notice}</span> : null}
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
            <small>Applied when the next simulation starts</small>
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
            </div> : <p className="ratings-empty">Add an offensive player to set ratings and badges</p>}
            {selectedRatingsPlayer ? <button type="button" className="button button-outline role-rehearse-entry" onClick={() => { pauseSimulation(); onViewChange?.("role", selectedRatingsPlayer.id); }}><UserRound size={15} />Rehearse this role</button> : null}
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
              <small>Ratings range from 1 (low) to 5 (high). New players start at 3</small>
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
                <small>Badges shape simulation decisions. Paused edits apply when you resume</small>
              </> : <p className="ratings-empty">Add an offensive player to assign badges</p>}
            </div>}
          </div> : null}
          <p className="playbook-help">Drag markers to set positions. Select an arrow to adjust its endpoint. Use Delete or the toolbar to clean up</p>
        </aside>
        <main className={`playbook-editor ${simulationActive ? "is-simulating" : ""}`}>
          {draft.branches?.length ? <div className="playbook-branch-bar">
            <div className="playbook-branch-tabs" role="tablist" aria-label="Play endings">
              <button type="button" role="tab" aria-selected={activeBranchId === null} className={`playbook-branch-tab ${activeBranchId === null ? "is-active" : ""}`} onClick={() => selectBranch(null)}>Main</button>
              {draft.branches.map((branch) => <div className={`playbook-branch-tab-item ${activeBranchId === branch.id ? "is-active" : ""}`} key={branch.id}>
                <button type="button" role="tab" aria-selected={activeBranchId === branch.id} className="playbook-branch-tab" onClick={() => selectBranch(branch.id)}>{branch.label}</button>
                {renamingBranchId === branch.id ? <input ref={branchLabelInput} className="playbook-branch-label-input" aria-label={`Rename ${branch.label}`} maxLength={40} value={branchLabelValue} onChange={(event) => setBranchLabelValue(event.currentTarget.value)} onBlur={saveBranchLabel} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveBranchLabel(); } if (event.key === "Escape") { setRenamingBranchId(null); setBranchLabelValue(branch.label); } }} /> : <>
                  <button type="button" className="playbook-branch-icon" aria-label={`Rename ${branch.label}`} title={`Rename ${branch.label}`} onClick={() => { setBranchLabelValue(branch.label); setRenamingBranchId(branch.id); }}> <Pencil size={13} /></button>
                  <button type="button" className="playbook-branch-icon" aria-label={`Delete ${branch.label}`} title={`Delete ${branch.label}`} onClick={() => deleteBranch(branch.id)}><Trash2 size={13} /></button>
                </>}
              </div>)}
            </div>
            {activeBranchId ? <div className="playbook-branch-tools">{forkNotice ? <span className="playbook-fork-notice" role="status">{forkNotice}</span> : null}<label className="playbook-compare-main"><input type="checkbox" checked={compareMain} onChange={(event) => setCompareMain(event.currentTarget.checked)} />Compare with Main</label></div> : null}
          </div> : null}
          <div className="playbook-toolbar" role="toolbar" aria-label="Playbook drawing tools">
            <ToolButton active={tool === "select"} icon={<MousePointer2 size={15} />} label="Select" title={TOOL_LABELS.select} onClick={() => chooseTool("select")} />
            <ToolButton active={tool === "player"} icon={<UserRound size={15} />} label="Add player" title={TOOL_LABELS.player} onClick={() => chooseTool("player")} />
            <ToolButton active={tool === "ball"} icon={<Circle size={15} />} label="Add ball" title={TOOL_LABELS.ball} onClick={() => chooseTool("ball")} />
            <ToolButton active={tool === "movement"} icon={<ArrowUpRight size={15} />} label="Movement" title={TOOL_LABELS.movement} onClick={() => chooseTool("movement")} />
            <ToolButton active={tool === "pass"} icon={<Send size={15} />} label="Pass" title={TOOL_LABELS.pass} onClick={() => chooseTool("pass")} />
            <ToolButton active={tool === "screen"} icon={<Shield size={15} />} label="Screen" title={TOOL_LABELS.screen} onClick={() => chooseTool("screen")} />
            <ToolButton active={tool === "slip-screen"} icon={<CornerDownRight size={15} />} label="Slip" title={TOOL_LABELS["slip-screen"]} onClick={() => chooseTool("slip-screen")} />
            <ToolButton active={tool === "handoff"} icon={<Hand size={15} />} label="Handoff" title={TOOL_LABELS.handoff} onClick={() => chooseTool("handoff")} />
            <ToolButton active={tool === "pick-roll"} icon={<ArrowUpRight size={15} />} label="Pick & roll" title={TOOL_LABELS["pick-roll"]} onClick={() => chooseTool("pick-roll")} />
            <ToolButton active={tool === "pick-pop"} icon={<ArrowUpRight size={15} />} label="Pick & pop" title={TOOL_LABELS["pick-pop"]} onClick={() => chooseTool("pick-pop")} />
            <ToolButton active={tool === "off-ball-screen"} icon={<UsersRound size={15} />} label="Off-ball screen" title={TOOL_LABELS["off-ball-screen"]} onClick={() => chooseTool("off-ball-screen")} />
            <ToolButton active={tool === "pin-down"} icon={<UsersRound size={15} />} label="Pin-down" title={TOOL_LABELS["pin-down"]} onClick={() => chooseTool("pin-down")} />
            <ToolButton active={tool === "backdoor-cut"} icon={<ArrowUpRight size={15} />} label="Backdoor cut" title={TOOL_LABELS["backdoor-cut"]} onClick={() => chooseTool("backdoor-cut")} />
            <ToolButton active={tool === "spacing-gate"} icon={<Target size={15} />} label="Spacing gate" title={TOOL_LABELS["spacing-gate"]} onClick={() => chooseTool("spacing-gate")} />
            <span className="toolbar-spacer" />
            <ToolButton icon={<BrainCircuit size={15} />} label="AI defense" title="Apply ARCade Hoops defensive AI" onClick={applyAIDefense} />
            <ToolButton icon={simulationPlaying ? <Pause size={15} /> : <Play size={15} />} label={simulationPlaying ? "Pause" : simulationPaused ? "Resume" : "Play"} title={!draft.players.length ? "Add at least one offensive player before simulating" : simulationPlaying ? "Pause play simulation" : simulationPaused ? "Resume play simulation" : "Play simulation with defensive AI"} disabled={!draft.players.length && !simulationActive} onClick={() => {
              if (simulationPlaying) pauseSimulation();
              else startSimulation();
            }} />
            <ToolButton active={tool === "delete"} icon={<Eraser size={15} />} label="Delete" title={TOOL_LABELS.delete} onClick={() => chooseTool("delete")} />
            <ToolButton disabled={!history.length} icon={<Undo2 size={15} />} label="Undo" title="Undo last edit" onClick={undo} />
            <ToolButton disabled={!future.length} icon={<Redo2 size={15} />} label="Redo" title="Redo last edit" onClick={redo} />
          </div>
          <div className="playbook-simulation-bar" role="region" aria-label="Play simulation controls">
            <ArrowVisibilityControl />
            <span className="simulation-ai-label"><ShieldCheck size={14} /> ARCade Hoops defensive AI</span>
            {simulationActive && simulationFrame.activeDefenseScheme ? <span className="simulation-scheme-label" role="status"><ShieldCheck size={13} />{currentDefenseSchemeLabel}</span> : null}
            <span className="simulation-copy">{simulationInterrupted ? "Playback interrupted · press Play to restart" : simulationPaused ? "Paused · edit the board, then resume" : simulationActive ? (simulationFrame.shotPhase === "setup" ? "Shot setup" : simulationFrame.shotPhase === "air" ? `Shot in air · ${Math.round(simulationFrame.shotProgress * 100)}%` : simulationFrame.shotPhase === "result" ? `${simulationFrame.shotResult === "made" ? "Made shot" : "Missed shot"} · ${simulationFrame.shotQuality}% quality` : simulationFrame.activeActionLabel ? `${simulationFrame.activeActionLabel} in progress` : simulationFrame.adaptiveReadLabel ? `Read: ${simulationFrame.adaptiveReadLabel}` : simulationFrame.activeSequence ? `Move ${simulationFrame.activeSequence} in progress` : "Defensive setup") : "Play to preview the sequence"}</span>
            {simulationActive && simulationFrame.adaptiveReadReason ? <span className="simulation-read-copy" role="status">{simulationFrame.adaptiveReadReason}</span> : null}
            {simulationActive && simulationFrame.defenseSchemeNotice ? <span className="simulation-scheme-notice" role="status">{simulationFrame.defenseSchemeNotice}</span> : null}
            <span className="simulation-quality" role="status">Off-ball quality <strong>{offBallQualityDisplay}</strong></span>
            <span className="simulation-quality" role="status">Defensive quality <strong>{simulationActive ? `${simulationFrame.defensiveQuality}%` : "—"}</strong></span>
            <button type="button" className="button button-outline read-coach-capture-button" disabled={!simulationClientRef.current} title={!simulationClientRef.current ? "Start a simulation, then pause while the ball is held" : "Capture the acknowledged fixed-step court state"} onClick={() => captureReadCheckpoint()}><CircleHelp size={14} />Create a read checkpoint</button>
            <button type="button" className={`simulation-settings-toggle ${settingsOpen ? "is-open" : ""}`} aria-expanded={settingsOpen} aria-controls="simulation-settings" onClick={() => setSettingsOpen((current) => !current)}><Settings2 size={14} />Settings</button>
            {simulationSession ? <label className="simulation-replay-control"><span>Replay</span><input aria-label="Playbook replay time" type="range" min={0} max={simulationSession.recordedUntilMs || 1} step="any" disabled={simulationSession.recordedUntilMs === 0 || simulationInterrupted} value={simulationSession.positionMs} aria-valuetext={`${(simulationSession.positionMs / 1000).toFixed(2)} seconds of ${(simulationSession.recordedUntilMs / 1000).toFixed(2)} recorded`} onChange={(event) => seekSimulation(Number(event.currentTarget.value))} onKeyDown={(event) => {
              const offsets: Record<string, number> = { ArrowLeft: -1000 / 30, ArrowDown: -1000 / 30, ArrowRight: 1000 / 30, ArrowUp: 1000 / 30, PageDown: -1000, PageUp: 1000 };
              if (!(event.key in offsets) && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault(); event.stopPropagation();
              seekSimulation(event.key === "Home" ? 0 : event.key === "End" ? simulationSession.recordedUntilMs : Math.max(0, Math.min(simulationSession.recordedUntilMs, simulationSession.positionMs + offsets[event.key])));
            }} /><output>{(simulationSession.positionMs / 1000).toFixed(2)} / {(simulationSession.recordedUntilMs / 1000).toFixed(2)}s</output></label> : null}
            {selectedArrow ? <>
              {timingActive ? <div className="sequence-editor sequence-timing-link"><span>Move number</span><output>{selectedArrowSequence ?? "?"}</output><button type="button" onClick={() => { setTimingOpen(true); requestAnimationFrame(() => document.getElementById("timing-mixer")?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }}>Open Timing block</button></div>
                : <label className="sequence-editor"><span>Move order</span><input aria-label="Move order" type="number" min={1} max={30} value={arrowFields.id === selectedArrow.id ? arrowFields.sequence : String(selectedArrowSequence ?? 1)} onChange={(event) => { const value = event.currentTarget.value; setArrowFields((current) => ({ ...current, id: selectedArrow.id, sequence: value })); }} onBlur={() => { const value = Number(arrowFields.sequence); if (arrowFields.id === selectedArrow.id && Number.isFinite(value) && arrowFields.sequence.trim()) changeArrowSequence(selectedArrow.id, value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>Same number runs together</small></label>}
              {["movement", "backdoor-cut", "pass", "handoff"].includes(selectedArrow.kind) ? <div className="sequence-editor"><span>{selectedArrow.kind === "pass" || selectedArrow.kind === "handoff" ? "Passer" : "Player"}</span><ArcSelect ariaLabel="Action player" className="arc-select--compact playbook-path-select" value={String(selectedArrow.actor_id ?? "auto")} options={[...(selectedArrow.kind === "backdoor-cut" ? [] : [{ value: "auto", label: `Auto · Player ${selectedParticipants?.actorId ?? "?"}` }]), ...draft.players.map((player) => ({ value: String(player.id), label: `Player ${player.id}` }))]} onValueChange={(value) => changeArrowParticipant(selectedArrow.id, "actor_id", value)} /></div> : null}
              {selectedArrow.kind === "pass" || selectedArrow.kind === "handoff" ? <div className="sequence-editor"><span>Receiver</span><ArcSelect ariaLabel="Action receiver" className="arc-select--compact playbook-path-select" value={String(selectedArrow.recipient_id ?? "auto")} options={[{ value: "auto", label: `Auto · Player ${selectedParticipants?.recipientId ?? "?"}` }, ...draft.players.filter((player) => player.id !== (selectedArrow.actor_id ?? selectedParticipants?.actorId)).map((player) => ({ value: String(player.id), label: `Player ${player.id}` }))]} onValueChange={(value) => changeArrowParticipant(selectedArrow.id, "recipient_id", value)} /></div> : null}
              <div className="sequence-editor"><span>Path</span><ArcSelect ariaLabel="Arrow path" className="arc-select--compact playbook-path-select" value={selectedArrow.path ?? "straight"} options={[{ value: "straight", label: "Straight" }, { value: "curve", label: "Curved" }]} onValueChange={(value) => changeArrowPath(selectedArrow.id, value as "straight" | "curve")} /></div>
              {!timingActive ? <label className="sequence-editor"><span>Min. seconds</span><input aria-label="Action timing" type="number" min={0.5} max={4} step={0.1} value={arrowFields.id === selectedArrow.id ? arrowFields.timing : clampTiming(selectedArrow.timing ?? 1.2).toFixed(1)} onChange={(event) => { const value = event.currentTarget.value; setArrowFields((current) => ({ ...current, id: selectedArrow.id, timing: value })); }} onBlur={() => { const value = Number(arrowFields.timing); if (arrowFields.id === selectedArrow.id && Number.isFinite(value) && arrowFields.timing.trim()) changeArrowTiming(selectedArrow.id, value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label> : null}
            </> : null}
          </div>
        {readCoachCapture ? <ReadCoachAuthorPanel session={readCoachCapture.session} frame={readCoachCapture.frame} base={draft} existing={readCoachEditing ?? undefined} visibility={arrowVisibility} onCancel={() => { previewCancelRef.current?.(); setReadCoachCapture(null); setReadCoachEditing(null); }} onSave={saveReadCheckpoint} onPreview={previewReadChoice} /> : null}
          {settingsOpen ? <div id="simulation-settings" className="simulation-settings-panel" role="group" aria-label="Simulation settings">
            <div className="simulation-setting"><span>Offense off-ball</span><ArcSelect ariaLabel="Offense off-ball style" className="arc-select--compact playbook-offense-select" value={simulationSettings.offenseOffBall} options={[{ value: "read-react", label: "Read & react" }, { value: "cuts", label: "Structured cuts" }, { value: "spacing", label: "Spacing only" }, { value: "off", label: "Off" }]} onValueChange={(value) => changeSimulationSetting("offenseOffBall", value as SimulationSettings["offenseOffBall"])} /></div>
            <div className="simulation-setting simulation-defense-setting"><span>Coverage & emphasis</span><ArcSelect ariaLabel="Coverage and defensive emphasis" className="arc-select--compact playbook-defense-select" value={simulationSettings.defenseStrategy} options={[
              { value: "help", label: "Help & recover", description: "Send weak-side help to drives, then recover" },
              { value: "contain", label: "Contain & deny", description: "Contain the handler and stay close to each assignment" },
              { value: "switch", label: "Switch screens", description: "Exchange matchups at screen use or a close handoff" },
              { value: "fight-over", label: "Fight over top", description: "Keep matchups and route the screened defender over the screen" },
              { value: "go-under", label: "Go under", description: "Keep matchups and route the screened defender below the screen" },
              { value: "drop", label: "Drop coverage", description: "The screener's defender protects the lane while the handler is covered" },
              { value: "hedge", label: "Hedge & recover", description: "Show briefly at the screen, then return to the matchup" },
              { value: "trap-rotate", label: "Trap & rotate", description: "Bring extra pressure and rotate help behind the screen or drive" },
              { value: "deny-lanes", label: "Deny passing lanes", description: "Shade off-ball defenders toward passing lanes and close on receivers" },
              { value: "protect-paint", label: "Protect paint", description: "Keep help defenders closer to the basket and drive lane" },
              { value: "off", label: "Hold positions", description: "Stay in place; overlapping players still separate" },
            ]} onValueChange={(value) => changeSimulationSetting("defenseStrategy", value as SimulationSettings["defenseStrategy"])} /></div>
            <label className="simulation-setting simulation-setting-range"><span>Off-ball intensity <output>{simulationSettings.offBallIntensity}%</output></span><input aria-label="Off-ball intensity" type="range" min={0} max={100} step={1} value={simulationSettings.offBallIntensity} onChange={(event) => changeSimulationSetting("offBallIntensity", Number(event.currentTarget.value))} /></label>
            <span className="simulation-settings-note">The scheme sets the defensive shape. Coverage and emphasis change screen, help, pressure, and recovery behavior</span>
          </div> : null}
          <div className="court-frame">
            <svg ref={svgRef} className={`court-svg ${routePointPick ? "is-route-point-pick" : ""} ${spacingGateRoutePick ? "is-spacing-gate-route-pick" : ""}`} viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Editable NBA half-court play diagram" onDragOver={onPocketDragOver} onDrop={onPocketDrop} onPointerDownCapture={(event) => spacingGateRoutePick ? onSpacingGateRoutePointPointerDown(event) : onTimingRoutePointPointerDown(event)} onPointerDown={onBackgroundPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerInterrupted} onLostPointerCapture={onPointerInterrupted}>
              <defs>
                <pattern id="court-boards" width="80" height="80" patternUnits="userSpaceOnUse"><rect width="80" height="80" fill="var(--surface)" /><path d="M0 0h80M0 40h80" stroke="rgba(255,255,255,.022)" strokeWidth="1" /><path d="M40 0v80" stroke="rgba(255,255,255,.014)" strokeWidth="1" /></pattern>
                <marker id="movement-arrow" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto"><path d="M0 0 10 5 0 10z" fill="var(--text)" /></marker>
                <marker id="pass-arrow" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto"><path d="M0 0 10 5 0 10z" fill="var(--orange)" /></marker>
              </defs>
              <rect x="0" y="0" width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} rx="8" className="court-floor" fill="url(#court-boards)" />
              <CourtMarkings />
              {simulationActive ? <CourtRoutes routes={simulationFrame.routes.filter((route) => route.actionId !== editingArrowId || editingArrowId == null)} visibility={arrowVisibility} labels /> : <CourtRoutes routes={authoredRoutes.filter((route) => !route.id.endsWith(":actor") && route.kind === "handler-support")} visibility={arrowVisibility} />}
              {!simulationActive && compareRoutes.length ? <CourtRoutes routes={compareRoutes} visibility={arrowVisibility} compare /> : null}
              {spacingGateRoutePreview ? <g className="spacing-gate-route-preview" pointerEvents="none"><CourtRoutes routes={[spacingGateRoutePreview]} visibility="all" /><text x={markerPoint(spacingGateRoutePreview.end).x} y={markerPoint(spacingGateRoutePreview.end).y - 24}>CLICK ROUTE POINT</text></g> : null}
              <SpacingGateLayer gates={activeDraft.spacingGates?.gates ?? []} results={simulationFrame.spacingGateResults ?? []} visible={showSpacingGates} selectedGateId={selectedSpacingGateId} interactive onSelect={(id) => { const gate = activeDraft.spacingGates?.gates.find((candidate) => candidate.id === id); if (gate) selectSpacingGate(gate); }} onPointerStart={beginSpacingGateDrag} />
              {timingPreviewRoute ? <g className={`timing-court-preview ${routePointPick ? "is-picking" : ""}`} pointerEvents="none"><CourtRoutes routes={[timingPreviewRoute]} visibility="all" /><circle cx={markerPoint(timingPreviewRoute.start).x} cy={markerPoint(timingPreviewRoute.start).y} r="16" /><text x={markerPoint(timingPreviewRoute.start).x} y={markerPoint(timingPreviewRoute.start).y - 24}>START</text><circle cx={markerPoint(timingPreviewRoute.end).x} cy={markerPoint(timingPreviewRoute.end).y} r="16" /><text x={markerPoint(timingPreviewRoute.end).x} y={markerPoint(timingPreviewRoute.end).y - 24}>END</text></g> : null}
              {pocketPreviewArrows.map((arrow) => {
                const participants = [arrow.actor_id, arrow.recipient_id, arrow.screener_id, arrow.handler_id, arrow.cutter_id].filter((id): id is number => id != null);
                const resolved = bindAuthoredActions({ ...activeDraft, arrows: [arrow] })[0];
                const route = { scope: arrow.kind === "pass" || arrow.kind === "handoff" || resolved?.actorId === pocketPreviewBallHandlerId ? "on-ball" as const : "off-ball" as const, importance: "main" as const };
                if (!routeVisible(route, arrowVisibility)) return null;
                const start = markerPoint(arrow.start), end = markerPoint(arrow.end);
                return <g key={`pocket-preview-${arrow.id}`} className="pocket-preview-route" pointerEvents="none"><path d={actionPath(arrow)} markerEnd={`url(#${actionMarker(arrow.kind)})`} /><circle cx={start.x} cy={start.y} r="11" /><circle cx={end.x} cy={end.y} r="11" /><text x={start.x} y={start.y - 14}>ENTRY</text><text x={end.x} y={end.y - 14}>EXIT</text><title>{participants.length ? `Player ${participants.join(", Player ")}` : "Pocket route"}</title></g>;
              })}
              {visibleArrows.map((arrow) => {
                const start = markerPoint(arrow.start);
                const end = markerPoint(arrow.end);
                const control = markerPoint(arrowControl(arrow));
                const active = selected?.type === "arrow" && selected.id === arrow.id;
                const sequence = arrowSequence(arrow, draft.arrows.findIndex((original) => original.id === arrow.id));
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
              {drawStart && drawEnd ? <path d={actionPath({ id: "preview", kind: tool === "pass" ? "pass" : tool === "screen" ? "screen" : tool === "slip-screen" ? "slip-screen" : tool === "handoff" ? "handoff" : tool === "pick-roll" ? "pick-roll" : "movement", start: drawStart, end: drawEnd, path: "straight" })} className={`drawing-preview ${actionClass(tool === "pass" ? "pass" : tool === "screen" ? "screen" : tool === "slip-screen" ? "slip-screen" : tool === "handoff" ? "handoff" : tool === "pick-roll" ? "pick-roll" : "movement")}`} markerEnd={`url(#${actionMarker(tool === "pass" ? "pass" : tool === "screen" ? "screen" : tool === "slip-screen" ? "slip-screen" : tool === "handoff" ? "handoff" : tool === "pick-roll" ? "pick-roll" : "movement")})`} /> : null}
              {(draft.defenders_visible || simulationActive) ? (simulationActive ? simulationFrame.defenders : draft.defenders).map((marker) => {
                const point = markerPoint(marker);
                const active = selected?.type === "defender" && selected.id === marker.id;
                return <g key={`defender-${marker.id}`} className={`defense-marker ${active ? "is-selected" : ""}`} onPointerDown={(event) => onMarkerPointerDown(event, { type: "defender", id: marker.id })}>
                  <circle cx={point.x} cy={point.y} r="30" className="marker-hit-target" />
                  <circle cx={point.x} cy={point.y} r={simulationActive ? 18 : 24} className="defense-marker-ring" />{simulationActive ? <text x={point.x} y={point.y + 1} className="simulation-defender-number">{marker.id}</text> : <><path d={`M${point.x - 10} ${point.y - 10}l20 20M${point.x + 10} ${point.y - 10}l-20 20`} className="defense-marker" /><text x={point.x} y={point.y + 39} className="marker-caption">D{marker.id}</text></>}
                </g>;
              }) : null}
              {(simulationActive ? simulationFrame.players : draft.players).map((marker) => {
                const point = markerPoint(marker);
                const active = selected?.type === "player" && selected.id === marker.id;
                const role = offBallScreenSelection.screenerId === marker.id ? "is-screen-screener" : offBallScreenSelection.cutterId === marker.id ? "is-screen-cutter" : pickPopSelection.screenerId === marker.id ? "is-screen-screener" : pickPopSelection.handlerId === marker.id ? "is-screen-cutter" : backdoorCutterId === marker.id ? "is-screen-cutter" : "";
                return <g key={`player-${marker.id}`} className={`offense-marker-group ${active ? "is-selected" : ""} ${role} ${pocketPreviewPlayerIds.includes(marker.id) ? "pocket-assigned-preview" : ""}`} onPointerDown={(event) => onMarkerPointerDown(event, { type: "player", id: marker.id })}>
                  <circle cx={point.x} cy={point.y} r="30" className="marker-hit-target" /><circle cx={point.x} cy={point.y} r={simulationActive ? 18 : 25} className="offense-marker" /><text x={point.x} y={point.y + 1} className="marker-number">{marker.id}</text>
                </g>;
              })}
              {(() => {
                const ball = simulationActive ? simulationFrame.ball : draft.ball;
                if (!ball) return null;
                const point = markerPoint(ball), holder = simulationFrame.players.find((player) => player.id === simulationFrame.ballHandlerId);
                const attached = simulationActive && holder && pointDistance(ball, holder) < .2;
                if (attached) { point.x += 14; point.y -= 14; }
                const radius = simulationActive ? 8 : 14;
                return <g className={`ball-marker-group ${selected?.type === "ball" ? "is-selected" : ""}`} style={{ pointerEvents: ["pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"].includes(tool) ? "none" : undefined }} onPointerDown={(event) => onMarkerPointerDown(event, { type: "ball", id: "ball" })}>
                  <circle cx={point.x} cy={point.y} r="24" className="marker-hit-target" /><circle cx={point.x} cy={point.y} r={radius} className="ball-marker" /><path d={`M${point.x - radius + 3} ${point.y}h${radius * 2 - 6}M${point.x} ${point.y - radius + 3}v${radius * 2 - 6}`} className="ball-seam" />
                </g>;
              })()}
            </svg>
            <div className="court-hint">{spacingGateRoutePick ? "Click the highlighted route to place the spacing checkpoint · Escape cancels" : routePointPick ? `Click Player ${routePointPick.playerId}'s highlighted route to place the wait point` : tool === "spacing-gate" ? "Click near a player to place a spacing gate · Escape cancels" : tool === "select" ? "Select a marker to move it" : tool === "delete" ? "Select an object to delete" : tool === "player" ? "Click the court to place a player" : tool === "ball" ? "Click the court to place the ball" : tool === "pick-pop" ? pickPopSelection.screenerId == null ? "Select the screener" : pickPopSelection.handlerId == null ? "Select the ball handler" : pickPopSelection.screenPoint == null ? "Click the screen location" : "Click the pop destination" : tool === "pin-down" ? offBallScreenSelection.screenerId == null ? "Select the screener" : offBallScreenSelection.cutterId == null ? "Select the cutter" : offBallScreenSelection.screenPoint == null ? "Click the screen location" : "Click the cutter destination" : tool === "off-ball-screen" ? offBallScreenSelection.screenerId == null ? "Select the screener" : offBallScreenSelection.cutterId == null ? "Select the cutter" : "Click a spot to set the screen" : tool === "backdoor-cut" ? backdoorCutterId == null ? "Select the cutter" : "Click the basket route destination" : "Drag across the court to draw"}</div>
          </div>
          <TimingMixerPanel id="timing-mixer" actions={activeDraft.arrows} players={activeDraft.players} bindings={timingBindings} routes={authoredRoutes} sharedActionIds={activePath.sharedIds} diagnostics={simulationFrame.execution} selectedActionId={selectedArrow?.id ?? null} routePickPending={routePointPick !== null} open={timingOpen} onOpenChange={setTimingOpen} onSelect={(id) => { if (simulationPlaying) pauseSimulation(); setTool("select"); setSelected({ type: "arrow", id }); }} onChangeStart={changeTimingStart} onChangeDuration={changeTimingDuration} onToggleSync={toggleTimingSync} onAddWait={addTimingWait} onRemoveWait={removeTimingWait} onStartRoutePick={beginRoutePointWait} onPreviewAction={setTimingPreviewActionId} />
          <div className="playbook-statusbar"><span><Hand size={14} /> {selected ? `${selected.type === "ball" ? "Ball" : selected.type === "arrow" ? `Move ${selectedArrowSequence ?? ""}` : `${selected.type === "defender" ? "Defender" : "Player"} ${selected.id}`} selected` : "Nothing selected"}</span><span>Arrows stay draggable · Arrow keys nudge · Shift for larger steps · Cmd/Ctrl Z to undo</span></div>
        </main>
        <aside className={`saved-plays-panel ${savedOpen ? "is-open" : ""}`} aria-label="Saved plays">
          <div className="saved-plays-heading"><div><span className="section-kicker">Local library</span><h2>Saved plays</h2></div><button type="button" className="icon-button" aria-label="Close saved plays" onClick={() => setSavedOpen(false)}><X size={17} /></button></div>
          {saved.length ? <div className="saved-play-list">{saved.map((play) => <SavedPlayCard key={play.id} play={play} active={draft.id === play.id} deletePending={deleteId === play.id} onOpen={() => requestLoad(clonePlaybook(play))} onDuplicate={() => duplicate(play)} onDelete={() => { if (window.confirm(`Delete ${play.name}?`)) void confirmDelete(play.id); }} />)}</div> : <div className="saved-empty"><FolderOpen size={20} /><p>Your saved diagrams will appear here</p><button type="button" onClick={() => void saveDraft()}>Save this play</button></div>}
        </aside>
      </div>
      {starterOpen ? <div className="playbook-modal-backdrop" role="presentation" onMouseDown={() => setStarterOpen(false)}><section className="playbook-modal starter-modal" role="dialog" aria-modal="true" aria-labelledby="starter-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading"><div><span className="section-kicker">Start from a diagram</span><h2 id="starter-title">Starter plays</h2></div><button type="button" className="icon-button" onClick={() => setStarterOpen(false)} aria-label="Close starter plays"><X size={17} /></button></div>
        <label className="starter-search"><Search size={15} /><input type="search" aria-label="Search starter plays" placeholder="Search sets and actions" value={starterSearch} onChange={(event) => setStarterSearch(event.currentTarget.value)} /></label>
        <div className="starter-categories" role="group" aria-label="Filter starter plays by category">{starterCategories.map((category) => <button type="button" key={category} className={starterCategory === category ? "is-active" : ""} aria-pressed={starterCategory === category} onClick={() => setStarterCategory(category)}>{category}</button>)}</div>
        <div className="starter-grid">{filteredStarterPlays.map((play) => { const details = STARTER_PLAY_DETAILS[play.name]; return <button type="button" className="starter-card" key={play.name} onClick={() => { requestLoad(clonePlaybook(play)); setStarterOpen(false); }}><MiniCourt play={play} /><span className="starter-card-copy"><span className="starter-category-label">{details?.category}</span><strong>{play.name}</strong><span>{details?.description ?? "Edit this diagram"}</span></span></button>; })}{filteredStarterPlays.length === 0 ? <p className="starter-empty">No starter plays match that search</p> : null}</div>
      </section></div> : null}
      {replacement ? <div className="playbook-modal-backdrop" role="presentation"><section className="playbook-modal replacement-modal" role="dialog" aria-modal="true" aria-labelledby="replace-title"><div className="modal-heading"><div><span className="section-kicker">Unsaved draft</span><h2 id="replace-title">Replace this play?</h2></div></div><p>Your current diagram has changes. Save it before opening the new starting point, or discard the draft</p><div className="modal-actions"><button type="button" className="button button-subtle" onClick={() => setReplacement(null)}>Cancel</button><button type="button" className="button button-outline" onClick={() => { const next = replacement; void saveDraft().then((didSave) => { if (didSave && draftSession.isCurrent(didSave) && replacementRef.current === next) { loadDraft(next); setReplacement(null); } }); }}>Save then replace</button><button type="button" className="button button-primary" onClick={() => { loadDraft(replacement); setReplacement(null); }}>Discard changes</button></div></section></div> : null}
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
  const visibility = useArrowVisibility();
  const geometry = prepareMiniCourt(play, visibility);
  return <svg className="mini-court" viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} aria-hidden="true">
    <rect x="0" y="0" width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} rx="5" className="mini-floor" />
    <CourtMarkings mini />
    {geometry.arrows.map((arrow) => <g key={arrow.id}>
      {arrow.supportPath ? <path d={arrow.supportPath} className="mini-screen-cutter" /> : null}
      <path d={arrow.path} className={arrow.className} />
      <circle cx={arrow.badge.x} cy={arrow.badge.y} r="22" className="mini-sequence-badge" />
      <text x={arrow.badge.x} y={arrow.badge.y + 1} className="mini-sequence-number">{arrow.sequence}</text>
    </g>)}
    {geometry.defenders.map((marker) => <path key={`d-${marker.id}`} d={marker.path} className="mini-defense" />)}
    {geometry.players.map((marker) => <circle key={`p-${marker.id}`} cx={marker.x} cy={marker.y} r="16" className="mini-player" />)}
    {geometry.ball ? <circle cx={geometry.ball.x} cy={geometry.ball.y} r="9" className="mini-ball" /> : null}
  </svg>;
}
