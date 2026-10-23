import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronDown, Link2, Unlink2 } from "lucide-react";
import type { ActionDiagnostic } from "./simulation.ts";
import type { CourtRoute } from "./arrowVisibility.ts";
import { actionParticipants, actionPrimaryPlayer, waitLabel } from "./timingMixer.ts";
import type { PlaybookArrow, PlaybookMarker, PlaybookTimingWait } from "./types.ts";

type Binding = { arrow: PlaybookArrow; sequence: number; actorId: number | null; recipientId: number | null; partnerId?: number | null; durationMs: number; startTime: number };
type DragState = { pointerId: number; actionId: string; mode: "start" | "duration"; startX: number; initialValue: number; changed: boolean };

const PX_PER_SECOND = 92;
const labels: Record<string, string> = { movement: "Move", pass: "Pass", screen: "Screen", "slip-screen": "Slip", handoff: "Handoff", "pick-roll": "Pick & roll", "pick-pop": "Pick & pop", "off-ball-screen": "Off-ball screen", "pin-down": "Pin-down", "backdoor-cut": "Backdoor cut" };
const transferKinds = new Set(["pass", "handoff"]);
const screenKinds = new Set(["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"]);
const timingIdentity = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;

export function TimingMixerPanel({
  id = "timing-mixer", actions, players, bindings, routes, sharedActionIds, diagnostics = [], selectedActionId, routePickPending, open, onOpenChange,
  onSelect, onChangeStart, onChangeDuration, onToggleSync, onAddWait, onRemoveWait, onStartRoutePick, onPreviewAction,
}: {
  actions: PlaybookArrow[];
  players: PlaybookMarker[];
  bindings: Binding[];
  routes: CourtRoute[];
  sharedActionIds: Set<string>;
  diagnostics?: ActionDiagnostic[];
  selectedActionId: string | null;
  routePickPending?: boolean;
  id?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onChangeStart: (id: string, startAtMs: number) => void;
  onChangeDuration: (id: string, seconds: number) => void;
  onToggleSync: (firstId: string, secondId?: string) => void;
  onAddWait: (actionId: string, wait: PlaybookTimingWait) => void;
  onRemoveWait: (actionId: string, waitId: string) => void;
  onStartRoutePick: (actionId: string, sourceId: string, playerId: number, routePhase: "main" | "approach" | "use" | "release") => void;
  onPreviewAction: (id: string | null) => void;
}) {
  const [otherActionId, setOtherActionId] = useState("");
  const [waitSourceId, setWaitSourceId] = useState("");
  const [waitEvent, setWaitEvent] = useState<PlaybookTimingWait["event"]>("complete");
  const [waitPlayerId, setWaitPlayerId] = useState<number | "">("");
  const [waitPhase, setWaitPhase] = useState<"main" | "approach" | "use" | "release">("main");
  const [startField, setStartField] = useState<{ id: string; value: string } | null>(null);
  const [durationField, setDurationField] = useState<{ id: string; value: string } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ id: string; value: number; mode: "start" | "duration" } | null>(null);
  const drag = useRef<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bindingById = useMemo(() => new Map(bindings.map((binding) => [binding.arrow.id, binding])), [bindings]);
  const actionById = useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);
  const selected = selectedActionId ? actionById.get(selectedActionId) ?? null : null;
  const selectedBinding = selected ? bindingById.get(selected.id) : undefined;
  const participants = (arrow: PlaybookArrow) => {
    const binding = bindingById.get(arrow.id);
    return actionParticipants(arrow, binding?.actorId ?? null, binding?.recipientId ?? null, binding?.partnerId ?? null);
  };
  const startOf = (arrow: PlaybookArrow) => dragPreview?.id === arrow.id && dragPreview.mode === "start"
    ? dragPreview.value : arrow.timingPlan?.startAtMs ?? bindingById.get(arrow.id)?.startTime ?? 0;
  const minDurationOf = (arrow: PlaybookArrow) => dragPreview?.id === arrow.id && dragPreview.mode === "duration"
    ? dragPreview.value : arrow.timing ?? 1.2;
  const maxSeconds = Math.max(4, ...actions.map((arrow) => (startOf(arrow) + Math.max(minDurationOf(arrow) * 1000, bindingById.get(arrow.id)?.durationMs ?? 0)) / 1000)) + 1;
  const timelineWidth = Math.max(480, maxSeconds * PX_PER_SECOND + 30);
  const selectedSyncId = selected?.timingPlan?.syncId;
  const syncMembers = selectedSyncId ? actions.filter((action) => action.timingPlan?.syncId === selectedSyncId) : [];
  function canPinWith(candidate: PlaybookArrow) {
    if (!selected || selected.id === candidate.id) return false;
    if (sharedActionIds.has(selected.id) !== sharedActionIds.has(candidate.id)) return false;
    const groupIds = new Set([selected.timingPlan?.syncId, candidate.timingPlan?.syncId].filter((value): value is string => Boolean(value)));
    const group = actions.filter((arrow) => arrow.id === selected.id || arrow.id === candidate.id || groupIds.has(arrow.timingPlan?.syncId ?? ""));
    if (group.some((arrow) => sharedActionIds.has(arrow.id) !== sharedActionIds.has(selected.id))) return false;
    if (group.filter((arrow) => transferKinds.has(arrow.kind)).length > 1) return false;
    const ids = new Set(group.map((arrow) => arrow.id));
    if (group.some((arrow) => arrow.timingPlan?.waits?.some((wait) => ids.has(wait.actionId)))) return false;
    const owners = new Set<number>();
    for (const arrow of group) {
      const binding = bindingById.get(arrow.id);
      const primary = actionPrimaryPlayer(arrow, binding?.actorId ?? null);
      const moving = arrow.kind === "movement" || arrow.kind === "backdoor-cut" ? [primary]
        : arrow.kind === "off-ball-screen" || arrow.kind === "pin-down" ? [primary, binding?.recipientId ?? arrow.cutter_id]
          : ["screen", "slip-screen", "pick-roll", "pick-pop"].includes(arrow.kind) ? [primary, binding?.partnerId ?? arrow.handler_id]
            : arrow.kind === "handoff" ? [binding?.actorId ?? arrow.actor_id, binding?.recipientId ?? arrow.recipient_id]
              : arrow.kind === "pass" ? [binding?.recipientId ?? arrow.recipient_id] : [];
      for (const id of moving) {
        if (id == null) continue;
        if (owners.has(id)) return false;
        owners.add(id);
      }
    }
    return true;
  }
  const eligiblePinTargets = actions.filter((action) => action.id !== selectedActionId && canPinWith(action));
  const source = waitSourceId ? actionById.get(waitSourceId) : undefined;
  const sourceParticipants = source ? [...new Set(routes.filter((route) => route.actionId === source.id).map((route) => route.playerId))] : [];
  const availableEvents: PlaybookTimingWait["event"][] = ["start", "complete", ...(source && transferKinds.has(source.kind) ? ["catch" as const] : []), ...(source && screenKinds.has(source.kind) ? ["screen-set" as const, "screen-use" as const] : []), "route-point"];
  const diagnosticsById = useMemo(() => new Map(diagnostics.map((diagnostic) => [diagnostic.actionId, diagnostic])), [diagnostics]);

  function beginDrag(event: PointerEvent<HTMLElement>, arrow: PlaybookArrow, mode: DragState["mode"]) {
    event.preventDefault(); event.stopPropagation();
    onSelect(arrow.id);
    const initialValue = mode === "start" ? startOf(arrow) : minDurationOf(arrow);
    drag.current = { pointerId: event.pointerId, actionId: arrow.id, mode, startX: event.clientX, initialValue, changed: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragPreview({ id: arrow.id, mode, value: initialValue });
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = Math.round((event.clientX - current.startX) / PX_PER_SECOND * 10) / 10;
    const value = current.mode === "start"
      ? Math.max(0, Math.round((current.initialValue + delta * 1000) / 100) * 100)
      : Math.max(.5, Math.min(4, Math.round((current.initialValue + delta) * 10) / 10));
    current.changed ||= Math.abs(value - current.initialValue) > 1e-6;
    setDragPreview({ id: current.actionId, mode: current.mode, value });
  }
  function finishDrag(event: PointerEvent<HTMLElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    const delta = Math.round((event.clientX - current.startX) / PX_PER_SECOND * 10) / 10;
    const value = cancelled ? current.initialValue : current.mode === "start"
      ? Math.max(0, Math.round((current.initialValue + delta * 1000) / 100) * 100)
      : Math.max(.5, Math.min(4, Math.round((current.initialValue + delta) * 10) / 10));
    setDragPreview(null);
    if (!cancelled && Math.abs(value - current.initialValue) > 1e-6) {
      if (current.mode === "start") onChangeStart(current.actionId, value);
      else onChangeDuration(current.actionId, value);
    }
  }
  function onBlockKeyDown(event: KeyboardEvent<HTMLDivElement>, arrow: PlaybookArrow) {
    if (event.key === "Escape" && drag.current) { drag.current = null; setDragPreview(null); event.preventDefault(); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(arrow.id); return; }
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.shiftKey) onChangeDuration(arrow.id, Math.max(.5, Math.min(4, minDurationOf(arrow) + (event.key === "ArrowRight" ? .1 : -.1))));
    else onChangeStart(arrow.id, Math.max(0, startOf(arrow) + (event.key === "ArrowRight" ? 100 : -100)));
  }
  function addSelectedWait() {
    if (!selected || !source || selected.id === source.id) return;
    if (waitEvent === "route-point") {
      if (typeof waitPlayerId !== "number") return;
      onStartRoutePick(selected.id, source.id, waitPlayerId, waitPhase);
      return;
    }
    onAddWait(selected.id, { id: timingIdentity("wait"), actionId: source.id, event: waitEvent });
  }

  return <section id={id} className={`timing-mixer ${open ? "is-open" : ""}`} aria-label="Timing mixer">
    <button type="button" className="timing-mixer-toggle" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <span><ChevronDown size={16} className="timing-chevron" /><strong>Timing</strong><small>Choreograph starts and dependencies</small></span>
      <span className="timing-toggle-meta">{actions.length} moves · {open ? "Hide" : "Expand"}</span>
    </button>
    {open ? <div className="timing-mixer-content">
      <div className="timing-mixer-toolbar">
        <label><span>Pin selected with</span><select aria-label="Action to start together" value={otherActionId} onChange={(event) => setOtherActionId(event.currentTarget.value)} disabled={!selected || !eligiblePinTargets.length}><option value="">Choose an action</option>{eligiblePinTargets.map((action) => <option key={action.id} value={action.id}>Move {action.sequence ?? "?"} · {labels[action.kind] ?? action.kind}</option>)}</select></label>
        {selectedSyncId ? <button type="button" className="timing-quiet-button" onClick={() => onToggleSync(selected!.id)}><Unlink2 size={14} />Separate {syncMembers.length} actions</button>
          : <button type="button" className="timing-quiet-button" disabled={!selected || !eligiblePinTargets.some((action) => action.id === otherActionId)} onClick={() => { if (selected && eligiblePinTargets.some((action) => action.id === otherActionId)) onToggleSync(selected.id, otherActionId); }}><Link2 size={14} />Start together</button>}
        <span className="timing-help">Start times snap to 0.1s · minimum duration is 0.5–4s; the shaded tail estimates travel time</span>
      </div>
      {selected ? <div className="timing-detail-row">
        <strong>Move {selected.sequence ?? "?"} · {labels[selected.kind] ?? selected.kind}</strong>
        <label>Start <input aria-label="Selected action start time in seconds" type="number" min="0" max="120" step="0.1" value={startField?.id === selected.id ? startField.value : (startOf(selected) / 1000).toFixed(1)} onFocus={() => setStartField({ id: selected.id, value: (startOf(selected) / 1000).toFixed(1) })} onChange={(event) => setStartField({ id: selected.id, value: event.currentTarget.value })} onBlur={() => { if (startField?.id !== selected.id) return; const value = Number(startField.value); if (Number.isFinite(value)) onChangeStart(selected.id, Math.max(0, Math.round(value * 10) * 100)); setStartField(null); }} /></label>
        <label>Minimum <input aria-label="Selected action minimum duration in seconds" type="number" min="0.5" max="4" step="0.1" value={durationField?.id === selected.id ? durationField.value : minDurationOf(selected).toFixed(1)} onFocus={() => setDurationField({ id: selected.id, value: minDurationOf(selected).toFixed(1) })} onChange={(event) => setDurationField({ id: selected.id, value: event.currentTarget.value })} onBlur={() => { if (durationField?.id !== selected.id) return; const value = Number(durationField.value); if (Number.isFinite(value)) onChangeDuration(selected.id, value); setDurationField(null); }} /></label>
        {selectedBinding ? <span className="timing-travel-estimate">Travel estimate {Math.max(0, (selectedBinding.durationMs - minDurationOf(selected) * 1000) / 1000).toFixed(1)}s beyond minimum</span> : null}
      </div> : <p className="timing-empty">Select an action block to adjust its schedule</p>}
      <div className="timing-waits-panel">
        <div className="timing-waits-heading"><strong>Wait until</strong><small>All listed events must happen before this action starts</small></div>
        {selected?.timingPlan?.waits?.length ? <div className="timing-wait-chips">{selected.timingPlan.waits.map((wait) => <span className="timing-wait-chip" key={wait.id}>{waitLabel(wait, actionById.get(wait.actionId))}<button type="button" aria-label={`Remove wait ${waitLabel(wait, actionById.get(wait.actionId))}`} onClick={() => onRemoveWait(selected.id, wait.id)}>×</button></span>)}</div> : null}
        <div className="timing-wait-controls">
          <select aria-label="Wait for action" value={waitSourceId} onChange={(event) => { setWaitSourceId(event.currentTarget.value); setWaitEvent("complete"); }} disabled={!selected}><option value="">Choose source move</option>{actions.filter((action) => action.id !== selectedActionId).map((action) => <option key={action.id} value={action.id}>Move {action.sequence ?? "?"} · {labels[action.kind] ?? action.kind}</option>)}</select>
          <select aria-label="Timing event" value={waitEvent} onChange={(event) => setWaitEvent(event.currentTarget.value as PlaybookTimingWait["event"])} disabled={!source}>{availableEvents.map((event) => <option key={event} value={event}>{event === "start" ? "Starts" : event === "complete" ? "Completes" : event === "catch" ? "Confirmed catch" : event === "screen-set" ? "Screen set" : event === "screen-use" ? "Screen use" : "Route point"}</option>)}</select>
          {waitEvent === "route-point" ? <>
            <select aria-label="Player reaching the route point" value={waitPlayerId} onChange={(event) => setWaitPlayerId(event.currentTarget.value ? Number(event.currentTarget.value) : "")} disabled={!source}><option value="">Choose player</option>{sourceParticipants.map((id) => <option key={id} value={id}>Player {id}</option>)}</select>
            <select aria-label="Route phase" value={waitPhase} onChange={(event) => setWaitPhase(event.currentTarget.value as typeof waitPhase)}><option value="main">Main route</option>{screenKinds.has(source?.kind ?? "") ? <><option value="approach">Screen approach</option><option value="use">Screen use</option><option value="release">Screen release</option></> : null}</select>
          </> : null}
          <button type="button" className="timing-quiet-button" disabled={!selected || !source || (waitEvent === "route-point" && typeof waitPlayerId !== "number")} onClick={addSelectedWait}>{waitEvent === "route-point" ? routePickPending ? "Click the route on court" : "Pick point on court" : "Add wait"}</button>
        </div>
        <div className="timing-event-hint">Events are taken from executed movement and confirmed possession</div>
      </div>
      <div className="timing-lane-viewport" ref={scrollRef} tabIndex={0} aria-label="Player timing lanes">
        <div className="timing-lane-board" style={{ width: timelineWidth }}>
          <div className="timing-ruler"><span className="timing-lane-name">PLAYER</span><div className="timing-ruler-track">{Array.from({ length: Math.ceil(maxSeconds) + 1 }, (_, second) => <span key={second} style={{ left: second * PX_PER_SECOND }}>{second.toFixed(0)}s</span>)}</div></div>
          {players.map((player) => <div className="timing-lane" key={player.id}>
            <div className="timing-lane-name"><b>{player.id}</b><span>Player {player.id}</span></div>
            <div className="timing-lane-track" style={{ width: timelineWidth - 104 }}>
              {actions.filter((arrow) => participants(arrow).includes(player.id)).map((arrow) => {
                const binding = bindingById.get(arrow.id);
                const primary = actionPrimaryPlayer(arrow, binding?.actorId ?? null) === player.id;
                const startMs = startOf(arrow), minDuration = minDurationOf(arrow), estimatedDuration = Math.max(minDuration * 1000, binding?.durationMs ?? 0);
                const estimatedWidth = estimatedDuration / 1000 * PX_PER_SECOND;
                const minimumWidth = Math.min(estimatedWidth, Math.max(38, minDuration * PX_PER_SECOND));
                const diagnostic = diagnosticsById.get(arrow.id);
                const waiting = diagnostic?.startedAtMs == null && Boolean(diagnostic?.notice);
                const active = diagnostic?.startedAtMs != null && diagnostic.phase !== "completed" && !["obstructed", "conflict", "interrupted"].includes(diagnostic.phase);
                const selectedBlock = selectedActionId === arrow.id;
                const sequence = arrow.sequence ?? actions.indexOf(arrow) + 1;
                return <div key={`${arrow.id}-${player.id}`} className={`timing-block ${primary ? "is-primary" : "is-linked"} ${selectedBlock ? "is-selected" : ""} ${waiting ? "is-waiting" : ""} ${active ? "is-active" : ""} ${diagnostic?.phase === "completed" ? "is-completed" : ""} ${["obstructed", "conflict", "interrupted"].includes(diagnostic?.phase ?? "") ? "is-obstructed" : ""}`} style={{ left: startMs / 1000 * PX_PER_SECOND, width: Math.max(43, estimatedWidth) }} role="group" tabIndex={0} aria-label={`Move ${sequence}, ${labels[arrow.kind] ?? arrow.kind}, ${primary ? "primary action" : "linked participant view"}, Player ${player.id}, starts at ${(startMs / 1000).toFixed(1)} seconds, minimum duration ${minDuration.toFixed(1)} seconds${diagnostic?.notice ? `, ${diagnostic.notice}` : ""}`} title={diagnostic?.notice ?? `Move ${sequence} · ${labels[arrow.kind] ?? arrow.kind}${primary ? "" : " · linked participant"}`} onClick={() => onSelect(arrow.id)} onPointerDown={(event) => beginDrag(event, arrow, "start")} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onLostPointerCapture={(event) => finishDrag(event, true)} onKeyDown={(event) => onBlockKeyDown(event, arrow)} onFocus={() => { onSelect(arrow.id); onPreviewAction(arrow.id); }} onBlur={() => onPreviewAction(null)} onMouseEnter={() => onPreviewAction(arrow.id)} onMouseLeave={() => onPreviewAction(null)}>
                  <span className="timing-block-minimum" style={{ width: minimumWidth }}><b>{primary ? `M${sequence}` : "↳"}</b><span>{labels[arrow.kind] ?? arrow.kind}</span></span>
                  {estimatedDuration > minDuration * 1000 + 100 ? <span className="timing-travel-tail" aria-hidden="true">Travel</span> : null}
                  {primary ? <span className="timing-block-resize" style={{ left: minimumWidth - 4 }} role="slider" aria-label={`Resize minimum duration for move ${sequence}`} aria-valuemin={.5} aria-valuemax={4} aria-valuenow={minDuration} tabIndex={0} onPointerDown={(event) => { event.stopPropagation(); beginDrag(event, arrow, "duration"); }} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onLostPointerCapture={(event) => finishDrag(event, true)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onChangeDuration(arrow.id, Math.max(.5, Math.min(4, minDuration + (event.key === "ArrowRight" ? .1 : -.1)))); } if (event.key === "Escape") { drag.current = null; setDragPreview(null); } }} /> : null}
                  {primary && (arrow.timingPlan?.waits?.length ?? 0) > 0 ? <span className="timing-block-wait-pin" aria-label="Has timing waits">◆</span> : null}
                  {primary && arrow.timingPlan?.syncId ? <span className="timing-block-sync-pin" aria-label="Starts together">↔</span> : null}
                </div>;
              })}
            </div>
          </div>)}
          {players.length === 0 ? <p className="timing-empty">Add an offensive player to see the timing lanes</p> : null}
        </div>
      </div>
    </div> : null}
  </section>;
}
