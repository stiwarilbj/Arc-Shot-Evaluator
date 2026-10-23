import { useEffect, useMemo, useRef, useState, type MouseEvent, type Ref } from "react";
import { Check, CircleHelp, Play, Plus, Trash2, X } from "lucide-react";
import { CourtMarkings } from "./CourtMarkings";
import { CourtRoutes } from "./CourtRoutes";
import { clientPointToCourt, COURT_VIEWBOX, courtPointToSvg } from "./courtGeometry";
import { defaultArrowControl } from "./playbookPaths";
import { routeVisible, type ArrowVisibility } from "./arrowVisibility";
import { SpacingGateLayer } from "./SpacingGateLayer.tsx";
import type { SimulationFrame } from "./simulation";
import type { CourtRoute } from "./arrowVisibility";
import type { PlaybookArrow, PlaybookDraft, ReadCoachCheckpoint, ReadCoachChoice, ReadCoachCourtSnapshot, ReadCoachSessionRecord, SpacingGate } from "./types";

type ChoiceKind = PlaybookArrow["kind"];
type AuthorProps = {
  session: ReadCoachSessionRecord;
  frame: SimulationFrame;
  base: PlaybookDraft;
  existing?: ReadCoachCheckpoint;
  visibility: ArrowVisibility;
  onCancel: () => void;
  onSave: (checkpoint: ReadCoachCheckpoint, previousId?: string) => void;
  onPreview: (checkpoint: ReadCoachCheckpoint, choiceId: string, onFrame: (frame: SimulationFrame) => void) => Promise<void>;
};

function blankChoices(): ReadCoachChoice[] {
  return [{ id: "read-option-a", label: "Option A", arrows: [] }, { id: "read-option-b", label: "Option B", arrows: [] }];
}

function routePath(arrow: PlaybookArrow) {
  const start = courtPointToSvg(arrow.start), end = courtPointToSvg(arrow.end);
  const control = arrow.control && courtPointToSvg(arrow.control);
  return `M${start.x} ${start.y} ${control ? `Q${control.x} ${control.y}` : "L"} ${end.x} ${end.y}`;
}

export function ReadCoachCourt({ frame, arrows = [], visibility, showRoutes = true, routes, emphasisPlayerId = null, showWholeTeam = true, spacingGates = [], showSpacingGates = false, onClick, drawing, ariaLabel, svgRef }: {
  frame: SimulationFrame; arrows?: PlaybookArrow[]; visibility: ArrowVisibility; showRoutes?: boolean; routes?: CourtRoute[];
  emphasisPlayerId?: number | null; showWholeTeam?: boolean; spacingGates?: SpacingGate[]; showSpacingGates?: boolean;
  onClick?: (event: MouseEvent<SVGSVGElement>) => void; drawing?: boolean; ariaLabel: string; svgRef?: Ref<SVGSVGElement>;
}) {
  const courtRoutes = useMemo(() => routes ?? frame.routes, [routes, frame.routes]);
  return <svg ref={svgRef} className={`court-svg read-coach-court ${drawing ? "is-drawing-read" : ""}`} viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={ariaLabel} onClick={onClick}>
    <rect x="0" y="0" width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} className="court-floor" /><CourtMarkings />
    {showRoutes ? <CourtRoutes routes={courtRoutes} visibility={visibility} /> : null}
    <SpacingGateLayer gates={spacingGates} results={frame.spacingGateResults ?? []} visible={showSpacingGates} interactive={false} />
    <defs><marker id="read-choice-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9Z" fill="var(--orange)" /></marker></defs>
    {arrows.filter((arrow) => routeVisible({ scope: arrow.kind === "pass" || arrow.kind === "handoff" || arrow.actor_id === frame.ballHandlerId || arrow.recipient_id === frame.ballHandlerId || arrow.handler_id === frame.ballHandlerId ? "on-ball" : "off-ball", importance: "main" }, visibility)).map((arrow, index) => <g key={arrow.id} className="read-choice-route"><path d={routePath(arrow)} markerEnd="url(#read-choice-arrow)" /><circle cx={courtPointToSvg(arrow.start).x} cy={courtPointToSvg(arrow.start).y} r="3.5" /><text x={courtPointToSvg(arrow.end).x} y={courtPointToSvg(arrow.end).y - 9}>{index + 1}</text></g>)}
    {frame.defenders.map((marker) => { const point = courtPointToSvg(marker); return <g key={`d${marker.id}`} className={`read-defender ${emphasisPlayerId !== null && !showWholeTeam ? "read-role-muted" : ""}`}><circle cx={point.x} cy={point.y} r="15" /><text x={point.x} y={point.y + 1}>D{marker.id}</text></g>; })}
    {frame.players.map((marker) => { const point = courtPointToSvg(marker); return <g key={`p${marker.id}`} className={`read-player ${frame.ballHandlerId === marker.id ? "is-handler" : ""} ${emphasisPlayerId !== null && marker.id !== emphasisPlayerId && !showWholeTeam ? "read-role-muted" : ""} ${marker.id === emphasisPlayerId ? "is-role-player" : ""}`}><circle cx={point.x} cy={point.y} r="17" /><text x={point.x} y={point.y + 1}>{marker.id}</text></g>; })}
    {frame.ball ? <circle className="read-ball" cx={courtPointToSvg(frame.ball).x} cy={courtPointToSvg(frame.ball).y} r="7" /> : null}
  </svg>;
}

