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
} from "./domain";
import { listClips, saveClip } from "./storage";
import { openVideo, preview } from "./media";
import { ClipVideo, useBlobUrl } from "./JumperLab";

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
  const [tracks, setTracks] = useState<Track[]>([]);
  const [target, setTarget] = useState(1);
  const [editing, setEditing] = useState(1);
  const [frame, setFrame] = useState(0);
  const [negative, setNegative] = useState(false);
  const [image, setImage] = useState<Blob | null>(null);
  const imageUrl = useBlobUrl(image);
  const [view, setView] = useState<"source" | "masked">("source");
  const [result, setResult] = useState<MaskResult | null>(null);
  const videoUrl = useBlobUrl(result?.highlight ?? null);
  const sourceUrl = useBlobUrl(file);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
    setReviewed(false);
    setSaved(false);
    setDirty(true);
    savedIdentity.current = crypto.randomUUID();
  }
  async function upload(next: File | undefined) {
    if (!next || busy || saving) return;
    if (!next.size || next.size > MAX_BYTES) {
      setError("Choose a nonempty video no larger than 100 MB.");
      return;
    }
    const revision = ++sourceGeneration.current;
    setError("");
    try {
      const opened = await openVideo(next);
      const length = opened.duration;
      opened.input.dispose();
      if (revision !== sourceGeneration.current) return;
      setFile(next);
      setName("");
      setDuration(length);
      setStart(0);
      setEnd(Math.min(6, length));
      setTracks([]);
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
    }
  }
  function trim(nextStart: number, nextEnd: number) {
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return;
    setStart(nextStart);
    setEnd(nextEnd);
    setFrame(0);
    setTracks([]);
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
    if (busy || saving || !image) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const xy = [
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height,
    ];
    setCursor(xy);
    addPoint(xy);
  }
  function addPoint(xy: number[]) {
    if (busy || saving || !image) return;
    let id = editing;
    if (!tracks.length) {
      id = 1;
      setTracks([{ id, prompts: [] }]);
      setTarget(id);
      setEditing(id);
    }
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
    if (!file || busy || saving) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setProgress({ stage: "Finding people in the starting frame", progress: 0 });
    try {
      const { detectPeople } = await import("./detection");
      const boxes = await detectPeople(file, start, abort.signal);
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
      if (!abort.signal.aborted) setError(String(error));
      else setProgress({ stage: "Detection cancelled", progress: 0 });
    } finally {
      setBusy(false);
    }
  }
  async function process() {
    if (!file || busy || saving) return;
    const request = { start, end, target_id: target, objects: tracks };
    try {
      if (!name.trim()) throw Error("Name the selected player first.");
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
      if (id !== generation.current) return;
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
    const identity = savedIdentity.current;
    try {
      const existing = (await listClips()).find(
        (clip) => normalizeName(clip.player.name) === normalizeName(name),
      );
      const value: PersonalClip = {
        version: 1,
        id: identity,
        player: {
          id: existing?.player.id ?? identity,
          name: name.trim(),
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
      setSaved(true);
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
  const count = Math.max(1, Math.ceil((end - start) * 30));
  const track = tracks.find((value) => value.id === editing);
  const prompts = track?.prompts.find((value) => value.frame === frame);
  return (
    <div className="jumper-editor">
      <aside className="jumper-panel jumper-editor-controls">
        <span className="jumper-eyebrow">MAKE A MYSTERY</span>
        <h2>One shot. No clues.</h2>
        <p>
          Hide the entire background and choose which player keeps their
          original appearance.
        </p>
        {!supported ? (
          <div className="jumper-notice">
            Creating clips requires WebGPU and video encoding. Try Chrome or use
            the downloaded app. Guess and saved clips remain available.
          </div>
        ) : null}
        <label className="jumper-upload">
          <Upload size={22} />
          <span>{file ? file.name : "Choose a basketball video"}</span>
          <small>Up to 100 MB · process up to 15 seconds</small>
          <input
            type="file"
            accept="video/*,.mkv,.ogv"
            disabled={busy || saving || !supported}
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        {file ? (
          <>
            <fieldset disabled={busy || saving}>
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
            <fieldset disabled={busy || saving}>
              <legend>2 · Name and select the player</legend>
              <label>
                Player name
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
              <p className="jumper-caption">
                The name is a label. Select the named player on frame 1. Add
                other tracks on their first visible frame, then mark the named
                player below.
              </p>
              <button
                type="button"
                className="button button-outline"
                onClick={detect}
              >
                Find people in first frame
              </button>
              <div className="jumper-track-list">
                {tracks.map((value) => (
                  <div key={value.id}>
                    <button
                      type="button"
                      className={editing === value.id ? "is-active" : ""}
                      onClick={() => setEditing(value.id)}
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
                          invalidate();
                        }}
                      />{" "}
                      Named player
                    </label>
                    <button
                      type="button"
                      className="jumper-icon"
                      aria-label={`Remove track ${value.id}`}
                      onClick={() => {
                        const next = tracks.filter(
                          (track) => track.id !== value.id,
                        );
                        setTracks(next);
                        setEditing(next[0]?.id ?? 1);
                        if (target === value.id) setTarget(next[0]?.id ?? 1);
                        invalidate();
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
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
                Include the body; exclude the ball, shadows, and background. At
                a later frame, points correct that same track.
              </p>
            </fieldset>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || saving || !supported || !tracks.length}
              onClick={process}
            >
              {result ? "Apply corrections & process" : "Process clip"}
            </button>
            {busy ? (
              <button
                type="button"
                className="button button-outline"
                onClick={() => controller.current?.abort()}
              >
                Cancel processing
              </button>
            ) : null}
          </>
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
              <div className="jumper-point-surface">
                {imageUrl ? (
                  <>
                    <img
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
                      {track?.prompts.find((p) => p.frame === 0)?.box
                        ? (() => {
                            const b = track.prompts.find(
                              (p) => p.frame === 0,
                            )!.box!;
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
              <label className="jumper-scrubber">
                Frame {frame + 1} of {count}
                <input
                  aria-label="Correction frame"
                  type="range"
                  min="0"
                  max={Math.max(0, count - 1)}
                  value={Math.min(frame, count - 1)}
                  disabled={busy || saving}
                  onChange={(event) => setFrame(Number(event.target.value))}
                />
              </label>
              <div className="jumper-toolbar">
                <span>
                  Editing track {editing} ·{" "}
                  {negative ? "Exclude point" : "Include point"}
                </span>
                <button
                  type="button"
                  disabled={busy || !prompts}
                  onClick={() => {
                    setTracks((current) =>
                      current.map((value) =>
                        value.id === editing
                          ? {
                              ...value,
                              prompts: value.prompts.filter(
                                (value) => value.frame !== frame,
                              ),
                            }
                          : value,
                      ),
                    );
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
                <ClipVideo
                  src={videoUrl}
                  label="Finished highlighted player clip"
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
                    <div>
                      {result.warnings.slice(0, 6).map((warning, index) => (
                        <button
                          type="button"
                          key={index}
                          onClick={() => {
                            setFrame(warning.frame);
                            setView("source");
                          }}
                        >
                          {warning.kind.replaceAll("_", " ")} · frame{" "}
                          {warning.frame + 1}
                        </button>
                      ))}
                    </div>
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
                  Use in my guessing game (also saves silhouette and reveal
                  videos)
                </label>
                <div className="jumper-toolbar">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={
                      !reviewed ||
                      saving ||
                      saved ||
                      !!result.warnings.length ||
                      !name.trim()
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
              Upload, select the people, and turn one short shot into a clip
              with every background clue removed.
            </p>
            <ol>
              <li>Trim to the gather, shot, and follow-through.</li>
              <li>
                Name and click the player; select the other court players.
              </li>
              <li>Process, fix any mask errors, and save or download.</li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
