import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Circle, Play, Pause, Shield, Trash2, X } from "lucide-react";
import { bindAuthoredActions } from "./simulation.ts";
import { createPlaybookSimulationClient, type PlaybookSimulationClient } from "./playbookSimulationClient.ts";
import type { SimulationView } from "./playbookSimulationProtocol.ts";
import { ReadCoachCourt } from "./ReadCoachViews.tsx";
import { baitPayoffActionSignature, baitPayoffInteractionEndMs, baitPayoffParticipants, evaluateBaitPayoffReaction, milestoneTime, scriptedBaitPayoffSettings, type BaitPayoffSample } from "./baitPayoff.ts";
import type { ArrowVisibility } from "./arrowVisibility.ts";
import type { BaitPayoffArea, BaitPayoffConnection, BaitPayoffEvent, BaitPayoffReaction, PlaybookArrow, PlaybookDraft, SimulationSettings } from "./types.ts";
import { BaitPayoffAreaOverlay } from "./BaitPayoffArea.tsx";

const EVENT_LABELS: Record<BaitPayoffEvent, string> = {
  start: "Action starts", complete: "Action completes", catch: "Confirmed catch", "screen-set": "Screen is set", "screen-use": "Screen is used", "route-point": "Player reaches a route point",
};
const screenKinds = new Set(["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"]);
const screenUseKinds = new Set([...screenKinds, "slip-screen", "handoff"]);

export function supportedBaitEvents(action: PlaybookArrow): BaitPayoffEvent[] {
  return ["start", "complete", ...(action.kind === "pass" || action.kind === "handoff" ? ["catch" as const] : []),
    ...(screenKinds.has(action.kind) ? ["screen-set" as const] : []), ...(screenUseKinds.has(action.kind) ? ["screen-use" as const] : []), "route-point"];
}

function actionName(action: PlaybookArrow) {
  return action.kind.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}
function actionOption(action: PlaybookArrow, sequence: number, participantText: string) {
  return `Move ${sequence} · ${actionName(action)}${participantText ? ` · ${participantText}` : ""}`;
}
function freshId() { return `bait-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`; }

