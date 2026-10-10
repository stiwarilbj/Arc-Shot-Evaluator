import { ArrowVisibilityControl, useArrowVisibility } from "./ArrowVisibilityControl";
import { CourtRoutes } from "./CourtRoutes";
import { authoredCourtRoutes } from "./simulation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, FlaskConical, LoaderCircle, Pause, Play, RotateCcw, Save, X } from "lucide-react";
import type { PlaybookDraft, PlaybookDocument } from "./types";
import { clonePlaybook } from "./types";
import { createPlaybook, fetchPlaybooks, subscribePlaybooks } from "./api";
import { STARTER_PLAYS } from "./data";
import { COUNTER_LAB_DEFAULT_PROFILES, COUNTER_LAB_EXTRA_SCHEMES, COUNTER_LAB_EXTRA_STRATEGIES, eligibleCounterLabSchemes, type CounterLabFrame, type CounterLabMode, type CounterLabProfile, type CounterLabRepair, type CounterLabSummary, type CounterLabMessage, type CounterLabProgress } from "./counterLabTypes";
import { advanceReplay, matchesReplay, replayFrame } from "./counterLabReplay";
import { COURT_VIEWBOX, courtPointToSvg } from "./courtGeometry";
import { CourtMarkings } from "./CourtMarkings";
const requestId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clock = (time: number) => `${(time / 1000).toFixed(1)}s`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${Number(value.toFixed(1))}`;
const modeName = (mode: CounterLabMode) => mode === "scripted" ? "Drawn play" : "Adaptive offense";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please retry.";

export function CounterLab({ active, currentDraft, requestedPlay, onOpenEditor, onOpenInPlaybook }: {
  active: boolean; currentDraft: PlaybookDraft | null; requestedPlay: { requestId: string; play: PlaybookDraft } | null;
  onOpenEditor: () => void; onOpenInPlaybook: (play: PlaybookDocument) => void;
}) {
  const [draft, setDraft] = useState(() => clonePlaybook(requestedPlay?.play ?? currentDraft ?? STARTER_PLAYS[0]));
  const [source, setSource] = useState(currentDraft || requestedPlay ? "Playbook draft" : "Starter play");
  const [saved, setSaved] = useState<PlaybookDocument[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [playQuery, setPlayQuery] = useState("");
  const [profiles, setProfiles] = useState<CounterLabProfile[]>(() => [...COUNTER_LAB_DEFAULT_PROFILES]);
  const [modes, setModes] = useState<CounterLabMode[]>(["scripted", "adaptive"]);
  const [advanced, setAdvanced] = useState(false);
  const [results, setResults] = useState<CounterLabSummary[] | null>(null);
  const [repairs, setRepairs] = useState<CounterLabRepair[]>([]);
  const [selection, setSelection] = useState({ profileId: "switch", mode: "scripted" as CounterLabMode });
  const [repairId, setRepairId] = useState("original");
  const [baselineTrace, setBaselineTrace] = useState<CounterLabFrame[] | null>(null);
  const [repairTrace, setRepairTrace] = useState<CounterLabFrame[] | null>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [courtView, setCourtView] = useState<"original" | "repair">("original");
  const [progress, setProgress] = useState<CounterLabProgress | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailRetry, setDetailRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedCopies, setSavedCopies] = useState<Record<string, PlaybookDocument>>({});
  const [saveMessage, setSaveMessage] = useState("");
  const reportWorker = useRef<Worker | null>(null), pendingWorker = useRef<Worker | null>(null);
  const reportId = useRef(""), pendingId = useRef("");
  const expectedDetail = useRef<{ id: string; detailId: string; key: string; repairId: string } | null>(null);
  const libraryVersion = useRef(0), saveLock = useRef(false), positionRef = useRef(0);
  const resultsRef = useRef<HTMLElement>(null);
  const key = `${selection.profileId}:${selection.mode}`;
  const baseline = results?.find((result) => result.key === key) ?? null;
  const eligibleRepairs = repairs.filter((repair) => repair.evidence.some((e) => e.key === key && e.verified)).sort((a, b) => {
    const left = a.evidence.find((e) => e.key === key)!, right = b.evidence.find((e) => e.key === key)!;
    return Number(right.cleared) - Number(left.cleared) || right.gain - left.gain || a.name.localeCompare(b.name);
  }).slice(0, 3);
  const chosenRepair = eligibleRepairs.find((repair) => repair.id === repairId) ?? null;
  const chosenId = chosenRepair?.id ?? "original";
  const repaired = chosenRepair?.results.find((result) => result.key === key) ?? null;
  const duration = Math.max(baselineTrace?.at(-1)?.elapsedMs ?? 0, repairTrace?.at(-1)?.elapsedMs ?? 0);
  const schemes = eligibleCounterLabSchemes(draft.defenders.length || Math.min(5, draft.players.length), draft.players.length);
  const refreshLibrary = useCallback(() => {
    const version = ++libraryVersion.current;
    void fetchPlaybooks().then((plays) => { if (version === libraryVersion.current) { setSaved(plays); setLibraryError(""); } }).catch((caught: unknown) => { if (version === libraryVersion.current) setLibraryError(messageOf(caught)); });
  }, []);
  useEffect(() => {
    refreshLibrary(); const unsubscribe = subscribePlaybooks(refreshLibrary);
    return () => { ++libraryVersion.current; unsubscribe(); reportWorker.current?.terminate(); pendingWorker.current?.terminate(); };
  }, [refreshLibrary]);
  useEffect(() => { if (active) refreshLibrary(); }, [active, refreshLibrary]);
  useEffect(() => { if (requestedPlay) loadPlay(requestedPlay.play, "Playbook draft"); }, [requestedPlay?.requestId]);
  useEffect(() => { if (!active) setPlaying(false); }, [active]);
  useEffect(() => { const pause = () => { if (document.hidden) setPlaying(false); }; document.addEventListener("visibilitychange", pause); return () => document.removeEventListener("visibilitychange", pause); }, []);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => {
    if (!playing || !active || !duration) return;
    let previous = performance.now(), handle = 0;
    const tick = (now: number) => {
      if (document.hidden) { setPlaying(false); return; }
      const next = advanceReplay(positionRef.current, now - previous, speed, duration); previous = now; positionRef.current = next; setPosition(next);
      if (next >= duration) setPlaying(false); else handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick); return () => cancelAnimationFrame(handle);
  }, [playing, active, speed, duration]);
  useEffect(() => {
    if (!baseline || !reportWorker.current) return;
    setPlaying(false); setBaselineTrace(null); setRepairTrace(null); setDetailError("");
    const expected = { id: reportId.current, detailId: requestId(), key, repairId: chosenId }; expectedDetail.current = expected;
    reportWorker.current.postMessage({ type: "details", ...expected });
    const timeout = window.setTimeout(() => { if (expectedDetail.current?.detailId === expected.detailId) setDetailError("Replay could not be loaded. Retry the replay or test defenses again."); }, 8000);
    return () => window.clearTimeout(timeout);
  }, [baseline, key, chosenId, detailRetry]);
  useEffect(() => { if (results && active) resultsRef.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }, [Boolean(results)]);

  function pauseAndSeek(time: number) { setPlaying(false); positionRef.current = Math.max(0, Math.min(time, duration)); setPosition(positionRef.current); }
  function clearReport() {
    pendingWorker.current?.terminate(); reportWorker.current?.terminate(); pendingWorker.current = null; reportWorker.current = null;
    pendingId.current = ""; reportId.current = ""; expectedDetail.current = null;
    setProgress(null); setResults(null); setRepairs([]); setRepairId("original"); setBaselineTrace(null); setRepairTrace(null); setPlaying(false); setPosition(0); positionRef.current = 0;
    setSavedCopies({}); setSaveMessage(""); setError(""); setDetailError("");
  }
  function loadPlay(play: PlaybookDraft, origin: string) {
    clearReport(); setDraft(clonePlaybook(play)); setSource(origin);
    const allowed = new Set<string>(eligibleCounterLabSchemes(play.defenders.length || Math.min(5, play.players.length), play.players.length).map((profile) => profile.id));
    setProfiles((current) => current.filter((profile) => !COUNTER_LAB_EXTRA_SCHEMES.some((extra) => extra.id === profile.id) || allowed.has(profile.id)));
  }
  function chooseResult(profileId: string, mode = selection.mode) { setSelection({ profileId, mode }); setRepairId("original"); setCourtView("original"); pauseAndSeek(0); }
  function toggleProfile(profile: CounterLabProfile) { clearReport(); setProfiles((current) => current.some((item) => item.id === profile.id) ? current.filter((item) => item.id !== profile.id) : [...current, profile]); }
  function toggleMode(mode: CounterLabMode) { clearReport(); setModes((current) => current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode]); }
  function cancel() {
    const worker = pendingWorker.current; if (worker) worker.postMessage({ type: "cancel", id: pendingId.current });
    if (worker !== reportWorker.current) worker?.terminate();
    pendingWorker.current = null; pendingId.current = ""; setProgress(null); setSaveMessage("Comparison cancelled. Completed results remain available.");
  }
  function runAnalysis() {
    if (pendingWorker.current || !draft.players.length || !draft.arrows.length || !profiles.length || !modes.length) return;
    setPlaying(false); setError(""); setSaveMessage("");
    const id = requestId(); let worker: Worker;
    try { worker = new Worker(new URL("./counterLab.worker.ts", import.meta.url), { type: "module" }); }
    catch { setError("Analysis could not start. Reload Counter Lab and retry; your play is unchanged."); return; }
    pendingWorker.current = worker; pendingId.current = id;
    worker.onmessage = (event: MessageEvent<CounterLabMessage>) => {
      const message = event.data;
      if (message.type === "details") {
        if (!matchesReplay(message, expectedDetail.current) || message.id !== reportId.current) return;
        expectedDetail.current = null;
        if (!message.original || (message.repairId !== "original" && !message.repaired)) { setDetailError("This replay is unavailable. Test defenses again to regenerate it."); return; }
        setBaselineTrace(message.original); setRepairTrace(message.repaired); setDetailError("");
        positionRef.current = Math.min(positionRef.current, Math.max(message.original.at(-1)?.elapsedMs ?? 0, message.repaired?.at(-1)?.elapsedMs ?? 0)); setPosition(positionRef.current); return;
      }
      if (message.id !== pendingId.current) return;
      if (message.type === "progress") setProgress(message);
      if (message.type === "baseline") {
        if (reportWorker.current !== worker) reportWorker.current?.terminate(); reportWorker.current = worker; reportId.current = id;
        setResults(message.results); setRepairs([]); setRepairId("original"); setSavedCopies({}); setPosition(0); positionRef.current = 0;
        const mode = modes.includes("scripted") ? "scripted" : modes[0];
        const candidates = message.results.filter((result) => result.mode === mode).sort((a, b) => Number(Boolean(b.firstBreakdown)) - Number(Boolean(a.firstBreakdown)) || a.score - b.score);
        setSelection({ profileId: candidates[0]?.profile.id ?? profiles[0].id, mode });
      }
      if (message.type === "complete") { setRepairs(message.repairs); setProgress(null); pendingWorker.current = null; pendingId.current = ""; }
      if (message.type === "error") { setError(message.message); setProgress(null); pendingWorker.current = null; pendingId.current = ""; if (worker !== reportWorker.current) worker.terminate(); }
      if (message.type === "cancelled") { setProgress(null); pendingWorker.current = null; pendingId.current = ""; }
    };
    worker.onerror = () => {
      if (worker !== reportWorker.current && worker !== pendingWorker.current) return; worker.terminate();
      if (worker === pendingWorker.current) { pendingWorker.current = null; pendingId.current = ""; setProgress(null); }
      if (worker === reportWorker.current) { reportWorker.current = null; expectedDetail.current = null; setDetailError("The replay worker stopped. Test defenses again to restore replay."); }
      setError("Analysis stopped unexpectedly. Your play and completed results are unchanged; try again.");
    };
    setProgress({ completed: 0, total: 0, label: "Preparing the same court for every defense", stage: "defenses" }); worker.postMessage({ type: "analyze", id, draft: clonePlaybook(draft), profiles, modes });
  }
  async function saveRepair() {
    if (!chosenRepair || savedCopies[chosenRepair.id] || saveLock.current) return;
    saveLock.current = true; setSaving(true); setError(""); const analysisId = reportId.current, repair = chosenRepair;
    try {
      const copy = await createPlaybook({ ...clonePlaybook(repair.play), id: `draft-counter-${requestId()}`, created_at: undefined, updated_at: undefined, name: `${draft.name} · ${repair.name}`.slice(0, 80) });
      if (reportId.current === analysisId) { setSavedCopies((current) => ({ ...current, [repair.id]: copy })); setSaveMessage(`Saved “${copy.name}” as a separate editable play.`); }
    } catch (caught) { if (reportId.current === analysisId) setError(messageOf(caught)); }
    finally { saveLock.current = false; setSaving(false); }
  }
  function playPause() { if (position >= duration) { positionRef.current = 0; setPosition(0); } setPlaying((value) => !value); }
  const previewRoutes = useMemo(() => authoredCourtRoutes(draft), [draft]);
  const preview: CounterLabFrame = { elapsedMs: 0, sequence: null, action: null, ballHandlerId: null, assignments: [], opportunities: [], blockedPass: null, involvedPlayerIds: [], activeRoutes: previewRoutes, players: draft.players, defenders: draft.defenders, ball: draft.ball, shotPhase: "idle" };

  return <main className="counter-lab-page">
    <header className="counter-lab-header"><div><span className="section-kicker">BREAK MY PLAY</span><h1><FlaskConical size={26} />Counter Lab</h1><p>See where your play breaks. Try a small change and test it again.</p></div></header>
    <ol className="counter-steps" aria-label="Counter Lab workflow"><li className={!results ? "is-current" : ""}><b>1</b>Choose play</li><li className={progress ? "is-current" : ""}><b>2</b>Test defenses</li><li className={results ? "is-current" : ""}><b>3</b>Inspect breakdown</li><li className={chosenRepair ? "is-current" : ""}><b>4</b>Try repair</li></ol>
    <div className="counter-workbench"><aside className="counter-sidebar" aria-label="Play selection and test settings">
    <section className="counter-import-panel" aria-label="Choose a play"><div className="counter-import-heading"><h2>Choose a play</h2></div><label className="counter-play-search">Find a play<input type="search" value={playQuery} onChange={(event) => setPlayQuery(event.target.value)} placeholder="Search starter or saved plays" /></label>{currentDraft ? <button className="counter-import-choice" onClick={() => loadPlay(currentDraft, "Playbook draft")}><strong>Current Playbook draft</strong><span>{currentDraft.name}</span></button> : null}<h3>Saved plays</h3>{libraryError ? <div className="counter-alert" role="alert">{libraryError}<button className="counter-text-button" onClick={refreshLibrary}>Retry saved plays</button></div> : saved.length ? <div className="counter-import-list">{saved.filter((play) => play.name.toLowerCase().includes(playQuery.toLowerCase().trim())).map((play) => <button key={play.id} className="counter-import-choice" aria-pressed={source === "Saved play" && draft.id === play.id} onClick={() => loadPlay(play, "Saved play")}><strong>{play.name}</strong><span>{play.players.length} players · {play.arrows.length} actions</span></button>)}</div> : <p className="counter-muted">No saved plays yet. Choose a starter below.</p>}<h3>Starter plays</h3><div className="counter-starters">{STARTER_PLAYS.filter((play) => play.name.toLowerCase().includes(playQuery.toLowerCase().trim())).map((play) => <button key={play.id} className="counter-chip" aria-pressed={source === "Starter play" && draft.id === play.id} onClick={() => loadPlay(play, "Starter play")}>{play.name}</button>)}</div>{playQuery.trim() && ![...saved, ...STARTER_PLAYS].some((play) => play.name.toLowerCase().includes(playQuery.toLowerCase().trim())) ? <p className="counter-muted" role="status">No matching plays. Try another name.</p> : null}</section>
      <ArrowVisibilityControl />
      <details open={advanced} onToggle={(event) => { setAdvanced(event.currentTarget.open); if (!event.currentTarget.open) event.currentTarget.closest(".counter-sidebar")?.scrollTo({ top: 0 }); }} className="counter-settings"><summary>Test settings · {profiles.length} defenses · {modes.length === 2 ? "both offense modes" : modes.map(modeName).join(", ") || "choose a mode"}</summary><fieldset><legend>Defensive responses</legend><div className="counter-options">{[...COUNTER_LAB_DEFAULT_PROFILES, ...COUNTER_LAB_EXTRA_STRATEGIES, ...schemes].map((profile) => <label key={profile.id}><input type="checkbox" checked={profiles.some((item) => item.id === profile.id)} onChange={() => toggleProfile(profile)} />{profile.label}</label>)}</div></fieldset><fieldset><legend>Offense behavior</legend><div className="counter-options">{(["scripted", "adaptive"] as const).map((mode) => <label key={mode}><input type="checkbox" checked={modes.includes(mode)} onChange={() => toggleMode(mode)} />{modeName(mode)}</label>)}</div><p>Drawn play follows your actions. Adaptive offense can improvise.</p></fieldset></details>
    </aside><div className="counter-main">
    <section className="counter-setup" aria-label="Play and test settings"><div className="counter-play-summary"><span className="section-kicker">1 · YOUR PLAY</span><h2>{draft.name}</h2><p>{source} · {draft.players.length} players · {draft.arrows.length} actions</p>{!draft.arrows.length ? <div className="counter-empty"><h3>Start with a play that has actions</h3><p>This draft has a starting lineup, but no moves to test.</p><button className="counter-text-button" onClick={onOpenEditor}>Open Playbook to draw a play</button></div> : <p className="counter-muted">The original stays unchanged. Every defense starts with the same positions and ratings.</p>}
      <div className="counter-run-row"><button className="button button-primary" disabled={!progress && (!draft.players.length || !draft.arrows.length || !profiles.length || !modes.length)} onClick={progress ? cancel : runAnalysis}>{progress ? <><X size={17} />Cancel test</> : <><FlaskConical size={17} />Test defenses</>}</button>{progress ? <div className="counter-progress" role="status"><strong>{progress.stage === "defenses" ? "Testing defenses" : "Testing repairs"}</strong><span>{progress.label}</span><progress max={progress.total || 1} value={progress.completed} aria-label="Comparison progress" /></div> : <span className="counter-muted">Runs in your browser</span>}</div>{(!profiles.length || !modes.length) ? <p role="status">Choose at least one defense and offense behavior in Test settings.</p> : null}</div><div className="counter-preview"><CounterCourt title="Play preview" frame={preview} preview /></div></section>
    {error ? <div className="counter-alert" role="alert"><CircleAlert size={20} />{error}</div> : null}{saveMessage ? <div className="counter-success" role="status"><Check size={20} />{saveMessage}</div> : null}
    {results ? <section ref={resultsRef} className="counter-results" aria-label="Counter Lab results"><div className="counter-results-heading"><div><span className="section-kicker">3 · INSPECT THE RESULT</span><h2>How the defense answers</h2></div><div className="counter-mode-tabs" role="group" aria-label="Offense behavior results">{modes.map((mode) => <button key={mode} aria-pressed={selection.mode === mode} onClick={() => chooseResult(selection.profileId, mode)}>{modeName(mode)}</button>)}</div></div><div className="counter-matchups">{results.filter((result) => result.mode === selection.mode).map((result) => <button key={result.key} className={`counter-matchup ${selection.profileId === result.profile.id ? "is-selected" : ""}`} aria-pressed={selection.profileId === result.profile.id} onClick={() => chooseResult(result.profile.id)}><strong>{result.profile.label}</strong><b>{result.score}<small> / 100</small></b><span>{resultLabel(result)}</span></button>)}</div><p className="counter-score-note">Simulation quality score. This is not a real scoring probability.</p>
      <div className="counter-inspect-layout"><div className="counter-playback">{chosenRepair ? <div className="counter-court-tabs" role="group" aria-label="Court comparison view"><button aria-pressed={courtView === "original"} onClick={() => setCourtView("original")}>Original</button><button aria-pressed={courtView === "repair"} onClick={() => setCourtView("repair")}>Repair</button></div> : null}<div className={`counter-courts ${chosenRepair ? `mobile-${courtView}` : "is-single"}`}><CounterCourt title="Original play" frame={replayFrame(baselineTrace, position)} view="original" />{chosenRepair ? <CounterCourt title={chosenRepair.name} frame={replayFrame(repairTrace, position)} view="repair" /> : null}</div>
        {detailError ? <div className="counter-alert" role="alert">{detailError}<button className="counter-text-button" onClick={() => setDetailRetry((value) => value + 1)}>Retry replay</button></div> : !baselineTrace ? <div className="counter-loading-detail" role="status"><LoaderCircle className="counter-spinner" size={20} />Loading the selected replay…</div> : <div className="counter-timeline" tabIndex={0} aria-label="Court replay controls" onKeyDown={(event) => { if ((event.target as HTMLElement).closest("select,input,button")) return; if (event.key === " ") { event.preventDefault(); playPause(); } if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); pauseAndSeek(position + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1000 : 100)); } if (event.key === "Home" || event.key === "End") { event.preventDefault(); pauseAndSeek(event.key === "Home" ? 0 : duration); } }}>
          <div className="counter-timeline-actions"><button aria-label={playing ? "Pause court replay" : "Play court replay"} onClick={playPause}>{playing ? <Pause size={18} /> : <Play size={18} />}{playing ? "Pause" : "Play"}</button><button aria-label="Restart court replay" onClick={() => pauseAndSeek(0)}><RotateCcw size={17} /></button><span>{clock(position)} / {clock(duration)}</span><label>Speed <select aria-label="Replay speed" value={speed} onChange={(event) => setSpeed(Number(event.currentTarget.value))}><option value={.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label></div><div className="counter-scrub-wrap"><input aria-label="Scrub court replay" type="range" min={0} max={duration || 1} step={50} value={position} onChange={(event) => pauseAndSeek(Number(event.currentTarget.value))} />{baseline?.firstBreakdown ? <button className="counter-scrub-marker" style={{ left: `${baseline.firstBreakdown.atMs / Math.max(1, duration) * 100}%` }} aria-label={`Jump to first breakdown at ${clock(baseline.firstBreakdown.atMs)}`} title="First breakdown" onClick={() => pauseAndSeek(baseline.firstBreakdown!.atMs)} /> : null}</div><div className="counter-scrub-foot"><span>{replayFrame(baselineTrace, position)?.action ?? "Possession"}</span>{baseline?.firstBreakdown ? <button className="counter-text-button" onClick={() => pauseAndSeek(baseline.firstBreakdown!.atMs)}>Jump to breakdown · {clock(baseline.firstBreakdown.atMs)}</button> : null}</div></div>}
      </div><aside className="counter-diagnosis"><span className="section-kicker">{baseline?.profile.label} · {modeName(selection.mode)}</span><h3>{baseline ? resultLabel(baseline) : "Choose a defense"}</h3><p>{baseline ? explainResult(baseline) : ""}</p>{baseline?.firstUnsafePass ? <div className="counter-warning"><strong>Contested pass · Move {baseline.firstUnsafePass.sequence}</strong><p>The lane was unsafe at {clock(baseline.firstUnsafePass.unsafeAtMs!)}. {baseline.firstUnsafePass.status === "delivered" ? "The pass was still delivered in this simulation." : baseline.firstUnsafePass.status === "interrupted" ? "The action was interrupted before a catch was recorded." : "The transfer later failed."}</p></div> : null}<p className="counter-outcome">{baseline?.outcome}</p>{baseline ? <details><summary>Simulation evidence</summary><p>Adaptive attempts: {baseline.adaptiveAttempts} · completed: {baseline.adaptiveSuccesses}</p>{baseline.actionDiagnostics?.filter((action) => action.notice).map((action) => <p key={action.actionId}>Move {action.sequence}: {action.notice}</p>)}{baseline.passDiagnostics.map((pass) => <p key={pass.actionId}>Move {pass.sequence}: Player {pass.actorId} → {pass.playerId ?? "missing receiver"} · {pass.status}{pass.unsafeAtMs != null ? ` · separation ${pass.receiverGap.toFixed(1)} ft, lane ${pass.laneGap.toFixed(1)} ft` : ""}</p>)}</details> : null}{repaired ? <div className="counter-repaired-outcome"><strong>Repair result</strong><p>{resultLabel(repaired)}</p><p>{repaired.outcome}</p></div> : null}</aside></div>
      <section className="counter-repairs" aria-label="Verified repairs"><span className="section-kicker">4 · TRY A REPAIR</span><h3>Small changes, tested against {baseline?.profile.label}</h3>{progress ? <p className="counter-muted" role="status">Your original results are ready. Repairs are still being tested.</p> : !eligibleRepairs.length ? <p className="counter-no-repairs">No tested edit improved this matchup. Keep the original or inspect another defense.</p> : null}<div className="counter-repair-grid">{eligibleRepairs.map((repair) => { const evidence = repair.evidence.find((e) => e.key === key)!, negatives = repair.evidence.filter((e) => e.gain < 0).length; return <button key={repair.id} className={`counter-repair-card ${chosenId === repair.id ? "is-selected" : ""}`} aria-pressed={chosenId === repair.id} onClick={() => { setRepairId(repair.id); setCourtView("repair"); pauseAndSeek(0); }}><strong>{repair.name}</strong><b>{evidence.cleared ? "Breakdown cleared" : `${signed(evidence.gain)} quality points`}</b><span>{repair.reason}</span><small>{negatives ? `${negatives} other trial${negatives === 1 ? "" : "s"} had lower quality` : "No quality regression in the tested trials"}</small></button>; })}</div>
        {chosenRepair ? <div className="counter-repair-details"><div className="counter-repair-toolbar"><button className="counter-text-button" onClick={() => { setRepairId("original"); setCourtView("original"); pauseAndSeek(0); }}>View original only</button>{savedCopies[chosenRepair.id] ? <button className="button button-primary" onClick={() => onOpenInPlaybook(savedCopies[chosenRepair.id])}>Open saved repair in Playbook</button> : <button className="button button-primary" disabled={saving} onClick={() => void saveRepair()}><Save size={17} />{saving ? "Saving…" : "Save repair to Playbook"}</button>}</div><div className="counter-action-changes"><strong>Changed actions</strong>{describeChanges(draft, chosenRepair.play).map((change) => <span key={change}>{change}</span>)}</div><details><summary>Compare all tested defenses</summary><div className="counter-table-wrap"><table><thead><tr><th>Defense / offense</th><th>Quality change</th><th>Breakdown</th></tr></thead><tbody>{chosenRepair.evidence.map((e) => <tr key={e.key}><th>{chosenRepair.results.find((r) => r.key === e.key)?.profile.label} · {modeName(chosenRepair.results.find((r) => r.key === e.key)!.mode)}</th><td>{signed(e.gain)}</td><td>{e.cleared ? "Cleared" : e.opening === "delayed" ? `Delayed ${clock(e.delayMs)}` : e.opening === "not created" ? "No advantage created" : e.opening === "still failing" ? "Still failing" : "Unchanged"}</td></tr>)}</tbody></table></div></details></div> : null}
      </section>
    </section> : null}
    </div></div>
  </main>;
}
function resultLabel(result: CounterLabSummary) {
  if (result.firstBreakdown) {
    const event = result.firstBreakdown;
    return event.kind === "failed-pass" ? `Transfer failed · Move ${event.sequence}` : event.kind === "obstructed-action" ? `Route obstructed · Move ${event.sequence}` : event.kind === "action-conflict" ? `Conflicting actions · Move ${event.sequence}` : `Opening lost · ${clock(event.atMs)}`;
  }
  return result.createdAdvantage ? "No breakdown detected" : "No clear advantage created";
}
function explainResult(result: CounterLabSummary) {
  if (result.firstBreakdown?.kind === "obstructed-action" || result.firstBreakdown?.kind === "action-conflict") return result.actionDiagnostics.find((action) => action.actionId === result.firstBreakdown?.actionId)?.notice ?? "This action could not finish cleanly within its bounded waiting window.";
  if (result.firstBreakdown?.kind === "failed-pass") return `The authored pass or handoff did not complete at ${clock(result.firstBreakdown.atMs)}. The receiver did not catch the ball within the engine's retry window.`;
  if (result.firstBreakdown?.kind === "opening-lost") return `An opening existed, then the best eligible option dropped by at least 15 quality points and stayed below the opening threshold for 0.3 seconds. ${result.notice ?? ""}`;
  return result.createdAdvantage ? "A clear option remained available. No sustained loss or failed authored transfer was recorded before the shot." : "This run did not create an eligible opening of 55 quality or higher. There is no lost advantage to diagnose.";
}
function describeChanges(original: PlaybookDraft, repaired: PlaybookDraft) {
  return repaired.arrows.flatMap((arrow, index) => {
    const before = original.arrows.find((a) => a.id === arrow.id); if (!before) return [`Added ${arrow.kind}`]; const changes: string[] = [];
    if (before.kind !== arrow.kind) changes.push(`${before.kind.replaceAll("-", " ")} → ${arrow.kind.replaceAll("-", " ")}`);
    if (before.timing !== arrow.timing) changes.push(`duration ${(before.timing ?? 1.2).toFixed(2)}s → ${(arrow.timing ?? 1.2).toFixed(2)}s`);
    if (before.end.x !== arrow.end.x || before.end.y !== arrow.end.y) changes.push("destination changed");
    if (JSON.stringify(before.exit_target) !== JSON.stringify(arrow.exit_target)) changes.push("finish route changed");
    return changes.length ? [`Move ${arrow.sequence ?? index + 1}: ${changes.join(" · ")}`] : [];
  });
}
function CounterCourt({ title, frame, preview = false, view }: { title: string; frame: CounterLabFrame | null; preview?: boolean; view?: string }) {
  const visibility = useArrowVisibility();
  const involvedDefenders = new Set(frame?.assignments.filter((a) => frame.involvedPlayerIds.includes(a.playerId)).map((a) => a.defenderId));
  return <figure className={`counter-court ${preview ? "is-preview" : "is-replay"}`} data-view={view}><figcaption>{title}</figcaption><svg viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} role="img" aria-label={`${title} court position`}><rect width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} className="counter-court-floor" /><CourtMarkings /><CourtRoutes routes={frame?.activeRoutes ?? []} visibility={visibility} />{frame?.defenders.map((defender) => { const p = courtPointToSvg(defender); return <g key={`d${defender.id}`} className={involvedDefenders.has(defender.id) ? "counter-defender-involved" : ""}><circle cx={p.x} cy={p.y} r={preview ? 30 : 18} className="counter-defense-dot" /><text x={p.x} y={p.y + 2} className="counter-defender-number">{defender.id}</text></g>; })}{frame?.players.map((player) => { const p = courtPointToSvg(player); return <g key={`p${player.id}`}><circle cx={p.x} cy={p.y} r={preview ? 30 : 18} className={`counter-offense-dot ${frame.involvedPlayerIds.includes(player.id) ? "is-involved" : ""}`} /><text x={p.x} y={p.y + 2} className="counter-player-number">{player.id}</text></g>; })}{frame?.ball ? (() => { const p = courtPointToSvg(frame.ball); const holder = frame.players.find((player) => player.id === frame.ballHandlerId); const attached = holder && Math.hypot(holder.x - frame.ball!.x, holder.y - frame.ball!.y) < .2; return <circle cx={p.x + (attached ? 14 : 0)} cy={p.y - (attached ? 14 : 0)} r="8" className="counter-ball-dot" />; })() : null}</svg><div className="counter-court-legend"><span><i className="counter-legend-offense" />Offense</span><span><i className="counter-legend-defense" />Defense</span>{!preview ? <span>Best option <b>{frame ? Math.max(0, ...frame.opportunities.map((o) => o.quality)) : "—"}</b></span> : null}</div></figure>;
}
