import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Pause, Play, RotateCcw, Target } from "lucide-react";
import SwishCourt from "./SwishCourt";
import { BALL_RADIUS, CONTROL_LIMITS, RELEASE_HEIGHT, ROUND_SETUPS, clamp, sampleFlight, simulateShot, speedForPower, type ShotControls, type ShotFlight } from "./swishPhysics";
import { loadSwishModel, predictShot, type ShotPrediction, type SwishModel } from "./swishPrediction";
import { createSwishSession, loadSwishSession, nextSwishRound, roundScore, saveSwishSession, shoot } from "./swishSession";
import "./swish.css";

function TuneControl({ name, label, value, unit, hint, disabled, onChange }: {
  name: keyof ShotControls; label: string; value: number; unit: string; hint: string; disabled: boolean; onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const [min, max] = CONTROL_LIMITS[name];
  return <div className="swish-control">
    <div className="swish-control-title"><label htmlFor={`swish-${name}`}>{label}</label><span>
      <input id={`swish-${name}-number`} aria-label={`${label} value`} aria-describedby={`swish-${name}-hint`} type="number" min={min} max={max} step="0.1" disabled={disabled} value={text}
        onChange={e => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value && Number.isFinite(n) && n >= min && n <= max) onChange(n); }}
        onBlur={() => { const n = text.trim() ? Number(text) : value; const next = Number.isFinite(n) ? Math.round(clamp(n, min, max) * 10) / 10 : value; onChange(next); setText(String(next)); }} /> {unit}</span></div>
    <input id={`swish-${name}`} type="range" min={min} max={max} step="0.1" disabled={disabled} value={value} onChange={e => onChange(Number(e.target.value))} aria-valuetext={`${value} ${name === "angle" ? "degrees" : name === "power" ? "percent" : "revolutions per second"}`} aria-describedby={`swish-${name}-hint`} />
    <p id={`swish-${name}-hint`}>{hint}</p>
  </div>;
}