export function BaitPayoffInspector({ play, branchId, sharedIds, totalConnectionCount, selectedActionId, selectedConnectionId, areaPickingId, pickedAreaPoint, onConsumeAreaPoint, onSelectConnection, onSave, onDelete, onShow, onPickArea }: {
  play: PlaybookDraft; branchId: string | null; sharedIds: Set<string>; totalConnectionCount: number; selectedActionId: string; selectedConnectionId: string | null;
  areaPickingId: string | null; pickedAreaPoint?: { x: number; y: number } | null; onConsumeAreaPoint?: () => void; onSelectConnection: (id: string | null) => void;
  onSave: (connection: BaitPayoffConnection, previousId?: string) => void; onDelete: (id: string) => void;
  onShow: (connection: BaitPayoffConnection) => void; onPickArea: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [baitActionId, setBaitActionId] = useState(selectedActionId);
  const [payoffActionId, setPayoffActionId] = useState("");
  const [title, setTitle] = useState("");
  const [explanation, setExplanation] = useState("");
  const [reactionOn, setReactionOn] = useState(false);
  const [defenderId, setDefenderId] = useState("");
  const [direction, setDirection] = useState<"enter" | "leave">("enter");
  const [area, setArea] = useState<BaitPayoffArea>({ shape: "circle", center: { x: 50, y: 50 }, radiusFeet: 3 });
  const [checkpointActionId, setCheckpointActionId] = useState("");
  const [checkpointEvent, setCheckpointEvent] = useState<BaitPayoffEvent>("start");
  const [routePlayerId, setRoutePlayerId] = useState("");
  const [routeProgress, setRouteProgress] = useState(0.5);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pickedAreaPoint || !areaPickingId || areaPickingId !== (editingId ?? "new")) return;
    setArea((current) => ({ ...current, center: { ...pickedAreaPoint } }));
    onConsumeAreaPoint?.();
    // The court click is consumed once, then parent state is cleared
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedAreaPoint, areaPickingId, editingId]);
  const actions = useMemo(() => {
    const bindings = new Map(bindAuthoredActions(play).map((item) => [item.arrow.id, item]));
    return play.arrows.map((action, index) => {
    const binding = bindings.get(action.id);
    const ids = [...new Set([binding?.actorId, binding?.recipientId, binding?.partnerId].filter((id): id is number => id != null))];
    return { action, sequence: action.sequence ?? index + 1, participants: ids.map((id) => `Player ${id}`).join(" / ") };
    });
  }, [play]);
  const connections = play.baitPayoffs?.connections ?? [];
  const selectedConnection = connections.find((item) => item.id === selectedConnectionId) ?? null;
  const editConnection = connections.find((item) => item.id === editingId) ?? null;
  const selectedIndex = actions.findIndex((item) => item.action.id === selectedActionId);
  const defaultPayoff = actions.find((item) => item.action.id !== selectedActionId)?.action.id ?? "";

  function resetForm() {
    const bait = selectedActionId || actions[0]?.action.id || "";
    const payoff = actions.find((item) => item.action.id !== bait)?.action.id ?? "";
    setEditingId(null); setBaitActionId(bait); setPayoffActionId(payoff); setTitle(""); setExplanation(""); setReactionOn(false);
    setDefenderId(String(play.defenders[0]?.id ?? play.players[0]?.id ?? "")); setDirection("enter");
    setArea({ shape: "circle", center: { x: 50, y: 50 }, radiusFeet: 3 }); setCheckpointActionId(payoff); setCheckpointEvent("start");
    setRoutePlayerId(String(play.players[0]?.id ?? "")); setRouteProgress(0.5); setError(null);
  }
  function editExisting(connection: BaitPayoffConnection) {
    setEditingId(connection.id); setBaitActionId(connection.baitActionId); setPayoffActionId(connection.payoffActionId);
    setTitle(connection.title); setExplanation(connection.explanation); setReactionOn(Boolean(connection.reaction));
    setDefenderId(String(connection.reaction?.defenderId ?? play.defenders[0]?.id ?? play.players[0]?.id ?? ""));
    setDirection(connection.reaction?.direction ?? "enter"); setArea(connection.reaction?.area ?? { shape: "circle", center: { x: 50, y: 50 }, radiusFeet: 3 });
    setCheckpointActionId(connection.reaction?.checkpoint.actionId ?? connection.payoffActionId);
    setCheckpointEvent(connection.reaction?.checkpoint.event ?? "start"); setRoutePlayerId(String(connection.reaction?.checkpoint.routePlayerId ?? play.players[0]?.id ?? ""));
    setRouteProgress(connection.reaction?.checkpoint.progress ?? 0.5); setError(null);
  }
  function saveForm() {
    const bait = actions.find((item) => item.action.id === baitActionId)?.action;
    const payoff = actions.find((item) => item.action.id === payoffActionId)?.action;
    if (!bait || !payoff || bait.id === payoff.id) { setError("Choose two different actions in this ending"); return; }
    if (!title.trim() || !explanation.trim()) { setError("Add a title and explanation for the connection"); return; }
    if (!editingId && totalConnectionCount >= 30) { setError("A play can contain at most 30 Bait & Payoff connections"); return; }
    const scope = !branchId || sharedIds.has(bait.id) && sharedIds.has(payoff.id) ? "shared" : "ending";
    const checkpointAction = actions.find((item) => item.action.id === checkpointActionId)?.action;
    const areaFits = area.shape === "circle"
      ? Math.min(area.center.x * 0.5, (100 - area.center.x) * 0.5, area.center.y * 0.47, (100 - area.center.y) * 0.47) >= area.radiusFeet - 1e-6
      : Math.min(area.center.x * 0.5, (100 - area.center.x) * 0.5) >= area.widthFeet / 2 - 1e-6
        && Math.min(area.center.y * 0.47, (100 - area.center.y) * 0.47) >= area.heightFeet / 2 - 1e-6;
    const reaction: BaitPayoffReaction | undefined = reactionOn ? {
      defenderId: Number(defenderId), direction, area,
      checkpoint: { actionId: checkpointActionId, event: checkpointEvent,
        ...(checkpointEvent === "route-point" ? { routePlayerId: Number(routePlayerId), routePhase: "main" as const, routeSegment: 0, progress: routeProgress } : {}) },
    } : undefined;
    if (reactionOn && (!checkpointAction || !defenderId)) { setError("Choose a defender and a milestone from a linked action"); return; }
    if (reactionOn && checkpointActionId !== baitActionId && checkpointActionId !== payoffActionId) { setError("Reaction checkpoints must belong to the bait or payoff action"); return; }
    if (reactionOn && !areaFits) { setError("Keep the full reaction area inside the playable court"); return; }
    if (reactionOn && checkpointEvent === "route-point" && !baitPayoffParticipants(checkpointAction!, play).includes(Number(routePlayerId))) { setError("Choose a player bound to the selected action route"); return; }
    const connection: BaitPayoffConnection = {
      id: editingId ?? freshId(), baitActionId, payoffActionId, title: title.trim(), explanation: explanation.trim(), scope,
      ...(scope === "ending" ? { branchId: branchId! } : {}), baitSignature: baitPayoffActionSignature(bait, play), payoffSignature: baitPayoffActionSignature(payoff, play),
      ...(reaction ? { reaction } : {}),
    };
    onSave(connection, editingId ?? undefined); setEditingId(null); setError(null); onSelectConnection(connection.id);
  }

  const currentBait = actions.find((item) => item.action.id === baitActionId)?.action;
  const currentPayoff = actions.find((item) => item.action.id === payoffActionId)?.action;
  const checkpointAction = actions.find((item) => item.action.id === checkpointActionId)?.action;
  const checkpointParticipants = checkpointAction ? baitPayoffParticipants(checkpointAction, play) : [];
  const eventOptions = checkpointAction ? supportedBaitEvents(checkpointAction).filter((event) => event !== "route-point" || checkpointParticipants.length > 0) : [];

  return <section className="bait-payoff-inspector" aria-label="Bait and payoff connections">
    <button type="button" className="bait-payoff-toggle" aria-expanded={open} onClick={() => { setOpen((value) => !value); if (!open) resetForm(); }}>
      <span><strong>Bait &amp; Payoff</strong><small>Explain why two actions connect</small></span><span className="bait-payoff-count">{connections.length}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    {open ? <div className="bait-payoff-inspector-body">
      {connections.map((connection) => {
        const bait = actions.find((item) => item.action.id === connection.baitActionId), payoff = actions.find((item) => item.action.id === connection.payoffActionId);
        const needsReview = Boolean(bait && payoff && (baitPayoffActionSignature(bait.action, play) !== connection.baitSignature || baitPayoffActionSignature(payoff.action, play) !== connection.payoffSignature));
        return <article className={`bait-payoff-card ${selectedConnectionId === connection.id ? "is-selected" : ""}`} key={connection.id}>
          <button type="button" className="bait-payoff-card-select" onClick={() => { onSelectConnection(connection.id); editExisting(connection); }}>
            <span className="bait-payoff-card-flow"><strong>{bait ? `Move ${bait.sequence} · ${actionName(bait.action)}` : "Missing bait"}</strong><span aria-hidden="true">→</span><strong>{payoff ? `Move ${payoff.sequence} · ${actionName(payoff.action)}` : "Missing payoff"}</strong></span>
            <span>{connection.title}</span>{needsReview ? <small className="bait-payoff-review">Review participants or action types</small> : null}
          </button>
          <div className="bait-payoff-card-actions"><button type="button" className="button button-outline" onClick={() => onShow(connection)} disabled={!bait || !payoff}><Play size={13} />Show the idea</button><button type="button" className="icon-button" aria-label={`Delete ${connection.title}`} onClick={() => onDelete(connection.id)}><Trash2 size={14} /></button></div>
        </article>;
      })}
      {actions.length < 2 ? <p className="bait-payoff-empty">Add at least two actions to connect a decoy with its payoff</p> : <div className="bait-payoff-form">
        <div className="bait-payoff-form-heading"><strong>{editingId ? "Edit connection" : `Connect from Move ${selectedIndex + 1}`}</strong>{editingId ? <button type="button" className="button button-subtle" onClick={resetForm}>New connection</button> : null}</div>
        <label><span>Bait action</span><select value={baitActionId} onChange={(event) => setBaitActionId(event.currentTarget.value)}>{actions.map(({ action, sequence, participants }) => <option key={action.id} value={action.id}>{actionOption(action, sequence, participants)}</option>)}</select></label>
        <label><span>Payoff action</span><select value={payoffActionId || defaultPayoff} onChange={(event) => setPayoffActionId(event.currentTarget.value)}>{actions.filter(({ action }) => action.id !== baitActionId).map(({ action, sequence, participants }) => <option key={action.id} value={action.id}>{actionOption(action, sequence, participants)}</option>)}</select></label>
        <label><span>Connection title</span><input maxLength={60} value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Corner cut draws help" /></label>
        <label><span>Coach explanation</span><textarea maxLength={1000} value={explanation} onChange={(event) => setExplanation(event.currentTarget.value)} placeholder="Explain what the first action is meant to open" /></label>
        <details className="bait-payoff-reaction-editor" open={reactionOn}>
          <summary><label><input type="checkbox" checked={reactionOn} onChange={(event) => setReactionOn(event.currentTarget.checked)} />Check defender reaction</label></summary>
          {reactionOn ? <div className="bait-payoff-reaction-fields">
            <label><span>Defender</span><select value={defenderId} onChange={(event) => setDefenderId(event.currentTarget.value)}>{play.defenders.length ? play.defenders.map((player) => <option key={player.id} value={player.id}>Defender {player.id}</option>) : play.players.map((player) => <option key={player.id} value={player.id}>Generated defender {player.id}</option>)}</select></label>
            <label><span>Expected movement</span><select value={direction} onChange={(event) => setDirection(event.currentTarget.value as "enter" | "leave")}><option value="enter">Enter area</option><option value="leave">Leave area</option></select></label>
            <label><span>Area shape</span><select value={area.shape} onChange={(event) => setArea(event.currentTarget.value === "circle" ? { shape: "circle", center: area.center, radiusFeet: 3 } : { shape: "rectangle", center: area.center, widthFeet: 6, heightFeet: 8 })}><option value="circle">Circle</option><option value="rectangle">Rectangle</option></select></label>
            {area.shape === "circle" ? <label><span>Radius feet</span><input type="number" min="0.5" max="25" step="0.5" value={area.radiusFeet} onChange={(event) => setArea({ ...area, radiusFeet: Math.max(0.5, Math.min(25, Number(event.currentTarget.value) || 3)) })} /></label>
              : <><label><span>Width feet</span><input type="number" min="1" max="50" step="0.5" value={area.widthFeet} onChange={(event) => setArea({ ...area, widthFeet: Math.max(1, Math.min(50, Number(event.currentTarget.value) || 6)) })} /></label><label><span>Height feet</span><input type="number" min="1" max="47" step="0.5" value={area.heightFeet} onChange={(event) => setArea({ ...area, heightFeet: Math.max(1, Math.min(47, Number(event.currentTarget.value) || 8)) })} /></label></>}
            <label><span>Center X · court %</span><input type="number" min="0" max="100" step="0.5" value={area.center.x} onChange={(event) => setArea({ ...area, center: { ...area.center, x: Math.max(0, Math.min(100, Number(event.currentTarget.value) || 0)) } })} /></label>
            <label><span>Center Y · court %</span><input type="number" min="0" max="100" step="0.5" value={area.center.y} onChange={(event) => setArea({ ...area, center: { ...area.center, y: Math.max(0, Math.min(100, Number(event.currentTarget.value) || 0)) } })} /></label>
            <button type="button" className={`button ${areaPickingId === (editingId ?? "new") ? "button-primary" : "button-outline"}`} onClick={() => onPickArea(editingId ?? "new")}><Circle size={14} />{areaPickingId === (editingId ?? "new") ? "Click area center on court" : "Place center on court"}</button>
            <label><span>Checkpoint action</span><select value={checkpointActionId || payoffActionId} onChange={(event) => { const next = actions.find((item) => item.action.id === event.currentTarget.value)?.action; setCheckpointActionId(event.currentTarget.value); if (next && !supportedBaitEvents(next).includes(checkpointEvent)) setCheckpointEvent("start"); if (next && checkpointEvent === "route-point") { const eligible = baitPayoffParticipants(next, play); if (!eligible.includes(Number(routePlayerId))) setRoutePlayerId(String(eligible[0] ?? "")); } }}>{[currentBait, currentPayoff].filter((action): action is PlaybookArrow => Boolean(action)).map((action) => { const item = actions.find((candidate) => candidate.action.id === action.id)!; return <option key={action.id} value={action.id}>{actionOption(action, item.sequence, item.participants)}</option>; })}</select></label>
            <label><span>Later milestone</span><select value={checkpointEvent} onChange={(event) => { const next = event.currentTarget.value as BaitPayoffEvent; setCheckpointEvent(next); if (next === "route-point" && !checkpointParticipants.includes(Number(routePlayerId))) setRoutePlayerId(String(checkpointParticipants[0] ?? "")); }}>{eventOptions.map((event) => <option key={event} value={event}>{EVENT_LABELS[event]}</option>)}</select></label>
            {checkpointEvent === "route-point" ? <><label><span>Route player</span><select value={routePlayerId} onChange={(event) => setRoutePlayerId(event.currentTarget.value)}>{checkpointParticipants.map((id) => <option key={id} value={id}>Player {id}</option>)}</select></label><label><span>Route progress</span><input type="number" min="0.01" max="0.99" step="0.01" value={routeProgress} onChange={(event) => setRouteProgress(Math.max(0.01, Math.min(0.99, Number(event.currentTarget.value) || 0.5)))} /></label></> : null}
            <small>Checks the defender’s recorded position at the bait start and milestone · It does not prove the bait caused the movement</small>
          </div> : null}
        </details>
        {error ? <p className="bait-payoff-error" role="alert">{error}</p> : null}
        <button type="button" className="button button-primary" onClick={saveForm}><Check size={14} />{editingId ? "Save connection" : "Add Bait & Payoff"}</button>
      </div>}
    </div> : null}
  </section>;
}

