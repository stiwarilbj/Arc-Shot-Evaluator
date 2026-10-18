import { loadEditFont } from "./editFont";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import TimelinePieces from "./TimelinePieces";
import { CanvasSink } from "mediabunny";
import { openVideo } from "./media";
import { drawEdit } from "./editDrawing";
import {
  EditHistory,
  clampCaptions,
  editFrame,
  isProject,
  newProject,
  neutralFraming,
  pieceFrames,
  pieceTrimLimits,
  projectFrames,
  splitPiece,
  splitPoint,
  type EditProject,
  type Piece,
} from "./editProject";
import { exportEdits } from "./editProcessing";
import type { EditedVideos } from "./editRenderer";
export type EditOutput = EditedVideos & {
  project: EditProject;
  stale: boolean;
  rendering: boolean;
};
export default function VideoEditPanel({
  base,
  baseDuration,
  palette = true,
  initialProject,
  initialVideos,
  initialCleanAvailable = true,
  active,
  disabled = false,
  onChange,
}: {
  base: Blob;
  baseDuration: number;
  palette?: boolean;
  initialProject?: EditProject;
  initialVideos?: EditedVideos;
  initialCleanAvailable?: boolean;
  active: boolean;
  disabled?: boolean;
  onChange: (value: EditOutput) => void;
}) {
  const [project, setProject] = useState(() =>
    initialProject && isProject(initialProject)
      ? structuredClone(initialProject)
      : newProject(baseDuration, base.type, palette),
  );
  const [history] = useState(() => new EditHistory());
  const splitHelpId = useId();
  const [videos, setVideos] = useState<EditedVideos>(
    () =>
      initialVideos ?? { highlight: base, clean: base, duration: baseDuration },
  );
  const [exported, setExported] = useState(() =>
    initialCleanAvailable ? JSON.stringify(project) : "",
  );
  const [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [panel, setPanel] = useState("Cut"),
    [selected, setSelected] = useState(project.pieces[0].id);
  const [caption, setCaption] = useState(""),
    [error, setError] = useState(""),
    [previewError, setPreviewError] = useState(""),
    [reload, setReload] = useState(0),
    [clean, setClean] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [framingEnd, setFramingEnd] = useState(false);
  const [trimPreview, setTrimPreview] = useState<{
    edge: "start" | "end";
    source: number;
  } | null>(null);
  const gesture = useRef<{ active: boolean; recorded: boolean }>({
    active: false,
    recorded: false,
  });
  const panPointer = useRef<number | null>(null);
  const trimming = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    decoder = useRef<{
      input: Awaited<ReturnType<typeof openVideo>>["input"];
      sink: CanvasSink;
      width: number;
      height: number;
    } | null>(null),
    request = useRef(0),
    generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    latest = useRef({ project, frame, clean, trimPreview }),
    drawing = useRef(false),
    queued = useRef(false);
  latest.current = { project, frame, clean, trimPreview };
  const selectPiece = useCallback((id: string, start: number) => {
    setSelected(id);
    setFrame(start);
    setPlaying(false);
    setTrimPreview(null);
  }, []);
  const beginTrim = useCallback(() => {
    trimming.current = true;
    gesture.current = { active: true, recorded: false };
    setPlaying(false);
  }, []);
  const endTrim = useCallback(() => {
    trimming.current = false;
    gesture.current.active = false;
  }, []);
  const count = projectFrames(project),
    stale = exported !== JSON.stringify(project),
    piece = project.pieces.find((p) => p.id === selected) ?? project.pieces[0],
    trimLimits = pieceTrimLimits(piece, project.baseFrames, count);
  const split = splitPoint(project, frame);
  function stepFrame(direction: number) {
    setPlaying(false);
    setTrimPreview(null);
    setFrame((current) =>
      Math.max(0, Math.min(count - 1, current + direction)),
    );
  }
  useEffect(() => {
    onChange({ ...videos, project, stale, rendering: busy });
  }, [videos, project, stale, busy, onChange]);
  useEffect(() => {
    const finishGesture = () => {
      if (trimming.current) return;
      gesture.current.active = false;
      panPointer.current = null;
    };
    window.addEventListener("pointerup", finishGesture);
    window.addEventListener("pointercancel", finishGesture);
    window.addEventListener("blur", finishGesture);
    return () => {
      window.removeEventListener("pointerup", finishGesture);
      window.removeEventListener("pointercancel", finishGesture);
      window.removeEventListener("blur", finishGesture);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setPreviewError("");
    void openVideo(base)
      .then(async ({ input, track }) => {
        if (cancelled) {
          input.dispose();
          return;
        }
        try {
          await loadEditFont();
        } catch (error) {
          input.dispose();
          throw error;
        }
        if (cancelled) {
          input.dispose();
          return;
        }
        decoder.current = {
          input,
          sink: new CanvasSink(track, { poolSize: 2 }),
          width: await track.getDisplayWidth(),
          height: await track.getDisplayHeight(),
        };
        if (!cancelled) {
          queued.current = true;
          void paint();
        }
      })
      .catch((e) => {
        if (!cancelled) setPreviewError(String(e));
      });
    return () => {
      cancelled = true;
      decoder.current?.input.dispose();
      decoder.current = null;
      request.current++;
    };
  }, [base, reload]);
  // One outstanding decode, at most one newest pending preview. Avoid a seek queue during scrubbing.
  async function paint() {
    if (drawing.current || !decoder.current) return;
    drawing.current = true;
    let reading: NonNullable<typeof decoder.current> | null = null;
    try {
      while (queued.current && decoder.current) {
        queued.current = false;
        const current: NonNullable<typeof decoder.current> = decoder.current;
        reading = current;
        const state = latest.current,
          id = ++request.current;
        const image = await current.sink.getCanvas(
          (state.trimPreview?.source ??
            editFrame(state.project, state.frame, state.clean).source) /
            30 +
            0.00001,
        );
        if (id !== request.current || current !== decoder.current) continue;
        const target = canvas.current,
          context = target?.getContext("2d");
        if (image && target && context) {
          target.width = current.width;
          target.height = current.height;
          if (state.trimPreview) {
            // Boundary inspection must remain visible even with fades/zoom/captions.
            context.drawImage(
              image.canvas,
              0,
              0,
              current.width,
              current.height,
            );
          } else
            drawEdit(
              context,
              image.canvas,
              current.width,
              current.height,
              state.project,
              state.frame,
              state.clean,
            );
        }
      }
    } catch (e) {
      if (reading && reading === decoder.current) {
        setPlaying(false);
        setPreviewError(String(e));
      }
    } finally {
      drawing.current = false;
      if (queued.current && decoder.current) void paint();
    }
  }
  useEffect(() => {
    queued.current = true;
    void paint();
  }, [project, frame, clean, trimPreview]);
  useEffect(() => {
    if (disabled) {
      generation.current++;
      controller.current?.abort();
      setBusy(false);
    }
  }, [disabled]);
  useEffect(() => {
    if (!active || disabled) setPlaying(false);
    const hide = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [active, disabled]);
  useEffect(() => {
    if (!playing || !active) return;
    const start = performance.now(),
      from = frame;
    let handle = 0;
    const tick = (now: number) => {
      const next = from + Math.floor((now - start) * 0.03);
      if (next >= count) {
        setFrame(count - 1);
        setPlaying(false);
      } else {
        setFrame(next);
        handle = requestAnimationFrame(tick);
      }
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, active, count]);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  function change(next: EditProject, record = true) {
    next = clampCaptions(next);
    if (!isProject(next)) {
      setError(
        "Keep the finished video between 2 frames and 60 seconds, with valid piece and caption times.",
      );
      return false;
    }
    const current = latest.current.project;
    if (JSON.stringify(next) === JSON.stringify(current)) return true;
    if (record && (!gesture.current.active || !gesture.current.recorded)) {
      history.record(current);
      gesture.current.recorded = true;
    }
    generation.current++;
    controller.current?.abort();
    setBusy(false);
    setPlaying(false);
    setError("");
    setTrimPreview(null);
    latest.current.project = next;
    setProject(next);
    setFrame((f) => Math.min(f, projectFrames(next) - 1));
    return true;
  }
  function trimBoundary(id: string, edge: "start" | "end", value: number) {
    if (disabled || busy || !Number.isFinite(value)) return;
    const current = latest.current.project;
    const target = current.pieces.find((p) => p.id === id);
    if (!target || target.freeze) return;
    const limits = pieceTrimLimits(
      target,
      current.baseFrames,
      projectFrames(current),
    )[edge];
    const updated = {
      ...target,
      [edge]: Math.max(limits.min, Math.min(limits.max, Math.round(value))),
    };
    const next = {
      ...current,
      pieces: current.pieces.map((p) => (p.id === id ? updated : p)),
    };
    if (!change(next)) return;
    setPlaying(false);
    const offset = next.pieces
      .slice(
        0,
        next.pieces.findIndex((p) => p.id === id),
      )
      .reduce((sum, p) => sum + pieceFrames(p), 0);
    setFrame(offset + (edge === "end" ? pieceFrames(updated) - 1 : 0));
    setTrimPreview({
      edge,
      source: edge === "start" ? updated.start : updated.end - 1,
    });
  }
  function updatePiece(update: Partial<Piece>) {
    change({
      ...project,
      pieces: project.pieces.map((p) =>
        p.id === piece.id ? { ...p, ...update } : p,
      ),
    });
  }
  function move(direction: number) {
    const i = project.pieces.findIndex((p) => p.id === piece.id),
      j = i + direction;
    if (j < 0 || j >= project.pieces.length) return;
    const pieces = [...project.pieces];
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
    change({ ...project, pieces });
  }
  async function render() {
    if (busy || disabled) return;
    setPlaying(false);
    setError("");
    const id = ++generation.current,
      abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setBusy(true);
    setProgress(0);
    try {
      const value = await exportEdits(
        base,
        project,
        (p) => {
          if (id === generation.current) setProgress(p);
        },
        abort.signal,
      );
      if (id !== generation.current || abort.signal.aborted) return;
      setVideos(value);
      setExported(JSON.stringify(project));
    } catch (e) {
      if (id === generation.current && !abort.signal.aborted)
        setError(
          `${String(e)} Your previous successful download is preserved. Retry without masking again.`,
        );
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }
  const time = (n: number) => (n / 30).toFixed(2);
  function seconds(value: string) {
    return Math.round(Number(value) * 30);
  }
  return (
    <section
      className="jumper-panel jumper-edit-panel"
      aria-label="Edit video"
      onPointerDownCapture={(e) => {
        if (trimming.current) return;
        const node = e.target as HTMLElement;
        if (
          node instanceof HTMLCanvasElement ||
          (node instanceof HTMLInputElement && node.type === "range")
        )
          gesture.current = { active: true, recorded: false };
      }}
      onPointerUpCapture={(event) => {
        if (
          !trimming.current &&
          !(event.target as HTMLElement).closest(".jumper-trim-handle")
        )
          gesture.current.active = false;
      }}
      onPointerCancelCapture={(event) => {
        if (
          !trimming.current &&
          !(event.target as HTMLElement).closest(".jumper-trim-handle")
        )
          gesture.current.active = false;
      }}
    >
      <div className="jumper-toolbar">
        <div>
          <span className="jumper-eyebrow">EDIT · MASKING IS FINISHED</span>
          <h2>Edit video</h2>
        </div>
        <button
          disabled={disabled || !history.canUndo || busy}
          onClick={() => change(history.undo(project), false)}
        >
          Undo edit
        </button>
        <button
          disabled={disabled || !history.canRedo || busy}
          onClick={() => change(history.redo(project), false)}
        >
          Redo edit
        </button>
        <button
          disabled={disabled || busy}
          onClick={() => change(newProject(baseDuration, base.type, palette))}
        >
          Reset edits
        </button>
      </div>
      <div className="jumper-edit-layout">
        <div className="jumper-edit-preview">
          <canvas
            ref={canvas}
            className="jumper-edit-canvas"
            aria-label="Edited masked video preview"
            tabIndex={0}
            onKeyDown={(e) => {
              if (disabled || busy) return;
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setPlaying(false);
                setTrimPreview(null);
                setFrame((f) =>
                  Math.max(
                    0,
                    Math.min(count - 1, f + (e.key === "ArrowRight" ? 1 : -1)),
                  ),
                );
              }
              if (e.key === " ") {
                e.preventDefault();
                setTrimPreview(null);
                setPlaying((v) => !v);
              }
            }}
            onPointerDown={(e) => {
              if (
                panel !== "Effects" ||
                clean ||
                disabled ||
                busy ||
                panPointer.current !== null
              )
                return;
              panPointer.current = e.pointerId;
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (
                panPointer.current !== e.pointerId ||
                !e.currentTarget.hasPointerCapture(e.pointerId)
              )
                return;
              const r = e.currentTarget.getBoundingClientRect();
              const scale = Math.min(
                r.width / e.currentTarget.width,
                r.height / e.currentTarget.height,
              );
              const imageWidth = e.currentTarget.width * scale,
                imageHeight = e.currentTarget.height * scale;
              const key = framingEnd ? "to" : "from";
              const f = piece[key];
              updatePiece({
                [key]: {
                  ...f,
                  x: Math.max(
                    0,
                    Math.min(
                      1,
                      (e.clientX - r.left - (r.width - imageWidth) / 2) /
                        imageWidth,
                    ),
                  ),
                  y: Math.max(
                    0,
                    Math.min(
                      1,
                      (e.clientY - r.top - (r.height - imageHeight) / 2) /
                        imageHeight,
                    ),
                  ),
                },
              });
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
              panPointer.current = null;
            }}
            onLostPointerCapture={() => {
              panPointer.current = null;
              gesture.current.active = false;
            }}
          />
          {previewError ? (
            <p role="alert">
              Preview unavailable: {previewError}{" "}
              <button
                onClick={() => {
                  setReload((v) => v + 1);
                }}
              >
                Retry preview
              </button>
            </p>
          ) : null}
          <div className="jumper-toolbar">
            <button
              disabled={!active || !!previewError}
              onClick={() => {
                setTrimPreview(null);
                if (frame >= count - 1) setFrame(0);
                setPlaying((v) => !v);
              }}
            >
              {playing ? "Pause edit preview" : "Play edit preview"}
            </button>
            <span>
              {time(frame)} / {time(count)}s
            </span>
            <label>
              <input
                type="checkbox"
                checked={clean}
                onChange={(e) => {
                  setTrimPreview(null);
                  setClean(e.target.checked);
                }}
              />{" "}
              Clean quiz preview
            </label>
          </div>
          <input
            aria-label="Edit playhead"
            type="range"
            min={0}
            max={count - 1}
            step={1}
            value={Math.min(frame, count - 1)}
            onChange={(e) => {
              setPlaying(false);
              setTrimPreview(null);
              setFrame(Number(e.target.value));
            }}
          />
          {panel === "Cut" ? (
            <div className="jumper-split-position" aria-hidden="true">
              <span
                style={{
                  left: `${count <= 1 ? 0 : (frame / (count - 1)) * 100}%`,
                }}
              />
            </div>
          ) : null}
          {trimPreview ? (
            <p className="jumper-trim-preview" role="status">
              Trim preview · {trimPreview.edge === "start" ? "First" : "Last"}{" "}
              retained source frame {trimPreview.source + 1} ·{" "}
              {time(trimPreview.source)}s (masked base, without presentation
              effects)
            </p>
          ) : null}
          <TimelinePieces
            base={base}
            pieces={project.pieces}
            selected={piece.id}
            active={active}
            baseFrames={project.baseFrames}
            trimEnabled={panel === "Cut" && !disabled && !busy}
            onTrimStart={beginTrim}
            onTrim={trimBoundary}
            onTrimEnd={endTrim}
            onSelect={selectPiece}
          />
          <p className="jumper-caption">
            One 30 fps timeline · {time(count)}s / 60s. Quiz copies keep cuts,
            speed, and freezes; captions, framing, and fades stay in your
            viewing version.
          </p>
        </div>
        <div className="jumper-edit-controls">
          <div
            className="jumper-toolbar"
            role="group"
            aria-label="Editing tools"
          >
            {["Cut", "Text", "Effects"].map((v) => (
              <button
                key={v}
                aria-pressed={panel === v}
                onClick={() => setPanel(v)}
              >
                {v}
              </button>
            ))}
          </div>
          <fieldset disabled={disabled || busy}>
            {panel === "Cut" ? (
              <>
                <h3>
                  Piece {project.pieces.indexOf(piece) + 1}
                  {piece.freeze ? " · freeze" : ""}
                </h3>
                {!piece.freeze ? (
                  <>
                    <label>
                      Source start (s)
                      <input
                        aria-label="Piece start seconds"
                        type="number"
                        min={trimLimits.start.min / 30}
                        max={trimLimits.start.max / 30}
                        step={1 / 30}
                        value={time(piece.start)}
                        onChange={(e) =>
                          trimBoundary(
                            piece.id,
                            "start",
                            seconds(e.target.value),
                          )
                        }
                      />
                    </label>
                    <input
                      aria-label="Drag piece start"
                      type="range"
                      min={trimLimits.start.min}
                      max={trimLimits.start.max}
                      value={piece.start}
                      onChange={(e) =>
                        trimBoundary(piece.id, "start", Number(e.target.value))
                      }
                    />
                    <label>
                      Source end (s)
                      <input
                        aria-label="Piece end seconds"
                        type="number"
                        min={trimLimits.end.min / 30}
                        max={trimLimits.end.max / 30}
                        step={1 / 30}
                        value={time(piece.end)}
                        onChange={(e) =>
                          trimBoundary(piece.id, "end", seconds(e.target.value))
                        }
                      />
                    </label>
                    <input
                      aria-label="Drag piece end"
                      type="range"
                      min={trimLimits.end.min}
                      max={trimLimits.end.max}
                      value={piece.end}
                      onChange={(e) =>
                        trimBoundary(piece.id, "end", Number(e.target.value))
                      }
                    />
                  </>
                ) : (
                  <label>
                    Freeze length (s)
                    <input
                      type="number"
                      aria-label="Freeze duration"
                      min={0.5}
                      max={3}
                      step={1 / 30}
                      value={time(piece.freeze)}
                      onChange={(e) =>
                        updatePiece({ freeze: seconds(e.target.value) })
                      }
                    />
                  </label>
                )}
                <div
                  className="jumper-split-controls"
                  role="group"
                  aria-label="Frame stepping and split"
                >
                  <button disabled={frame <= 0} onClick={() => stepFrame(-1)}>
                    Previous frame
                  </button>
                  <button
                    disabled={!!split.reason}
                    aria-describedby={splitHelpId}
                    onClick={() => {
                      try {
                        const next = splitPiece(project, frame);
                        if (change(next)) {
                          setSelected(editFrame(next, frame).piece.id);
                        }
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    Split at playhead
                  </button>
                  <button
                    disabled={frame >= count - 1}
                    onClick={() => stepFrame(1)}
                  >
                    Next frame
                  </button>
                </div>
                <p
                  id={splitHelpId}
                  className="jumper-caption jumper-split-help"
                  role="status"
                >
                  {split.reason
                    ? `Playhead: frame ${frame + 1} · ${time(frame)}s · Piece ${split.index + 1}. ${split.reason}`
                    : `Split before frame ${frame + 1} · ${time(frame)}s · Piece ${split.index + 1} · source frame ${split.hit.source + 1}.`}
                </p>
                <div className="jumper-toolbar">
                  <button
                    disabled={project.pieces.indexOf(piece) === 0}
                    onClick={() => move(-1)}
                  >
                    Move left
                  </button>
                  <button
                    disabled={
                      project.pieces.indexOf(piece) ===
                      project.pieces.length - 1
                    }
                    onClick={() => move(1)}
                  >
                    Move right
                  </button>
                  <button
                    disabled={project.pieces.length === 1}
                    onClick={() =>
                      change({
                        ...project,
                        pieces: project.pieces.filter((p) => p.id !== piece.id),
                      })
                    }
                  >
                    Delete piece
                  </button>
                </div>
              </>
            ) : null}
            {panel === "Text" ? (
              <>
                <label>
                  Caption
                  <input
                    aria-label="New caption"
                    maxLength={200}
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                  />
                </label>
                <button
                  disabled={!caption.trim()}
                  onClick={() => {
                    change({
                      ...project,
                      captions: [
                        ...project.captions,
                        {
                          id: crypto.randomUUID(),
                          text: caption.trim(),
                          start: frame,
                          end: Math.min(count, frame + 60),
                          size: "medium",
                          position: "bottom",
                        },
                      ],
                    });
                    setCaption("");
                  }}
                >
                  Add at current time
                </button>
                {project.captions.map((c) => (
                  <div className="jumper-caption-editor" key={c.id}>
                    <input
                      aria-label="Caption text"
                      value={c.text}
                      maxLength={200}
                      onChange={(e) =>
                        change({
                          ...project,
                          captions: project.captions.map((v) =>
                            v.id === c.id ? { ...v, text: e.target.value } : v,
                          ),
                        })
                      }
                    />
                    {c.outside ? (
                      <p role="status">
                        This caption was clamped after a cut. Check its timing.
                      </p>
                    ) : null}
                    {(["start", "end"] as const).map((key) => (
                      <label key={key}>
                        Caption {key} (s)
                        <input
                          aria-label={`Caption ${key} seconds`}
                          type="number"
                          min={key === "start" ? 0 : (c.start + 1) / 30}
                          max={(key === "start" ? c.end - 1 : count) / 30}
                          step={1 / 30}
                          value={time(c[key])}
                          onChange={(e) =>
                            change({
                              ...project,
                              captions: project.captions.map((v) =>
                                v.id === c.id
                                  ? {
                                      ...v,
                                      [key]: seconds(e.target.value),
                                      outside: false,
                                    }
                                  : v,
                              ),
                            })
                          }
                        />
                        <input
                          aria-label={`Drag caption ${key}`}
                          type="range"
                          min={key === "start" ? 0 : c.start + 1}
                          max={key === "start" ? c.end - 1 : count}
                          value={c[key]}
                          onChange={(e) =>
                            change({
                              ...project,
                              captions: project.captions.map((v) =>
                                v.id === c.id
                                  ? {
                                      ...v,
                                      [key]: Number(e.target.value),
                                      outside: false,
                                    }
                                  : v,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                    <label>
                      Size
                      <select
                        value={c.size}
                        onChange={(e) =>
                          change({
                            ...project,
                            captions: project.captions.map((v) =>
                              v.id === c.id
                                ? {
                                    ...v,
                                    size: e.target.value as typeof c.size,
                                  }
                                : v,
                            ),
                          })
                        }
                      >
                        {["small", "medium", "large"].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Placement
                      <select
                        value={c.position}
                        onChange={(e) =>
                          change({
                            ...project,
                            captions: project.captions.map((v) =>
                              v.id === c.id
                                ? {
                                    ...v,
                                    position: e.target
                                      .value as typeof c.position,
                                  }
                                : v,
                            ),
                          })
                        }
                      >
                        {["top", "center", "bottom"].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      onClick={() =>
                        change({
                          ...project,
                          captions: project.captions.filter(
                            (v) => v.id !== c.id,
                          ),
                        })
                      }
                    >
                      Remove caption
                    </button>
                  </div>
                ))}
              </>
            ) : null}
            {panel === "Effects" ? (
              <>
                <label>
                  Piece speed
                  <select
                    aria-label="Piece speed"
                    disabled={!!piece.freeze}
                    value={piece.speed}
                    onChange={(e) =>
                      updatePiece({
                        speed: Number(e.target.value) as Piece["speed"],
                      })
                    }
                  >
                    <option value={0.5}>0.5× · slow motion</option>
                    <option value={1}>1× · normal</option>
                    <option value={2}>2× · fast</option>
                  </select>
                </label>
                <button
                  disabled={
                    project.pieces.length +
                      (!split.hit.piece.freeze &&
                      split.hit.source > split.hit.piece.start
                        ? 2
                        : 1) >
                    100
                  }
                  onClick={() => {
                    const at = editFrame(project, frame),
                      i = project.pieces.findIndex((p) => p.id === at.piece.id);
                    const freeze: Piece = {
                      ...at.piece,
                      id: crypto.randomUUID(),
                      start: at.source,
                      end: at.source + 1,
                      freeze: 30,
                      from: at.framing,
                      to: at.framing,
                    };
                    let pieces = [...project.pieces];
                    if (!at.piece.freeze && at.source > at.piece.start) {
                      // A freeze may start on a repeated slow-motion sample.
                      const split = splitPiece(
                        project,
                        splitPoint(project, frame).boundary,
                      );
                      pieces = [...split.pieces];
                      pieces.splice(i + 1, 0, freeze);
                    } else pieces.splice(i, 0, freeze);
                    change({ ...project, pieces });
                    setSelected(freeze.id);
                  }}
                >
                  Insert 1-second freeze
                </button>
                <label>
                  Frame position
                  <select
                    aria-label="Framing endpoint"
                    value={framingEnd ? "end" : "start"}
                    onChange={(e) => {
                      const end = e.target.value === "end";
                      setFramingEnd(end);
                      setPlaying(false);
                      const offset = project.pieces
                        .slice(0, project.pieces.indexOf(piece))
                        .reduce((sum, p) => sum + pieceFrames(p), 0);
                      setFrame(offset + (end ? pieceFrames(piece) - 1 : 0));
                    }}
                  >
                    <option value="start">Start framing</option>
                    <option value="end">End framing</option>
                  </select>
                </label>
                <label>
                  Zoom · {piece[framingEnd ? "to" : "from"].zoom.toFixed(2)}×
                  <input
                    aria-label="Zoom"
                    type="range"
                    min={1}
                    max={2}
                    step={0.05}
                    value={piece[framingEnd ? "to" : "from"].zoom}
                    onChange={(e) => {
                      const key = framingEnd ? "to" : "from";
                      updatePiece({
                        [key]: { ...piece[key], zoom: Number(e.target.value) },
                      });
                    }}
                  />
                </label>
                <p className="jumper-caption">
                  Drag the preview to frame the selected endpoint, or adjust its
                  center below.
                </p>
                {(["x", "y"] as const).map((axis) => (
                  <label key={axis}>
                    {axis === "x" ? "Horizontal" : "Vertical"} framing
                    <input
                      aria-label={`${axis} framing`}
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={piece[framingEnd ? "to" : "from"][axis]}
                      onChange={(e) => {
                        const key = framingEnd ? "to" : "from";
                        updatePiece({
                          [key]: {
                            ...piece[key],
                            [axis]: Number(e.target.value),
                          },
                        });
                      }}
                    />
                  </label>
                ))}
                <button
                  onClick={() =>
                    updatePiece({
                      from: neutralFraming(),
                      to: neutralFraming(),
                    })
                  }
                >
                  Reset framing
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={project.fadeIn}
                    onChange={(e) =>
                      change({ ...project, fadeIn: e.target.checked })
                    }
                  />{" "}
                  Fade in · 0.25s
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={project.fadeOut}
                    onChange={(e) =>
                      change({ ...project, fadeOut: e.target.checked })
                    }
                  />{" "}
                  Fade out · 0.25s
                </label>
              </>
            ) : null}
          </fieldset>
        </div>
      </div>
      {error ? (
        <p role="alert" className="jumper-notice">
          {error}
        </p>
      ) : null}
      <div className="jumper-toolbar">
        <button
          className="button button-primary"
          disabled={busy || disabled || !stale}
          onClick={render}
        >
          {busy
            ? `Rendering · ${Math.round(progress * 100)}%`
            : stale
              ? "Update finished video"
              : "Finished video up to date"}
        </button>
        {busy ? (
          <button
            onClick={() => {
              generation.current++;
              controller.current?.abort();
              setBusy(false);
            }}
          >
            Cancel rendering
          </button>
        ) : null}
        <span role="status">
          {stale
            ? "Preview updated. Render before reviewing or saving."
            : "Ready for final-motion review."}
        </span>
      </div>
    </section>
  );
}