export default function SwishTuner({ active }: { active: boolean }) {
  const [loaded] = useState(() => loadSwishSession());
  const [session, setSession] = useState(loaded.session);
  const sessionRef = useRef(session);
  const [storageAvailable, setStorageAvailable] = useState(loaded.storageAvailable);
  const [model, setModel] = useState<SwishModel | null>(null);
  const [modelState, setModelState] = useState<"loading" | "neural" | "fallback">("loading");
  const [modelAttempt, setModelAttempt] = useState(0);
  const [prediction, setPrediction] = useState<ShotPrediction | null>(null);
  const [predictionPending, setPredictionPending] = useState(true);
  const [flight, setFlight] = useState<ShotFlight | null>(null);
  const [flightTime, setFlightTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const flightLock = useRef(false);
  const arena = useRef<HTMLDivElement>(null);
  const clock = useRef(0);
  const [restartOpen, setRestartOpen] = useState(false);
  const restartButton = useRef<HTMLButtonElement>(null), cancelButton = useRef<HTMLButtonElement>(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const setup = ROUND_SETUPS[session.setupIndex];
  const restoredFlight = useMemo(() => session.lastShot ? simulateShot(session.lastShot.controls, setup) : null, [session.lastShot, setup]);
  const currentFlight = flight ?? restoredFlight;
  const inFlight = !!flight && flightTime < flight.duration;
  const finished = session.makes === 3 && !inFlight;
  const commit = (next: typeof session) => {
    sessionRef.current = next;
    setSession(next);
    setStorageAvailable(saveSwishSession(next));
  };
  useEffect(() => {
    let cancelled = false;
    setModelState("loading");
    loadSwishModel().then(result => { if (!cancelled) { setModel(result); setModelState("neural"); } }).catch(() => { if (!cancelled) { setModel(null); setModelState("fallback"); } });
    return () => { cancelled = true; };
  }, [modelAttempt]);
  useEffect(() => {
    if (!active) return;
    setPredictionPending(true);
    const id = requestAnimationFrame(() => { setPrediction(predictShot(session.controls, model)); setPredictionPending(false); });
    return () => cancelAnimationFrame(id);
  }, [session.controls, model, active]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!active) { setPlaying(false); setRestartOpen(false); }
    const hide = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [active]);
  useEffect(() => {
    if (!playing || !active || !flight) return;
    let id = 0, previous: number | null = null;
    const tick = (now: number) => {
      if (previous !== null) clock.current = Math.min(flight.duration, clock.current + Math.min(0.1, (now - previous) / 1000));
      previous = now;
      setFlightTime(clock.current);
      if (clock.current >= flight.duration) { setPlaying(false); flightLock.current = false; }
      else id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, active, flight]);
  useEffect(() => {
    if (restartOpen && active) cancelButton.current?.focus();
  }, [restartOpen, active]);
  function fire() {
    if (flightLock.current || sessionRef.current.makes === 3 || !active || document.hidden) return;
    flightLock.current = true;
    const result = shoot(sessionRef.current);
    if (!result.flight) { flightLock.current = false; return; }
    // Commit the deterministic result before animation; reload settles it without awarding it again
    commit(result.session);
    setFlight(result.flight);
    clock.current = reducedMotion ? result.flight.duration : 0;
    setFlightTime(clock.current);
    setPlaying(!reducedMotion);
    if (reducedMotion) flightLock.current = false;
    if (window.matchMedia("(max-width: 760px)").matches) arena.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }
  function updateControl(key: keyof ShotControls, value: number) {
    if (flightLock.current || sessionRef.current.makes === 3) return;
    commit({ ...sessionRef.current, controls: { ...sessionRef.current.controls, [key]: value } });
  }
  function closeRestart() { setRestartOpen(false); restartButton.current?.focus(); }
  const time = flight ? flightTime : currentFlight?.duration ?? 0;
  const ball = currentFlight ? sampleFlight(currentFlight.points, time) : { x: 0, y: RELEASE_HEIGHT, t: 0 };
  const actual = currentFlight ? currentFlight.points.slice(0, Math.max(1, Math.floor(time * 240) + 1)) : [];
  const lastOutcome = !inFlight ? session.lastShot?.outcome : null;
  return <main className="swish-game" aria-label="Swish Tuner">
    <div className="swish-heading"><div><h1>Swish Tuner</h1><p>Find a reliable shot · Make three to move on</p></div><button ref={restartButton} type="button" className="button button-outline" onClick={() => { setPlaying(false); setRestartOpen(true); }}><RotateCcw size={15} aria-hidden="true" /> Restart practice</button></div>
    <dl className="swish-score"><div><dt>Makes this round</dt><dd>{session.makes}<span> / 3</span></dd></div><div><dt>Attempts</dt><dd>{session.attempts}</dd></div><div><dt>Completed rounds</dt><dd>{session.completed}</dd></div><div><dt>Total score</dt><dd>{session.totalScore}</dd></div></dl>
    <section className="swish-workbench" aria-label={`Round ${session.round}`}>
      <div className="swish-arena" ref={arena}>
        <div className="swish-round"><strong>Round {session.round}</strong><span>Hoop {setup.height.toFixed(2)} m high{setup.height !== 3.048 ? " · Challenge height" : " · Standard height"}</span></div>
        <SwishCourt setup={setup} prediction={predictionPending ? null : prediction} actual={actual} ball={{ ...ball, y: Math.max(BALL_RADIUS, ball.y) }} flying={inFlight} />
        <div className="swish-legend"><span><i className="is-predicted" />{modelState === "neural" ? "Neural estimate" : modelState === "loading" ? "Loading neural model" : "Physics preview"}</span><span><i className="is-spread" />Release spread{modelState === "neural" ? " + model error" : ""}</span><span><i className="is-actual" />Actual shot</span></div>
        <div className={`swish-feedback ${lastOutcome === "Swish" ? "is-make" : ""}`} role="status" aria-live="polite">
          <Target size={20} aria-hidden="true" /><div><strong>{inFlight ? playing ? "Shot in flight" : "Shot paused" : finished ? `Round complete · ${roundScore(session.attempts)} / 100` : lastOutcome ?? "Tune your shot"}</strong>
          <p>{inFlight ? "Controls unlock when this shot finishes" : finished ? "Three makes · Fewer attempts earn a higher score" : lastOutcome === "Swish" ? "Clean through the target · Keep finding that combination" : lastOutcome ? "Adjust your angle, power, or spin and try again" : "Follow the dashed estimate, then shoot to test your combination"}</p></div>
        </div>
      </div>
      <aside className="swish-tuning" aria-label="Shot controls"><h2>Tune the release</h2>
        <TuneControl name="angle" label="Release angle" value={session.controls.angle} unit="°" hint="Higher angles create a steeper arc" disabled={inFlight || finished} onChange={v => updateControl("angle", v)} />
        <TuneControl name="power" label="Power" value={session.controls.power} unit="%" hint={`${speedForPower(session.controls.power).toFixed(2)} m/s release speed · More power carries farther`} disabled={inFlight || finished} onChange={v => updateControl("power", v)} />
        <TuneControl name="spin" label="Backspin" value={session.controls.spin} unit="rps" hint="A small lift effect · Spin alone does not guarantee a make" disabled={inFlight || finished} onChange={v => updateControl("spin", v)} />
        <div className="swish-spread-note">Every shot varies slightly<br /><span>±0.15° angle · ±0.2% power · ±0.03 rps</span></div>
        {inFlight ? <button type="button" className="button button-primary swish-shoot" onClick={() => setPlaying(v => !v)}>{playing ? <Pause size={17} /> : <Play size={17} />}{playing ? "Pause shot" : "Resume shot"}</button> : finished ? <button type="button" className="button button-primary swish-shoot" onClick={() => { commit(nextSwishRound(sessionRef.current)); setFlight(null); setFlightTime(0); }}>Next round <ArrowRight size={17} /></button> : <button type="button" className="button button-primary swish-shoot" onClick={fire}><Target size={17} /> Shoot</button>}
        <p className="swish-score-hint">Three makes, unlimited attempts<br />Round score = 300 ÷ attempts, rounded</p>
      </aside>
    </section>
    {modelState === "fallback" ? <p className="swish-notice" role="status">Neural prediction unavailable · Physics preview is active and scoring works normally <button type="button" onClick={() => setModelAttempt(v => v + 1)}>Retry neural model</button></p> : null}
    <div className="swish-bottom"><p>{storageAvailable ? "Progress stays in this browser · No account needed" : "Storage unavailable · Progress lasts for this visit"}</p><details><summary>About the shot model</summary><p>A small neural network trained offline estimates pre-contact flight from simplified game physics · The shaded band includes bounded release variation and up to 5 cm of model error · Actual fixed-step physics decides the result, and rim or backboard contact is a miss · This is a game, not a real shooting assessment · No API calls or runtime training</p></details></div>
    {restartOpen ? <div className="playbook-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) closeRestart(); }}><section role="dialog" aria-modal="true" aria-labelledby="swish-restart-title" className="playbook-modal swish-restart" onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); closeRestart(); }
      if (e.key === "Tab") { const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button")); if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1)?.focus(); } else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0]?.focus(); } }
    }}><h2 id="swish-restart-title">Restart practice?</h2><p>Your rounds, attempts, and score will reset</p><div><button ref={cancelButton} type="button" className="button button-outline" onClick={closeRestart}>Keep playing</button><button type="button" className="button button-primary" onClick={() => { commit(createSwishSession()); setFlight(null); setPlaying(false); setFlightTime(0); flightLock.current = false; closeRestart(); }}>Restart practice</button></div></section></div> : null}
  </main>;
}
