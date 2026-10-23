import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import { ArrowLeft, Check, Image, Pause, Play, Plus, Printer, Redo2, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { exportPlaybookPng } from "./exportPlaybookPng.ts";
import { ReadCoachCourt } from "./ReadCoachViews.tsx";
import { createPlaybookSimulationClient, type PlaybookSimulationClient } from "./playbookSimulationClient.ts";
import { SIMULATION_ENGINE_VERSION } from "./simulationVersion.ts";
import { courtPointToSvg, COURT_VIEWBOX } from "./courtGeometry.ts";
import { routeVisible, type ArrowVisibility } from "./arrowVisibility.ts";
import type { SimulationFrame } from "./simulation.ts";
import type { PlaybookDraft, PlayFlipbookPanel, PlayFlipbookSnapshot, PlayFlipbookStory, ReadCoachSessionRecord, SimulationSettings } from "./types.ts";

const EMPTY_FRAME: SimulationFrame = {
  routes: [], players: [], defenders: [], ball: null, ballHandlerId: null, ballPhase: "held", activeSequence: null,
  activeActionLabel: null, adaptiveReadLabel: null, adaptiveReadReason: null, adaptiveReadRoute: null,
  activeDefenseScheme: null, defenseSchemeWasAutomatic: false, defenseSchemeNotice: null, defensiveQuality: 0,
  offBallQuality: 0, shotPhase: "idle", shotProgress: 0, shotResult: "pending", shotQuality: 0,
  shotRelease: null, shooterId: null, shotStart: null, shotTarget: null,
};
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const distanceFeet = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot((a.x - b.x) * .5, (a.y - b.y) * .47);

function snapshotFromFrame(frame: SimulationFrame, atMs: number): PlayFlipbookSnapshot {
  return {
    atMs,
    players: frame.players.map(({ id, x, y }) => ({ id, x, y })),
    defenders: frame.defenders.map(({ id, x, y }) => ({ id, x, y })),
    ball: frame.ball ? { ...frame.ball } : null,
    ballHandlerId: frame.ballHandlerId ?? null,
    ballPhase: frame.ballPhase ?? "held",
    shotPhase: frame.shotPhase,
    routes: structuredClone(frame.routes ?? []),
  };
}

function frameFromSnapshot(snapshot: PlayFlipbookSnapshot, routeIds: string[] = snapshot.routes.map((route) => route.id)): SimulationFrame {
  return { ...EMPTY_FRAME, players: structuredClone(snapshot.players), defenders: structuredClone(snapshot.defenders),
    ball: snapshot.ball ? { ...snapshot.ball } : null, ballHandlerId: snapshot.ballHandlerId,
    ballPhase: snapshot.ballPhase, shotPhase: snapshot.shotPhase,
    routes: structuredClone(snapshot.routes.filter((route) => routeIds.includes(route.id))) };
}

function panelFromFrame(frame: SimulationFrame, atMs: number, caption: string, actionIds?: string[], fromMs = 0): PlayFlipbookPanel {
  const snapshot = snapshotFromFrame(frame, atMs);
  const intervalActionIds = actionIds ?? [...new Set((frame.execution ?? []).filter((action) => action.startedAtMs != null
    && action.startedAtMs <= atMs && (action.completedAtMs == null || action.completedAtMs >= fromMs)
    && !["pending", "obstructed", "conflict", "interrupted"].includes(action.phase)).map((action) => action.actionId))];
  const routes = snapshot.routes.filter((route) => route.actionId != null && intervalActionIds.includes(route.actionId));
  return { id: newId("panel"), atMs, caption, focusPlayerIds: [...new Set(routes.map((route) => route.playerId))], routeIds: routes.map((route) => route.id), snapshot };
}

function selectedStory(story: PlayFlipbookStory, panels: PlayFlipbookPanel[]): PlayFlipbookStory {
  return { ...story, panels: [...panels].sort((a, b) => a.atMs - b.atMs) };
}

function eventCandidates(previous: SimulationFrame | null, frame: SimulationFrame, atMs: number) {
  if (!previous) return [] as Array<{ label: string; actionId?: string }>;
  const found: Array<{ label: string; actionId?: string }> = [];
  const before = new Map((previous.execution ?? []).map((action) => [action.actionId, action]));
  for (const action of frame.execution ?? []) {
    const old = before.get(action.actionId);
    if (action.setAtMs != null && old?.setAtMs == null) found.push({ label: "Screen set", actionId: action.actionId });
    if (action.usedAtMs != null && old?.usedAtMs == null) found.push({ label: "Screen interaction", actionId: action.actionId });
    if (action.completedAtMs != null && old?.completedAtMs == null) {
      const kind = frame.routes.find((route) => route.actionId === action.actionId)?.kind.replaceAll("-", " ") ?? "Action";
      found.push({ label: `${kind[0].toUpperCase()}${kind.slice(1)} completed`, actionId: action.actionId });
    }
    if (action.transfer?.outcome.kind === "caught" && old?.transfer?.outcome.kind !== "caught") {
      found.push({ label: `Catch · Player ${action.transfer.receiverId ?? ""}`.trim(), actionId: action.actionId });
    }
  }
  if (frame.shotRelease && !previous.shotRelease) found.push({ label: "Shot released" });
  return found;
}

function possessionLabel(panel: PlayFlipbookPanel) {
  const { ballPhase, ballHandlerId } = panel.snapshot;
  if (ballPhase === "held") return ballHandlerId == null ? "Ball held" : `Ball held · Player ${ballHandlerId}`;
  if (ballPhase === "pass-in-flight") return "Pass in flight";
  if (ballPhase === "handoff-pending") return "Handoff pending";
  if (ballPhase === "loose") return "Loose ball";
  if (ballPhase === "shot-setup") return "Shot setup";
  if (ballPhase === "shot-in-flight") return "Shot in flight";
  return "Shot result";
}

function PanelCourt({ panel, visibility, svgRef, previous }: { panel: PlayFlipbookPanel; visibility: ArrowVisibility; svgRef?: Ref<SVGSVGElement>; previous?: PlayFlipbookPanel }) {
  const frame = frameFromSnapshot(panel.snapshot, panel.routeIds);
  const focus = new Set(panel.focusPlayerIds);
  const changedPlayers = previous ? [
    ...panel.snapshot.players.flatMap((player) => {
      if (focus.size && !focus.has(player.id)) return [];
      const old = previous.snapshot.players.find((candidate) => candidate.id === player.id);
      return old && distanceFeet(old, player) >= .25 ? [{ id: player.id, side: "Player", old, current: player }] : [];
    }),
    ...(focus.size ? [] : panel.snapshot.defenders.flatMap((player) => {
      const old = previous.snapshot.defenders.find((candidate) => candidate.id === player.id);
      return old && distanceFeet(old, player) >= .25 ? [{ id: player.id, side: "Defender", old, current: player }] : [];
    })),
  ] : [];
  const visibleRoutes = panel.snapshot.routes.filter((route) => panel.routeIds.includes(route.id) && routeVisible(route, visibility));
  const previousRouteIds = new Set(previous?.routeIds ?? []);
  const currentRouteIds = new Set(panel.routeIds);
  const routeFocus = (route: PlayFlipbookSnapshot["routes"][number]) => !focus.size || focus.has(route.playerId);
  const addedRoutes = previous ? panel.snapshot.routes.filter((route) => currentRouteIds.has(route.id) && !previousRouteIds.has(route.id) && routeVisible(route, visibility) && routeFocus(route)) : [];
  const removedRoutes = previous ? previous.snapshot.routes.filter((route) => previousRouteIds.has(route.id) && !currentRouteIds.has(route.id) && routeVisible(route, visibility) && routeFocus(route)) : [];
  return <div className="play-flipbook-court-wrap">
    <ReadCoachCourt svgRef={svgRef} frame={frame} routes={visibleRoutes} visibility={visibility} ariaLabel={`Walkthrough court at ${(panel.atMs / 1000).toFixed(2)} seconds`} />
    {previous ? <svg className="flipbook-change-overlay" viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} aria-hidden="true">
      {removedRoutes.map((route) => <path key={`removed-${route.id}`} className="route-removed" d={routeSvgPath(route)} />)}
      {addedRoutes.map((route) => <path key={`added-${route.id}`} className="route-added" d={routeSvgPath(route)} />)}
      {changedPlayers.map(({ id, side, old, current }) => {
        const from = courtPointToSvg(old), to = courtPointToSvg(current);
        return <g key={`${side}-${id}-${from.x}-${from.y}`}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} /><circle cx={from.x} cy={from.y} r="18" /><text x={from.x} y={from.y + 1}>{side === "Defender" ? `D${id}` : `P${id}`}</text></g>;
      })}
    </svg> : null}
  </div>;
}

