import { loadEditFont } from "./editFont";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import TimelinePieces from "./TimelinePieces";
import CaptionPreview from "./CaptionPreview";
import FramingPreview from "./FramingPreview";
import CaptionTimeline from "./CaptionTimeline";
import PieceEffectsClipboard from "./PieceEffectsClipboard";
import { CanvasSink } from "mediabunny";
import { openVideo } from "./media";
import { drawEdit } from "./editDrawing";
import { useCaptionOcclusion } from "./useCaptionOcclusion";
import { captionLayout } from "./captionLayout";
import { describeVideoEdit, videoEditFocus } from "./editHistory";
import {
  previewRange,
  previewOrigin,
  previewPlaybackFrame,
} from "./previewPlayback";
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
  duplicatePiece,
  duplicatePieceReason,
  splitPoint,
  type EditProject,
  type Caption,
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
  reviewed = false,
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
  reviewed?: boolean;
  onChange: (value: EditOutput) => void;
}) {
  const [project, setProject] = useState(() =>
    initialProject && isProject(initialProject)
      ? structuredClone(initialProject)
      : newProject(baseDuration, base.type, palette),
  );
  const [history] = useState(() => new EditHistory());
  const editor = useRef<HTMLElement>(null);
  const [historyReveal, setHistoryReveal] = useState<{
    pieceId: string;
    captionId: string | null;
  } | null>(null);
  useEffect(() => {
    if (!historyReveal) return;
    const selector = historyReveal.captionId
      ? `.jumper-caption-lane[data-caption-id="${CSS.escape(historyReveal.captionId)}"]`
      : `.jumper-edit-piece[data-piece-id="${CSS.escape(historyReveal.pieceId)}"]`;
    editor.current?.querySelector(selector)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "auto",
    });
  }, [historyReveal]);
  const [selectedCaption, setSelectedCaption] = useState<string | null>(null);
  const [previewDimensions, setPreviewDimensions] = useState({
    width: 0,
    height: 0,
  });
  const splitHelpId = useId();
  const duplicateHelpId = useId();
  const previewHelpId = useId();
  const [videos, setVideos] = useState<EditedVideos>(
    () =>
      initialVideos ?? { highlight: base, clean: base, duration: baseDuration },
  );
  const [exported, setExported] = useState(() =>
    initialCleanAvailable ? JSON.stringify(project) : "",
  );
  const [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [loop, setLoop] = useState(false),
    [loopContext, setLoopContext] = useState(false),
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
  const framingGuide =
    panel === "Effects" && !playing && !clean && !trimPreview;
  const gesture = useRef<{ active: boolean; recorded: boolean }>({
    active: false,
    recorded: false,
  });
  const trimming = useRef(false);
  const overlayDragging = useRef(false);
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
    latest = useRef({ project, frame, clean, trimPreview, framingGuide }),
    drawing = useRef(false),
    queued = useRef(false);
  latest.current = { project, frame, clean, trimPreview, framingGuide };
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
  const selectCaption = useCallback((id: string) => {
    setSelectedCaption(id);
    setPanel("Text");
    setPlaying(false);
  }, []);
  const beginOverlayDrag = useCallback(() => {
    overlayDragging.current = true;
    gesture.current = { active: true, recorded: false };
  }, []);
  const endOverlayDrag = useCallback(() => {
    overlayDragging.current = false;
    gesture.current.active = false;
  }, []);
  const count = projectFrames(project),
    stale = exported !== JSON.stringify(project),
    piece = project.pieces.find((p) => p.id === selected) ?? project.pieces[0],
    trimLimits = pieceTrimLimits(piece, project.baseFrames, count);
  const split = splitPoint(project, frame);
  const captionCuts = useMemo(() => {
    let offset = 0;
    return project.pieces.slice(0, -1).map((p) => (offset += pieceFrames(p)));
  }, [project.pieces]);
  const captionFits = useMemo(() => {
    if (!previewDimensions.width || !previewDimensions.height) return null;
    const context = document.createElement("canvas").getContext("2d");
    return context
      ? project.captions.map(
          (c) =>
            captionLayout(
              context,
              previewDimensions.width,
              previewDimensions.height,
              c,
            ).fits,
        )
      : null;
  }, [project.captions, previewDimensions]);
  const captionCheck = useCaptionOcclusion(base, project, active);
  const captionOverflow = captionFits?.some((fits) => !fits) ?? false;
  const playbackRange = loop
    ? previewRange(project, piece.id, loopContext ? 15 : 0)
    : { start: 0, end: count };
  function togglePlayback() {
    if (!active || disabled || busy || previewError) return;
    setTrimPreview(null);
    if (!playing)
      setFrame((current) =>
        loop
          ? previewOrigin(current, playbackRange)
          : current >= count - 1
            ? 0
            : current,
      );
    setPlaying((value) => !value);
  }
  const duplicateReason = duplicatePieceReason(project, piece.id);
  const splitReason =
    split.hit.piece.id !== piece.id
      ? `Move the playhead inside selected Piece ${project.pieces.indexOf(piece) + 1} to split it.`
      : split.reason;
  function stepFrame(direction: number) {
    setPlaying(false);
    setTrimPreview(null);
    setFrame((current) =>
      Math.max(0, Math.min(count - 1, current + direction)),
    );
  }
  useEffect(() => {
    onChange({
      ...videos,
      project,
      stale: stale || captionOverflow || !captionFits,
      rendering: busy,
    });
  }, [videos, project, stale, captionOverflow, captionFits, busy, onChange]);
  useEffect(() => {
    const finishGesture = () => {
      if (trimming.current || overlayDragging.current) return;
      gesture.current.active = false;
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
          setPreviewDimensions({
            width: decoder.current.width,
            height: decoder.current.height,
          });
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
          if (state.trimPreview || state.framingGuide) {
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
  }, [project, frame, clean, trimPreview, framingGuide]);
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
      from = loop ? previewOrigin(frame, playbackRange) : frame;
    setFrame(from);
    let handle = 0;
    const tick = (now: number) => {
      const next = previewPlaybackFrame(from, now - start, playbackRange, loop);
      setFrame(next.frame);
      if (next.finished) {
        setPlaying(false);
      } else {
        handle = requestAnimationFrame(tick);
      }
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, active, loop, playbackRange.start, playbackRange.end]);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  function change(next: EditProject, record = true, label?: string) {
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
      const edit = describeVideoEdit(current, next, piece.id, frame);
      if (label) edit.label = label;
      history.record(current, edit);
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
  function applyHistory(direction: "undo" | "redo") {
    if (disabled || busy) return;
    const edit = direction === "undo" ? history.nextUndo : history.nextRedo;
    const next = history[direction](latest.current.project);
    if (!change(next, false) || !edit) return;
    const focus = videoEditFocus(next, edit);
    setSelected(focus.pieceId);
    setSelectedCaption(focus.captionId);
    setPanel(focus.panel);
    setFrame(focus.frame);
    setFramingEnd(focus.framingEnd);
    setHistoryReveal({ pieceId: focus.pieceId, captionId: focus.captionId });
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
  function seekFraming(end: boolean) {
    setFramingEnd(end);
    setPlaying(false);
    setTrimPreview(null);
    const offset = project.pieces
      .slice(0, project.pieces.indexOf(piece))
      .reduce((sum, p) => sum + pieceFrames(p), 0);
    setFrame(offset + (end ? pieceFrames(piece) - 1 : 0));
  }
  function updatePiece(update: Partial<Piece>, label?: string) {
    return change(
      {
        ...project,
        pieces: project.pieces.map((p) =>
          p.id === piece.id ? { ...p, ...update } : p,
        ),
      },
      true,
      label,
    );
  }
  function moveCaption(id: string, position: Caption["position"]) {
    if (disabled || busy) return;
    const current = latest.current.project;
    const target = current.captions.find((c) => c.id === id);
    if (!target || target.position === position) return;
    change({
      ...current,
      captions: current.captions.map((c) =>
        c.id === id ? { ...c, position } : c,
      ),
    });
  }
  function timeCaption(id: string, interval: { start: number; end: number }) {
    if (disabled || busy) return;
    const current = latest.current.project;
    const target = current.captions.find((c) => c.id === id);
    if (
      !target ||
      (target.start === interval.start && target.end === interval.end)
    )
      return;
    change({
      ...current,
      captions: current.captions.map((c) =>
        c.id === id ? { ...c, ...interval, outside: false } : c,
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
    if (busy || disabled || captionOverflow) return;
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
  const freezeDurationControl = piece.freeze ? (
    <label>
      Freeze length (s) · 0.5–3 seconds
      <input
        type="number"
        aria-label="Freeze duration"
        min={0.5}
        max={3}
        step={1 / 30}
        value={time(piece.freeze)}
        onChange={(e) => updatePiece({ freeze: seconds(e.target.value) })}
      />
    </label>
  ) : null;
  return (
    <section
      ref={editor}
      className="jumper-panel jumper-edit-panel"
      aria-label="Edit video"
      onPointerDownCapture={(e) => {
        if (trimming.current || overlayDragging.current) return;
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
          !overlayDragging.current &&
          !(event.target as HTMLElement).closest(".jumper-trim-handle")
        )
          gesture.current.active = false;
      }}
      onPointerCancelCapture={(event) => {
        if (
          !trimming.current &&
          !overlayDragging.current &&
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
          onClick={() => applyHistory("undo")}
        >
          Undo: {history.nextUndo?.label ?? "no edits"}
        </button>
        <button
          disabled={disabled || !history.canRedo || busy}
          onClick={() => applyHistory("redo")}
        >
          Redo: {history.nextRedo?.label ?? "no edits"}
        </button>
        <button
          disabled={disabled || busy}
          onClick={() =>
            change(
              newProject(baseDuration, base.type, palette),
              true,
              "reset edits",
            )
          }
        >
          Reset edits
        </button>
      </div>
      <div className="jumper-edit-layout">
        <div className="jumper-edit-preview">
          <div
            className="jumper-preview-switch"
            role="group"
            aria-label="Preview version"
            aria-describedby={previewHelpId}
          >
            {(
              [
                [false, "Edited video"],
                [true, "Clean quiz"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={String(value)}
                aria-pressed={clean === value}
                onClick={() => {
                  setTrimPreview(null);
                  setClean(value === true);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p id={previewHelpId} className="jumper-caption">
            Clean quiz keeps cuts, speeds, and freezes, without text, zoom/pan,
            or fades. Switching previews does not change your download.
          </p>
          <div className="jumper-preview-stage">
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
                      Math.min(
                        count - 1,
                        f + (e.key === "ArrowRight" ? 1 : -1),
                      ),
                    ),
                  );
                }
                if (e.key === " ") {
                  e.preventDefault();
                  togglePlayback();
                }
              }}
            />
            <FramingPreview
              canvas={canvas}
              dimensions={previewDimensions}
              framing={piece[framingEnd ? "to" : "from"]}
              endpoint={framingEnd ? "End" : "Start"}
              identity={`${piece.id}-${framingEnd}`}
              visible={
                active && framingGuide && !disabled && !busy && !previewError
              }
              onMove={(framing) => {
                seekFraming(framingEnd);
                updatePiece({ [framingEnd ? "to" : "from"]: framing });
              }}
              onStart={beginOverlayDrag}
              onEnd={endOverlayDrag}
            />
            <CaptionPreview
              canvas={canvas}
              dimensions={previewDimensions}
              captions={project.captions}
              frame={frame}
              visible={
                active &&
                !clean &&
                !trimPreview &&
                !framingGuide &&
                !disabled &&
                !busy &&
                !previewError
              }
              selected={selectedCaption}
              onSelect={selectCaption}
              onMove={moveCaption}
              onDragStart={beginOverlayDrag}
              onDragEnd={endOverlayDrag}
            />
          </div>
          {project.captions.length > 0 ? (
            <div className="jumper-caption" aria-live="polite">
              <p>
                Edited video captions · {captionCheck.status}{" "}
                {captionCheck.retry ? (
                  <button onClick={captionCheck.retry}>
                    Retry caption check
                  </button>
                ) : null}
              </p>
              {captionCheck.risks.map((risk) => {
                const index = project.captions.findIndex(
                  (c) => c.id === risk.id,
                );
                return (
                  <div className="jumper-notice" key={risk.id}>
                    <p>
                      Caption {index + 1} covers{" "}
                      {risk.upper >= 0.15
                        ? "the upper silhouette (which may obscure shooting motion)"
                        : "a substantial part of the shooter"}{" "}
                      around {(risk.frame / 30).toFixed(2)}s. This is an
                      approximate mask-overlap hint, not hand or release
                      detection. Placement is your choice.
                    </p>
                    <div className="jumper-toolbar">
                      <button
                        onClick={() => {
                          selectCaption(risk.id);
                          setFrame(risk.frame);
                          setClean(false);
                        }}
                      >
                        Inspect caption {index + 1}
                      </button>
                      {risk.suggestion ? (
                        <button
                          disabled={disabled || busy}
                          onClick={() => moveCaption(risk.id, risk.suggestion!)}
                        >
                          Try {risk.suggestion} · less silhouette overlap
                        </button>
                      ) : (
                        <span>
                          No clearly better supported position. Try shorter text
                          or a different interval.
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
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
              disabled={!active || disabled || busy || !!previewError}
              onClick={togglePlayback}
            >
              {playing ? "Pause edit preview" : "Play edit preview"}
            </button>
            <button
              aria-pressed={loop}
              disabled={!active || disabled || busy || !!previewError}
              onClick={() => setLoop((value) => !value)}
            >
              Loop selected piece
            </button>
            <span>
              {time(frame)} / {time(count)}s
            </span>
          </div>
          {loop ? (
            <div className="jumper-loop-options">
              <label>
                <input
                  type="checkbox"
                  checked={loopContext}
                  onChange={(e) => setLoopContext(e.target.checked)}
                />{" "}
                Include 0.5s before and after
              </label>
              <p className="jumper-caption" role="status">
                Looping Piece {project.pieces.indexOf(piece) + 1} ·{" "}
                {time(playbackRange.start)}–{time(playbackRange.end)}s. Preview
                only; downloads are unchanged.
              </p>
            </div>
          ) : null}
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
          <div className="jumper-split-position" aria-hidden="true">
            <span
              style={{
                left: `${count <= 1 ? 0 : (frame / (count - 1)) * 100}%`,
              }}
            />
          </div>
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
          <CaptionTimeline
            captions={project.captions}
            cuts={captionCuts}
            frames={count}
            frame={frame}
            selected={selectedCaption}
            enabled={active && !disabled && !busy}
            onSelect={selectCaption}
            onChange={timeCaption}
            onStart={beginOverlayDrag}
            onEnd={endOverlayDrag}
          />
          <p className="jumper-caption">
            One 30 fps timeline · {time(count)}s / 60s. Quiz copies keep cuts,
            speed, and freezes; captions, framing, and fades stay in your
            viewing version.
          </p>
        </div>
        <div className="jumper-edit-controls">
          <fieldset
            className="jumper-piece-toolbar"
            aria-label="Selected piece toolbar"
            disabled={disabled || busy}
          >
            <legend>
              Selected piece · Piece {project.pieces.indexOf(piece) + 1}
              {piece.freeze ? " · freeze" : ""}
            </legend>
            <div
              className="jumper-split-controls"
              role="group"
              aria-label="Frame stepping and split"
            >
              <button disabled={frame <= 0} onClick={() => stepFrame(-1)}>
                Previous frame
              </button>
              <button
                disabled={!!splitReason}
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
              {splitReason
                ? `Playhead: frame ${frame + 1} · ${time(frame)}s · Piece ${split.index + 1}. ${splitReason}`
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
                  project.pieces.indexOf(piece) === project.pieces.length - 1
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
              <button
                disabled={!!duplicateReason}
                aria-describedby={duplicateReason ? duplicateHelpId : undefined}
                onClick={() => {
                  try {
                    const next = duplicatePiece(project, piece.id);
                    const index = project.pieces.indexOf(piece) + 1;
                    const copy = next.pieces[index];
                    if (change(next)) {
                      setSelected(copy.id);
                      setSelectedCaption(null);
                      setFrame(
                        next.pieces
                          .slice(0, index)
                          .reduce((sum, p) => sum + pieceFrames(p), 0),
                      );
                      setHistoryReveal({ pieceId: copy.id, captionId: null });
                    }
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Duplicate
              </button>
            </div>
            {duplicateReason ? (
              <p id={duplicateHelpId} className="jumper-caption" role="status">
                {duplicateReason}
              </p>
            ) : null}
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
            {piece.freeze ? (
              <p className="jumper-caption">
                Freeze frames keep their set duration; adjust Freeze length in
                Cut or Effects.
              </p>
            ) : null}
          </fieldset>
          <div
            className="jumper-toolbar"
            role="group"
            aria-label="Editing tools"
          >
            {["Cut", "Text", "Effects"].map((v) => (
              <button
                key={v}
                aria-pressed={panel === v}
                onClick={() => {
                  setPanel(v);
                  if (v === "Effects") {
                    setPlaying(false);
                    setTrimPreview(null);
                  }
                }}
              >
                {v}
              </button>
            ))}
          </div>
          <fieldset disabled={disabled || busy}>
            <div hidden={panel !== "Effects"}>
              <PieceEffectsClipboard
                piece={piece}
                name={`${piece.freeze ? "Freeze" : "Piece"} ${project.pieces.indexOf(piece) + 1}`}
                onPaste={(patch) => updatePiece(patch, "paste effects")}
              />
            </div>
            {panel === "Cut" ? (
              <>
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
                  freezeDurationControl
                )}
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
                    const id = crypto.randomUUID();
                    const added = change({
                      ...project,
                      captions: [
                        ...project.captions,
                        {
                          id,
                          text: caption.trim(),
                          start: frame,
                          end: Math.min(count, frame + 60),
                          size: "medium",
                          position: "bottom",
                        },
                      ],
                    });
                    if (added) setSelectedCaption(id);
                    setCaption("");
                  }}
                >
                  Add at current time
                </button>
                <p className="jumper-caption">
                  Click a visible caption in the preview to select it. Drag it
                  to the top, center, or bottom guides, or use Placement below.{" "}
                  Long captions wrap within the outlined safe area. Use a
                  smaller size or shorter text if a caption cannot fit.
                </p>
                {project.captions.map((c, index) => (
                  <div
                    className={`jumper-caption-editor${selectedCaption === c.id ? " is-selected" : ""}`}
                    key={c.id}
                    role="group"
                    aria-label={`Caption ${index + 1} controls`}
                    onFocusCapture={() => setSelectedCaption(c.id)}
                  >
                    <strong>
                      {selectedCaption === c.id
                        ? "Selected caption"
                        : `Caption ${index + 1}`}
                    </strong>
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
                    {captionFits?.[index] === false ? (
                      <p role="alert" className="jumper-notice">
                        Caption {index + 1} cannot fit in the safe area at this
                        size. Choose a smaller size or shorten the text before
                        updating the finished video.
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
                <p className="jumper-caption jumper-freeze-preview">
                  Hold the frame shown in the video preview: frame {frame + 1} ·{" "}
                  {time(frame)}s (masked source frame {split.hit.source + 1} ·{" "}
                  {time(split.hit.source)}s). A new freeze starts at 1 second.
                </p>
                <button
                  disabled={
                    project.pieces.length +
                      (!split.hit.piece.freeze &&
                      split.hit.source > split.hit.piece.start
                        ? 2
                        : 1) >
                      100 || count + 30 > 1800
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
                    if (change({ ...project, pieces })) {
                      setSelected(freeze.id);
                      setFramingEnd(false);
                      setFrame(
                        pieces
                          .slice(
                            0,
                            pieces.findIndex((p) => p.id === freeze.id),
                          )
                          .reduce((sum, p) => sum + pieceFrames(p), 0),
                      );
                    }
                  }}
                >
                  Freeze at playhead
                </button>
                {count + 30 > 1800 ? (
                  <p className="jumper-caption">
                    Make room for one second within the 60-second limit before
                    adding a freeze.
                  </p>
                ) : null}
                {project.pieces.length +
                  (!split.hit.piece.freeze &&
                  split.hit.source > split.hit.piece.start
                    ? 2
                    : 1) >
                100 ? (
                  <p className="jumper-caption">
                    Delete a piece to make room within the 100-piece limit.
                  </p>
                ) : null}
                {freezeDurationControl}
                <div
                  className="jumper-framing-endpoints"
                  role="group"
                  aria-label="Framing endpoint"
                >
                  <button
                    aria-pressed={!framingEnd}
                    onClick={() => seekFraming(false)}
                  >
                    Start framing
                  </button>
                  <button
                    aria-pressed={framingEnd}
                    onClick={() => seekFraming(true)}
                  >
                    End framing
                  </button>
                </div>
                <button
                  disabled={
                    piece.to.zoom === piece.from.zoom &&
                    piece.to.x === piece.from.x &&
                    piece.to.y === piece.from.y
                  }
                  onClick={() => {
                    seekFraming(true);
                    updatePiece(
                      { to: { ...piece.from } },
                      "match start framing",
                    );
                  }}
                >
                  Match start framing
                </button>
                <p className="jumper-caption">
                  Match copies the start zoom and position to the end for a
                  stationary crop.
                </p>
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
                      seekFraming(framingEnd);
                      const key = framingEnd ? "to" : "from";
                      updatePiece({
                        [key]: { ...piece[key], zoom: Number(e.target.value) },
                      });
                    }}
                  />
                </label>
                <p className="jumper-caption">
                  While paused, the preview shows the full masked frame. Drag
                  the
                  {framingEnd ? " end" : " start"} rectangle or use arrow keys
                  to pan; zoom above 1× to move it. Play to see the finished
                  crop. Clean quiz has no framing guide or zoom.
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
                        seekFraming(framingEnd);
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
                    updatePiece(
                      {
                        from: neutralFraming(),
                        to: neutralFraming(),
                      },
                      "reset framing",
                    )
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
      {captionOverflow ? (
        <p role="alert" className="jumper-notice">
          Caption text exceeds the safe area. Open Text to shorten it or choose
          a smaller size. Your previous finished download is preserved.
        </p>
      ) : null}
      <div className="jumper-toolbar">
        <button
          className="button button-primary"
          disabled={
            busy || disabled || !stale || captionOverflow || !captionFits
          }
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
        <div
          className="jumper-finished-status"
          role="status"
          aria-label="Finished-video status"
        >
          <span>
            {stale
              ? "Download: previous finished version; latest edits not yet included."
              : "Download: includes the latest edits."}
          </span>
          <span>
            {busy
              ? "Final-motion review required after rendering finishes."
              : stale
                ? "Final-motion review required after updating the finished video."
                : reviewed
                  ? "Final-motion review complete."
                  : "Final-motion review required: watch the finished video below and confirm."}
          </span>
        </div>
      </div>
    </section>
  );
}
