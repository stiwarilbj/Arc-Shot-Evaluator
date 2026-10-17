import { useEffect, useRef, useState } from "react";
import { Download, Plus, Trash2, Upload, Check, X } from "lucide-react";
import { IS_GITHUB_PAGES } from "../../runtime";
import {
  MAX_BYTES,
  normalizeName,
  validateMaskRequest,
  type JobProgress,
  type MaskResult,
  type Track,
  type PersonalClip,
  type MaskWarning,
} from "./domain";
import { listClips, saveClip } from "./storage";
import { openVideo, preview } from "./media";
import { clearFramePoints, needsSelection } from "./editorSelections";
import MaskTimeline from "./MaskTimeline";
import ShooterPreview from "./ShooterPreview";
import SelectionMagnifier from "./SelectionMagnifier";
import { ClipVideo, useBlobUrl } from "./JumperLab";
import ReviewComparison from "./ReviewComparison";

export default function JumperEditor({
  active,
  onSaved,
}: {
  active: boolean;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [name, setName] = useState("");
  const [automatic, setAutomatic] = useState(true);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [target, setTarget] = useState(1);
  const [editing, setEditing] = useState(1);
  const [frame, setFrame] = useState(0);
  const editorRoot = useRef<HTMLDivElement>(null);
  const correctionPanel = useRef<HTMLDetailsElement>(null);
  const frameImage = useRef<HTMLImageElement>(null);
  const resultTarget = useRef(1);
  const [negative, setNegative] = useState(false);
  const [image, setImage] = useState<Blob | null>(null);
  const [previewRatio, setPreviewRatio] = useState<number>();
  const imageUrl = useBlobUrl(image);
  const [view, setView] = useState<"source" | "masked">("source");
  const [result, setResult] = useState<MaskResult | null>(null);
  const videoUrl = useBlobUrl(result?.highlight ?? null);
  const sourceUrl = useBlobUrl(file);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const uploadLock = useRef(false);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [quiz, setQuiz] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [cursor, setCursor] = useState([0.5, 0.5]);
  const [cursorVisible, setCursorVisible] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const saveLock = useRef(false);
  const savedIdentity = useRef(crypto.randomUUID());
  const sourceGeneration = useRef(0);
  const supported =
    !IS_GITHUB_PAGES || ("gpu" in navigator && "VideoEncoder" in globalThis);
  useEffect(
    () => () => {
      generation.current++;
      sourceGeneration.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setImage(null);
      return;
    }
    setImage(null);
    const abort = new AbortController();
    const blob =
      view === "masked" && result && !dirty ? result.highlight : file;
    const time = blob === file ? start + frame / 30 : frame / 30;
    const timer = setTimeout(() => {
      void preview(blob, time, abort.signal)
        .then((value) => {
          if (!cancelled) setImage(value);
        })
        .catch((error) => {
          if (!cancelled) setError(`Preview unavailable: ${String(error)}`);
        });
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [file, start, frame, view, result, dirty]);
  function invalidate() {
    setView("source");
    setReviewed(false);
    setSaved(false);
    setDirty(true);
    savedIdentity.current = crypto.randomUUID();
  }
  async function upload(next: File | undefined) {
    if (!next || busy || saving || uploadLock.current) return;
    if (!next.size || next.size > MAX_BYTES) {
      setError("Choose a nonempty video no larger than 100 MB.");
      return;
    }
    uploadLock.current = true;
    setLoading(true);
    generation.current++;
    const revision = ++sourceGeneration.current;
    setError("");
    try {
      const opened = await openVideo(next);
      const length = opened.duration;
      opened.input.dispose();
      if (revision !== sourceGeneration.current) return;
      setPreviewRatio(undefined);
      setFile(next);
      setName("");
      setDuration(length);
      setStart(0);
      setEnd(Math.min(6, length));
      setTracks([]);
      setAutomatic(true);
      setTarget(1);
      setEditing(1);
      setFrame(0);
      setResult(null);
      setImage(null);
      setView("source");
      setProgress(null);
      invalidate();
    } catch (error) {
      if (revision === sourceGeneration.current) setError(String(error));
    } finally {
      uploadLock.current = false;
      if (revision === sourceGeneration.current) setLoading(false);
    }
  }
  function trim(nextStart: number, nextEnd: number) {
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return;
    setStart(nextStart);
    setEnd(nextEnd);
    setFrame(0);
    setTracks([]);
    setTarget(1);
    setEditing(1);
    setNegative(false);
    setResult(null);
    setView("source");
    invalidate();
  }
  function addTrack() {
    if (tracks.length >= 20 || busy) return;
    const id = Math.max(0, ...tracks.map((value) => value.id)) + 1;
    setEditing(id);
    setTracks((current) => [...current, { id, prompts: [] }]);
    if (!tracks.length) setTarget(id);
    invalidate();
  }
  function point(event: React.MouseEvent<HTMLImageElement>) {
    if (busy || saveLock.current || uploadLock.current || !image) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const xy = [
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height,
    ];
    setCursor(xy);
    addPoint(xy);
  }
  function addPoint(xy: number[]) {
    if (busy || saveLock.current || uploadLock.current || !image) return;
    let id = editing;
    if (
      negative &&
      (!tracks.length ||
        needsSelection(tracks.find((track) => track.id === id)))
    ) {
      setError(
        "Start this player with an Include point, then add Exclude points if needed.",
      );
      return;
    }
    if (!tracks.length && frame !== 0) {
      setError("Return to frame 1 and click the shooter first.");
      return;
    }
    if (!tracks.length) {
      id = 1;
      setTracks([{ id, prompts: [] }]);
      setTarget(id);
      setEditing(id);
    }
    setError("");
    setTracks((current) => {
      const values = current.length ? current : [{ id, prompts: [] }];
      return values.map((value) => {
        if (value.id !== id) return value;
        const existing = value.prompts.find((value) => value.frame === frame);
        const prompt = {
          ...existing,
          frame,
          points: [...(existing?.points ?? []), xy],
          labels: [...(existing?.labels ?? []), negative ? 0 : 1],
        };
        return {
          ...value,
          prompts: [
            ...value.prompts.filter((value) => value.frame !== frame),
            prompt,
          ].sort((a, b) => a.frame - b.frame),
        };
      });
    });
    invalidate();
  }
  async function detect() {
    if (!file || busy || saveLock.current || uploadLock.current) return;
    const id = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setProgress({ stage: "Finding people in the starting frame", progress: 0 });
    try {
      const { detectPeople } = await import("./detection");
      const boxes = await detectPeople(file, start, abort.signal);
      if (abort.signal.aborted || generation.current !== id) return;
      setResult(null);
      setTracks(
        boxes.map((box, index) => ({
          id: index + 1,
          prompts: [{ frame: 0, box }],
        })),
      );
      setEditing(1);
      setTarget(1);
      setFrame(0);
      invalidate();
      setProgress({
        stage: `Found ${boxes.length} possible people. Remove spectators, artwork, and false detections; confirm the named player.`,
        progress: 1,
      });
    } catch (error) {
      if (generation.current !== id) return;
      if (!abort.signal.aborted) setError(String(error));
      else setProgress({ stage: "Detection cancelled", progress: 0 });
    } finally {
      if (generation.current === id) setBusy(false);
    }
  }
  async function process() {
    if (!file || busy || saveLock.current || uploadLock.current) return;
    const request = {
      start,
      end,
      target_id: target,
      objects: tracks,
      auto_detect_others: automatic,
      presentation: "silhouette" as const,
    };
    try {
      if (end > duration + 0.01)
        throw Error("The trim extends beyond this video.");
      validateMaskRequest(request);
    } catch (error) {
      setError(String(error));
      return;
    }
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const id = ++generation.current;
    setBusy(true);
    setError("");
    setProgress({ stage: "Preparing the editor", progress: 0 });
    try {
      const { processVideo } = await import("./processing");
      const value = await processVideo(
        file,
        request,
        (update) => {
          if (generation.current === id) setProgress(update);
        },
        abort.signal,
      );
      if (id !== generation.current || abort.signal.aborted) return;
      if (value.objects) setTracks(value.objects);
      resultTarget.current = target;
      setResult(value);
      setDirty(false);
      setReviewed(false);
      setSaved(false);
      setView("masked");
      savedIdentity.current = crypto.randomUUID();
      setProgress({ stage: "Ready for review", progress: 1 });
    } catch (error) {
      if (id === generation.current) {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          setError(String(error));
        else
          setProgress({
            stage: "Processing cancelled. Your selections are preserved.",
            progress: 0,
          });
      }
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }
  async function save() {
    if (
      saveLock.current ||
      uploadLock.current ||
      !result ||
      dirty ||
      !reviewed ||
      saved ||
      result.warnings.length ||
      busy
    )
      return;
    saveLock.current = true;
    setSaving(true);
    setError("");
    if (quiz && !name.trim()) {
      setError("Add the player’s name to use this clip in your guessing game.");
      saveLock.current = false;
      setSaving(false);
      return;
    }
    const identity = savedIdentity.current;
    try {
      const existing = (await listClips()).find(
        (clip) => normalizeName(clip.player.name) === normalizeName(name),
      );
      const value: PersonalClip = {
        version: 1,
        presentation: "silhouette",
        id: identity,
        player: {
          id: existing?.player.id ?? identity,
          name: name.trim() || "Selected player",
          aliases: [],
        },
        duration: result.duration,
        createdAt: new Date().toISOString(),
        mime:
          result.highlight.type === "video/mp4" ? "video/mp4" : "video/webm",
        quiz,
        highlight: result.highlight,
        ...(quiz ? { quizVideo: result.quiz, reveal: result.reveal } : {}),
      };
      await saveClip(value);
      if (identity === savedIdentity.current) setSaved(true);
      onSaved();
    } catch (error) {
      setError(
        `Could not save: ${String(error)}. Your result is still downloadable.`,
      );
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  function inspectWarning(warning: MaskWarning, requestedId?: number) {
    if (busy || saveLock.current || uploadLock.current) return;
    const available = tracks.filter((t) => !t.ignored);
    const recorded =
      warning.track_ids ??
      (warning.kind === "target_lost" || warning.kind === "tracking_unstable"
        ? [resultTarget.current]
        : []);
    const id =
      requestedId ??
      (recorded.includes(editing) && available.some((t) => t.id === editing)
        ? editing
        : recorded.find((id) => available.some((t) => t.id === id))) ??
      (available.some((t) => t.id === editing) ? editing : target);
    setFrame(warning.frame);
    setEditing(id);
    setNegative(false);
    setView("source");
    if (correctionPanel.current) correctionPanel.current.open = true;
    editorRoot.current
      ?.querySelectorAll("video")
      .forEach((video) => video.pause());
  }
  const count = Math.max(1, Math.ceil((end - start) * 30));
  const track = tracks.find((value) => value.id === editing);
  const prompts = track?.prompts.find((value) => value.frame === frame);
  const incompleteTrack = tracks.find((track) => needsSelection(track));
  const targetNeedsStart = !tracks
    .find((track) => track.id === target)
    ?.prompts.some(
      (prompt) =>
        prompt.frame === 0 && (prompt.box || prompt.labels?.includes(1)),
    );
  return (
    <div ref={editorRoot} className="jumper-editor">
      <aside className="jumper-panel jumper-editor-controls">
        <span className="jumper-eyebrow">MAKE A MYSTERY</span>
        <h2>One shot. No clues.</h2>
        <p>
          Click the shooter to turn them black. Other players become gray, with
          a flat background and no original colors or audio.
        </p>
        {!supported ? (
          <div className="jumper-notice">
            Creating clips requires WebGPU and video encoding. Try Chrome or use
            <a
              href="https://github.com/stiwarilbj/Arc-Shot-Evaluator#readme"
              target="_blank"
              rel="noreferrer"
            >
              the free downloaded app
            </a>
            . Guess and saved clips remain available.
          </div>
        ) : null}
        <label className="jumper-upload">
          <Upload size={22} />
          <span>{file ? file.name : "Choose a basketball video"}</span>
          <small>Up to 100 MB · process up to 15 seconds</small>
          <input
            type="file"
            accept="video/*,.mkv,.ogv"
            disabled={busy || saving || loading || !supported}
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        {file ? (
          <>
            <fieldset disabled={busy || saving || loading}>
              <legend>1 · Trim one complete shot</legend>
              <div className="jumper-trim">
                <label>
                  Start (s)
                  <input
                    type="number"
                    min="0"
                    max={duration}
                    step="0.1"
                    value={start}
                    onChange={(event) => trim(Number(event.target.value), end)}
                  />
                </label>
                <label>
                  End (s)
                  <input
                    type="number"
                    min="0"
                    max={duration}
                    step="0.1"
                    value={end}
                    onChange={(event) =>
                      trim(start, Number(event.target.value))
                    }
                  />
                </label>
              </div>
              <small>
                {(end - start).toFixed(1)} seconds selected · Trimming resets
                player selections.
              </small>
            </fieldset>
            <fieldset disabled={busy || saving || loading}>
              <legend>2 · Click the shooter in frame 1</legend>
              <p className="jumper-caption">
                The clicked player stays black. Other people are found
                automatically throughout the clip. Review the whole result
                before saving.
              </p>
              <button
                type="button"
                className="button button-outline"
                onClick={() => {
                  setResult(null);
                  setTracks([]);
                  setTarget(1);
                  setEditing(1);
                  setFrame(0);
                  setNegative(false);
                  setView("source");
                  invalidate();
                }}
              >
                Select shooter again
              </button>
              <label>
                Player name (optional until adding to quiz)
                <input
                  value={name}
                  maxLength={100}
                  placeholder="e.g. Stephen Curry"
                  onChange={(event) => {
                    setName(event.target.value);
                    setSaved(false);
                    savedIdentity.current = crypto.randomUUID();
                  }}
                />
              </label>
              <details ref={correctionPanel} className="jumper-corrections">
                <summary>Correct masks & player selection</summary>
                <label className="jumper-check">
                  <input
                    type="checkbox"
                    checked={automatic}
                    onChange={(event) => {
                      setAutomatic(event.target.checked);
                      invalidate();
                    }}
                  />
                  Find other people automatically, including later entrants
                </label>
                <p className="jumper-caption">
                  Remove spectators or false detections. Select a track and add
                  Include/Exclude points on problem frames, then process again.
                  Use manual selection if automatic discovery is unsuitable.
                </p>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={detect}
                >
                  Find people in first frame
                </button>
                <div className="jumper-track-list">
                  {tracks
                    .filter((value) => !value.ignored)
                    .map((value) => (
                      <div key={value.id}>
                        <button
                          type="button"
                          className={editing === value.id ? "is-active" : ""}
                          onClick={() => {
                            setEditing(value.id);
                            setFrame(value.prompts[0]?.frame ?? 0);
                            setView("source");
                          }}
                        >
                          Track {value.id}
                        </button>
                        <label>
                          <input
                            type="radio"
                            name="jumper-target"
                            checked={target === value.id}
                            onChange={() => {
                              setTarget(value.id);
                              setEditing(value.id);
                              setFrame(0);
                              setView("source");
                              setNegative(false);
                              invalidate();
                            }}
                          />{" "}
                          Shooter · black
                        </label>
                        <button
                          type="button"
                          className="jumper-icon"
                          aria-label={`Remove track ${value.id}`}
                          onClick={() => {
                            if (value.id === target) {
                              setError(
                                "Choose a different shooter before removing this track.",
                              );
                              return;
                            }
                            setTracks((current) =>
                              needsSelection(value)
                                ? current.filter(
                                    (track) => track.id !== value.id,
                                  )
                                : current.map((track) =>
                                    track.id === value.id
                                      ? { ...track, ignored: true }
                                      : track,
                                  ),
                            );
                            setEditing(target);
                            invalidate();
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                </div>
                {tracks.some((value) => value.ignored) ? (
                  <button
                    type="button"
                    onClick={() => {
                      setTracks((current) =>
                        current.map((value) => ({ ...value, ignored: false })),
                      );
                      invalidate();
                    }}
                  >
                    Restore removed tracks
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button-outline"
                  disabled={tracks.length >= 20}
                  onClick={addTrack}
                >
                  <Plus size={15} /> Add player
                </button>
                <div className="jumper-toolbar">
                  <button
                    type="button"
                    aria-pressed={!negative}
                    onClick={() => setNegative(false)}
                  >
                    <Plus size={14} /> Include
                  </button>
                  <button
                    type="button"
                    aria-pressed={negative}
                    onClick={() => setNegative(true)}
                  >
                    <X size={14} /> Exclude
                  </button>
                </div>
                <p className="jumper-caption">
                  Include the body; exclude the ball, shadows, and background.
                  At a later frame, points correct that same track.
                </p>
              </details>
            </fieldset>
            <button
              type="button"
              className="button button-primary"
              disabled={
                busy ||
                saving ||
                loading ||
                !supported ||
                !tracks.length ||
                !!incompleteTrack ||
                targetNeedsStart
              }
              onClick={process}
            >
              {result && dirty ? "Apply corrections & process" : "Process clip"}
            </button>
            {busy ? (
              <button
                type="button"
                className="button button-outline"
                onClick={() => {
                  generation.current++;
                  controller.current?.abort();
                  setBusy(false);
                  setProgress({
                    stage:
                      "Processing cancelled. Your selections are preserved.",
                    progress: 0,
                  });
                }}
              >
                Cancel processing
              </button>
            ) : null}
          </>
        ) : null}
        {loading ? <p role="status">Checking video…</p> : null}
        {incompleteTrack || (tracks.length > 0 && targetNeedsStart) ? (
          <p role="status">
            Add an Include point for{" "}
            {incompleteTrack
              ? `track ${incompleteTrack.id}`
              : "the shooter in frame 1"}{" "}
            before processing.
          </p>
        ) : null}
        {progress ? (
          <div className="jumper-progress" role="status">
            <span>{progress.stage}</span>
            <progress
              max="1"
              value={Math.max(0, Math.min(1, progress.progress))}
            />
          </div>
        ) : null}
        {error ? (
          <div className="jumper-notice" role="alert">
            {error}
          </div>
        ) : null}
      </aside>
      <div className="jumper-editor-main">
        {file ? (
          <>
            <section className="jumper-panel">
              <div className="jumper-toolbar">
                <h2>
                  {result && !dirty && view === "masked"
                    ? "Inspect the mask"
                    : "Select and correct players"}
                </h2>
                <select
                  aria-label="Inspection view"
                  value={view}
                  onChange={(event) =>
                    setView(event.target.value as typeof view)
                  }
                >
                  <option value="source">Original frame</option>
                  <option value="masked" disabled={!result || dirty}>
                    Masked frame
                  </option>
                </select>
              </div>
              <div
                className="jumper-point-surface"
                style={previewRatio ? { aspectRatio: previewRatio } : undefined}
              >
                {imageUrl ? (
                  <>
                    <img
                      onLoad={(event) =>
                        setPreviewRatio(
                          event.currentTarget.naturalWidth /
                            event.currentTarget.naturalHeight,
                        )
                      }
                      ref={frameImage}
                      src={imageUrl}
                      alt="Selected video frame; click to add a mask point"
                      tabIndex={0}
                      role="button"
                      aria-label="Add mask points: arrow keys move the cursor, Enter places a point"
                      onFocus={() => setCursorVisible(true)}
                      onBlur={() => setCursorVisible(false)}
                      onKeyDown={(event) => {
                        const direction: Record<string, number[]> = {
                          ArrowLeft: [-1, 0],
                          ArrowRight: [1, 0],
                          ArrowUp: [0, -1],
                          ArrowDown: [0, 1],
                        };
                        if (direction[event.key]) {
                          event.preventDefault();
                          const delta = direction[event.key];
                          setCursor((current) =>
                            current.map((value, index) =>
                              Math.max(
                                0,
                                Math.min(
                                  1,
                                  value +
                                    delta[index] *
                                      (event.shiftKey ? 0.05 : 0.01),
                                ),
                              ),
                            ),
                          );
                        }
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          addPoint(cursor);
                        }
                      }}
                      onPointerMove={(event) => {
                        if (busy || saving || loading) return;
                        const bounds =
                          event.currentTarget.getBoundingClientRect();
                        setCursor([
                          Math.max(
                            0,
                            Math.min(
                              1,
                              (event.clientX - bounds.left) / bounds.width,
                            ),
                          ),
                          Math.max(
                            0,
                            Math.min(
                              1,
                              (event.clientY - bounds.top) / bounds.height,
                            ),
                          ),
                        ]);
                        setCursorVisible(true);
                      }}
                      onClick={point}
                      draggable={false}
                    />
                    <svg
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      {cursorVisible ? (
                        <g stroke="#fff" strokeWidth=".3">
                          <path
                            d={`M${cursor[0] * 100 - 2},${cursor[1] * 100} h4 M${cursor[0] * 100},${cursor[1] * 100 - 2} v4`}
                          />
                        </g>
                      ) : null}
                      {prompts?.box
                        ? (() => {
                            const b = prompts.box!;
                            return (
                              <rect
                                x={b[0] * 100}
                                y={b[1] * 100}
                                width={(b[2] - b[0]) * 100}
                                height={(b[3] - b[1]) * 100}
                                fill="none"
                                stroke="#ee733f"
                                strokeWidth=".4"
                              />
                            );
                          })()
                        : null}
                      {prompts?.points?.map((point, index) => (
                        <g key={index}>
                          <circle
                            cx={point[0] * 100}
                            cy={point[1] * 100}
                            r="1.1"
                            fill={
                              prompts.labels?.[index] ? "#ee733f" : "#49b4ee"
                            }
                            stroke="white"
                            strokeWidth=".25"
                          />
                        </g>
                      ))}
                    </svg>
                  </>
                ) : (
                  <p role="status">Decoding preview…</p>
                )}
              </div>
              {imageUrl && view === "source" ? (
                <div className="jumper-selection-tools">
                  <SelectionMagnifier src={imageUrl} cursor={cursor} />
                  <div>
                    <p className="jumper-caption">
                      Move over the frame to aim. On touchscreens, tap near the
                      player, then use the nudge buttons to place a precise
                      point. Keyboard: arrows to aim, Enter to select.
                    </p>
                    <div
                      className="jumper-nudge"
                      role="group"
                      aria-label="Fine selection controls"
                    >
                      {(
                        [
                          ["Left", -1, 0],
                          ["Up", 0, -1],
                          ["Down", 0, 1],
                          ["Right", 1, 0],
                        ] as const
                      ).map(([label, dx, dy]) => (
                        <button
                          key={label}
                          className="button button-outline"
                          type="button"
                          disabled={busy || saving || loading}
                          aria-label={`Aim ${label.toLowerCase()}`}
                          onClick={() => {
                            setCursorVisible(true);
                            setCursor((current) => [
                              Math.max(0, Math.min(1, current[0] + dx * 0.005)),
                              Math.max(0, Math.min(1, current[1] + dy * 0.005)),
                            ]);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={busy || saving || loading}
                        className="button button-outline"
                        onClick={() => addPoint(cursor)}
                      >
                        Place point
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              {file && frame === 0 && view === "source" ? (
                <ShooterPreview
                  key={`${start}:${end}:${target}:${JSON.stringify(tracks.find((t) => t.id === target)?.prompts.find((p) => p.frame === 0))}`}
                  file={file}
                  start={start}
                  end={end}
                  track={tracks.find((t) => t.id === target)}
                  active={active}
                  paused={busy || saving || loading}
                />
              ) : null}
              <label className="jumper-scrubber">
                Frame {frame + 1} of {count}
                <input
                  aria-label="Correction frame"
                  type="range"
                  min="0"
                  max={Math.max(0, count - 1)}
                  value={Math.min(frame, count - 1)}
                  disabled={busy || saving || loading}
                  onChange={(event) => setFrame(Number(event.target.value))}
                />
              </label>
              {result ? (
                <MaskTimeline
                  warnings={result.warnings}
                  count={count}
                  frame={frame}
                  tracks={tracks}
                  stale={dirty}
                  disabled={busy || saving || loading}
                  onInspect={inspectWarning}
                />
              ) : null}
              <div className="jumper-toolbar">
                <span>
                  Editing track {editing} ·{" "}
                  {negative ? "Exclude point" : "Include point"}
                </span>
                <button
                  type="button"
                  disabled={
                    busy || saving || loading || !prompts?.points?.length
                  }
                  onClick={() => {
                    if (saveLock.current || uploadLock.current) return;
                    setTracks((current) =>
                      clearFramePoints(current, editing, frame),
                    );
                    if (editing === target && frame === 0 && !prompts?.box) {
                      setNegative(false);
                      setView("source");
                    }
                    invalidate();
                  }}
                >
                  Clear this frame’s points
                </button>
              </div>
            </section>
            {result && !dirty ? (
              <section className="jumper-panel">
                <span className="jumper-eyebrow">3 · REVIEW IN MOTION</span>
                <h2>Your finished clip</h2>
                <ReviewComparison
                  key={videoUrl}
                  original={sourceUrl}
                  masked={videoUrl}
                  start={start}
                  duration={result.duration}
                  active={active}
                />
                {result.warnings.length ? (
                  <div className="jumper-notice" role="alert">
                    Tracking needs attention on{" "}
                    {
                      new Set(result.warnings.map((warning) => warning.frame))
                        .size
                    }{" "}
                    frame(s). Correct the selected track or shorten the segment
                    before saving.
                    <p>
                      Use the mask-quality timeline above to inspect every
                      flagged frame. These hints do not detect every masking
                      error.
                    </p>
                  </div>
                ) : null}
                <label className="jumper-check">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={saving}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />{" "}
                  I reviewed the full motion: correct player, all bodies masked,
                  no original background or ball colors.
                </label>
                <label className="jumper-check">
                  <input
                    type="checkbox"
                    checked={quiz}
                    disabled={saving || saved}
                    onChange={(event) => setQuiz(event.target.checked)}
                  />{" "}
                  Use in my guessing game (requires a player name; video stays
                  masked after answering)
                </label>
                <div className="jumper-toolbar">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={
                      !reviewed ||
                      busy ||
                      loading ||
                      saving ||
                      saved ||
                      !!result.warnings.length ||
                      (quiz && !name.trim())
                    }
                    onClick={save}
                  >
                    {saved ? (
                      <>
                        <Check size={16} /> Saved to My Clips
                      </>
                    ) : saving ? (
                      "Saving…"
                    ) : (
                      "Save to My Clips"
                    )}
                  </button>
                  <a
                    className="button button-outline"
                    href={videoUrl}
                    download={`jumper-${savedIdentity.current}.${result.highlight.type === "video/mp4" ? "mp4" : "webm"}`}
                  >
                    <Download size={16} /> Download
                  </a>
                </div>
                <p className="jumper-caption">
                  Private to this device. No footage is added to the public NBA
                  collection.
                </p>
              </section>
            ) : sourceUrl ? (
              <section className="jumper-panel">
                <h3>Original video · trim reference</h3>
                <ClipVideo
                  src={sourceUrl}
                  label="Original upload for trimming"
                  active={active}
                />
              </section>
            ) : null}
          </>
        ) : (
          <div className="jumper-empty">
            <Upload size={42} />
            <h2>Bring your own jumpshot</h2>
            <p>
              Upload, click the shooter, and turn one short shot into a clip
              with every background clue removed.
            </p>
            <ol>
              <li>Trim to the gather, shot, and follow-through.</li>
              <li>
                Click the shooter in frame 1; find other people automatically.
              </li>
              <li>Process, fix any mask errors, and save or download.</li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