function routeSvgPath(route: PlayFlipbookSnapshot["routes"][number]) {
  const start = courtPointToSvg(route.start), end = courtPointToSvg(route.end);
  const point = (value: { x: number; y: number }) => {
    const converted = courtPointToSvg(value);
    return `${converted.x.toFixed(2)} ${converted.y.toFixed(2)}`;
  };
  if (route.points && route.points.length > 1) return `M ${point(route.points[0])} L ${route.points.slice(1).map(point).join(" L ")}`;
  if (route.control) return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} Q ${point(route.control)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  if (route.via) return `M ${point(route.start)} L ${point(route.via)} L ${point(route.end)}`;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} L ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export function PlayFlipbookView({ source, settings, visibility, endingId, endingLabel, story, initialCapture, active, onExit, onChange, onSavePlay, onUndo, onRedo, canUndo, canRedo, historyRevision }: {
  source: PlaybookDraft; settings: SimulationSettings; visibility: ArrowVisibility; endingId: string | null; endingLabel: string;
  story?: PlayFlipbookStory; initialCapture?: { session: ReadCoachSessionRecord; frame: SimulationFrame } | null; active: boolean;
  onExit: () => void; onChange: (story: PlayFlipbookStory | null) => boolean; onSavePlay: () => void;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean; historyRevision: number;
}) {
  const clientRef = useRef<PlaybookSimulationClient | null>(null);
  const animationRef = useRef<number | null>(null);
  const previousFrameRef = useRef<SimulationFrame | null>(null);
  const acknowledgedPositionRef = useRef(0);
  const candidatesRef = useRef<Array<{ atMs: number; frame: SimulationFrame; label: string; actionId?: string }>>([]);
  const wasPlayingRef = useRef(false);
  const captureSentRef = useRef(false);
  const currentFrameRef = useRef<SimulationFrame | null>(null);
  const panelSvgs = useRef(new Map<string, SVGSVGElement>());
  const pendingPanelUpdateRef = useRef<{ panelId: string; atMs: number } | null>(null);
  const [workingStory, setWorkingStory] = useState<PlayFlipbookStory | null>(() => story ? structuredClone(story) : null);
  const workingStoryRef = useRef(workingStory);
  const onChangeRef = useRef(onChange);
  workingStoryRef.current = workingStory;
  onChangeRef.current = onChange;
  const [stagedStory, setStagedStory] = useState<PlayFlipbookStory | null>(null);
  const [currentFrame, setCurrentFrame] = useState<SimulationFrame | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(story?.panels[0]?.id ?? null);
  const [status, setStatus] = useState<"recording" | "ready" | "static" | "error">(story ? "ready" : "recording");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const [pendingTime, setPendingTime] = useState<number | null>(null);
  const [comparisonOn, setComparisonOn] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [persisted, setPersisted] = useState(Boolean(story));
  const historyRevisionRef = useRef(historyRevision);
  const selectedPanel = workingStory?.panels.find((panel) => panel.id === selectedId) ?? workingStory?.panels[0] ?? null;
  const priorPanel = selectedPanel && workingStory ? workingStory.panels[workingStory.panels.indexOf(selectedPanel) - 1] : null;
  const viewFrame = currentFrame ?? (selectedPanel ? frameFromSnapshot(selectedPanel.snapshot, selectedPanel.routeIds) : null);
  const canRebuild = Boolean(workingStory);
  const displayName = workingStory?.playName ?? source.name;
  const displayEndingLabel = workingStory?.endingLabel ?? endingLabel;

  const publish = useCallback((next: PlayFlipbookStory | null) => {
    try {
      const accepted = onChange(next);
      if (accepted) {
        const copy = next ? structuredClone(next) : null;
        workingStoryRef.current = copy;
        setWorkingStory(copy);
        setPersisted(Boolean(copy));
        setError(null);
        return true;
      }
      return false;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Walkthrough could not be saved");
      return false;
    }
  }, [onChange]);

  const launch = useCallback((record: ReadCoachSessionRecord | null, autoPlay: boolean, rebuild: boolean) => {
    clientRef.current?.dispose();
    clientRef.current = null;
    previousFrameRef.current = null;
    candidatesRef.current = [];
    wasPlayingRef.current = false;
    captureSentRef.current = false;
    currentFrameRef.current = null;
    acknowledgedPositionRef.current = 0;
    setCurrentFrame(null); setPositionMs(0); setDurationMs(0); setRecordingProgress(0); setError(null);
    setStatus(autoPlay ? "recording" : "ready");
    if (!autoPlay) setPlaying(false);
    const client = createPlaybookSimulationClient({ sessionId: crypto.randomUUID(),
      onState: (view) => {
        if (clientRef.current !== client) return;
        const frame = structuredClone(view.frame);
        currentFrameRef.current = frame;
        acknowledgedPositionRef.current = view.session.positionMs;
        setCurrentFrame(frame); setPositionMs(view.session.positionMs); setDurationMs(view.session.recordedUntilMs || view.durationMs);
        const pending = pendingPanelUpdateRef.current;
        if (pending && !view.playing && Math.abs(view.session.positionMs - pending.atMs) < 1e-4) {
          const currentStory = workingStoryRef.current;
          const targetPanel = currentStory?.panels.find((panel) => panel.id === pending.panelId);
          if (currentStory && targetPanel) {
            const fresh = panelFromFrame(frame, pending.atMs, targetPanel.caption);
            fresh.id = targetPanel.id;
            fresh.focusPlayerIds = targetPanel.focusPlayerIds;
            fresh.routeIds = targetPanel.routeIds.filter((id) => fresh.snapshot.routes.some((route) => route.id === id));
            const next = selectedStory(currentStory, currentStory.panels.map((panel) => panel.id === targetPanel.id ? fresh : panel));
            if (onChangeRef.current(next)) {
              workingStoryRef.current = structuredClone(next);
              setWorkingStory(structuredClone(next));
              setPersisted(true);
            } else setError("This timing edit could not be saved. The previous panel remains intact");
          }
          pendingPanelUpdateRef.current = null;
        }
        setRecordingProgress(view.durationMs > 0 ? Math.min(100, view.session.positionMs / view.durationMs * 100) : 0);
        setPlaying(view.playing);
        if (autoPlay) {
          if (candidatesRef.current.length === 0) candidatesRef.current.push({ atMs: 0, frame, label: "Opening" });
          for (const candidate of eventCandidates(previousFrameRef.current, frame, view.session.positionMs)) {
            const last = candidatesRef.current.at(-1);
            if (view.session.positionMs > (last?.atMs ?? -Infinity) + 180) candidatesRef.current.push({ atMs: view.session.positionMs, frame, ...candidate });
          }
          previousFrameRef.current = frame;
          if (view.playing) wasPlayingRef.current = true;
          if (!view.playing && wasPlayingRef.current && !captureSentRef.current
            && view.session.positionMs >= view.durationMs - 1e-6
            && view.session.recordedUntilMs >= view.durationMs - 1e-6) {
            captureSentRef.current = true;
            client.captureFlipbook();
          }
        }
      },
      onFlipbookCapture: (capture) => {
        if (clientRef.current !== client) return;
        const endFrame = structuredClone(capture.frame);
        const endMs = capture.session.positionMs;
        const candidates = candidatesRef.current;
        const chosen = candidates.filter((item) => item.atMs > 0 && item.atMs < endMs - 250).slice(0, 6);
        const proposed: Array<{ atMs: number; frame: SimulationFrame; caption: string; actionIds?: string[] }> = [
          { atMs: 0, frame: candidates[0]?.frame ?? endFrame, caption: "Opening", actionIds: [] as string[] },
          ...chosen.map((item) => ({ atMs: item.atMs, frame: item.frame, caption: item.label })),
        ];
        if ((proposed.at(-1)?.atMs ?? 0) >= endMs - 1) proposed[proposed.length - 1] = { atMs: endMs, frame: endFrame, caption: "Finish" };
        else if (endMs > 0) proposed.push({ atMs: endMs, frame: endFrame, caption: "Finish" });
        const panels = proposed.slice(0, 12).map((item, index) => panelFromFrame(item.frame, item.atMs, item.caption, item.actionIds,
          index > 0 ? proposed[index - 1].atMs : 0));
        const generated: PlayFlipbookStory = { id: rebuild && workingStory ? workingStory.id : newId("flipbook"), playName: source.name, endingId,
          endingLabel, recording: capture.session, panels };
        if (rebuild && workingStory) { setStagedStory(generated); setNotice("Review the rebuilt panels, then accept to replace the frozen story"); }
        else {
          workingStoryRef.current = generated;
          setWorkingStory(generated); setPersisted(false); setSelectedId(panels[0]?.id ?? null);
          setNotice("Review the suggested moments, then save the walkthrough to this play");
        }
        setStatus("ready"); setPlaying(false); setPositionMs(endMs); setDurationMs(endMs); setRecordingProgress(100);
      },
      onFailure: (message) => {
        if (clientRef.current !== client) return;
        clientRef.current = null; setPlaying(false); setStatus("error"); setError(message);
      },
    });
    clientRef.current = client;
    try {
      if (record) {
        client.openFlipbook(record);
        if (autoPlay) client.playback(true);
      } else {
        if (!source.players.length) throw new Error("Add at least one player before building a walkthrough");
        client.start(source, settings);
      }
      setPlaying(autoPlay);
    } catch (caught) {
      client.dispose(); clientRef.current = null; setStatus("error"); setPlaying(false);
      setError(caught instanceof Error ? caught.message : "Walkthrough recording could not start");
    }
  }, [endingId, endingLabel, rebuilding, settings, source, workingStory]);

  useEffect(() => {
    if (story) {
      setWorkingStory(structuredClone(story));
      setSelectedId(story.panels[0]?.id ?? null);
      if (story.recording.engineVersion === SIMULATION_ENGINE_VERSION) launch(story.recording, false, false);
      else { setStatus("static"); setPositionMs(story.panels[0]?.atMs ?? 0); setDurationMs(story.recording.positionMs); setNotice("This frozen walkthrough is still available. Playback reconstruction needs the matching simulation engine"); }
    } else if (initialCapture && initialCapture.session.engineVersion === SIMULATION_ENGINE_VERSION) {
      launch(initialCapture.session, true, false);
    } else launch(null, true, false);
    return () => {
      clientRef.current?.dispose(); clientRef.current = null;
      if (animationRef.current != null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
    // A walkthrough uses a frozen recording for the full mount lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (historyRevisionRef.current === historyRevision) return;
    historyRevisionRef.current = historyRevision;
    pendingPanelUpdateRef.current = null;
    if (!story) {
      clientRef.current?.dispose();
      clientRef.current = null;
      workingStoryRef.current = null;
      setWorkingStory(null); setPersisted(false); setPlaying(false); setStatus("ready");
      setCurrentFrame(null); setPositionMs(0); setDurationMs(0);
      setNotice("Undo restored the play without this walkthrough");
      return;
    }
    workingStoryRef.current = structuredClone(story);
    setWorkingStory(structuredClone(story)); setPersisted(true);
    const nextPanel = story.panels.find((panel) => panel.id === selectedId) ?? story.panels[0] ?? null;
    setSelectedId(nextPanel?.id ?? null); setCaptionDraft(nextPanel?.caption ?? ""); setPendingTime(nextPanel?.atMs ?? null);
    if (story.recording.engineVersion === SIMULATION_ENGINE_VERSION) launch(story.recording, false, false);
    else {
      clientRef.current?.dispose(); clientRef.current = null;
      setCurrentFrame(null); setPositionMs(nextPanel?.atMs ?? 0); setDurationMs(story.recording.positionMs); setPlaying(false); setStatus("static");
      setNotice("This frozen walkthrough is still available. Playback reconstruction needs the matching simulation engine");
    }
  }, [historyRevision, launch, selectedId, story]);

  useEffect(() => {
    if (!active || document.hidden) {
      clientRef.current?.playback(false); setPlaying(false); return;
    }
    if (!playing) return;
    let previous = performance.now();
    const tick = (now: number) => {
      if (!active || document.hidden) { clientRef.current?.playback(false); setPlaying(false); return; }
      clientRef.current?.advance(Math.min(50, Math.max(0, now - previous))); previous = now;
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => { if (animationRef.current != null) cancelAnimationFrame(animationRef.current); animationRef.current = null; };
  }, [active, playing]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) { clientRef.current?.playback(false); setPlaying(false); } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => { setCaptionDraft(selectedPanel?.caption ?? ""); setPendingTime(selectedPanel?.atMs ?? null); }, [selectedPanel?.id]);

  const updatePanels = (panels: PlayFlipbookPanel[]) => {
    if (!workingStory) return false;
    const next = selectedStory(workingStory, panels);
    if (!publish(next)) return false;
    return true;
  };

  function commitCaption() {
    if (!selectedPanel || !workingStory || captionDraft === selectedPanel.caption) return;
    updatePanels(workingStory.panels.map((panel) => panel.id === selectedPanel.id ? { ...panel, caption: captionDraft.slice(0, 160) } : panel));
  }

  function seek(time: number) {
    pendingPanelUpdateRef.current = null;
    const clamped = Math.max(0, Math.min(durationMs, time));
    setPlaying(false); clientRef.current?.seek(clamped); setPositionMs(clamped);
  }

  function play() {
    if (!clientRef.current || status === "static") return;
    if (positionMs >= durationMs - 1) { clientRef.current.seek(0); setPositionMs(0); }
    clientRef.current.playback(true); setPlaying(true);
  }

  function selectPanel(panel: PlayFlipbookPanel) {
    pendingPanelUpdateRef.current = null;
    setSelectedId(panel.id); setCaptionDraft(panel.caption); setPendingTime(panel.atMs); seek(panel.atMs);
  }

  function addCurrentMoment() {
    const acknowledgedFrame = currentFrameRef.current;
    if (!workingStory || !acknowledgedFrame || Math.abs(acknowledgedPositionRef.current - positionMs) > 1e-3 || workingStory.panels.length >= 12) return;
    const at = Math.max(0, Math.min(acknowledgedPositionRef.current, durationMs));
    if (workingStory.panels.some((panel) => Math.abs(panel.atMs - at) < 1)) { setNotice("A panel already marks this recorded moment"); return; }
    const precedingTime = workingStory.panels.filter((panel) => panel.atMs < at).at(-1)?.atMs ?? 0;
    const panel = panelFromFrame(acknowledgedFrame, at, "New moment", undefined, precedingTime);
    const next = selectedStory(workingStory, [...workingStory.panels, panel]);
    if (publish(next)) { setSelectedId(panel.id); setCaptionDraft(panel.caption); setNotice("Moment added to the walkthrough"); }
  }

  function deleteSelected() {
    if (!workingStory || !selectedPanel || workingStory.panels.length <= 1) return;
    const remaining = workingStory.panels.filter((panel) => panel.id !== selectedPanel.id);
    if (publish({ ...workingStory, panels: remaining })) setSelectedId(remaining[Math.max(0, workingStory.panels.indexOf(selectedPanel) - 1)]?.id ?? remaining[0]?.id ?? null);
  }

  function updatePanelTime(atMs: number) {
    if (!workingStory || !selectedPanel || !Number.isFinite(atMs)) return;
    const index = workingStory.panels.findIndex((panel) => panel.id === selectedPanel.id);
    const min = index > 0 ? workingStory.panels[index - 1].atMs + 1 : 0;
    const max = index < workingStory.panels.length - 1 ? workingStory.panels[index + 1].atMs - 1 : durationMs;
    const safe = Math.max(min, Math.min(max, atMs));
    setPendingTime(safe);
    pendingPanelUpdateRef.current = { panelId: selectedPanel.id, atMs: safe };
    setPlaying(false);
    clientRef.current?.seek(safe);
    setPositionMs(safe);
  }

  function updateFocus(playerId: number, enabled: boolean) {
    if (!workingStory || !selectedPanel) return;
    const focusPlayerIds = enabled ? [...selectedPanel.focusPlayerIds, playerId] : selectedPanel.focusPlayerIds.filter((id) => id !== playerId);
    updatePanels(workingStory.panels.map((panel) => panel.id === selectedPanel.id ? { ...panel, focusPlayerIds } : panel));
  }

  function updateRoute(routeId: string, enabled: boolean) {
    if (!workingStory || !selectedPanel) return;
    const routeIds = enabled ? [...selectedPanel.routeIds, routeId] : selectedPanel.routeIds.filter((id) => id !== routeId);
    updatePanels(workingStory.panels.map((panel) => panel.id === selectedPanel.id ? { ...panel, routeIds } : panel));
  }

  function rebuild() {
    if (!workingStory) return;
    setRebuilding(true); setStagedStory(null); setNotice("The existing frozen story stays intact while a replacement is prepared");
    launch(null, true, true);
  }

  function acceptRebuild() {
    if (!stagedStory) return;
    if (publish(stagedStory)) { setStagedStory(null); setRebuilding(false); setSelectedId(stagedStory.panels[0]?.id ?? null); setNotice("Rebuilt walkthrough accepted"); }
  }

  function saveWalkthrough() {
    if (!workingStory) return;
    const current = selectedPanel && captionDraft !== selectedPanel.caption
      ? { ...workingStory, panels: workingStory.panels.map((panel) => panel.id === selectedPanel.id ? { ...panel, caption: captionDraft.slice(0, 160) } : panel) }
      : workingStory;
    if (publish(current)) setNotice("Walkthrough saved to this play · Save the play to keep it after leaving");
  }

  async function exportPng() {
    try {
      const storyToExport = workingStory;
      if (!storyToExport) throw new Error("Save a walkthrough before exporting the storyboard");
      const panels = storyToExport.panels;
      const columns = 2, cardW = 720, cardH = 455, headerH = 110, rows = Math.ceil(panels.length / columns);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg"); svg.setAttribute("width", String(cardW * columns)); svg.setAttribute("height", String(headerH + cardH * rows));
      svg.setAttribute("viewBox", `0 0 ${cardW * columns} ${headerH + cardH * rows}`);
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = `.court-floor{fill:#151819}.court-line{fill:none;stroke:#d7d2c7;stroke-width:3}.court-dash{fill:none;stroke:#8f9692;stroke-width:2;stroke-dasharray:9 10}.shared-court-route{fill:none;stroke:#ee733f;stroke-width:2}.shared-court-route.route-adjustment{stroke:#b3b9b5;stroke-dasharray:3 4}.read-player circle{fill:#ee733f;stroke:#fff2ea;stroke-width:2}.read-player text,.read-defender text{fill:#fff8f0;font:700 18px sans-serif;text-anchor:middle;dominant-baseline:central}.read-defender circle{fill:#151819;stroke:#73bff0;stroke-width:3}.read-ball{fill:#ee733f;stroke:#fff2ea;stroke-width:2}.flipbook-change-overlay line{stroke:#ee733f;stroke-width:3;stroke-dasharray:5 4}.flipbook-change-overlay circle{fill:#ee733f44;stroke:#ee733f;stroke-width:2}.flipbook-change-overlay text{fill:#fff;font:700 14px sans-serif;text-anchor:middle;dominant-baseline:central}`;
      svg.append(style);
      const background = document.createElementNS(svg.namespaceURI, "rect"); background.setAttribute("width", "100%"); background.setAttribute("height", "100%"); background.setAttribute("fill", "#101314"); svg.append(background);
      const addText = (text: string, x: number, y: number, size: number, color = "#f2f1ed", weight = "600") => {
        const element = document.createElementNS(svg.namespaceURI, "text"); element.setAttribute("x", String(x)); element.setAttribute("y", String(y)); element.setAttribute("fill", color); element.setAttribute("font-family", "Arial, sans-serif"); element.setAttribute("font-size", String(size)); element.setAttribute("font-weight", weight); element.textContent = text; svg.append(element);
      };
      addText(`${storyToExport.playName} · ${storyToExport.endingLabel}`, 36, 44, 27, "#ee733f", "700");
      addText("Play Flipbook", 36, 77, 16, "#b3b9b5");
      panels.forEach((panel, index) => {
        const x = (index % columns) * cardW + 28, y = headerH + Math.floor(index / columns) * cardH;
        const box = document.createElementNS(svg.namespaceURI, "rect"); box.setAttribute("x", String(x)); box.setAttribute("y", String(y + 8)); box.setAttribute("width", String(cardW - 56)); box.setAttribute("height", String(cardH - 24)); box.setAttribute("rx", "12"); box.setAttribute("fill", "#191e20"); box.setAttribute("stroke", "#394143"); svg.append(box);
        const court = panelSvgs.current.get(panel.id);
        if (court) {
          const nested = court.cloneNode(true) as SVGSVGElement;
          nested.setAttribute("x", String(x + 12)); nested.setAttribute("y", String(y + 20)); nested.setAttribute("width", String(cardW - 80)); nested.setAttribute("height", "280");
          nested.removeAttribute("ref"); nested.querySelectorAll(".selection-handle,.marker-hit-target").forEach((node) => node.remove()); svg.append(nested);
        }
        addText(`${index + 1}  ·  ${(panel.atMs / 1000).toFixed(2)} s`, x + 18, y + 328, 14, "#ee733f", "700");
        const caption = panel.caption || "Untitled moment";
        const captionLines = wrapCaption(caption, 56);
        const captionText = document.createElementNS(svg.namespaceURI, "text");
        captionText.setAttribute("x", String(x + 18)); captionText.setAttribute("y", String(y + 357)); captionText.setAttribute("fill", "#f2f1ed"); captionText.setAttribute("font-family", "Arial, sans-serif"); captionText.setAttribute("font-size", "19"); captionText.setAttribute("font-weight", "600");
        captionLines.slice(0, 3).forEach((line, lineIndex) => { const span = document.createElementNS(svg.namespaceURI, "tspan"); span.setAttribute("x", String(x + 18)); span.setAttribute("dy", lineIndex === 0 ? "0" : "21"); span.textContent = line; captionText.append(span); });
        svg.append(captionText);
        if (comparisonOn && index > 0) addText(changeSummary(panels[index - 1], panel).slice(0, 90), x + 18, y + 423, 12, "#b3b9b5");
      });
      await exportPlaybookPng(svg, `${storyToExport.playName} — ${storyToExport.endingLabel} — walkthrough`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Storyboard export could not start"); }
  }

  if (status === "recording" && !workingStory) {
    const hasFrame = Boolean(viewFrame);
    const recordingPanel = viewFrame ? panelFromFrame(viewFrame, positionMs, "Recording current moment") : null;
    return <main className="playbook-page playbook-flipbook">
      <header className="flipbook-header"><div><span className="section-kicker">Playbook · Play Flipbook</span><h1>Build a walkthrough</h1><p>{source.name} · {endingLabel}</p></div><button className="button button-subtle" onClick={onExit}><ArrowLeft size={15} />Back to editing</button></header>
      <section className="flipbook-recording"><div className="flipbook-recording-court">{hasFrame && recordingPanel ? <PanelCourt panel={recordingPanel} visibility={visibility} /> : <div className="flipbook-recording-placeholder">Preparing the full possession recording</div>}</div><div className="flipbook-recording-copy"><span className="flipbook-recording-pulse" /><h2>Recording this ending</h2><p>Play Flipbook is capturing the complete simulation, including passes, screens, catches, and shots. This stays in your browser</p><div className="flipbook-progress"><span style={{ width: `${recordingProgress}%` }} /></div><small>{Math.round(recordingProgress)}% · {Math.max(0, durationMs - positionMs) / 1000 < 1 ? "Finalizing moments" : `${((durationMs - positionMs) / 1000).toFixed(1)} seconds remaining`}</small><div className="flipbook-recording-actions"><button className="button button-outline" onClick={() => { const resume = !playing; clientRef.current?.playback(resume); setPlaying(resume); }} disabled={status !== "recording"}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? "Pause recording" : "Resume recording"}</button><button className="button button-outline" onClick={() => { setError("Walkthrough recording cancelled"); setStatus("error"); setRebuilding(false); clientRef.current?.dispose(); clientRef.current = null; }}><X size={15} />Cancel</button></div>{error ? <p className="flipbook-error" role="alert">{error} <button type="button" onClick={() => launch(null, true, false)}>Retry recording</button></p> : null}</div></section>
    </main>;
  }

  if (!workingStory) return <main className="playbook-page playbook-flipbook"><header className="flipbook-header"><div><span className="section-kicker">Playbook · Play Flipbook</span><h1>Build a walkthrough</h1></div><button className="button button-subtle" onClick={onExit}><ArrowLeft size={15} />Back to editing</button></header><section className="flipbook-empty"><h2>Walkthrough could not be prepared</h2><p>{error ?? "Check the play and try again"}</p><button className="button button-primary" onClick={() => launch(null, true, false)}><RefreshCw size={15} />Try again</button></section></main>;

  const currentPanelIndex = selectedPanel ? workingStory.panels.findIndex((panel) => panel.id === selectedPanel.id) : -1;
  const routeChoices = selectedPanel?.snapshot.routes ?? [];
  const playerChoices = selectedPanel?.snapshot.players ?? [];
  const currentFrameMatchesPosition = currentFrame && Math.abs(acknowledgedPositionRef.current - positionMs) < 1e-3;
  const livePanel = selectedPanel && currentFrameMatchesPosition ? { ...selectedPanel, atMs: positionMs,
    routeIds: selectedPanel.routeIds.filter((id) => currentFrame!.routes.some((route) => route.id === id)),
    snapshot: snapshotFromFrame(currentFrame!, positionMs) } : selectedPanel;
  const routePanel = (panel: PlayFlipbookPanel, previous?: PlayFlipbookPanel, hidden = false) => <PanelCourt key={`${panel.id}-${hidden ? "print" : "preview"}`} panel={panel} previous={previous} visibility={visibility} svgRef={hidden ? (element) => { if (element) panelSvgs.current.set(panel.id, element); else panelSvgs.current.delete(panel.id); } : undefined} />;

  return <main className="playbook-page playbook-flipbook">
    <header className="flipbook-header"><div><span className="section-kicker">Playbook · {displayEndingLabel}</span><h1>Play Flipbook</h1><p>{displayName} · {workingStory.panels.length} moments</p></div><div className="flipbook-header-actions">{!persisted ? <button className="button button-primary" onClick={saveWalkthrough}><Check size={15} />Save walkthrough</button> : null}<button className="button button-outline" onClick={onUndo} disabled={!canUndo}><Undo2 size={15} />Undo</button><button className="button button-outline" onClick={onRedo} disabled={!canRedo}><Redo2 size={15} />Redo</button><button className="button button-outline" onClick={onSavePlay} disabled={!persisted} title={!persisted ? "Save the walkthrough to the play first" : undefined}><Check size={15} />Save play</button><button className="button button-subtle" onClick={onExit}><ArrowLeft size={15} />Back to editing</button></div></header>
    {error ? <div className="playbook-alert" role="alert">{error}</div> : null}{notice ? <div className="flipbook-notice" role="status">{notice}</div> : null}
    {rebuilding && status === "recording" ? <div className="flipbook-recording-banner" role="status"><span>Rebuilding from the current play · {Math.round(recordingProgress)}%</span><div className="flipbook-progress"><span style={{ width: `${recordingProgress}%` }} /></div><button className="button button-subtle" onClick={() => { clientRef.current?.dispose(); clientRef.current = null; setPlaying(false); setStatus("ready"); setRebuilding(false); setNotice("The existing walkthrough was kept"); }}>Cancel rebuild</button></div> : null}
    <div className="flipbook-workbench">
      <section className="flipbook-viewer" aria-label="Walkthrough preview">
        <div className="flipbook-preview-heading"><span><strong>Moment {Math.max(1, currentPanelIndex + 1)}</strong><small>{(positionMs / 1000).toFixed(2)} s · {possessionLabel(selectedPanel!)}</small></span><button className={`flipbook-switch ${comparisonOn ? "is-on" : ""}`} type="button" aria-pressed={comparisonOn} onClick={() => setComparisonOn((value) => !value)}>What changed?</button></div>
        <div className="flipbook-main-court">{livePanel ? routePanel(livePanel, comparisonOn ? priorPanel ?? undefined : undefined) : null}<div className="flipbook-court-time">{(positionMs / 1000).toFixed(2)} s</div></div>
        {selectedPanel ? <div className="flipbook-caption-preview">{selectedPanel.caption || "Add a caption for this moment"}</div> : null}
        {comparisonOn && selectedPanel && priorPanel ? <div className="flipbook-change-summary"><strong>What changed?</strong><span>{changeSummary(priorPanel, selectedPanel)}</span></div> : null}
        <div className="flipbook-transport"><button className="button button-outline" onClick={() => playing ? (clientRef.current?.playback(false), setPlaying(false)) : play()} disabled={status === "static"}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? "Pause" : "Play"}</button><input aria-label="Walkthrough playback position" type="range" min="0" max={Math.max(1, durationMs)} step="1" value={Math.min(positionMs, durationMs)} onChange={(event) => seek(Number(event.currentTarget.value))} /><span>{(durationMs / 1000).toFixed(1)} s</span></div>
      </section>
      <aside className="flipbook-editor" aria-label="Walkthrough panel editor">
        <div className="flipbook-panel-heading"><div><span className="section-kicker">Story panels</span><h2>Tell the possession</h2></div><span>{workingStory.panels.length}/12</span></div>
        <div className="flipbook-panel-strip" role="list" aria-label="Walkthrough moments">{workingStory.panels.map((panel, index) => <button type="button" role="listitem" key={panel.id} className={`flipbook-panel-chip ${selectedPanel?.id === panel.id ? "is-selected" : ""}`} onClick={() => selectPanel(panel)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{panel.caption || "Untitled moment"}</strong><small>{(panel.atMs / 1000).toFixed(2)} s</small></button>)}</div>
        <div className="flipbook-editor-fields">
          <label><span>Caption</span><textarea value={captionDraft} maxLength={160} rows={2} onChange={(event) => setCaptionDraft(event.currentTarget.value)} onBlur={commitCaption} placeholder="Describe what happens in this moment" /></label>
          <div className="flipbook-time-row"><label><span>Captured time (seconds)</span><input type="number" min="0" max={(durationMs / 1000).toFixed(3)} step="0.001" value={((pendingTime ?? selectedPanel?.atMs ?? 0) / 1000).toFixed(3)} onChange={(event) => setPendingTime(Math.max(0, Number(event.currentTarget.value || 0) * 1000))} onBlur={() => pendingTime != null && pendingTime !== selectedPanel?.atMs ? updatePanelTime(pendingTime) : undefined} /></label><button className="button button-outline" type="button" onClick={() => updatePanelTime(positionMs)} disabled={!currentFrame}>Capture current moment</button></div>
          <details className="flipbook-refine"><summary>Refine this panel</summary><div><strong>Players in focus</strong>{playerChoices.map((player) => <label key={player.id}><input type="checkbox" checked={selectedPanel?.focusPlayerIds.includes(player.id) ?? false} onChange={(event) => updateFocus(player.id, event.currentTarget.checked)} />Player {player.id}</label>)}<strong>Routes shown</strong>{routeChoices.length ? routeChoices.map((route) => <label key={route.id}><input type="checkbox" checked={selectedPanel?.routeIds.includes(route.id) ?? false} onChange={(event) => updateRoute(route.id, event.currentTarget.checked)} />{route.kind.replaceAll("-", " ")} · Player {route.playerId}</label>) : <small>No recorded routes at this moment</small>}</div></details>
          <div className="flipbook-actions"><button className="button button-outline" type="button" onClick={addCurrentMoment} disabled={!currentFrame || Math.abs(acknowledgedPositionRef.current - positionMs) > 1e-3 || workingStory.panels.length >= 12}><Plus size={15} />Add current moment</button><button className="button button-subtle flipbook-delete" type="button" onClick={deleteSelected} disabled={workingStory.panels.length <= 1 || !selectedPanel}><Trash2 size={15} />Delete panel</button></div>
          <label className="flipbook-panel-time"><span>Adjust selected moment</span><input type="range" min="0" max={Math.max(1, durationMs)} step="1" value={pendingTime ?? selectedPanel?.atMs ?? 0} onChange={(event) => setPendingTime(Number(event.currentTarget.value))} onPointerUp={() => pendingTime != null && updatePanelTime(pendingTime)} onKeyUp={() => pendingTime != null && updatePanelTime(pendingTime)} /></label>
          {stagedStory ? <div className="flipbook-rebuild-review"><strong>Replacement ready for review</strong><span>The current saved story is still preserved</span><button className="button button-primary" onClick={acceptRebuild}><Check size={14} />Accept rebuilt walkthrough</button><button className="button button-subtle" onClick={() => { setStagedStory(null); setRebuilding(false); setNotice("The existing walkthrough was kept"); }}>Keep existing story</button></div> : null}
        </div>
      </aside>
    </div>
    <div className="flipbook-story-controls"><span>{status === "static" ? "Frozen snapshots · playback unavailable for this engine version" : "Frozen recording · panel edits do not change the play"}</span><div>{canRebuild ? <button className="button button-outline" onClick={rebuild} disabled={status === "recording"}><RefreshCw size={15} />Rebuild from current play</button> : null}<button className="button button-outline" onClick={exportPng}><Image size={15} />Export storyboard PNG</button><button className="button button-subtle" onClick={() => window.print()}><Printer size={15} />Print / Save PDF</button></div></div>
    <section className="flipbook-change-list" aria-label="Panel changes">{workingStory.panels.slice(1).map((panel, index) => { const previous = workingStory.panels[index]; return <article key={panel.id}><span>Between moments {index + 1} and {index + 2}</span><strong>{comparisonOn ? changeSummary(previous, panel) : "Comparison hidden"}</strong></article>; })}</section>
    <section className="flipbook-print-story" aria-label="Printable storyboard">{workingStory.panels.map((panel, index) => <article className="flipbook-print-panel" key={panel.id}><header><strong>Moment {index + 1}</strong><span>{(panel.atMs / 1000).toFixed(2)} s · {possessionLabel(panel)}</span></header>{routePanel(panel, comparisonOn && index > 0 ? workingStory.panels[index - 1] : undefined, true)}<h2>{panel.caption || "Untitled moment"}</h2>{comparisonOn && index > 0 ? <p>{changeSummary(workingStory.panels[index - 1], panel)}</p> : null}</article>)}</section>
  </main>;
}

function changeSummary(previous: PlayFlipbookPanel, current: PlayFlipbookPanel) {
  const focus = new Set(current.focusPlayerIds);
  const movedOffense = current.snapshot.players.filter((player) => {
    if (focus.size && !focus.has(player.id)) return false;
    const old = previous.snapshot.players.find((candidate) => candidate.id === player.id);
    return old && distanceFeet(old, player) >= .25;
  }).map((player) => player.id);
  const movedDefense = focus.size ? [] : current.snapshot.defenders.filter((player) => {
    const old = previous.snapshot.defenders.find((candidate) => candidate.id === player.id);
    return old && distanceFeet(old, player) >= .25;
  }).map((player) => player.id);
  const possessionChanged = previous.snapshot.ballPhase !== current.snapshot.ballPhase || previous.snapshot.ballHandlerId !== current.snapshot.ballHandlerId;
  const oldRoutes = new Set(previous.routeIds), newRoutes = new Set(current.routeIds);
  const added = [...newRoutes].filter((id) => !oldRoutes.has(id)).length;
  const removed = [...oldRoutes].filter((id) => !newRoutes.has(id)).length;
  const changes: string[] = [];
  if (movedOffense.length) changes.push(`Players ${movedOffense.join(", ")} moved at least 0.25 feet`);
  if (movedDefense.length) changes.push(`Defenders ${movedDefense.join(", ")} moved at least 0.25 feet`);
  if (possessionChanged) changes.push(`${possessionLabel(previous)} → ${possessionLabel(current)}`);
  if (added || removed) changes.push(`${added} route${added === 1 ? "" : "s"} appeared · ${removed} disappeared`);
  return changes.length ? changes.join(" · ") : "No recorded change";
}

function wrapCaption(value: string, limit: number) {
  const lines: string[] = [];
  let current = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    if (word.length > limit) {
      if (current) { lines.push(current); current = ""; }
      for (let offset = 0; offset < word.length; offset += limit) lines.push(word.slice(offset, offset + limit));
      continue;
    }
    if (!current) current = word;
    else if (`${current} ${word}`.length <= limit) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