export function ReadCoachAuthorPanel({ session, frame, base, existing, visibility, onCancel, onSave, onPreview }: AuthorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [question, setQuestion] = useState(existing?.question ?? "");
  const [explanation, setExplanation] = useState(existing?.explanation ?? "");
  const [choices, setChoices] = useState<ReadCoachChoice[]>(() => structuredClone(existing?.choices ?? blankChoices()));
  const [correctChoiceId, setCorrectChoiceId] = useState(existing?.correctChoiceId ?? choices[0]?.id ?? "read-option-a");
  const [selectedChoiceId, setSelectedChoiceId] = useState(choices[0]?.id ?? "read-option-a");
  const [kind, setKind] = useState<ChoiceKind>("movement");
  const [actorId, setActorId] = useState(String(frame.ballHandlerId ?? frame.players[0]?.id ?? ""));
  const [recipientId, setRecipientId] = useState(String(frame.players.find((player) => player.id !== frame.ballHandlerId)?.id ?? ""));
  const [screenExit, setScreenExit] = useState<PlaybookArrow["end"] | null>(null);
  const [timing, setTiming] = useState(1.2);
  const [path, setPath] = useState<"straight" | "curve">("straight");
  const [drawMode, setDrawMode] = useState(false);
  const [drawStart, setDrawStart] = useState<PlaybookArrow["start"] | null>(null);
  const [previewFrame, setPreviewFrame] = useState<SimulationFrame | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedChoice = choices.find((choice) => choice.id === selectedChoiceId) ?? choices[0];
  const visibleFrame = previewFrame ?? frame;
  const allReviewed = choices.length >= 2 && choices.every((choice) => choice.arrows.length > 0 && reviewed.has(choice.id));
  const allLabeled = choices.every((choice) => choice.label.trim().length > 0);
  const needsScreenPartner = ["screen", "slip-screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"].includes(kind);
  const needsExit = kind === "pick-pop" || kind === "pin-down";
  const nextCheckpointId = () => `read-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

  function updateChoice(choiceId: string, update: (choice: ReadCoachChoice) => ReadCoachChoice) {
    setChoices((current) => current.map((choice) => choice.id === choiceId ? update(choice) : choice));
    setReviewed((current) => { const next = new Set(current); next.delete(choiceId); return next; });
    setPreviewFrame(null);
  }

  function handleCourtClick(event: MouseEvent<SVGSVGElement>) {
    if (!drawMode || !selectedChoice) return;
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return;
    const point = clientPointToCourt(event.clientX, event.clientY, matrix);
    if (!point || point.x < 0 || point.x > 100 || point.y < 0 || point.y > 100) return;
    const actorCandidate = kind === "pass" || kind === "handoff" ? frame.ballHandlerId : Number(actorId);
    const recipient = Number(recipientId);
    if (actorCandidate == null || !Number.isInteger(actorCandidate) || !frame.players.some((player) => player.id === actorCandidate)) { setError("Choose an offensive player before drawing this action"); return; }
    const actor = actorCandidate;
    if ((kind === "pass" || kind === "handoff") && (!Number.isInteger(recipient) || recipient === actor || !frame.players.some((player) => player.id === recipient))) { setError("Choose a different receiver before drawing this transfer"); return; }
    if (needsScreenPartner && (!Number.isInteger(recipient) || recipient === actor || !frame.players.some((player) => player.id === recipient))) { setError("Choose a different handler or cutter before drawing this screen action"); return; }
    if (!drawStart) {
      const marker = frame.players.find((player) => player.id === actor)!;
      setDrawStart({ x: marker.x, y: marker.y }); setNotice("Route starts at this player’s captured position · click a destination"); return;
    }
    if (needsExit && !screenExit) { setScreenExit(point); setNotice("Screen location set · click the screener or cutter exit target"); return; }
    const start = drawStart, end = screenExit ?? point;
    const sequence = Math.max(0, ...selectedChoice.arrows.map((arrow, index) => arrow.sequence ?? index + 1)) + 1;
    const arrow: PlaybookArrow = { id: `read-${crypto.randomUUID()}`, kind, start, end, sequence, timing,
      path, ...(path === "curve" ? { control: defaultArrowControl(start, end) } : {}), actor_id: actor,
      ...(kind === "pass" || kind === "handoff" ? { recipient_id: recipient } : {}),
      ...(needsScreenPartner && ["off-ball-screen", "pin-down"].includes(kind) ? { screener_id: actor, cutter_id: recipient } : {}),
      ...(needsScreenPartner && !["off-ball-screen", "pin-down"].includes(kind) ? { screener_id: actor, handler_id: recipient } : {}),
      ...(kind === "pick-pop" || kind === "pin-down" ? { exit_target: point } : {}) };
    updateChoice(selectedChoice.id, (choice) => ({ ...choice, arrows: [...choice.arrows, arrow] }));
    setDrawStart(null); setScreenExit(null); setDrawMode(false); setNotice("Action added to this continuation"); setError(null);
  }

  async function preview(choice: ReadCoachChoice) {
    setError(null); setNotice(null); setPreviewing(choice.id); setPreviewFrame(null);
    const choicesForPreview = choices.map((item) => ({ ...item, arrows: item.id === choice.id ? choice.arrows : item.arrows.length ? item.arrows : structuredClone(choice.arrows) }));
    try {
      const checkpoint: ReadCoachCheckpoint = { id: existing?.id ?? nextCheckpointId(), question: question.trim() || "Preview this read", explanation: explanation.trim() || "Preview explanation", session, snapshot: snapshotFromFrame(frame, session.positionMs), choices: choicesForPreview,
        correctChoiceId: choicesForPreview.some((item) => item.id === correctChoiceId) ? correctChoiceId : choice.id };
      await onPreview(checkpoint, choice.id, setPreviewFrame);
      setReviewed((current) => new Set(current).add(choice.id));
      setNotice(`${choice.label} reviewed`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Choice preview could not finish"); }
    finally { setPreviewing(null); }
  }

  function save() {
    try {
      const checkpoint: ReadCoachCheckpoint = { id: existing?.id ?? nextCheckpointId(), question: question.trim(), explanation: explanation.trim(), session, snapshot: snapshotFromFrame(frame, session.positionMs),
        choices: structuredClone(choices), correctChoiceId };
      onSave(checkpoint, existing?.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "This lesson could not be saved"); }
  }

  return <div className="read-coach-backdrop" role="presentation"><section className="read-coach-editor" role="dialog" aria-modal="true" aria-labelledby="read-editor-title">
    <header className="read-coach-editor-header"><div><span className="section-kicker">Read Coach · Authoring</span><h2 id="read-editor-title">{existing ? "Edit read checkpoint" : "Create a read checkpoint"}</h2></div><button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel checkpoint editing"><X size={17} /></button></header>
    <p className="read-coach-editor-intro">This is the exact paused situation · Draw each answer from these positions · The play’s Main path and endings stay unchanged</p>
    <div className="read-coach-editor-grid">
        <div className="read-coach-editor-court"><ReadCoachCourt frame={visibleFrame} arrows={previewFrame ? [] : selectedChoice?.arrows} visibility={visibility} showRoutes={Boolean(previewFrame)} onClick={handleCourtClick} drawing={drawMode} ariaLabel={drawMode ? "Draw a read continuation on the court" : "Captured checkpoint court"} svgRef={svgRef} />
        <div className="read-coach-court-caption">{previewFrame ? "Choice preview · recorded defense reacts" : drawMode ? screenExit ? "Click the screen exit target" : drawStart ? needsExit ? "Click the screen location" : "Click the route destination" : "Click to start from the selected player" : "Captured court · no future routes shown"}</div>
      </div>
      <div className="read-coach-author-controls">
        <label className="read-coach-field"><span>Question</span><textarea maxLength={240} value={question} onChange={(event) => setQuestion(event.currentTarget.value)} placeholder="What should the handler read here?" /></label>
        <div className="read-coach-choice-heading"><strong>Continuations</strong><span>{choices.length} of 3</span></div>
        <div className="read-coach-choice-tabs" role="tablist" aria-label="Read continuations">{choices.map((choice) => <div key={choice.id} className="read-coach-choice-tab-wrap"><button type="button" role="tab" aria-selected={selectedChoiceId === choice.id} className={`read-coach-choice-tab ${selectedChoiceId === choice.id ? "is-active" : ""}`} onClick={() => { setSelectedChoiceId(choice.id); setPreviewFrame(null); }}>{choice.label}</button>{choices.length > 2 ? <button type="button" className="read-choice-remove" aria-label={`Remove ${choice.label}`} onClick={() => { setChoices((current) => current.filter((item) => item.id !== choice.id)); if (correctChoiceId === choice.id) setCorrectChoiceId(choices.find((item) => item.id !== choice.id)?.id ?? ""); setSelectedChoiceId(choices.find((item) => item.id !== choice.id)?.id ?? ""); setReviewed(new Set()); }}><X size={12} /></button> : null}</div>)}</div>
        {selectedChoice ? <>
          <label className="read-coach-field"><span>Choice label</span><input maxLength={80} value={selectedChoice.label} onChange={(event) => { const label = event.currentTarget.value; updateChoice(selectedChoice.id, (choice) => ({ ...choice, label })); }} /></label>
          <div className="read-coach-action-form">
            <label><span>Action</span><select value={kind} onChange={(event) => { setKind(event.currentTarget.value as ChoiceKind); setDrawStart(null); setScreenExit(null); }}>
              <option value="movement">Move</option><option value="pass">Pass</option><option value="handoff">Handoff</option><option value="backdoor-cut">Backdoor cut</option>
              <option value="screen">Screen</option><option value="slip-screen">Slip screen</option><option value="pick-roll">Pick and roll</option><option value="pick-pop">Pick and pop</option><option value="off-ball-screen">Off-ball screen</option><option value="pin-down">Pin down</option>
            </select></label>
            <label><span>{kind === "pass" || kind === "handoff" ? "Ball handler" : needsScreenPartner ? "Screener" : "Player"}</span><select disabled={kind === "pass" || kind === "handoff"} value={actorId} onChange={(event) => setActorId(event.currentTarget.value)}>{frame.players.map((player) => <option key={player.id} value={player.id}>Player {player.id}{frame.ballHandlerId === player.id ? " · Ball" : ""}</option>)}</select></label>
            {kind === "pass" || kind === "handoff" || needsScreenPartner ? <label><span>{kind === "pass" || kind === "handoff" ? "Receiver" : ["off-ball-screen", "pin-down"].includes(kind) ? "Cutter" : "Handler"}</span><select value={recipientId} onChange={(event) => setRecipientId(event.currentTarget.value)}>{frame.players.filter((player) => player.id !== (kind === "pass" || kind === "handoff" ? frame.ballHandlerId : Number(actorId))).map((player) => <option key={player.id} value={player.id}>{player.id === frame.ballHandlerId ? `Player ${player.id} · Ball` : `Player ${player.id}`}</option>)}</select></label> : null}
            <label><span>Minimum seconds</span><input type="number" min={0.5} max={4} step={0.1} value={timing} onChange={(event) => setTiming(Math.max(0.5, Math.min(4, Number(event.currentTarget.value) || 1.2)))} /></label>
            <label><span>Route</span><select value={path} onChange={(event) => setPath(event.currentTarget.value as "straight" | "curve")}><option value="straight">Straight</option><option value="curve">Curved</option></select></label>
          </div>
          <button type="button" className={`button ${drawMode ? "button-primary" : "button-outline"}`} onClick={() => { setDrawMode((value) => !value); setDrawStart(null); setNotice(null); setError(null); }}><Plus size={15} />{drawMode ? "Cancel drawing" : "Draw action on court"}</button>
          <div className="read-coach-authored-actions">{selectedChoice.arrows.map((arrow, index) => <div key={arrow.id}><span>Move {index + 1} · {arrow.kind.replaceAll("-", " ")} · Player {arrow.actor_id}</span><button type="button" aria-label={`Remove action ${index + 1}`} onClick={() => updateChoice(selectedChoice.id, (choice) => ({ ...choice, arrows: choice.arrows.filter((item) => item.id !== arrow.id) }))}><Trash2 size={14} /></button></div>)}{!selectedChoice.arrows.length ? <small>Add at least one authored action to this continuation</small> : null}</div>
          <label className="read-coach-intended"><input type="radio" name="read-coach-correct" checked={correctChoiceId === selectedChoice.id} onChange={() => setCorrectChoiceId(selectedChoice.id)} /><span>This is the intended read</span></label>
          <div className="read-coach-review-row"><button type="button" className="button button-subtle" disabled={!selectedChoice.arrows.length || previewing !== null} onClick={() => void preview(selectedChoice)}><Play size={14} />{previewing === selectedChoice.id ? "Previewing…" : reviewed.has(selectedChoice.id) ? "Preview again" : "Preview and review"}</button><span>{reviewed.has(selectedChoice.id) ? <><Check size={14} />Reviewed</> : "Review each choice"}</span></div>
        </> : null}
        {choices.length < 3 ? <button type="button" className="read-coach-add-choice" onClick={() => {
          const letter = ["A", "B", "C"].find((candidate) => !choices.some((choice) => choice.label.trim().toLocaleLowerCase() === `option ${candidate.toLocaleLowerCase()}`)) ?? String.fromCharCode(65 + choices.length);
          const choice = { id: `read-choice-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, label: `Option ${letter}`, arrows: [] };
          setChoices((current) => [...current, choice]); setSelectedChoiceId(choice.id); setReviewed(new Set());
        }}><Plus size={15} />Add another choice</button> : null}
        <label className="read-coach-field"><span>Explanation after the answer</span><textarea maxLength={2000} value={explanation} onChange={(event) => setExplanation(event.currentTarget.value)} placeholder="Explain the cue and why it matters" /></label>
        {error ? <p className="read-coach-error" role="alert">{error}</p> : notice ? <p className="read-coach-notice" role="status">{notice}</p> : null}
        <footer className="read-coach-editor-actions"><button type="button" className="button button-subtle" onClick={onCancel}>Cancel</button><button type="button" className="button button-primary" disabled={!question.trim() || !explanation.trim() || !allLabeled || !allReviewed || !choices.some((choice) => choice.id === correctChoiceId)} onClick={save}><Check size={15} />{existing ? "Save lesson" : "Add checkpoint"}</button></footer>
      </div>
    </div>
  </section></div>;
}

