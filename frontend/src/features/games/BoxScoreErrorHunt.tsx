import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RotateCcw, Search, X } from "lucide-react";
import { answerRound, calculateTotals, calculation, createSession, formatTotal, keysFor, nextRound, TOTAL_LABELS, type TotalKey } from "./boxScore";
import { loadPractice, savePractice } from "./boxScoreStorage";
import "./boxScore.css";

export default function BoxScoreErrorHunt({ active }: { active: boolean }) {
  const [state, setState] = useState(loadPractice);
  const [roundError, setRoundError] = useState("");
  const [restartOpen, setRestartOpen] = useState(false);
  const feedback = useRef<HTMLDivElement>(null);
  const firstTotal = useRef<HTMLButtonElement>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const cancelRestart = useRef<HTMLButtonElement>(null);
  const previousRound = useRef(state.session.puzzle.id);
  const previousAnswer = useRef(state.session.selected);
  const { session, storageAvailable } = state;
  const { puzzle, selected } = session;
  const answered = selected !== null;
  const correct = selected === puzzle.wrongField;
  const expected = calculateTotals(puzzle.source);
  const source = puzzle.source;
  const round = session.answered + Number(!answered);
  const unlockAt = session.correct < 5 ? 5 : 10;

  useEffect(() => {
    const available = savePractice(session);
    setState(current => current.storageAvailable === available ? current : { ...current, storageAvailable: available });
  }, [session]);

  useEffect(() => {
    if (active) {
      if (previousRound.current !== puzzle.id) firstTotal.current?.focus();
      else if (previousAnswer.current !== selected && selected !== null) feedback.current?.focus();
    }
    previousRound.current = puzzle.id;
    previousAnswer.current = selected;
  }, [active, puzzle.id, selected]);

  useEffect(() => {
    if (!active) setRestartOpen(false);
  }, [active]);
  useEffect(() => {
    if (restartOpen) cancelRestart.current?.focus();
  }, [restartOpen]);

  function closeRestart() {
    setRestartOpen(false);
    restartButton.current?.focus();
  }
  function advance() {
    try {
      const next = nextRound(session);
      setState(current => current.session === session ? { ...current, session: next } : current);
      setRoundError("");
    } catch {
      setRoundError("Could not prepare the next stat line · Your score is safe — try again");
    }
  }
  function choose(key: TotalKey) {
    setState(current => ({ ...current, session: answerRound(current.session, key) }));
  }

  return <main className="box-hunt" aria-labelledby="box-hunt-title">
    <header className="box-hunt-heading">
      <div><h1 id="box-hunt-title">Box-Score Error Hunt</h1><p>One stat line · One wrong total · Find it</p></div>
      <button ref={restartButton} type="button" className="button button-outline" onClick={() => setRestartOpen(true)}><RotateCcw size={15} aria-hidden="true" />Restart practice</button>
    </header>

    <dl className="box-hunt-score" aria-label="Practice score">
      <div><dt>Correct</dt><dd>{session.correct}<span> / {session.answered}</span></dd></div>
      <div><dt>Accuracy</dt><dd>{session.answered ? Math.round(session.correct / session.answered * 100) : 0}<span>%</span></dd></div>
      <div><dt>Streak</dt><dd>{session.streak}</dd></div>
      <div><dt>Best streak</dt><dd>{session.bestStreak}</dd></div>
    </dl>

    <section className="box-hunt-puzzle" aria-labelledby="box-hunt-question">
      <div className="box-hunt-round"><span>Round {round} · Fictional player</span><span>{puzzle.difficulty === 1 ? "Basics" : puzzle.difficulty === 2 ? "Shooting mix" : "Full stat line"}</span></div>
      <h2 id="box-hunt-question">Find the incorrect total</h2>
      <p className="box-hunt-hint">The source stats are correct · Select the one calculated value that does not match</p>
      <section className="box-hunt-source" aria-labelledby="box-hunt-source-title">
        <h3 id="box-hunt-source-title">Source stats <span>Fixed clues</span></h3>
        <dl>
          <div><dt>Field goals <span>(FG)</span></dt><dd aria-label={`${source.fgm} made out of ${source.fga} field goals attempted`}>{source.fgm}<span> / {source.fga}</span></dd></div>
          <div><dt>Three-pointers <span>(3PT)</span></dt><dd aria-label={`${source.threeMade} made out of ${source.threeAttempts} three-pointers attempted`}>{source.threeMade}<span> / {source.threeAttempts}</span></dd></div>
          <div><dt>Free throws <span>(FT)</span></dt><dd aria-label={`${source.ftm} made out of ${source.fta} free throws attempted`}>{source.ftm}<span> / {source.fta}</span></dd></div>
          <div><dt>Offensive rebounds</dt><dd>{source.oreb}</dd></div>
          <div><dt>Defensive rebounds</dt><dd>{source.dreb}</dd></div>
        </dl>
        <p>Shots are made / attempted · Field goals include three-pointers</p>
      </section>
      <h3 className="box-hunt-totals-label">Check these totals</h3>
      <div className="box-hunt-totals">
        {keysFor(puzzle.difficulty).map((key, index) => {
          const error = answered && key === puzzle.wrongField;
          const chosen = key === selected;
          return <button
            key={key} ref={index === 0 ? firstTotal : undefined} type="button"
            className={`box-hunt-total${error ? " is-error" : ""}${chosen && !correct ? " is-selected" : ""}`}
            disabled={answered} onClick={() => choose(key)}
            aria-label={`${TOTAL_LABELS[key]}: ${formatTotal(key, puzzle.totals[key]!)}`}
          >
            <span className="box-hunt-total-name">{TOTAL_LABELS[key]}</span>
            <strong>{formatTotal(key, puzzle.totals[key]!)}</strong>
            <span className="box-hunt-total-state">{answered ? error ? <><X size={14} aria-hidden="true" />Incorrect total</> : chosen ? <><Check size={14} aria-hidden="true" />This total is valid</> : <><Check size={14} aria-hidden="true" />Valid</> : <><Search size={14} aria-hidden="true" />Check value</>}</span>
          </button>;
        })}
      </div>
      {answered ? <div className={`box-hunt-feedback${correct ? " is-correct" : ""}`} ref={feedback} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true">
        <div className="box-hunt-feedback-title">{correct ? <Check size={20} aria-hidden="true" /> : <X size={20} aria-hidden="true" />}<h3>{correct ? "You found it" : "Not this time"}</h3></div>
        <p>{!correct ? `${TOTAL_LABELS[selected]} is valid · ` : ""}{TOTAL_LABELS[puzzle.wrongField]} should be <strong>{formatTotal(puzzle.wrongField, expected[puzzle.wrongField])}</strong>, not {formatTotal(puzzle.wrongField, puzzle.totals[puzzle.wrongField]!)}</p>
        <p className="box-hunt-equation">{calculation(source, puzzle.wrongField)}</p>
        {puzzle.wrongField.endsWith("Pct") ? <p>Rounded to one decimal place</p> : null}
      </div> : null}
      <div className="box-hunt-footer">
        <span>{session.correct < 10 ? `${Math.max(0, unlockAt - session.correct)} more correct to ${unlockAt === 5 ? "add field-goal percentage" : "unlock all shooting percentages"}` : "All stat types unlocked · Keep your streak going"}</span>
        {answered ? <button type="button" className="button button-primary" onClick={advance}>Next round <ArrowRight size={16} aria-hidden="true" /></button> : <span>No timer · Take your time</span>}
      </div>
      {roundError ? <p role="alert" className="box-hunt-warning">{roundError}</p> : null}
    </section>
    <p className="box-hunt-storage" role="status">{storageAvailable ? "Practice progress stays in this browser · No account needed" : "Browser storage is unavailable · You can keep playing, but progress lasts only for this visit"}</p>

    {restartOpen ? <div className="playbook-modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) closeRestart(); }}>
      <section className="playbook-modal box-hunt-restart" role="dialog" aria-modal="true" aria-labelledby="restart-practice-title" onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); closeRestart(); }
        if (event.key === "Tab") {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
        }
      }}>
        <h2 id="restart-practice-title">Restart practice?</h2><p>Start with a new stat line · Your current score, streak, and difficulty will reset</p>
        <div className="box-hunt-restart-actions"><button ref={cancelRestart} type="button" className="button button-outline" onClick={closeRestart}>Keep playing</button><button type="button" className="button button-primary" onClick={() => { setState(current => ({ ...current, session: createSession() })); setRoundError(""); setRestartOpen(false); }}>Restart practice</button></div>
      </section>
    </div> : null}
  </main>;
}
