import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, CheckCircle2, CircleAlert, FlaskConical, LoaderCircle, Pause, Play, Save, Sparkles, X } from "lucide-react";
import type { PlaybookDraft, PlaybookDocument } from "./types";
import { clonePlaybook } from "./types";
import { createPlaybook, fetchPlaybooks } from "./api";
import { STARTER_PLAYS } from "./data";
import {
  COUNTER_LAB_DEFAULT_PROFILES,
  COUNTER_LAB_EXTRA_SCHEMES,
  COUNTER_LAB_EXTRA_STRATEGIES,
  eligibleCounterLabSchemes,
  type CounterLabFrame,
  type CounterLabMode,
  type CounterLabProfile,
  type CounterLabRepair,
  type CounterLabResult,
} from "./counterLabTypes";
import { COURT_VIEWBOX, courtPointToSvg } from "./courtGeometry";
import { CourtMarkings } from "./CourtMarkings";

type Summary = Omit<CounterLabResult, "trace">;
type RepairSummary = Omit<CounterLabRepair, "results"> & { results: Summary[] };
type WorkerMessage =
  | { type: "progress"; id: string; completed: number; total: number; label: string }
  | { type: "complete"; id: string; results: Summary[]; repairs: RepairSummary[] }
  | { type: "details"; id: string; key: string; original: CounterLabFrame[] | null; repaired: CounterLabFrame[] | null }
  | { type: "error"; id: string; message: string };

function newRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function CounterLab({
  initialPlay,
  onOpenInPlaybook,
}: {
  initialPlay: PlaybookDraft | null;
  onOpenInPlaybook: (play: PlaybookDocument) => void;
}) {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef("");
  const [draft, setDraft] = useState<PlaybookDraft>(() => clonePlaybook(initialPlay ?? STARTER_PLAYS[0]));
  const [saved, setSaved] = useState<PlaybookDocument[]>([]);
  const [savedError, setSavedError] = useState("");
  const [selected, setSelected] = useState<PlaybookDocument | null>(null);
  const [profiles, setProfiles] = useState<CounterLabProfile[]>(COUNTER_LAB_DEFAULT_PROFILES);
  const [modes, setModes] = useState<CounterLabMode[]>(["scripted", "adaptive"]);
  const [results, setResults] = useState<Summary[] | null>(null);
  const [repairs, setRepairs] = useState<RepairSummary[]>([]);
  const [repairId, setRepairId] = useState("original");
  const [selectedProfileId, setSelectedProfileId] = useState("switch");
  const [selectedMode, setSelectedMode] = useState<CounterLabMode>("scripted");
  const [baselineTrace, setBaselineTrace] = useState<CounterLabFrame[] | null>(null);
  const [repairTrace, setRepairTrace] = useState<CounterLabFrame[] | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number; label: string } | null>(null);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [savedOpen, setSavedOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPlaybooks().then(setSaved).catch((caught: unknown) => {
      setSavedError(caught instanceof Error ? caught.message : "Saved plays could not be loaded.");
    });
    return () => workerRef.current?.terminate();
  }, []);

  useEffect(() => {
    if (!initialPlay) return;
    stopWorker();
    setDraft(clonePlaybook(initialPlay));
    const initialDefenders = initialPlay.defenders.length || Math.min(5, initialPlay.players.length);
    const initialSchemes = new Set<string>(eligibleCounterLabSchemes(initialDefenders, initialPlay.players.length).map((profile) => profile.id));
    setProfiles((current) => current.filter((profile) => !COUNTER_LAB_EXTRA_SCHEMES.some((candidate) => candidate.id === profile.id) || initialSchemes.has(profile.id)));
    setSelected(null);
    setResults(null);
    setRepairs([]);
    setBaselineTrace(null);
    setRepairTrace(null);
    setError("");
    setSaveMessage("");
  }, [initialPlay]);

  useEffect(() => {
    if (!results || !workerRef.current || !requestIdRef.current) return;
    const profile = profiles.find((candidate) => candidate.id === selectedProfileId) ?? profiles[0];
    if (!profile) return;
    const key = `${profile.id}:${selectedMode}`;
    if (!results.some((result) => result.key === key)) return;
    setBaselineTrace(null);
    setRepairTrace(null);
    workerRef.current.postMessage({ type: "details", id: requestIdRef.current, key, repairId });
  }, [results, selectedProfileId, selectedMode, repairId, profiles]);

  useEffect(() => {
    if (!playing) return;
    const interval = window.setInterval(() => {
      setPositionMs((current) => {
        const maximum = Math.max(baselineTrace?.at(-1)?.elapsedMs ?? 0, repairTrace?.at(-1)?.elapsedMs ?? 0);
        if (current + 100 >= maximum) {
          setPlaying(false);
          return maximum;
        }
        return current + 100;
      });
    }, 50);
    return () => window.clearInterval(interval);
  }, [playing, baselineTrace, repairTrace]);

  const selectedKey = profiles.find((profile) => profile.id === selectedProfileId)
    ? `${selectedProfileId}:${selectedMode}`
    : profiles[0] ? `${profiles[0].id}:${selectedMode}` : "";
  const baselineSummary = results?.find((result) => result.key === selectedKey) ?? null;
  const repairSummary = repairs.find((repair) => repair.id === repairId)?.results.find((result) => result.key === selectedKey) ?? null;
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null;
  const maxDuration = Math.max(baselineTrace?.at(-1)?.elapsedMs ?? 0, repairTrace?.at(-1)?.elapsedMs ?? 0);
  const baselineFrame = frameAt(baselineTrace, positionMs);
  const repairFrame = frameAt(repairTrace, positionMs);
  const suggestedRepairs = useMemo(() => repairs, [repairs]);
  const selectedRepair = suggestedRepairs.find((repair) => repair.id === repairId) ?? null;
  const defenderCount = draft.defenders.length || Math.min(5, draft.players.length);
  const eligibleSchemes = eligibleCounterLabSchemes(defenderCount, draft.players.length);

  function stopWorker() {
    const worker = workerRef.current;
    if (worker) {
      worker.postMessage({ type: "cancel", id: requestIdRef.current });
      worker.terminate();
    }
    workerRef.current = null;
    requestIdRef.current = `stopped-${newRequestId()}`;
    setProgress(null);
    setPlaying(false);
  }

  function invalidateComparison() {
    stopWorker();
    setResults(null);
    setRepairs([]);
    setRepairId("original");
    setBaselineTrace(null);
    setRepairTrace(null);
    setPositionMs(0);
  }

  function usePlay(play: PlaybookDraft) {
    stopWorker();
    setDraft(clonePlaybook(play));
    const playDefenders = play.defenders.length || Math.min(5, play.players.length);
    const playSchemes = new Set<string>(eligibleCounterLabSchemes(playDefenders, play.players.length).map((profile) => profile.id));
    setProfiles((current) => current.filter((profile) => !COUNTER_LAB_EXTRA_SCHEMES.some((candidate) => candidate.id === profile.id) || playSchemes.has(profile.id)));
    setSelected("created_at" in play ? play as PlaybookDocument : null);
    setResults(null);
    setRepairs([]);
    setRepairId("original");
    setBaselineTrace(null);
    setRepairTrace(null);
    setPositionMs(0);
    setError("");
    setSaveMessage("");
    setSavedOpen(false);
  }

  function toggleProfile(profile: CounterLabProfile) {
    const exists = profiles.some((item) => item.id === profile.id);
    const next = exists ? profiles.filter((item) => item.id !== profile.id) : [...profiles, profile];
    invalidateComparison();
    setProfiles(next);
    if (!exists) setSelectedProfileId(profile.id);
    else if (profile.id === selectedProfileId) setSelectedProfileId(next[0]?.id ?? "");
  }

  function toggleMode(mode: CounterLabMode) {
    const next = modes.includes(mode) ? modes.filter((item) => item !== mode) : [...modes, mode];
    invalidateComparison();
    setModes(next);
    if (!next.includes(selectedMode) && next[0]) setSelectedMode(next[0]);
  }

  function runAnalysis() {
    if (!draft.players.length) {
      setError("Add at least one offensive player to this play before testing it.");
      return;
    }
    if (!profiles.length || !modes.length) {
      setError("Choose at least one defensive response and one offense mode.");
      return;
    }
    stopWorker();
    setResults(null);
    setRepairs([]);
    setRepairId("original");
    setBaselineTrace(null);
    setRepairTrace(null);
    setPositionMs(0);
    setPlaying(false);
    setSaveMessage("");
    setError("");
    const id = newRequestId();
    requestIdRef.current = id;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./counterLab.worker.ts", import.meta.url), { type: "module" });
    } catch (caught) {
      setError(caught instanceof Error ? `Counter Lab could not start its analysis worker: ${caught.message}` : "Counter Lab could not start its analysis worker. Your Playbook is unchanged.");
      return;
    }
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.id !== requestIdRef.current) return;
      if (message.type === "progress") setProgress({ completed: message.completed, total: message.total, label: message.label });
      if (message.type === "complete") {
        setResults(message.results);
        setRepairs(message.repairs);
        setProgress(null);
        const bestBreakdown = message.results
          .filter((result) => result.firstLostOpeningMs != null || result.firstBlockedPass != null)
          .sort((a, b) => a.score - b.score)[0];
        if (bestBreakdown) setSelectedProfileId(bestBreakdown.profile.id);
      }
      if (message.type === "details") {
        setBaselineTrace(message.original);
        setRepairTrace(message.repaired);
        setPositionMs((current) => Math.min(current, Math.max(message.original?.at(-1)?.elapsedMs ?? 0, message.repaired?.at(-1)?.elapsedMs ?? 0)));
      }
      if (message.type === "error") {
        setProgress(null);
        setError(message.message);
      }
    };
    worker.onerror = () => {
      setProgress(null);
      setError("Counter Lab stopped unexpectedly. Your Playbook is unchanged; try the comparison again.");
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.postMessage({ type: "analyze", id, draft: clonePlaybook(draft), profiles, modes });
    setProgress({ completed: 0, total: 0, label: "Preparing matchups…" });
  }

  async function saveRepair() {
    const repair = suggestedRepairs.find((candidate) => candidate.id === repairId);
    if (!repair) return;
    setSaving(true);
    setSaveMessage("");
    setError("");
    const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36);
    try {
      const copy = await createPlaybook({
        ...clonePlaybook(repair.play),
        id: `draft-counter-${suffix}`,
        name: `${draft.name} · ${repair.name}`.slice(0, 80),
      });
      setSaved((current) => [copy, ...current.filter((item) => item.id !== copy.id)]);
      setSelected(copy);
      setSaveMessage(`Saved “${copy.name}” as a separate play. Your original is unchanged.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Repair could not be saved. Your original play is unchanged.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="counter-lab-page">
      <header className="counter-lab-header">
        <div><span className="section-kicker">ARC · PLAYBOOK TOOLS</span><h1><FlaskConical size={23} />Counter Lab</h1><p>Break a play, find the breakdown, and test a repair against the same defense.</p></div>
        <button type="button" className="button button-outline" onClick={() => setSavedOpen((open) => !open)} aria-expanded={savedOpen}><ArrowLeftRight size={16} />Import a play</button>
      </header>

      {savedOpen ? <section className="counter-import-panel" aria-label="Import a play">
        <div className="counter-import-heading"><strong>Choose a play</strong><button className="icon-button" type="button" aria-label="Close import panel" onClick={() => setSavedOpen(false)}><X size={15} /></button></div>
        {initialPlay ? <button className="counter-import-choice" type="button" onClick={() => usePlay(initialPlay)}><strong>Current Playbook draft</strong><span>{initialPlay.name}</span></button> : null}
        <div className="counter-import-list">{saved.map((play) => <button className="counter-import-choice" key={play.id} type="button" onClick={() => usePlay(play)}><strong>{play.name}</strong><span>Saved play · {play.players.length} players · {play.arrows.length} actions</span></button>)}</div>
        {savedError ? <p className="counter-muted" role="status">Saved plays unavailable: {savedError}</p> : null}
        <div className="counter-starters-label">Starter plays</div>
        <div className="counter-starters">{STARTER_PLAYS.map((play) => <button key={play.id} type="button" className="counter-chip" onClick={() => usePlay(play)}>{play.name}</button>)}</div>
      </section> : null}

      <section className="counter-play-card">
        <div><span className="counter-muted">TESTING PLAY</span><strong>{draft.name}</strong><span className="counter-muted">{draft.players.length} players · {draft.arrows.length} authored actions{selected?.id ? " · imported from saved plays" : ""}</span></div>
        {initialPlay ? <button type="button" className="counter-text-button" onClick={() => usePlay(initialPlay)}>Use current Playbook draft</button> : null}
      </section>

      <div className="counter-control-grid">
        <fieldset className="counter-control-card"><legend>Defensive responses</legend><p>Every defense uses the same starting court and player ratings.</p>
          <div className="counter-options">{COUNTER_LAB_DEFAULT_PROFILES.map((profile) => <label key={profile.id}><input type="checkbox" checked={profiles.some((item) => item.id === profile.id)} onChange={() => toggleProfile(profile)} /><span>{profile.label}</span></label>)}</div>
          <button className="counter-text-button" type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>{moreOpen ? "Hide more matchups" : "More strategies and zone defenses"}</button>
          {moreOpen ? <div className="counter-more-options"><div className="counter-options">{COUNTER_LAB_EXTRA_STRATEGIES.map((profile) => <label key={profile.id}><input type="checkbox" checked={profiles.some((item) => item.id === profile.id)} onChange={() => toggleProfile(profile)} /><span>{profile.label}</span></label>)}</div>{eligibleSchemes.length ? <div className="counter-options">{eligibleSchemes.map((profile) => <label key={profile.id}><input type="checkbox" checked={profiles.some((item) => item.id === profile.id)} onChange={() => toggleProfile(profile)} /><span>{profile.label}</span></label>)}</div> : <small className="counter-no-zones">Zone schemes need five defenders; Triangle-and-two also needs at least two offensive players.</small>}</div> : null}
        </fieldset>
        <fieldset className="counter-control-card"><legend>Offense behavior</legend><p>Run the authored actions as drawn and see whether the offense can recover.</p><div className="counter-options">
          <label><input type="checkbox" checked={modes.includes("scripted")} onChange={() => toggleMode("scripted")} /><span>Drawn play</span></label>
          <label><input type="checkbox" checked={modes.includes("adaptive")} onChange={() => toggleMode("adaptive")} /><span>Adaptive offense</span></label>
        </div><p className="counter-disclaimer">Adaptive reads are simulated choices, not predictions of real game outcomes.</p></fieldset>
      </div>

      {error ? <div className="counter-alert" role="alert"><CircleAlert size={16} />{error}</div> : null}
      {saveMessage ? <div className="counter-success" role="status"><CheckCircle2 size={16} />{saveMessage}<button className="counter-text-button" type="button" onClick={() => selected && onOpenInPlaybook(selected)}>Open in Playbook</button></div> : null}
      <div className="counter-run-row"><button type="button" className="button button-primary" disabled={!progress && (!draft.players.length || !profiles.length || !modes.length)} onClick={progress ? stopWorker : runAnalysis}>{progress ? <><LoaderCircle className="counter-spinner" size={16} />Cancel comparison</> : <><FlaskConical size={16} />Run Counter Lab</>}</button>
        {progress ? <div className="counter-progress" role="status"><span>{progress.label}</span>{progress.total ? <><div><i style={{ width: `${Math.round(progress.completed / progress.total * 100)}%` }} /></div><small>{progress.completed} / {progress.total}</small></> : <small>Preparing matchups</small>}</div> : null}
      </div>

      {results ? <section className="counter-results" aria-label="Counter Lab results">
        <div className="counter-results-heading"><div><span className="section-kicker">SIMULATED POSSESSIONS</span><h2>What happened</h2></div><label>Offense <select aria-label="Select offense behavior" value={selectedMode} onChange={(event) => setSelectedMode(event.currentTarget.value as CounterLabMode)}>{modes.map((mode) => <option key={mode} value={mode}>{mode === "scripted" ? "Drawn play" : "Adaptive offense"}</option>)}</select></label></div>
        <div className="counter-matchups">{results.filter((result) => result.mode === selectedMode).map((result) => <button key={result.key} type="button" className={`counter-matchup ${selectedProfileId === result.profile.id ? "is-selected" : ""}`} aria-pressed={selectedProfileId === result.profile.id} onClick={() => { setSelectedProfileId(result.profile.id); setPlaying(false); }}><strong>{result.profile.label}</strong><span>Simulation score</span><b>{result.score}<small> / 100</small></b>{result.firstLostOpeningMs != null ? <i>Opening lost · {formatClock(result.firstLostOpeningMs)}</i> : result.firstBlockedPass ? <i>Pass blocked · Move {result.firstBlockedPass.sequence ?? "—"}</i> : result.createdAdvantage ? <i>No breakdown detected</i> : <i>No clear advantage created</i>}</button>)}</div>
        <p className="counter-score-note">Score uses the simulator’s shot-quality scale; it is not a real-game probability.</p>

        <div className="counter-detail-heading"><div><span className="section-kicker">{selectedProfile?.label ?? "DEFENSE"} · {selectedMode === "scripted" ? "DRAWN PLAY" : "ADAPTIVE OFFENSE"}</span><h3>{baselineSummary?.notice ?? (baselineSummary?.firstBlockedPass ? `Move ${baselineSummary.firstBlockedPass.sequence ?? "?"} could not find a passing window.` : baselineSummary?.firstLostOpeningMs != null ? "The best opening did not stay open." : baselineSummary ? baselineSummary.createdAdvantage ? "No breakdown detected in this run." : "No clear advantage created." : "Choose a defensive response.")}</h3>
          <p>{baselineSummary?.firstLostOpeningMs != null ? `The best available option fell by at least 15 quality points and stayed down for 0.3 seconds, starting at ${formatClock(baselineSummary.firstLostOpeningMs)}.` : baselineSummary?.firstBlockedPass ? `At ${formatClock(baselineSummary.firstBlockedPass.atMs)}, Player ${baselineSummary.firstBlockedPass.playerId} had ${baselineSummary.firstBlockedPass.receiverGap.toFixed(1)} ft of defender separation and ${baselineSummary.firstBlockedPass.laneGap.toFixed(1)} ft of lane clearance.` : baselineSummary?.createdAdvantage ? "The simulated possession created an opening, but it did not stay closed long enough to count as a breakdown." : baselineSummary ? "The simulated possession did not create a clear advantage or obstruct an authored pass." : ""}</p>
          {baselineSummary ? <p className="counter-outcome">{repairSummary?.outcome ?? baselineSummary.outcome}</p> : null}
        </div></div>

        <div className="counter-compare-picker"><label>Compare with <select aria-label="Compare original play with repair" value={repairId} onChange={(event) => setRepairId(event.currentTarget.value)}><option value="original">Original play</option>{suggestedRepairs.map((repair) => <option key={repair.id} value={repair.id}>{repair.name} · {repair.resolvedBreakdowns ? `${repair.resolvedBreakdowns} breakdown${repair.resolvedBreakdowns === 1 ? "" : "s"} cleared` : signed(repair.averageGain)}</option>)}</select></label>
          {selectedRepair ? <><span>{selectedRepair.resolvedBreakdowns ? <><strong>{selectedRepair.resolvedBreakdowns} breakdown{selectedRepair.resolvedBreakdowns === 1 ? "" : "s"} cleared</strong>{selectedRepair.averageGain > 0 ? ` · +${selectedRepair.averageGain.toFixed(1)} average quality` : ""}</> : <>Average gain <strong>{signed(selectedRepair.averageGain)} quality</strong></>}</span><button className="button button-primary" type="button" disabled={saving} onClick={() => void saveRepair()}><Save size={15} />{saving ? "Saving…" : "Save repair to Playbook"}</button></> : null}
        </div>
        {!suggestedRepairs.length ? <p className="counter-no-repairs">No tested edit improved this play against the selected matchups. Keep the original or try a different defense and offense mode.</p> : null}

        {selectedRepair ? <p className="counter-repair-reason"><Sparkles size={15} />{selectedRepair.reason} Repairs appear here only after the same trial shows a measurable gain.</p> : null}
        {selectedRepair ? <div className="counter-action-changes"><strong>Changed actions</strong>{describeRepairChanges(draft, selectedRepair.play).map((change) => <span key={change}>{change}</span>)}</div> : null}
        {selectedRepair ? <div className="counter-tradeoffs"><strong>Across the tested defenses</strong>{selectedRepair.results.map((result) => {
          const baseline = results.find((base) => base.key === result.key);
          return <span key={result.key}>{result.profile.label} · {result.mode === "scripted" ? "Drawn" : "Adaptive"}: {describeRepairResult(result, baseline)}</span>;
        })}</div> : null}

        <div className={`counter-courts ${repairId === "original" ? "is-single" : ""}`}>
          <CounterCourt title="Original play" frame={baselineFrame} />
          {selectedRepair ? <CounterCourt title={selectedRepair.name} frame={repairFrame} /> : null}
        </div>
        {baselineTrace ? <div className="counter-timeline"><div className="counter-timeline-actions"><button type="button" aria-label={playing ? "Pause court replay" : "Play court replay"} onClick={() => { if (positionMs >= maxDuration) setPositionMs(0); setPlaying((value) => !value); }}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "Pause" : "Play"}</button><span>{formatClock(positionMs)} / {formatClock(maxDuration)}</span>{baselineSummary?.firstLostOpeningMs != null ? <button type="button" className="counter-event-jump" onClick={() => { setPlaying(false); setPositionMs(baselineSummary.firstLostOpeningMs ?? 0); }}>Jump to first lost opening</button> : null}{baselineSummary?.firstBlockedPass ? <button type="button" className="counter-event-jump" onClick={() => { setPlaying(false); setPositionMs(baselineSummary.firstBlockedPass?.atMs ?? 0); }}>Jump to blocked pass</button> : null}</div>
          <div className="counter-scrub-wrap"><input aria-label="Scrub court replay" type="range" min={0} max={maxDuration || 1} step={50} value={positionMs} onChange={(event) => { setPlaying(false); setPositionMs(Number(event.currentTarget.value)); }} /><div className="counter-scrub-marker" style={{ left: `${baselineSummary?.firstLostOpeningMs != null && maxDuration ? baselineSummary.firstLostOpeningMs / maxDuration * 100 : -5}%` }} title="First sustained loss of opening" /></div><div className="counter-scrub-foot"><span>Positions and coverage from the simulation</span><span>{baselineFrame?.action ?? "Possession start"}{baselineFrame?.sequence ? ` · Move ${baselineFrame.sequence}` : ""}</span></div></div> : <div className="counter-loading-detail"><LoaderCircle size={17} />Preparing the selected possession…</div>}
      </section> : null}
    </main>
  );
}

function frameAt(trace: CounterLabFrame[] | null, time: number) {
  if (!trace?.length) return null;
  let lo = 0;
  let hi = trace.length - 1;
  while (lo < hi) {
    const middle = (lo + hi) >> 1;
    if (trace[middle].elapsedMs < time) lo = middle + 1;
    else hi = middle;
  }
  return trace[lo];
}

function CounterCourt({ title, frame }: { title: string; frame: CounterLabFrame | null }) {
  const markerId = `counter-route-${useId().replaceAll(":", "")}`;
  return <figure className="counter-court"><figcaption>{title}</figcaption><svg viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} role="img" aria-label={`${title} simulated court position`}><rect width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} rx="8" className="counter-court-floor" /><CourtMarkings />
    {frame?.activeRoutes.map((route, index) => { const start = courtPointToSvg(route.start); const end = courtPointToSvg(route.end); return <path key={`${route.playerId}-${route.kind}-${index}`} d={`M${start.x} ${start.y} L${end.x} ${end.y}`} className="counter-active-route" markerEnd={`url(#${markerId})`} />; })}
    <defs><marker id={markerId} markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0L9 4.5L0 9Z" className="counter-route-head" /></marker></defs>
    {frame?.players.map((player) => { const p = courtPointToSvg(player); const involved = frame.involvedPlayerIds.includes(player.id); return <g key={`p-${player.id}`}><circle cx={p.x} cy={p.y} r={involved ? "22" : "19"} className={`counter-offense-dot ${involved ? "is-involved" : ""}`} /><text x={p.x} y={p.y + 1}>{player.id}</text></g>; })}
    {frame?.defenders.map((defender) => { const p = courtPointToSvg(defender); return <g key={`d-${defender.id}`}><circle cx={p.x} cy={p.y} r="17" className="counter-defense-dot" /><path d={`M${p.x - 6} ${p.y - 6}l12 12m0-12-12 12`} /><text x={p.x} y={p.y + 29}>D{defender.id}</text></g>; })}
    {frame?.ball ? (() => { const p = courtPointToSvg(frame.ball); return <circle cx={p.x} cy={p.y} r="7" className="counter-ball-dot" />; })() : null}
  </svg><div><span>Openings <b>{frame?.opportunities.filter((option) => option.quality >= 55).length ?? "—"}</b></span><span>Best read <b>{frame ? Math.max(0, ...frame.opportunities.map((option) => option.quality)) : "—"}</b></span></div></figure>;
}

function describeRepairChanges(original: PlaybookDraft, repaired: PlaybookDraft) {
  const before = new Map(original.arrows.map((arrow) => [arrow.id, arrow]));
  return repaired.arrows.flatMap((arrow) => {
    const previous = before.get(arrow.id);
    if (!previous) return [`Added ${arrow.kind.replaceAll("-", " ")} action`];
    const changes: string[] = [];
    if (previous.kind !== arrow.kind) changes.push(`${previous.kind.replaceAll("-", " ")} → ${arrow.kind.replaceAll("-", " ")}`);
    if (Math.abs((previous.timing ?? 1.2) - (arrow.timing ?? 1.2)) >= 0.01) changes.push(`timing ${(previous.timing ?? 1.2).toFixed(2)}s → ${(arrow.timing ?? 1.2).toFixed(2)}s`);
    if (previous.end.x !== arrow.end.x || previous.end.y !== arrow.end.y) changes.push("route endpoint adjusted");
    return changes.length ? [`Move ${arrow.sequence}: ${changes.join(" · ")}`] : [];
  });
}

function formatClock(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function signed(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function describeRepairResult(repaired: Summary, original?: Summary) {
  if (!original) return `${signed(repaired.score)} quality`;
  const scoreChange = repaired.score - original.score;
  const changes: string[] = [];
  if (original.firstLostOpeningMs != null) {
    if (repaired.firstLostOpeningMs == null) changes.push("opening held");
    else {
      const delay = repaired.firstLostOpeningMs - original.firstLostOpeningMs;
      if (delay >= 300) changes.push(`opening lost ${formatClock(delay)} later`);
      else if (delay <= -300) changes.push(`opening lost ${formatClock(-delay)} earlier`);
      else changes.push("opening still lost");
    }
  } else if (repaired.firstLostOpeningMs != null) changes.push("new opening loss");
  if (original.firstBlockedPass && !repaired.firstBlockedPass) changes.push("pass window cleared");
  else if (original.firstBlockedPass && repaired.firstBlockedPass) changes.push("pass still blocked");
  else if (!original.firstBlockedPass && repaired.firstBlockedPass) changes.push("new blocked pass");
  if (scoreChange !== 0 || changes.length === 0) changes.push(`${signed(scoreChange)} quality`);
  return changes.join(" · ");
}
