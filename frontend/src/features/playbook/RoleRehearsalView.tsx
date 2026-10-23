import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Pause, Pencil, Play, RotateCcw, UsersRound } from "lucide-react";
import { ReadCoachCourt } from "./ReadCoachViews.tsx";
import { createPlaybookSimulationClient, type PlaybookSimulationClient } from "./playbookSimulationClient.ts";
import { buildRoleCues, type RoleCue } from "./roleRehearsal.ts";
import { authoredCourtRoutes } from "./simulation.ts";
import { spacingGateStatusSymbol, spacingGateStatusText } from "./SpacingGateLayer.tsx";
import type { SimulationView } from "./playbookSimulationProtocol.ts";
import type { PlaybookDraft, RoleCuePhase, SimulationSettings } from "./types.ts";
import type { ArrowVisibility } from "./arrowVisibility.ts";

type Props = {
  play: PlaybookDraft;
  cueSource: PlaybookDraft;
  branchId: string | null;
  branchLabel: string | null;
  sharedIds: Set<string>;
  playerId: number | null;
  settings: SimulationSettings;
  visibility: ArrowVisibility;
  active: boolean;
  onViewChange: (view: "edit" | "practice" | "role", playerId?: number | null) => void;
  onCueChange: (cue: { playerId: number; actionId: string; phase: RoleCuePhase; text: string | null; signature: string }) => void;
};

function statusLabel(status: RoleCue["status"]) {
  return status === "blocked" ? "Blocked" : status === "completed" ? "Done" : status === "active" ? "Active" : "Waiting";
}