function snapshotFromFrame(frame: SimulationFrame, atMs: number): ReadCoachCourtSnapshot {
  return { players: structuredClone(frame.players), defenders: structuredClone(frame.defenders), ball: frame.ball ? { ...frame.ball } : null, ballHandlerId: frame.ballHandlerId ?? null, atMs };
}

const emptyFrame: SimulationFrame = {
  routes: [], players: [], defenders: [], ball: null, ballHandlerId: null, ballPhase: "held", activeSequence: null,
  activeActionLabel: null, adaptiveReadLabel: null, adaptiveReadReason: null, adaptiveReadRoute: null,
  activeDefenseScheme: null, defenseSchemeWasAutomatic: false, defenseSchemeNotice: null, defensiveQuality: 0,
  offBallQuality: 0, shotPhase: "idle", shotProgress: 0, shotResult: "pending", shotQuality: 0,
  shotRelease: null, shooterId: null, shotStart: null, shotTarget: null,
};

export function readCoachSnapshotFrame(snapshot: ReadCoachCourtSnapshot): SimulationFrame {
  return { ...emptyFrame, players: structuredClone(snapshot.players), defenders: structuredClone(snapshot.defenders),
    ball: snapshot.ball ? { ...snapshot.ball } : null, ballHandlerId: snapshot.ballHandlerId, ballPhase: "held" };
}

