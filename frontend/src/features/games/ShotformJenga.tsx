import { useEffect, useMemo, useRef, useState } from "react";
import { AREAS, LABELS, TEST_SECONDS, measure } from "./shotformMotion";
import { complete, createShotformSession, currentChallenge, loadShotformSession, nextShotformRound, pendingControls, saveShotformSession, score, stageNudge, testNudge, undoNudge, type Nudge, type ShotformSession } from "./shotformSession";
import { highlightedArea, loadMotionModel, type MotionModel } from "./shotformPrediction";
import ShotformShooter from "./ShotformShooter";
import "./shotform.css";
const DIRECTIONS = [["Shift left", "Shift right"], ["Bring in", "Move out"], ["Shorter hold", "Longer hold"]];
export default function ShotformJenga({ active }: { active: boolean }) {
  const [loaded] = useState(() => loadShotformSession());
  const [session, setSession] = useState(loaded.session), sessionRef = useRef(session);
  const [storage, setStorage] = useState(loaded.storageAvailable);
  const [model, setModel] = useState<MotionModel | null>(null), [modelStatus, setModelStatus] = useState("loading"), [modelRetry, setModelRetry] = useState(0);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [time, setTime] = useState(loaded.restored ? TEST_SECONDS : 0), clock = useRef(time);
  const [playing, setPlaying] = useState(!loaded.restored && !reduced && active && !document.hidden);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [restart, setRestart] = useState(false), cancelRef = useRef<HTMLButtonElement>(null), restartRef = useRef<HTMLButtonElement>(null);
  const challenge = useMemo(() => currentChallenge(session), [session.challengeSeed, session.round]);
  const scores = useMemo(() => measure(challenge, session.controls), [challenge, session.controls]);
  const before = useMemo(() => measure(challenge, session.previous ?? challenge.start), [challenge, session.previous]);
  const area = useMemo(() => highlightedArea(challenge, session.controls, model), [challenge, session.controls, model]);
  const done = complete(session);
  const commit = (next: ShotformSession) => { sessionRef.current = next; setSession(next); setStorage(saveShotformSession(next)); };
  useEffect(() => { setStorage(saveShotformSession(sessionRef.current)); }, []);
  useEffect(() => {
    const controller = new AbortController(); setModelStatus("loading");
    loadMotionModel(controller.signal).then(m => { if (!controller.signal.aborted) { setModel(m); setModelStatus("neural"); } }).catch(() => { if (!controller.signal.aborted) { setModel(null); setModelStatus("fallback"); } });
    return () => controller.abort();
  }, [modelRetry]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => { setReduced(media.matches); if (media.matches) { setPlaying(false); busyRef.current = false; setBusy(false); } };
    media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!active) { setPlaying(false); setRestart(false); }
    const hide = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", hide); return () => document.removeEventListener("visibilitychange", hide);
  }, [active]);
  useEffect(() => {
    if (!playing || !active || reduced) return;
    let id = 0, previous: number | null = null;
    const tick = (now: number) => {
      if (previous !== null) clock.current = Math.min(TEST_SECONDS, clock.current + Math.min(.1, (now - previous) / 1000));
      previous = now; setTime(clock.current);
      if (clock.current >= TEST_SECONDS) { setPlaying(false); busyRef.current = false; setBusy(false); }
      else id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick); return () => cancelAnimationFrame(id);
  }, [playing, active, reduced]);
  useEffect(() => { if (restart) cancelRef.current?.focus(); }, [restart]);
  function animate() {
    clock.current = 0; setTime(0);
    busyRef.current = !reduced; setBusy(!reduced); setPlaying(!reduced && active && !document.hidden);
  }
  function stage(axis: number, direction: -1 | 1) {
    if (busyRef.current) return;
    const next = stageNudge(sessionRef.current, { axis: axis as Nudge["axis"], direction });
    if (next !== sessionRef.current) { setPlaying(false); commit(next); }
  }
  function test() {
    if (busyRef.current) return;
    const next = testNudge(sessionRef.current);
    if (next === sessionRef.current) return;
    // Persist the outcome exactly once before any animation can be interrupted
    commit(next); animate();
  }
  function nextRound() {
    if (busyRef.current || !complete(sessionRef.current)) return;
    commit(nextShotformRound(sessionRef.current)); clock.current = 0; setTime(0); setPlaying(!reduced && active && !document.hidden);
  }
  function scrub(value: number) {
    setPlaying(false); clock.current = value; setTime(value);
    if (value >= TEST_SECONDS) { busyRef.current = false; setBusy(false); }
  }
  const pending = session.pending;
  return <main className="shotform-game" aria-labelledby="shotform-heading">
    <header className="sj-heading"><div><p className="sj-eyebrow">GAMES / A SMALL MOTION EXPERIMENT</p><h1 id="shotform-heading">Shotform Jenga</h1><p>Make one adjustment · Keep all three parts steady</p></div><button ref={restartRef} type="button" onClick={() => { setPlaying(false); setRestart(true); }}>Restart practice</button></header>
    <div className="sj-stats" aria-label="Practice progress"><span>Round <strong>{session.round}</strong></span><span>Tested adjustments <strong>{session.tests}</strong></span><span>Completed rounds <strong>{session.completed}</strong></span><span>Best round <strong>{session.bestScore}</strong></span></div>
    <div className="sj-layout"><section className="sj-stage" aria-label="Shooting motion">
      <div className="sj-stage-label"><span>{challenge.leftHanded ? "Left-handed" : "Right-handed"} shooter · Level {challenge.tier}</span><span>{modelStatus === "neural" ? "Neural motion highlight" : modelStatus === "loading" ? "Loading motion model" : "Game motion analysis"}</span></div>
      <ShotformShooter challenge={challenge} controls={session.controls} previous={session.previous} time={time} highlight={done ? -1 : area} />
      <div className="sj-insight" role="status">{done ? "✓ All three parts are steady" : `◎ Inspect ${LABELS[AREAS[area]].toLowerCase()} across all three repetitions`}</div>
      <div className="sj-playback"><button type="button" disabled={reduced} onClick={() => { if (playing) setPlaying(false); else { if (clock.current >= TEST_SECONDS) { clock.current = 0; setTime(0); } setPlaying(true); } }}>{playing ? "Pause" : "Resume"}</button><button type="button" onClick={() => { if (!busyRef.current) animate(); }} disabled={busy}>Replay test</button><label>Motion <input aria-label="Motion time" type="range" min="0" max={TEST_SECONDS} step="0.01" value={time} onChange={e => scrub(Number(e.target.value))} /></label><output>{time.toFixed(1)} s</output></div>
      {reduced && <p className="sj-help">Reduced motion · Scrub to inspect static poses across three repetitions</p>}
      {busy && !playing && <p className="sj-help">Test paused · Resume or scrub to the end before your next adjustment</p>}
      <p className="sj-help">Faint outlines compare the previous test · Each round reuses the same three variation samples</p>
    </section><section className="sj-controls" aria-label="Adjust shooting motion">
      <h2>Keep every score at 80+</h2><p className="sj-help">Change one part, then test the whole motion · Changes can affect other areas</p>
      {AREAS.map((key, i) => { const delta = scores[i] - before[i]; return <div className={`sj-area ${area === i && !done ? "is-highlighted" : ""}`} key={key}>
        <div className="sj-area-title"><h3>{LABELS[key]}</h3><span>{scores[i] >= 80 ? "✓ Steady" : "△ Unsteady"}</span></div>
        <div className="sj-scores"><span>Before {before[i].toFixed(1)}</span><strong>Now {scores[i].toFixed(1)} / 100</strong><span className={delta < -.05 ? "sj-worse" : ""}>{Math.abs(delta) < .05 ? "— No change" : `${delta > 0 ? "↑" : "↓"} ${Math.abs(delta).toFixed(1)}`}</span></div>
        <meter min="0" max="100" low={80} optimum={100} value={scores[i]} aria-label={`${LABELS[key]} stability`} />
        <div className="sj-adjustments">{([-1, 1] as const).map((direction, j) => <button type="button" key={direction} disabled={busy || done || !!pending || session.controls[i] + direction < -4 || session.controls[i] + direction > 4} onClick={() => stage(i, direction)}>{DIRECTIONS[i][j]}</button>)}<span aria-label={`${LABELS[key]} adjustment position`}>{session.controls[i] > 0 ? "+" : ""}{session.controls[i]} / ±4</span></div>
      </div>; })}
      <div className="sj-pending" role="status">{pending ? <><strong>Pending: {LABELS[AREAS[pending.axis]]} · {DIRECTIONS[pending.axis][pending.direction === -1 ? 0 : 1]}</strong><span>One step: {session.controls[pending.axis]} → {pendingControls(session)[pending.axis]} · Results appear after testing</span><button type="button" onClick={() => commit({ ...sessionRef.current, pending: null })}>Cancel adjustment</button></> : <span>{done ? "Round complete — your result is saved" : "Choose one small adjustment above"}</span>}</div>
      <div className="sj-actions"><button className="sj-primary" type="button" disabled={!pending || busy || done} onClick={test}>Test adjustment</button><button type="button" disabled={busy || done || !session.previous || !!pending} onClick={() => { setPlaying(false); commit(undoNudge(sessionRef.current)); clock.current = TEST_SECONDS; setTime(TEST_SECONDS); }}>Undo last adjustment</button></div>
      <p className="sj-help">Undo and replay never refund tested adjustments · All three scores must reach 80</p>
      {done && <div className="sj-complete" role="status"><h2>✓ Round steady</h2><p>Round score <strong>{score(session)} / 100</strong> · Best solution {challenge.minimum} adjustments · You tested {session.tests}</p><button className="sj-primary" type="button" disabled={busy} onClick={nextRound}>Next round</button></div>}
    </section></div>
    {modelStatus === "fallback" && <p className="sj-notice" role="status">Game motion analysis · The neural model could not be verified, so measured motion chooses the highlight <button type="button" onClick={() => setModelRetry(n => n + 1)}>Retry motion model</button></p>}
    {!storage && <p className="sj-notice" role="status">Progress stays in this tab because browser storage is unavailable</p>}
    <footer className="sj-help">An animated game model, not an assessment of real shooting technique · Private browser play with no uploads or paid API</footer>
    {restart && <div className="sj-modal-backdrop"><section className="sj-dialog" role="dialog" aria-modal="true" aria-labelledby="sj-restart-title" onKeyDown={e => { if (e.key === "Escape") { setRestart(false); restartRef.current?.focus(); } if (e.key === "Tab") { const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button")); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if ((e.shiftKey && index <= 0) || (!e.shiftKey && index === buttons.length - 1)) { e.preventDefault(); buttons[e.shiftKey ? buttons.length - 1 : 0]?.focus(); } } }}><h2 id="sj-restart-title">Restart practice?</h2><p>This clears your rounds and starts a fresh first challenge</p><div className="sj-actions"><button ref={cancelRef} type="button" onClick={() => { setRestart(false); restartRef.current?.focus(); }}>Keep practicing</button><button type="button" onClick={() => { commit(createShotformSession()); busyRef.current = false; setBusy(false); clock.current = 0; setTime(0); setPlaying(false); setRestart(false); restartRef.current?.focus(); }}>Restart</button></div></section></div>}
  </main>;
}