export function RoleRehearsalView({ play, cueSource, branchId, branchLabel, sharedIds, playerId, settings, visibility, active, onViewChange, onCueChange }: Props) {
  const clientRef = useRef<PlaybookSimulationClient | null>(null);
  const loopRef = useRef<{ kind: "role" | "cue"; start: number; end: number } | null>(null);
  const previousTimestamp = useRef<number | null>(null);
  const preparingRef = useRef(false);
  const rewindingRef = useRef(false);
  const lastProgressRef = useRef(0);
  const [view, setView] = useState<SimulationView | null>(null);
  const [playing, setPlaying] = useState(false);
  const [prepareProgress, setPrepareProgress] = useState<number | null>(0);
  const [restartNonce, setRestartNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showWholeTeam, setShowWholeTeam] = useState(false);
  const [roleRoutesOn, setRoleRoutesOn] = useState(true);
  const [showRoleSpacingGates, setShowRoleSpacingGates] = useState(true);
  const [selectedCueKey, setSelectedCueKey] = useState<string | null>(null);
  const [editingCue, setEditingCue] = useState(false);
  const [cueText, setCueText] = useState("");
  const activePlayer = play.players.find((player) => player.id === playerId) ?? null;
  const executableKey = useMemo(() => JSON.stringify({ players: play.players, defenders: play.defenders, ball: play.ball, arrows: play.arrows, defenders_visible: play.defenders_visible, settings }), [play, settings]);

  useEffect(() => {
    setView(null); setError(null); setPlaying(false); setPrepareProgress(0); loopRef.current = null; previousTimestamp.current = null;
    if (play.players.length === 0 || play.arrows.length === 0) {
      // Stationary roles need no worker. Empty or setup-only drawings should
      // show the intentional no-possession state rather than starting a worker
      // that has no executable timeline to record.
      setPrepareProgress(null);
      return;
    }
    const scripted: SimulationSettings = { ...settings, offenseMode: "scripted", offenseOffBall: "off", automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };
    const client = createPlaybookSimulationClient({
      sessionId: crypto.randomUUID(),
      onState: (next) => {
        if (preparingRef.current) {
          const fraction = next.durationMs > 0 ? Math.min(1, next.session.recordedUntilMs / next.durationMs) : 1;
          const percent = Math.floor(fraction * 100);
          if (percent === 100 || percent - lastProgressRef.current >= 5) {
            lastProgressRef.current = percent;
            setPrepareProgress(percent);
          }
          if (next.playing && next.session.recordedUntilMs + 1e-6 < next.durationMs) {
            // Advance the authoritative session in fixed 50 ms chunks. The
            // client permits only one outstanding worker request at a time.
            clientRef.current?.advance(50);
            return;
          }
          preparingRef.current = false;
          rewindingRef.current = true;
          setPrepareProgress(null);
          clientRef.current?.playback(false);
          clientRef.current?.seek(0);
          return;
        }
        if (rewindingRef.current && next.session.positionMs > 1e-6) return;
        rewindingRef.current = false;
        const loop = loopRef.current;
        const now = next.session.positionMs;
        if (loop && now >= loop.end - 1e-5) {
          client.seek(loop.start);
          client.playback(true);
          return;
        }
        setView(next); setPlaying(next.playing);
      },
      onFailure: (message) => { preparingRef.current = false; rewindingRef.current = false; setPrepareProgress(null); setError(message); setPlaying(false); },
    });
    clientRef.current = client;
    preparingRef.current = true;
    rewindingRef.current = false;
    lastProgressRef.current = 0;
    client.start(play, scripted);
    return () => {
      preparingRef.current = false;
      rewindingRef.current = false;
      loopRef.current = null;
      client.playback(false);
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };
    // Cue wording and the routed player are deliberately excluded: neither changes executable state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executableKey, restartNonce]);

  // Keep the recorded session alive while another workspace is visible. This
  // pauses the rehearsal without rebuilding it when the user returns.
  useEffect(() => {
    if (active) return;
    loopRef.current = null;
    previousTimestamp.current = null;
    if (preparingRef.current) return;
    setPlaying(false);
    clientRef.current?.playback(false);
  }, [active]);

  useEffect(() => {
    if (!active || !playing) return;
    let frameId = 0;
    const tick = (timestamp: number) => {
      if (document.hidden) { previousTimestamp.current = null; return; }
      const previous = previousTimestamp.current;
      previousTimestamp.current = timestamp;
      if (previous != null) clientRef.current?.advance(Math.min(50, Math.max(0, timestamp - previous)));
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [active, playing]);

  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const pauseHidden = () => {
      if (!document.hidden) return;
      if (preparingRef.current) return;
      loopRef.current = null; setPlaying(false); clientRef.current?.playback(false);
    };
    document.addEventListener("visibilitychange", pauseHidden);
    return () => document.removeEventListener("visibilitychange", pauseHidden);
  }, [active]);

  const cues = useMemo(() => buildRoleCues(play, playerId ?? -1, branchId, sharedIds, view?.frame.execution ?? [], view?.session.positionMs ?? 0, cueSource.roleCues), [play, cueSource.roleCues, playerId, branchId, sharedIds, view?.frame.execution, view?.session.positionMs]);
  const stationaryRole = cues.length === 1 && cues[0].actionId === "stationary";
  const nowMs = view?.session.positionMs ?? 0;
  const activeCueIndex = cues.findIndex((cue) => cue.status === "active" || cue.status === "blocked");
  const upcomingCueIndex = cues.findIndex((cue) => cue.startAtMs >= nowMs);
  const timelineCueIndex = activeCueIndex >= 0 ? activeCueIndex : upcomingCueIndex >= 0 ? upcomingCueIndex : Math.max(0, cues.length - 1);
  const requestedCueIndex = cues.findIndex((cue) => cue.key === selectedCueKey);
  const currentIndex = requestedCueIndex >= 0 ? requestedCueIndex : timelineCueIndex;
  const selectedCue = cues.find((cue) => cue.key === selectedCueKey) ?? cues[currentIndex] ?? null;
  const currentCueTime = cues[currentIndex]?.startAtMs;
  const previousCueTime = currentCueTime === undefined ? undefined : [...new Set(cues.map((cue) => cue.startAtMs).filter((time) => time < currentCueTime - 1))].sort((a, b) => a - b).at(-1);
  const nextCueTime = currentCueTime === undefined ? undefined : [...new Set(cues.map((cue) => cue.startAtMs).filter((time) => time > currentCueTime + 1))].sort((a, b) => a - b)[0];
  // Keep simultaneous responsibilities together so the strip never invents a
  // sequence for actions that start at the same time.
  const visibleCues = cues.filter((cue) => currentCueTime !== undefined && (Math.abs(cue.startAtMs - currentCueTime) <= 1
    || previousCueTime !== undefined && Math.abs(cue.startAtMs - previousCueTime) <= 1
    || nextCueTime !== undefined && Math.abs(cue.startAtMs - nextCueTime) <= 1));
  const roleRouteList = useMemo(() => authoredCourtRoutes(play).filter((route) => route.playerId === playerId && route.actionId !== null), [play, playerId]);
  const roleSpacingGates = useMemo(() => (play.spacingGates?.gates ?? []).filter((gate) => gate.playerId === playerId), [play.spacingGates, playerId]);
  const spacingGateResults = view?.frame.spacingGateResults ?? [];
  const isMissingPlayer = !activePlayer;

  function seek(timeMs: number) {
    if (!clientRef.current) return;
    loopRef.current = null; setPlaying(false); clientRef.current.seek(Math.max(0, Math.min(view?.durationMs ?? timeMs, timeMs)));
  }
  function togglePlayback() {
    const next = !playing;
    if (next) { loopRef.current = null; setSelectedCueKey(null); }
    setPlaying(next); clientRef.current?.playback(next);
  }
  function startLoop(kind: "role" | "cue", cue?: RoleCue | null) {
    if (!view || !clientRef.current) return;
    const start = kind === "cue" && cue ? Math.max(0, cue.startAtMs - 500) : 0;
    const end = kind === "cue" && cue ? Math.min(view.durationMs, cue.endAtMs + 500) : view.durationMs;
    if (end <= start) return;
    loopRef.current = { kind, start, end };
    setPlaying(false);
    clientRef.current.seek(start);
    clientRef.current.playback(true);
    setPlaying(true);
  }
  function focusCue(cue: RoleCue) {
    setSelectedCueKey(cue.key); setEditingCue(false); setCueText(cue.text); seek(cue.startAtMs);
  }
  function saveCue() {
    if (!selectedCue || !cueText.trim()) return;
    onCueChange({ playerId: selectedCue.playerId, actionId: selectedCue.actionId, phase: selectedCue.phase, text: cueText.trim(), signature: selectedCue.signature });
    setEditingCue(false);
  }
  function resetCue() {
    if (!selectedCue) return;
    onCueChange({ playerId: selectedCue.playerId, actionId: selectedCue.actionId, phase: selectedCue.phase, text: null, signature: selectedCue.signature });
    setCueText(selectedCue.text); setEditingCue(false);
  }

  return <main className="role-rehearsal-page" aria-label="My Role rehearsal">
    <header className="role-rehearsal-header">
      <div><span className="section-kicker">Playbook · My Role</span><h1>Rehearse one player’s job</h1><p>{play.name}{branchLabel ? ` · ${branchLabel}` : " · Main"}</p></div>
      <button type="button" className="button button-outline" onClick={() => onViewChange("edit")}><ArrowLeft size={15} />Back to editing</button>
    </header>
    <div className="role-rehearsal-layout">
      <section className="role-rehearsal-court-panel" aria-label="Role playback">
        <div className="role-rehearsal-toolbar">
          <label><span>Player</span><select aria-label="Choose a player to rehearse" value={activePlayer ? String(activePlayer.id) : ""} onChange={(event) => onViewChange("role", event.currentTarget.value ? Number(event.currentTarget.value) : null)}><option value="">Choose a player</option>{play.players.map((player) => <option key={player.id} value={player.id}>Player {player.id}</option>)}</select></label>
          <label className="role-toggle"><input type="checkbox" checked={showWholeTeam} onChange={(event) => setShowWholeTeam(event.currentTarget.checked)} /><span><UsersRound size={14} />Show whole team</span></label>
          <label className="role-toggle"><input type="checkbox" checked={roleRoutesOn} onChange={(event) => setRoleRoutesOn(event.currentTarget.checked)} /><span>Role routes: {roleRoutesOn ? "On" : "Off"}</span></label>
          <label className="role-toggle"><input type="checkbox" checked={showRoleSpacingGates} onChange={(event) => setShowRoleSpacingGates(event.currentTarget.checked)} /><span>Spacing gates: {showRoleSpacingGates ? "On" : "Off"}</span></label>
        </div>
        {isMissingPlayer ? <div className="role-rehearsal-empty" role="status"><strong>{playerId === null ? "Choose a player to rehearse" : `Player ${playerId} is not in this play`}</strong><p>Select an offensive player above. The routed player is never silently replaced</p></div> : null}
        {!isMissingPlayer && view ? <ReadCoachCourt frame={view.frame} visibility={roleRoutesOn ? "all" : "off"} showRoutes={roleRoutesOn} routes={roleRoutesOn ? roleRouteList : []} emphasisPlayerId={playerId} showWholeTeam={showWholeTeam} spacingGates={roleSpacingGates} showSpacingGates={showRoleSpacingGates} ariaLabel={`Simulation rehearsal for Player ${playerId}`} /> : null}
        {!isMissingPlayer && play.arrows.length > 0 && !view && !error ? <div className="role-rehearsal-empty" role="status">{prepareProgress === null ? "Opening the recorded rehearsal…" : `Preparing the authored rehearsal… ${prepareProgress}%`}</div> : null}
        {error ? <div className="role-rehearsal-error" role="alert"><span>{error}</span><button type="button" className="button button-outline" onClick={() => setRestartNonce((value) => value + 1)}>Retry rehearsal</button></div> : null}
        {play.arrows.length === 0 && !isMissingPlayer ? <p className="role-rehearsal-empty-note">This play has no executable possession yet · Add an action in Playbook to rehearse movement</p> : null}
        {view ? <div className="role-playback-controls">
          <div className="role-playback-buttons"><button type="button" className="button button-primary" onClick={togglePlayback} disabled={Boolean(error)} aria-label={playing ? "Pause role rehearsal" : "Play role rehearsal"}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? "Pause" : "Play"}</button><button type="button" className="button button-outline" disabled={Boolean(error)} onClick={() => startLoop("role")}><RotateCcw size={14} />Loop role</button><button type="button" className="button button-outline" disabled={Boolean(error) || !selectedCue || selectedCue.actionId === "stationary"} onClick={() => startLoop("cue", selectedCue)}><RotateCcw size={14} />Loop current cue</button></div>
          <div className="role-scrubber"><input aria-label="Rehearsal position" type="range" min={0} max={view.durationMs || 1} step={10} value={Math.min(nowMs, view.durationMs)} disabled={Boolean(error)} onChange={(event) => seek(Number(event.currentTarget.value))} /><output>{(nowMs / 1000).toFixed(1)}s / {(view.durationMs / 1000).toFixed(1)}s</output></div>
        </div> : null}
      </section>
      <aside className="role-rehearsal-cues" aria-label="Player responsibilities">
        <div className="role-cues-heading"><div><span className="section-kicker">Responsibilities</span><h2>{activePlayer ? `Player ${activePlayer.id}` : "Choose a player"}</h2></div><span>{cues.length} cues</span></div>
        {stationaryRole && activePlayer ? <p className="role-rehearsal-empty-note">No authored actions bind to this player · They hold their starting position</p> : null}
        {activePlayer && roleSpacingGates.length ? <section className="role-spacing-gates" aria-label={`Player ${activePlayer.id} spacing expectations`}>
          <header><strong>Spacing expectations</strong><span>{roleSpacingGates.length}</span></header>
          {roleSpacingGates.map((gate) => {
            const result = spacingGateResults.find((candidate) => candidate.gateId === gate.id);
            const time = result?.firstViolationAtMs ?? result?.checkedAtMs ?? result?.triggerAtMs;
            return <button type="button" key={gate.id} className={`role-spacing-gate status-${result?.status ?? "pending"}`} disabled={time == null} onClick={() => time != null && seek(time)}>
              <span className="role-spacing-gate-status" aria-hidden="true">{spacingGateStatusSymbol(result?.status)}</span>
              <span><strong>{gate.instruction || `${gate.rule === "inside" ? "Stay inside" : "Stay outside"} the ${gate.area.shape}`}</strong><small>{spacingGateStatusText(result?.status)} · {result?.reason ?? (result?.firstViolationAtMs != null ? `First violation at ${(result.firstViolationAtMs / 1000).toFixed(2)}s` : result?.checkedAtMs != null ? `Checked at ${(result.checkedAtMs / 1000).toFixed(2)}s` : "Play to check this expectation")}</small></span>
            </button>;
          })}
        </section> : null}
        {visibleCues.map((cue) => { const index = cues.findIndex((item) => item.key === cue.key); const position = Math.abs(cue.startAtMs - (currentCueTime ?? cue.startAtMs)) <= 1 ? "Current" : Math.abs(cue.startAtMs - (previousCueTime ?? Number.NaN)) <= 1 ? "Previous" : "Next"; return <button type="button" key={cue.key} className={`role-cue-card ${cue.key === selectedCue?.key ? "is-current" : ""}`} onClick={() => focusCue(cue)} aria-current={cue.key === selectedCue?.key ? "step" : undefined}>
          <span className={`role-cue-status is-${cue.status}`}>{position} · {statusLabel(cue.status)}</span><strong>{cue.text}</strong><small>Move {cue.sequence} · {(cue.startAtMs / 1000).toFixed(1)}s{cue.phase === "receive" && cue.diagnostic?.transfer?.outcome.kind === "pending" ? " · awaiting confirmed catch" : ""}</small>{cue.diagnostic?.notice ? <small className="role-cue-notice">{cue.diagnostic.notice}</small> : null}{cue.reviewWording ? <small className="role-cue-review">Review wording · its action or dependency changed</small> : null}
          {index > 0 && Math.abs(cues[index - 1].startAtMs - cue.startAtMs) < 1 ? <span className="sr-only">Simultaneous with previous responsibility</span> : null}
        </button>; })}
        {selectedCue ? <div className="role-cue-editor">
          <div><strong>{selectedCue.text}</strong><small>{selectedCue.diagnostic?.notice ?? (selectedCue.actionId === "stationary" ? "Stationary responsibility · Active" : `Move ${selectedCue.sequence} · ${statusLabel(selectedCue.status)}`)}</small></div>
          {editingCue ? <><textarea aria-label="Cue wording" maxLength={240} value={cueText} onChange={(event) => setCueText(event.currentTarget.value)} /><div className="role-cue-actions"><button type="button" className="button button-subtle" onClick={() => { setCueText(selectedCue.text); setEditingCue(false); }}>Cancel</button><button type="button" className="button button-outline" onClick={resetCue}>Reset wording</button><button type="button" className="button button-primary" disabled={!cueText.trim()} onClick={saveCue}>Save cue</button></div></> : <div className="role-cue-actions"><button type="button" className="button button-subtle" onClick={() => { setCueText(selectedCue.text); setEditingCue(true); }}><Pencil size={14} />Edit cues</button>{cueSource.roleCues?.cues.some((item) => item.playerId === selectedCue.playerId && item.actionId === selectedCue.actionId && item.phase === selectedCue.phase && (item.scope === "shared" && sharedIds.has(selectedCue.actionId) || item.scope === "ending" && item.branchId === branchId)) ? <button type="button" className="button button-subtle" onClick={resetCue}>Reset wording</button> : null}</div>}
        </div> : null}
        {cues.length ? <div className="role-cue-neighbors"><button type="button" disabled={currentIndex <= 0} onClick={() => { const index = Math.max(0, currentIndex - 1); focusCue(cues[index]); }}><ArrowLeft size={13} />Previous cue</button><button type="button" disabled={currentIndex >= cues.length - 1} onClick={() => { const index = Math.min(cues.length - 1, currentIndex + 1); focusCue(cues[index]); }}>Next cue<ArrowRight size={13} /></button></div> : null}
      </aside>
    </div>
  </main>;
}