export function ReadCoachPracticeView({ lesson, visibility, onExit, active }: {
  lesson?: { version: 1; checkpoints: ReadCoachCheckpoint[] };
  visibility: ArrowVisibility; onExit: () => void; active: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<string | null>(null);
  const [frame, setFrame] = useState<SimulationFrame | null>(null);
  const [playing, setPlaying] = useState(false);
  const [replayKind, setReplayKind] = useState<"opening" | "choice" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<import("./playbookSimulationClient.ts").PlaybookSimulationClient | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const checkpoint = lesson?.checkpoints[index];
  const selected = checkpoint?.choices.find((choice) => choice.id === answer);
  const intended = checkpoint?.choices.find((choice) => choice.id === checkpoint.correctChoiceId);
  const initialFrame: SimulationFrame | null = checkpoint ? {
    ...emptyFrame, players: checkpoint.snapshot.players, defenders: checkpoint.snapshot.defenders, ball: checkpoint.snapshot.ball,
    ballHandlerId: checkpoint.snapshot.ballHandlerId, ballPhase: "held", routes: [], execution: [], activeSequence: null, activeActionLabel: null,
    adaptiveReadLabel: null, adaptiveReadReason: null, adaptiveReadRoute: null, activeDefenseScheme: null,
    defenseSchemeWasAutomatic: false, defenseSchemeNotice: null, defensiveQuality: 0, offBallQuality: 0,
    shotPhase: "idle", shotProgress: 0, shotResult: "pending", shotQuality: 0, shotRelease: null,
    shooterId: null, shotStart: null, shotTarget: null,
  } : null;

  function stopClient() {
    clientRef.current?.dispose(); clientRef.current = null;
    if (frameRequestRef.current != null) cancelAnimationFrame(frameRequestRef.current);
    frameRequestRef.current = null;
  }
  function replay(mode: "opening" | "choice", choiceId?: string) {
    if (!checkpoint || !active) return;
    stopClient(); setError(null); setReplayKind(mode); setPlaying(true);
    try {
      const client = (requirePlaybookClient())({ sessionId: crypto.randomUUID(), onState: (view) => {
        if (clientRef.current !== client) return;
        setFrame(view.frame); setPlaying(view.playing);
      }, onFailure: (message) => { if (clientRef.current === client) { setPlaying(false); setReplayKind(null); setError(message); } } });
      clientRef.current = client;
      if (mode === "opening") client.startReadOpening(checkpoint);
      else client.startReadChoice(checkpoint, choiceId ?? checkpoint.correctChoiceId);
      let previous = performance.now();
      const tick = (now: number) => {
        if (clientRef.current !== client) return;
        if (document.hidden || !active) { setPlaying(false); client.playback(false); return; }
        client.advance(Math.max(0, Math.min(50, now - previous))); previous = now;
        frameRequestRef.current = requestAnimationFrame(tick);
      };
      frameRequestRef.current = requestAnimationFrame(tick);
    } catch (caught) { setPlaying(false); setReplayKind(null); setError(caught instanceof Error ? caught.message : "Replay could not start"); }
  }
  useEffect(() => {
    if (active) return;
    stopClient(); setPlaying(false); setReplayKind(null);
  }, [active]);
  useEffect(() => () => stopClient(), []);
  useEffect(() => {
    const pauseWhenHidden = () => {
      if (!document.hidden) return;
      clientRef.current?.playback(false);
      setPlaying(false);
      setReplayKind(null);
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  if (!checkpoint) return <main className="playbook-page read-coach-practice"><header className="read-coach-practice-header"><div><h1>Practice reads</h1><p>There are no saved checkpoints yet</p></div><button type="button" className="button button-outline" onClick={onExit}>Back to Playbook</button></header><div className="read-coach-practice-empty"><CircleHelp size={25} /><h2>Build a lesson from a live read</h2><p>Pause a simulation while the ball is held, then create a checkpoint from the exact court state</p></div></main>;

  return <main className="playbook-page read-coach-practice"><header className="read-coach-practice-header"><div><span className="section-kicker">Playbook · Read Coach</span><h1>Practice reads</h1><p>Checkpoint {index + 1} of {lesson?.checkpoints.length ?? 0}</p></div><div><button type="button" className="button button-outline" onClick={() => replay("opening")} disabled={playing}><Play size={15} />Play opening</button><button type="button" className="button button-subtle" onClick={onExit}>Back to editing</button></div></header>
    {error ? <p className="playbook-alert" role="alert">{error}</p> : null}
    <section className="read-coach-practice-grid" aria-label="Practice checkpoint">
      <div className="read-coach-practice-court"><ReadCoachCourt frame={frame ?? initialFrame!} arrows={answer && replayKind !== "choice" ? selected?.arrows : []} visibility={visibility} showRoutes={Boolean(answer && replayKind === "choice")} ariaLabel={answer ? "Selected continuation playback" : "Checkpoint opening with future routes hidden"} /><div className="read-coach-court-caption">{answer ? replayKind === "choice" ? "Continuation playback" : "Checkpoint situation" : replayKind === "opening" && !playing ? "Opening stopped at this checkpoint" : "Future routes are hidden until you choose"}</div></div>
      <div className="read-coach-practice-prompt"><h2>{checkpoint.question}</h2><p className="read-coach-lock-note">Choose the read you would make next</p><div className="read-coach-answer-list" role="group" aria-label="Choose an answer">{checkpoint.choices.map((choice) => <button type="button" key={choice.id} disabled={answer !== null} className={`read-coach-answer ${answer === choice.id ? "is-chosen" : ""}`} onClick={() => setAnswer(choice.id)}>{choice.label}</button>)}</div>
        {answer ? <div className="read-coach-feedback" role="status"><strong>{answer === checkpoint.correctChoiceId ? "That’s the intended read" : `The intended read was ${intended?.label ?? "another option"}`}</strong><p>{checkpoint.explanation}</p><div className="read-coach-replay-actions"><button type="button" className="button button-outline" onClick={() => replay("choice", answer)}><Play size={14} />Replay your choice</button><button type="button" className="button button-subtle" onClick={() => replay("choice", checkpoint.correctChoiceId)}><Play size={14} />Replay intended choice</button></div><button type="button" className="button button-subtle" onClick={() => { setAnswer(null); setFrame(null); setReplayKind(null); setError(null); stopClient(); }}>Try again</button></div> : null}
        <div className="read-coach-practice-nav"><span>{index + 1} / {lesson?.checkpoints.length ?? 0}</span><button type="button" className="button button-primary" disabled={index >= (lesson?.checkpoints.length ?? 1) - 1} onClick={() => { stopClient(); setIndex((current) => current + 1); setAnswer(null); setFrame(null); setReplayKind(null); setError(null); }}>Next checkpoint</button></div>
      </div>
    </section>
  </main>;
}

// Static ESM import is kept behind a tiny accessor to avoid loading a worker
// client merely by viewing the lesson authoring panel.
function requirePlaybookClient() {
  return createClient;
}
import { createPlaybookSimulationClient as createClient } from "./playbookSimulationClient.ts";