export function BaitPayoffPresentation({ play, connection, settings, visibility, active, onClose, onSeek }: {
  play: PlaybookDraft; connection: BaitPayoffConnection; settings: SimulationSettings; visibility: ArrowVisibility; active: boolean; onClose: () => void; onSeek?: (timeMs: number) => void;
}) {
  const clientRef = useRef<PlaybookSimulationClient | null>(null);
  const previousTimestamp = useRef<number | null>(null);
  const viewRef = useRef<SimulationView | null>(null);
  const samplesRef = useRef<BaitPayoffSample[]>([]);
  const interactionEnd = useRef<number | null>(null);
  const [view, setView] = useState<SimulationView | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [error, setError] = useState<string | null>(null);
  const sourceKey = JSON.stringify({ id: play.id, players: play.players, defenders: play.defenders, ball: play.ball, arrows: play.arrows, settings });
  const bait = play.arrows.find((action) => action.id === connection.baitActionId);
  const payoff = play.arrows.find((action) => action.id === connection.payoffActionId);
  const participants = useMemo(() => [...new Set([...(bait ? baitPayoffParticipants(bait, play) : []), ...(payoff ? baitPayoffParticipants(payoff, play) : [])])], [bait, payoff, play]);
  const samples = samplesRef.current;
  const reaction = useMemo(() => ready ? evaluateBaitPayoffReaction(connection, samples) : {
    status: "pending" as const, baitAtMs: null, checkpointAtMs: null, startPoint: null, endPoint: null, reason: "Recording the selected defense",
  }, [connection, view?.session.recordedUntilMs, ready]);
  const baitAtMs = milestoneTime(samples, connection.baitActionId, "start");
  const payoffAtMs = milestoneTime(samples, connection.payoffActionId, "start");

  useEffect(() => {
    setReady(false); setView(null); setError(null); setPlaying(false); setProgress(0); setStage(0); samplesRef.current = []; interactionEnd.current = null;
    if (!bait || !payoff) { setError("One of the linked actions is missing from this ending"); return; }
    const executable = { ...play, baitPayoffs: undefined };
    const scripted = scriptedBaitPayoffSettings(settings);
    let preparing = true;
    let lastProgress = -1;
    const client = createPlaybookSimulationClient({ sessionId: crypto.randomUUID(), onState: (next) => {
      viewRef.current = next;
      const time = next.session.positionMs;
      const execution = next.frame.execution ?? [];
      const defenders = next.frame.defenders.map(({ id, x, y }) => ({ id, x, y }));
      const last = samplesRef.current.at(-1);
      if (!last || time > last.atMs + 1e-4) samplesRef.current.push({ atMs: time, defenders, execution: structuredClone(execution) });
      const percent = next.durationMs ? Math.min(100, Math.floor(next.session.recordedUntilMs / next.durationMs * 100)) : 100;
      if (percent === 100 || percent >= lastProgress + 4) { lastProgress = percent; setProgress(percent); }
      setView(next);
      if (preparing && next.session.recordedUntilMs + 1e-4 >= next.durationMs) {
        preparing = false; setReady(true); client.playback(false);
        client.seek(milestoneTime(samplesRef.current, connection.baitActionId, "start") ?? 0);
        setPlaying(false); setProgress(100);
      }
      const end = interactionEnd.current;
      if (!preparing && end !== null && next.session.positionMs >= end - 1e-4) { interactionEnd.current = null; client.playback(false); setPlaying(false); }
    }, onFailure: (message) => { setError(message); setPlaying(false); setReady(false); }});
    clientRef.current = client;
    client.start(executable, scripted);
    // Recording must advance before the user can inspect the guided steps
    client.playback(true);
    setPlaying(true);
    return () => { preparing = false; client.playback(false); client.dispose(); if (clientRef.current === client) clientRef.current = null; };
    // A new action or setup changes the executable session; title/explanation edits do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, connection.baitActionId, connection.payoffActionId]);

  useEffect(() => {
    if (!active || !playing || document.hidden) return;
    let id = 0;
    const tick = (timestamp: number) => {
      if (document.hidden) { previousTimestamp.current = null; return; }
      const previous = previousTimestamp.current; previousTimestamp.current = timestamp;
      if (previous != null) clientRef.current?.advance(Math.min(50, Math.max(0, timestamp - previous)));
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(id); previousTimestamp.current = null; };
  }, [active, playing]);
  useEffect(() => {
    if (active) return;
    clientRef.current?.playback(false); setPlaying(false); interactionEnd.current = null;
  }, [active]);
  useEffect(() => {
    const pause = () => { if (!document.hidden) return; clientRef.current?.playback(false); setPlaying(false); interactionEnd.current = null; };
    document.addEventListener("visibilitychange", pause); return () => document.removeEventListener("visibilitychange", pause);
  }, []);
  useEffect(() => () => { clientRef.current?.dispose(); clientRef.current = null; }, []);

  function seekTo(time: number | null) {
    if (time === null || !clientRef.current) return;
    clientRef.current.playback(false); setPlaying(false); interactionEnd.current = null; clientRef.current.seek(Math.max(0, Math.min(viewRef.current?.durationMs ?? time, time))); onSeek?.(time);
  }
  function selectStage(next: 0 | 1 | 2) {
    setStage(next); clientRef.current?.playback(false); setPlaying(false); interactionEnd.current = null;
    const targetTime = next === 0 ? baitAtMs : next === 1 ? baitAtMs : payoffAtMs ?? viewRef.current?.session.recordedUntilMs ?? null;
    seekTo(targetTime);
  }
  function playInteraction() {
    if (!ready || baitAtMs === null || !clientRef.current) return;
    interactionEnd.current = baitPayoffInteractionEndMs(samplesRef.current, connection.payoffActionId, viewRef.current?.session.recordedUntilMs ?? baitAtMs);
    setStage(0); clientRef.current.seek(baitAtMs); clientRef.current.playback(true); setPlaying(true);
  }
  function toggleInteractionPlayback() {
    if (playing) {
      clientRef.current?.playback(false); setPlaying(false); interactionEnd.current = null;
      return;
    }
    playInteraction();
  }
  const actionId = stage === 0 ? connection.baitActionId : stage === 2 ? connection.payoffActionId : null;
  const roleRoutes = actionId ? (view?.frame.routes ?? []).filter((route) => route.actionId === actionId) : [];
  const guideFrame = view?.frame;
  const message = stage === 0 ? `Bait · ${bait ? actionName(bait) : "Action"}` : stage === 1 ? "Explanation" : `Payoff · ${payoff ? actionName(payoff) : "Action"}`;
  const reactionLabel = reaction.status === "pending" ? "Pending" : reaction.status === "reaction-observed" ? "Reaction observed" : reaction.status === "reaction-not-observed" ? "Reaction not observed" : reaction.status === "already-in-expected-position" ? "Already in expected position" : "Not evaluated";
  const statusText = (actionId: string | null) => {
    const diagnostic = actionId ? guideFrame?.execution?.find((item) => item.actionId === actionId) : undefined;
    if (!diagnostic) return null;
    const labels = { pending: "Waiting", approach: "Active", set: "Screen set", use: "Screen in use", release: "Released", transfer: "Transfer in progress", completed: "Completed", obstructed: "Blocked", conflict: "Conflicting action", interrupted: "Interrupted" } as const;
    return { label: labels[diagnostic.phase], notice: diagnostic.notice };
  };
  const baitStatus = statusText(connection.baitActionId), payoffStatus = statusText(connection.payoffActionId);
  const recordedPosition = (label: string, point: { x: number; y: number } | null) => point
    ? <small>{label} · court position {point.x.toFixed(1)}%, {point.y.toFixed(1)}%</small> : null;
  const nextTime = stage === 0 ? baitAtMs : stage === 1 ? payoffAtMs ?? view?.session.recordedUntilMs ?? null : payoffAtMs;
  const payoffInspectionMs = payoffAtMs === null ? view?.session.recordedUntilMs ?? null : null;

  return <div className="bait-payoff-backdrop" role="presentation"><section className="bait-payoff-presentation" role="dialog" aria-modal="true" aria-labelledby="bait-presentation-title">
    <header><div><span className="section-kicker">Playbook · Show the idea</span><h2 id="bait-presentation-title">{connection.title}</h2><p>{play.name} · {connection.scope === "ending" ? "Selected ending" : "Shared opening"}</p></div><button type="button" className="icon-button" aria-label="Close Bait and Payoff presentation" onClick={onClose}><X size={18} /></button></header>
    <div className="bait-payoff-steps" role="tablist" aria-label="Bait and payoff steps">{(["Bait", "Explanation", "Payoff"] as const).map((label, index) => <button type="button" role="tab" aria-selected={stage === index} key={label} onClick={() => selectStage(index as 0 | 1 | 2)} disabled={!ready}>{index + 1}<span>{label}</span></button>)}</div>
    <div className="bait-payoff-stage-heading"><strong>{message}</strong><span>{stage === 0 ? baitAtMs === null ? "No recorded start" : `${(baitAtMs / 1000).toFixed(2)} s` : stage === 2 ? payoffAtMs === null ? `No recorded start · inspected at ${((payoffInspectionMs ?? 0) / 1000).toFixed(2)} s` : `${(payoffAtMs / 1000).toFixed(2)} s` : "Paused at the bait moment"}</span></div>
    <div className="bait-payoff-action-statuses" aria-live="polite">{stage === 1 ? <>{baitStatus ? <span><strong>Bait · {baitStatus.label}</strong>{baitStatus.notice ? ` · ${baitStatus.notice}` : ""}</span> : null}{payoffStatus ? <span><strong>Payoff · {payoffStatus.label}</strong>{payoffStatus.notice ? ` · ${payoffStatus.notice}` : ""}</span> : null}{!baitStatus && !payoffStatus ? <span>No linked action diagnostic at the bait moment</span> : null}</> : (() => { const status = statusText(actionId); return status ? <span><strong>{status.label}</strong>{status.notice ? ` · ${status.notice}` : ""}</span> : <span>No execution diagnostic is available yet</span>; })()}</div>
    <div className="bait-payoff-presentation-court">{guideFrame ? <ReadCoachCourt frame={guideFrame} visibility={visibility} routes={visibility === "off" ? [] : roleRoutes} showRoutes={Boolean(actionId) && visibility !== "off"} emphasisPlayerIds={stage === 1 ? [] : participants} baitPayoffArea={connection.reaction?.area} ariaLabel={`Bait and payoff ${message.toLowerCase()} court view`} /> : <div className="bait-payoff-preparing" role="status">{error ? error : `Recording the selected defense · ${progress}%`}</div>}</div>
    {stage === 1 ? <div className="bait-payoff-explanation"><Shield size={17} /><p>{connection.explanation}</p></div> : null}
    {connection.reaction ? <section className={`bait-payoff-reaction-result status-${reaction.status}`} aria-label="Recorded defender endpoint check"><div><strong><span aria-hidden="true">{reaction.status === "reaction-observed" ? "✓" : reaction.status === "reaction-not-observed" ? "×" : reaction.status === "already-in-expected-position" ? "◉" : "·"}</span>{reactionLabel}</strong><small>{reaction.reason ?? `Defender ${connection.reaction.defenderId} · ${connection.reaction.direction === "enter" ? "Enter" : "Leave"} the marked area`}</small>{recordedPosition("Bait start", reaction.startPoint)}{recordedPosition("Later checkpoint", reaction.endPoint)}</div>{reaction.baitAtMs !== null ? <button type="button" className="button button-subtle" onClick={() => seekTo(reaction.baitAtMs)}>View bait start · {(reaction.baitAtMs / 1000).toFixed(2)}s</button> : null}{reaction.checkpointAtMs !== null ? <button type="button" className="button button-subtle" onClick={() => seekTo(reaction.checkpointAtMs)}>View checkpoint · {(reaction.checkpointAtMs / 1000).toFixed(2)}s</button> : null}<small className="bait-payoff-causality">Endpoint positions show movement only · They do not establish that the bait caused it or that the payoff succeeded</small></section> : null}
    {error ? <p className="bait-payoff-error" role="alert">{error}</p> : null}
    <footer className="bait-payoff-transport"><button type="button" className="button button-outline" onClick={() => selectStage(stage === 0 ? 0 : (stage - 1) as 0 | 1 | 2)} disabled={!ready || stage === 0}><ArrowLeft size={14} />Previous</button><button type="button" className="button button-primary" onClick={toggleInteractionPlayback} disabled={!ready || baitAtMs === null}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "Pause interaction" : "Play this interaction"}</button><button type="button" className="button button-outline" onClick={() => selectStage(stage === 2 ? 2 : (stage + 1) as 0 | 1 | 2)} disabled={!ready || stage === 2 || nextTime === null}><span>Next</span><ArrowRight size={14} /></button><input aria-label="Demonstration time" type="range" min="0" max={Math.max(1, view?.session.recordedUntilMs ?? 1)} step="10" value={Math.min(view?.session.positionMs ?? 0, view?.session.recordedUntilMs ?? 0)} disabled={!ready} onChange={(event) => seekTo(Number(event.currentTarget.value))} /><output>{((view?.session.positionMs ?? 0) / 1000).toFixed(2)} s</output></footer>
    <p className="bait-payoff-method-note">Authored offense · {view?.session.resolvedDefenseScheme ?? "Selected defense"} · Same recorded timeline for both actions</p>
  </section></div>;
}

export function BaitPayoffRoleGuide({ play, connection, view, samples, visibility, onSeek, onPlayInteraction, onClose }: {
  play: PlaybookDraft; connection: BaitPayoffConnection; view: SimulationView; samples: BaitPayoffSample[]; visibility: ArrowVisibility;
  onSeek: (timeMs: number) => void; onPlayInteraction: (startMs: number, endMs: number) => void; onClose: () => void;
}) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const bait = play.arrows.find((action) => action.id === connection.baitActionId);
  const payoff = play.arrows.find((action) => action.id === connection.payoffActionId);
  const participants = [...new Set([...(bait ? baitPayoffParticipants(bait, play) : []), ...(payoff ? baitPayoffParticipants(payoff, play) : [])])];
  const baitAtMs = milestoneTime(samples, connection.baitActionId, "start");
  const payoffAtMs = milestoneTime(samples, connection.payoffActionId, "start");
  const reaction = evaluateBaitPayoffReaction(connection, samples);
  const actionId = stage === 0 ? connection.baitActionId : stage === 2 ? connection.payoffActionId : null;
  const routes = actionId ? view.frame.routes.filter((route) => route.actionId === actionId) : [];
  const label = stage === 0 ? `Bait · ${bait ? actionName(bait) : "Action"}` : stage === 1 ? "Explanation" : `Payoff · ${payoff ? actionName(payoff) : "Action"}`;
  const time = stage === 2 ? payoffAtMs : baitAtMs;
  const inspectedAtMs = stage === 2 && payoffAtMs === null ? view.session.recordedUntilMs : null;
  const interactionEndMs = baitPayoffInteractionEndMs(samples, connection.payoffActionId, view.session.recordedUntilMs);
  function choose(next: 0 | 1 | 2) { setStage(next); onSeek(next === 2 ? payoffAtMs ?? view.session.recordedUntilMs : baitAtMs ?? view.session.positionMs); }
  return <div className="bait-payoff-backdrop" role="presentation"><section className="bait-payoff-presentation bait-payoff-role-guide" role="dialog" aria-modal="true" aria-labelledby="bait-role-title">
    <header><div><span className="section-kicker">My Role · Bait &amp; Payoff</span><h2 id="bait-role-title">{connection.title}</h2><p>{play.name} · Player responsibilities</p></div><button type="button" className="icon-button" aria-label="Close Bait and Payoff presentation" onClick={onClose}><X size={18} /></button></header>
    <div className="bait-payoff-steps" role="tablist" aria-label="Bait and payoff steps">{(["Bait", "Explanation", "Payoff"] as const).map((item, index) => <button type="button" role="tab" aria-selected={stage === index} key={item} onClick={() => choose(index as 0 | 1 | 2)}>{index + 1}<span>{item}</span></button>)}</div>
    <div className="bait-payoff-stage-heading"><strong>{label}</strong><span>{time == null ? stage === 2 ? `No recorded start · inspected at ${((inspectedAtMs ?? 0) / 1000).toFixed(2)} s` : "No recorded start" : `${(time / 1000).toFixed(2)} s`}</span></div>
    <div className="bait-payoff-presentation-court"><ReadCoachCourt frame={view.frame} visibility={visibility} routes={routes} showRoutes={Boolean(actionId) && visibility !== "off"} emphasisPlayerIds={stage === 1 ? [] : participants} baitPayoffArea={connection.reaction?.area} ariaLabel={`Bait and payoff ${label.toLowerCase()} court view`} /></div>
    {stage === 1 ? <div className="bait-payoff-explanation"><Shield size={17} /><p>{connection.explanation}</p></div> : null}
    {connection.reaction ? <section className={`bait-payoff-reaction-result status-${reaction.status}`}><div><strong>{reaction.status === "reaction-observed" ? "✓ Reaction observed" : reaction.status === "reaction-not-observed" ? "× Reaction not observed" : reaction.status === "already-in-expected-position" ? "◉ Already in expected position" : reaction.status === "pending" ? "· Pending" : "· Not evaluated"}</strong><small>{reaction.reason ?? `Defender ${connection.reaction.defenderId} · Endpoint positions only`}</small>{reaction.startPoint ? <small>Bait start · court position {reaction.startPoint.x.toFixed(1)}%, {reaction.startPoint.y.toFixed(1)}%</small> : null}{reaction.endPoint ? <small>Later checkpoint · court position {reaction.endPoint.x.toFixed(1)}%, {reaction.endPoint.y.toFixed(1)}%</small> : null}</div>{reaction.baitAtMs !== null ? <button type="button" className="button button-subtle" onClick={() => onSeek(reaction.baitAtMs!)}>View bait start · {(reaction.baitAtMs / 1000).toFixed(2)}s</button> : null}{reaction.checkpointAtMs !== null ? <button type="button" className="button button-subtle" onClick={() => onSeek(reaction.checkpointAtMs!)}>View checkpoint · {(reaction.checkpointAtMs / 1000).toFixed(2)}s</button> : null}<small className="bait-payoff-causality">Recorded positions do not establish cause or payoff success</small></section> : null}
    <footer className="bait-payoff-transport"><button type="button" className="button button-outline" onClick={() => choose(stage === 0 ? 0 : (stage - 1) as 0 | 1 | 2)} disabled={stage === 0}><ArrowLeft size={14} />Previous</button><button type="button" className="button button-primary" disabled={baitAtMs === null} onClick={() => onPlayInteraction(baitAtMs!, interactionEndMs)}><Play size={14} />Play this interaction</button><button type="button" className="button button-outline" onClick={() => choose(stage === 2 ? 2 : (stage + 1) as 0 | 1 | 2)} disabled={stage === 2}><span>Next</span><ArrowRight size={14} /></button><input aria-label="Role demonstration time" type="range" min="0" max={Math.max(1, view.session.recordedUntilMs)} step="10" value={Math.min(view.session.positionMs, view.session.recordedUntilMs)} onChange={(event) => onSeek(Number(event.currentTarget.value))} /><output>{(view.session.positionMs / 1000).toFixed(2)} s</output></footer>
    <p className="bait-payoff-method-note">Reuses this role rehearsal recording · Endpoint movement does not establish causation</p>
  </section></div>;
}
