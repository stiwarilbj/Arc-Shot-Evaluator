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
    <button ref={triggerRef} type="button" className="guide-trigger" aria-label="How to use ARCade Hoops" title="How to use ARCade Hoops" onClick={() => setOpen(true)}>
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
          <div><span className="section-kicker">Quick guide</span><h2 id="guide-title">How to use ARCade Hoops</h2></div>
          <button ref={closeRef} type="button" className="icon-button" onClick={close} aria-label="Close guide"><X size={17} /></button>
        </div>
        <p className="guide-intro" id="guide-intro">ARCade Hoops starts with Shot Analyzer for footage review · Use Playbook to draw plays, Counter Lab to test defenses, Games for Box-Score Error Hunt, Swish Tuner, and Shotform Jenga, and Others → Guess the Jumper to create and play personal mystery clips</p>
        <div className="guide-grid">
          <article className="guide-card"><h3>Box-Score Error Hunt</h3><ol><li>Open Games → Box-Score Error Hunt · Find one wrong calculated total using the fixed source stats</li><li>Select a value to lock your answer and see the correct calculation · Use Next round to keep practicing without a timer</li><li>Start with points, rebounds, and misses · Five correct answers add field-goal percentage; ten add all shooting percentages</li><li>Score, streak, difficulty, and the current round stay in this browser · Restart practice resets the session · The game works on both targets without an API or model download</li></ol></article>
          <article className="guide-card"><h3>Shotform Jenga</h3><ol><li>Open Games → Shotform Jenga · Watch the three repetitions and inspect the highlighted region</li><li>Stage one balance, elbow, or follow-through adjustment, then choose Test adjustment · The same seeded variations make comparisons fair</li><li>Keep every measured score at 80 or higher to finish · New rounds add a second unstable area at round 4 and a third at round 7</li><li>Cancel a pending change, undo the last tested change, or replay without earning extra progress · A paused test keeps adjustments locked until it finishes or you scrub to the end · After Undo, scores compare against the starting baseline · Reload settles interrupted tests once · Reduced motion supports static poses and manual scrubbing</li><li>The bundled neural model selects highlights locally · Measured synthetic motion determines results · This game does not assess real shooting technique</li></ol></article>
          <article className="guide-card"><h3>Swish Tuner</h3><ol><li>Open Games → Swish Tuner · Adjust angle, power, and backspin with sliders or numeric fields</li><li>Use the dashed neural estimate and release-spread band, then Shoot to see the actual flight · Rim or backboard contact is a miss</li><li>Make three shots to advance · Unlimited attempts, with fewer attempts earning more points · New rounds change distance or hoop height</li><li>Progress stays in this browser · Leaving pauses flight · The small prediction model runs locally with a labeled physics fallback and no paid API</li></ol></article>
          <article className="guide-card"><h3>Guess the Jumper</h3><ol><li>Open Others, then Guess the Jumper → Create</li><li>Upload up to 100 MB and trim to a complete shot of at most 15 seconds</li><li>Click or tap to aim at the shooter in the first frame, nudge if needed, then press Place point · Other people are found automatically</li><li>Process and inspect the entire motion · Open corrections to remove spectators or false detections and add include/exclude points, then process again · Use Confirm shooter later and place an Include point on the same person in a later frame to check tracking in both directions; inspect mismatch markers and correct or shorten uncertain sections · The status shows the checked range; full-motion review is still required · Small players receive a tighter crop pass using visible image detail · Inspect Small-player detail uncertain markers, add correction points, or choose a closer view; obscured hands and feet cannot be reconstructed</li><li>After masking, use Edit video: cut, split, reorder, add timed text, change speed, insert freezes, or add zoom/pan and fades · Finished edits can run up to 60 seconds · Edits never repeat masking; use Update finished video before reviewing</li><li>Review, save or download: black shooter, stable gray shades for other players, neutral background, no audio · My Clips → Edit copy restores the masked base and edits without changing the original · Quiz copies keep cuts and timing but omit captions, zoom, and fades · A player name is required only for “Use in my guessing game”; answering reveals the name while the video stays masked</li><li>In My Clips, open “Back up or restore library” to download your clips, masked bases, edit recipes, and labels as a private ZIP, optionally with guessing history · Restore it on either app target; identical clips are skipped and conflicting IDs become separate copies</li></ol><p>Processing stays on this device and uses no paid inference service · Time estimates use measured progress for the current stage, separate model downloads from tracking and export, and adjust as device speed changes · Pauses show guidance rather than a fixed countdown · Guess uses finished clips without inference · The public NBA collection is unavailable until its reviewed pack is ready</p></article>
          <article className="guide-card">
            <h3>Analyze a video</h3>
            <ol>
              <li>Choose a sample clip or select one or more basketball videos</li>
              <li>Choose Fast for a quick scan, Normal for a standard shot review, or Deep for a more detailed mechanics review, then start the analysis</li>
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
            <h3>Simulate and save</h3>
            <ul>
              <li>Choose Play to run the sequence; ARCade Hoops moves defenders, adjusts help and closeouts, then reads the live defense for an open cut, roll, post, drive, or perimeter pass before the shot</li>
              <li>Playback advances on a steady clock and blends positions between updates; passes and handoffs travel from the live ball position into a moving receiver's hands, and resuming after a pause or hidden tab does not jump ahead</li>
              <li>Use Auto actions in the left rail to choose which screens, handoffs, pick and rolls, and off-ball screens the simulator may add when a matchup allows</li>
              <li>Open Settings to tune offensive cuts or spacing, defensive reads, and movement intensity; pause to edit before resuming</li>
              <li>Replay seeks within the part already played and pauses there · Resume follows the recorded defense, settings and paused edits; editing while rewound creates a new future · Arrow keys seek 1/30 second, Page Up/Down one second, and Home/End the recorded start/end · Sessions stay in memory until reload or a new play</li>
              <li>Playback runs in a dedicated browser worker · Leaving Playbook or hiding the browser tab pauses it · If playback is interrupted, your drawing and last valid frame remain available; press Play to start a fresh simulation</li>
              <li>Use Player skills to set three-point, midrange, and finishing ratings from 1 to 5, then assign badges such as Playmaker, Deep range, Cutter, and Roll threat; the offense and defense respond to those strengths</li>
              <li>Open Defender skills or select a defender to assign Lockdown, Paint protector, and Helper badges; they guide matchups, zone roles, help, closeouts, and shot contests</li>
              <li>During playback, the offense favors open shots by expected points, can interrupt the drawn sequence for a clear high-quality look, and continues with up to three quick passes or drives when the defense shifts</li>
              <li>Movement follows actual route progress with braking and collision avoidance · Screens set before use; rolls and pops follow the interaction · Handoffs require close players and passes require a catch</li>
              <li>Timing is a minimum · A phase may wait up to 1.2 seconds; blocked or conflicting moves show an explanation instead of forcing players through one another</li>
              <li>Defenders keep stable assignments and scheme shape, hold screen coverage through each action, help only when a safe rotation is available, and recover with speed-limited movement</li>
              <li>Zone ball pressure changes with possession or a clear advantage; Lockdown, Paint protector, and Helper badges shape assignments and rotations without overriding screen or chaser duties</li>
              <li>Playback reads and routes are temporary and do not change saved diagrams or exports</li>
              <li>Save play stores the diagram and actions; Saved plays lets you reopen, duplicate, or delete a play</li>
              <li>Export PNG downloads a clean court image; hosted plays are saved in this browser, while the local app uses its local server</li>
            </ul>
          </article>
          <article className="guide-card">
            <h3>Break a play</h3>
            <ul>
              <li>From Playbook, choose Test in Counter Lab to carry over the current draft, or import a saved play or starter set</li>
              <li>Choose defensive responses and compare the authored sequence with the simulator’s adaptive offense</li>
              <li>Select a matchup to replay it; the timeline marks sustained loss of an opening and reports blocked authored passes separately</li>
              <li>Repairs appear only after rerunning the changed actions shows at least five quality points gained or a resolved breakdown without lower final quality; compare the results and routes before saving a new Playbook copy</li>
              <li>Use Arrows in either workspace to hide routes, show main on-ball actions, include off-ball actions, or include small movement trails · The preference applies to both workspaces; select a hidden Playbook action from Actions to edit it</li>
              <li>Counter Lab scores are simulation outputs, not real-game probabilities; Playbook edits and repair saves preserve reports until another play is imported or the page reloads</li>
            </ul>
          </article>
        </div>
        <div className="guide-shortcuts"><strong>Playbook keys</strong><span>Arrow keys nudge · Shift + arrow moves farther · Delete removes selection · Escape exits the current tool · ⌘/Ctrl + Z undo · ⌘/Ctrl + Shift + Z redo</span></div>
      </section>
    </div> : null}
  </>;
}
