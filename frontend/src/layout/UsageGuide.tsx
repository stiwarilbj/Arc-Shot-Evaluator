import { useEffect, useRef, useState } from "react";
import { BookOpen, X } from "lucide-react";

export function UsageGuide() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function close() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return <>
    <button ref={triggerRef} type="button" className="guide-trigger" aria-label="How to use ARC" title="How to use ARC" onClick={() => setOpen(true)}>
      <BookOpen size={17} /><span>How to use</span>
    </button>
    {open ? <div className="playbook-modal-backdrop guide-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="playbook-modal guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-intro" onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
          .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}>
        <div className="modal-heading">
          <div><span className="section-kicker">Quick guide</span><h2 id="guide-title">How to use ARC</h2></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={close} aria-label="Close guide"><X size={17} /></button>
        </div>
        <p className="guide-intro" id="guide-intro">ARC has three workspaces: review real shot footage in Shot Analyzer, draw and test a basketball play in Playbook, or search official NBA clips in Play Finder</p>
        <div className="guide-grid">
          <article className="guide-card">
            <h3>Analyze a video</h3>
            <ol>
              <li>Choose a sample clip or select one or more basketball videos</li>
              <li>Keep Analysis depth on Normal, then start the analysis</li>
              <li>Follow progress in the queue; open a completed result when it is ready</li>
            </ol>
          </article>
          <article className="guide-card">
            <h3>Review the footage</h3>
            <ul>
              <li>Use Overview for the session summary, Shot for selected-attempt details, and Tracking for player movement</li>
              <li>Choose Pose, Annotated, or Original above the video; scrub or play to inspect the release</li>
              <li>Select a shot thumbnail to jump to that attempt; correct its result or add notes in the detail panel</li>
              <li>Download the annotated clip or shot data from the export controls</li>
            </ul>
          </article>
          <article className="guide-card">
            <h3>Build a play</h3>
            <ul>
              <li>Start with Ready setup, choose a Starter play, or begin on Empty court; turn Defenders on or off as needed</li>
              <li>Select a tool, then click or drag on the court; circles are offense, X markers are defenders, and the ball is its own marker</li>
              <li>For Pick and pop choose the screener and handler, then place the screen and pop destination; for Pin-down choose the screener and cutter, then place the screen and cutter destination</li>
              <li>For an off-ball screen choose the screener, cutter, and screen spot; for Backdoor cut select a cutter and draw the route to the basket</li>
              <li>Open Starter plays to search 24 editable sets, including Horns, Flex, Shuffle, Triangle, Zipper, Box, and High-low</li>
              <li>Drag arrows to edit them even while another drawing tool is active; select an arrow to set its order, duration, or curved path</li>
              <li>Use Delete, Undo, and Redo to revise the diagram; touch dragging and arrow-key nudging are supported</li>
            </ul>
          </article>
          <article className="guide-card">
            <h3>Find a real play</h3>
            <ul>
              <li>Describe a basketball action or matchup; the example prompts show the supported style</li>
              <li>Review the condition chips, choose a player when a name is ambiguous, and remove unsupported details before searching</li>
              <li>Open a result to see the supporting fields and why it matched; follow the official NBA or team link to watch</li>
              <li>Use Filters for situation details, find similar plays by shared verified features, and save clips with notes in browser collections</li>
              <li>The catalog is a growing, reviewed sample; it does not yet search every filmed NBA possession, and unknown fields are left blank</li>
            </ul>
          </article>
          <article className="guide-card">
            <h3>Simulate and save</h3>
            <ul>
              <li>Choose Play to run the sequence; ARC moves defenders, adjusts help and closeouts, then reads the live defense for an open cut, roll, post, drive, or perimeter pass before the shot</li>
              <li>Use Auto actions in the left rail to choose which screens, handoffs, pick and rolls, and off-ball screens the simulator may add when a matchup allows</li>
              <li>Open Settings to tune offensive cuts or spacing, defensive reads, and movement intensity; pause to edit before resuming</li>
              <li>The adaptive read and route are temporary playback overlays; saving or exporting still uses the drawn diagram</li>
              <li>Save play stores the diagram and actions; Saved plays lets you reopen, duplicate, or delete a play</li>
              <li>Export PNG downloads a clean court image; hosted plays are saved in this browser, while the local app uses its local server</li>
            </ul>
          </article>
        </div>
        <div className="guide-shortcuts"><strong>Playbook keys</strong><span>Arrow keys nudge · Shift + arrow moves farther · Delete removes selection · Escape exits the current tool · ⌘/Ctrl + Z undo · ⌘/Ctrl + Shift + Z redo</span></div>
      </section>
    </div> : null}
  </>;
}
