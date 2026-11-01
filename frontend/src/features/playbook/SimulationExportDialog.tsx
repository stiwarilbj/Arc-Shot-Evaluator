import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Download, Minus, Plus, Redo2, Trash2, Undo2, X } from "lucide-react";
import { clientPointToCourt, courtPointToSvg, COURT_VIEWBOX } from "./courtGeometry.ts";
import type { SimulationFrame } from "./simulation.ts";
import type { ArrowVisibility } from "./arrowVisibility.ts";
import type { ReadCoachSessionRecord } from "./types.ts";
import type { SpacingGate } from "./types.ts";
import { canvasBlob, createImageZip, createPdf, downloadBlob, frameSvg, isExportFrame, MAX_EXPORT_BYTES, svgToCanvas, type ExportFocus, type ExportFrame, type ExportMark, type ExportTheme } from "./simulationExport.ts";

type Format = "current-png" | "current-pdf" | "video" | "pdf-frames" | "image-folder";
type Props = {
  title: string; frame: SimulationFrame; positionMs: number; durationMs: number; visibility: ArrowVisibility;
  session?: ReadCoachSessionRecord | null; frameAt?: (timeMs: number) => SimulationFrame | null;
  comparisonAt?: ((timeMs: number) => SimulationFrame | null) | null; comparisonDurationMs?: number | null;
  frameLabel?: string; comparisonLabel?: string; spacingGates?: SpacingGate[]; showSpacingGates?: boolean; focus?: ExportFocus; onClose: () => void;
};
type DragMark = { pointerId: number; tool: ExportMark["kind"]; points: Array<{ x: number; y: number }> };
const fpsValues = [30, 10, 5, 1] as const;
const filename = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "arcade-hoops-simulation";
const wait = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function prepareSessionFrames(session: ReadCoachSessionRecord, startMs: number, endMs: number, fps: number, signal: AbortSignal, onProgress: (value: number) => void): Promise<ExportFrame[]> {
  const worker = new Worker(new URL("./simulationExport.worker.ts", import.meta.url), { type: "module" });
  const jobId = crypto.randomUUID();
  const result = new Promise<ExportFrame[]>((resolve, reject) => {
    const frames: ExportFrame[] = [];
    const cleanup = () => { worker.removeEventListener("message", receive); worker.removeEventListener("error", fail); signal.removeEventListener("abort", cancel); worker.terminate(); };
    const fail = () => { cleanup(); reject(new Error("Replay export worker stopped · Retry or export the current frame")); };
    const cancel = () => { worker.postMessage({ type: "cancel", jobId }); cleanup(); reject(new DOMException("Export cancelled", "AbortError")); };
    const receive = (event: MessageEvent<Record<string, unknown>>) => {
      if (event.data.jobId !== jobId) return;
      if (event.data.type === "frames" && Array.isArray(event.data.frames)) {
        if (event.data.frames.length > 6 || !event.data.frames.every(isExportFrame) || !Number.isFinite(event.data.progress) || Number(event.data.progress) < 0 || Number(event.data.progress) > 1) { cleanup(); reject(new Error("Replay export worker returned invalid frame data · Retry from the selected frame")); return; }
        frames.push(...event.data.frames as ExportFrame[]); onProgress(Number(event.data.progress));
      }
      else if (event.data.type === "done") { cleanup(); resolve(frames); }
      else if (event.data.type === "cancelled") { cleanup(); reject(new DOMException("Export cancelled", "AbortError")); }
      else if (event.data.type === "error") { cleanup(); reject(new Error(typeof event.data.message === "string" ? event.data.message : "Replay frames could not be prepared")); }
      else { cleanup(); reject(new Error("Replay export worker returned an unknown response · Retry from the selected frame")); }
    };
    worker.addEventListener("message", receive); worker.addEventListener("error", fail); signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    worker.postMessage({ type: "start", jobId, session, startMs, endMs, fps });
  });
  return result;
}

export function SimulationExportDialog({ title, frame, positionMs, durationMs, visibility, session = null, frameAt, comparisonAt = null, comparisonDurationMs = null, frameLabel, comparisonLabel, spacingGates = [], showSpacingGates = false, focus, onClose }: Props) {
  const [format, setFormat] = useState<Format>("current-png");
  const [startMs, setStartMs] = useState(0), [endMs, setEndMs] = useState(durationMs);
  const [sampleFps, setSampleFps] = useState<number>(30), [resolution, setResolution] = useState<720 | 1080>(720);
  const [compare, setCompare] = useState(false), [notes, setNotes] = useState("");
  const [noteStart, setNoteStart] = useState(positionMs), [noteEnd, setNoteEnd] = useState(Math.min(durationMs, positionMs + 2000));
  const [marks, setMarks] = useState<ExportMark[]>([]), [tool, setTool] = useState<DragMark["tool"] | null>(null), [selectedMarkId, setSelectedMarkId] = useState<string | null>(null);
  const [markTextDraft, setMarkTextDraft] = useState("");
  const [gesturePoints, setGesturePoints] = useState<Array<{ x: number; y: number }> | null>(null);
  const [progress, setProgress] = useState<number | null>(null), [error, setError] = useState("");
  const [downloadName, setDownloadName] = useState(filename(title));
  const [previewTime, setPreviewTime] = useState(positionMs);
  const [undoMarks, setUndoMarks] = useState<ExportMark[][]>([]), [redoMarks, setRedoMarks] = useState<ExportMark[][]>([]);
  const [sessionPreviewFrame, setSessionPreviewFrame] = useState<SimulationFrame | null>(frame);
  const [previewLoading, setPreviewLoading] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null), dragRef = useRef<DragMark | null>(null), abortRef = useRef<AbortController | null>(null), previewAbortRef = useRef<AbortController | null>(null);
  const theme = useMemo<ExportTheme>(() => document.documentElement.dataset.theme === "light" ? "light" : "dark", []);
  const currentFrame = frameAt?.(previewTime) ?? sessionPreviewFrame ?? frame;
  const comparisonFrame = compare && comparisonAt ? comparisonAt(previewTime) : null;
  const comparisonEnded = Boolean(comparisonFrame && comparisonDurationMs != null && previewTime > comparisonDurationMs);
  const primaryEnded = Boolean(frameAt && previewTime > durationMs);
  const selectedFormat = format.startsWith("current-") ? "Current frame" : format === "video" ? "Video" : format === "pdf-frames" ? "PDF frames" : "Image folder";
  const isCurrent = format === "current-png" || format === "current-pdf";
  const rangeStart = isCurrent ? previewTime : startMs, rangeEnd = isCurrent ? previewTime : endMs;
  const timelineDurationMs = compare && comparisonAt ? Math.max(durationMs, comparisonDurationMs ?? 0) : durationMs;
  const fps = format === "video" ? 30 : sampleFps;
  const frameCount = isCurrent ? 1 : Math.floor(Math.max(0, rangeEnd - rangeStart) / (1000 / fps)) + 1;
  const outputHeight = resolution, singleCourtWidth = Math.ceil((outputHeight * COURT_VIEWBOX.width / COURT_VIEWBOX.height) / 2) * 2;
  const outputWidth = singleCourtWidth * (compare && comparisonAt ? 2 : 1);
  const estimateBytes = format === "video" ? (rangeEnd - rangeStart) / 1000 * 2_500_000 * (compare && comparisonAt ? 1.5 : 1)
    : format === "current-png" ? outputWidth * outputHeight * 1.6 : frameCount * outputWidth * outputHeight * (format === "pdf-frames" ? .35 : .55);
  const estimate = useMemo(() => estimateBytes > 1024 ** 2 ? `${(estimateBytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.max(1, Math.round(estimateBytes / 1024))} KiB`, [estimateBytes]);
  const drawingOptions = (atMs: number, ended = false, pairedEnded = false) => ({ notes: noteStart <= atMs && atMs <= noteEnd ? notes : "", marks, atMs, replayEnded: ended, comparisonEnded: pairedEnded, theme, spacingGates, showSpacingGates, frameLabel, comparisonLabel, focus });
  const previewData = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(frameSvg({ atMs: previewTime, frame: currentFrame, comparison: comparisonFrame, replayEnded: primaryEnded, comparisonEnded }, visibility, drawingOptions(previewTime, primaryEnded, comparisonEnded)))}`, [currentFrame, comparisonEnded, comparisonFrame, focus, marks, noteEnd, noteStart, notes, previewTime, primaryEnded, theme, visibility, spacingGates, showSpacingGates, frameLabel, comparisonLabel]);

  useEffect(() => { setEndMs(durationMs); setNoteEnd(Math.min(durationMs, positionMs + 2000)); }, [durationMs, positionMs]);
  useEffect(() => {
    if (!session) return;
    if (Math.abs(previewTime - positionMs) < 1) { setSessionPreviewFrame(frame); setPreviewLoading(false); return; }
    previewAbortRef.current?.abort();
    const controller = new AbortController(); previewAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      setPreviewLoading(true);
      void prepareSessionFrames(session, previewTime, previewTime, 1, controller.signal, () => undefined)
        .then((samples) => { if (!controller.signal.aborted) setSessionPreviewFrame(samples[0]?.frame ?? null); })
        .catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError")) setError(error instanceof Error ? error.message : "Preview frame could not be prepared"); })
        .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    }, 100);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [durationMs, frame, positionMs, previewTime, session]);
  useEffect(() => { setMarkTextDraft(marks.find((mark) => mark.id === selectedMarkId)?.text ?? ""); }, [marks, selectedMarkId]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { if (dragRef.current) { dragRef.current = null; setGesturePoints(null); } else if (progress != null) abortRef.current?.abort(); else onClose(); } };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose, progress]);
  useEffect(() => () => { abortRef.current?.abort(); previewAbortRef.current?.abort(); }, []);

  function courtPoint(event: ReactPointerEvent<SVGSVGElement>) {
    const matrix = svgRef.current?.getScreenCTM();
    const point = matrix ? clientPointToCourt(event.clientX, event.clientY, matrix) : null;
    return point && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100 ? point : null;
  }
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!tool || event.button !== 0) return;
    const point = courtPoint(event); if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, tool, points: [point] };
    setGesturePoints([point]);
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = dragRef.current; if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = courtPoint(event); if (!point) return;
    if (gesture.tool === "freehand" && Math.hypot(gesture.points.at(-1)!.x - point.x, gesture.points.at(-1)!.y - point.y) > .35) gesture.points.push(point);
    else if (gesture.points.length === 1) gesture.points.push(point);
    setGesturePoints([...gesture.points]);
  }
  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = dragRef.current; if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = courtPoint(event); if (point && gesture.points.length === 1) gesture.points.push(point);
    dragRef.current = null; setGesturePoints(null);
    const pointTool = gesture.tool === "text" || gesture.tool === "callout";
    const isShort = gesture.points.length < 2 || Math.hypot(gesture.points[0].x - gesture.points.at(-1)!.x, gesture.points[0].y - gesture.points.at(-1)!.y) < .3;
    if (isShort && !pointTool) { setTool(null); return; }
    const text = pointTool ? window.prompt(gesture.tool === "text" ? "Text for this frame" : "Callout label", "")?.slice(0, 100) : undefined;
    if (pointTool && !text?.trim()) { setTool(null); return; }
    const points = pointTool ? [gesture.points[0]] : gesture.points.slice(0, 256);
    const nextMark: ExportMark = { id: crypto.randomUUID(), kind: gesture.tool, points, startMs: noteStart, endMs: Math.max(noteStart, noteEnd), ...(text ? { text } : {}), ...(gesture.tool === "callout" ? { number: marks.filter((mark) => mark.kind === "callout").length + 1 } : {}) };
    const next = [...marks, nextMark];
    setUndoMarks((history) => [...history.slice(-19), marks]); setRedoMarks([]); setMarks(next); setSelectedMarkId(next.at(-1)?.id ?? null); setTool(null);
  }

  async function captureExportFrames(signal: AbortSignal, update: (value: number) => void) {
    if (session) return prepareSessionFrames(session, rangeStart, rangeEnd, fps, signal, update);
    if (!frameAt) return [{ atMs: positionMs, frame }];
      const samples: ExportFrame[] = [];
    const frameStep = 1000 / fps;
    const total = Math.floor(Math.max(0, rangeEnd - rangeStart) / frameStep + 1e-8) + 1;
    for (let index = 0; index < total; index++) {
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const atMs = index === total - 1 ? rangeEnd : rangeStart + index * frameStep;
      const selected = frameAt(atMs);
      if (selected) samples.push({ atMs, frame: selected, replayEnded: atMs > durationMs, comparison: compare && comparisonAt ? comparisonAt(atMs) : null,
        comparisonEnded: Boolean(compare && comparisonAt && comparisonDurationMs != null && atMs > comparisonDurationMs) });
      if (index % 4 === 0) { update(Math.min(1, (atMs - rangeStart) / Math.max(1, rangeEnd - rangeStart))); await wait(); }
      if (samples.length > 5400) throw new Error("This export contains too many frames · Choose a shorter range or lower sampling rate");
    }
    return samples;
  }

  async function render() {
    if (progress != null) return;
    setError("");
    if (estimateBytes > MAX_EXPORT_BYTES) { setError(`This export is estimated at ${estimate} and exceeds the 256 MiB safety limit · Shorten the range, lower the resolution, or reduce image sampling`); return; }
    const controller = new AbortController(); abortRef.current = controller; const signal = controller.signal;
    let downloadStarted = false;
    try {
      if (previewLoading) throw new Error("The selected replay frame is still loading · Wait for the preview, then try again");
      if (format === "current-png" || format === "current-pdf") {
        setProgress(0.1);
        const currentComparison = compare && comparisonAt ? comparisonAt(previewTime) : null;
        const ended = Boolean(currentComparison && comparisonDurationMs != null && previewTime > comparisonDurationMs);
        const canvas = await svgToCanvas(frameSvg({ atMs: previewTime, frame: currentFrame, comparison: currentComparison, replayEnded: primaryEnded, comparisonEnded: ended }, visibility, drawingOptions(previewTime, primaryEnded, ended)), outputWidth, outputHeight);
        if (format === "current-png") { downloadBlob(await canvasBlob(canvas), `${downloadName}-frame.png`); }
        else { const pdf = await createPdf([await canvasBlob(canvas, "image/png")], signal); downloadBlob(pdf, `${downloadName}-frame.pdf`); }
        downloadStarted = true; setProgress(1); return;
      }
      setProgress(0.01);
      const frames = await captureExportFrames(signal, (value) => setProgress(value * .45));
      if (!frames.length) throw new Error("No recorded frames are available in this range");
      let bytesSoFar = 0;
      if (format === "video") {
        const { writers } = await import("../jumper/media.ts");
        const video = await writers(outputWidth, outputHeight);
        const writer = await video.create(false);
        try {
          for (let index = 0; index < frames.length; index++) {
            if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
            const item = frames[index];
            const svg = frameSvg(item, visibility, drawingOptions(item.atMs, Boolean(item.replayEnded), Boolean(item.comparisonEnded)));
            const canvas = await svgToCanvas(svg, outputWidth, outputHeight);
            writer.context.clearRect(0, 0, writer.canvas.width, writer.canvas.height); writer.context.drawImage(canvas, 0, 0, writer.canvas.width, writer.canvas.height);
            await writer.source.add(index / 30, 1 / 30);
            if (index % 6 === 0) { setProgress(.45 + .53 * (index + 1) / frames.length); await wait(); }
            bytesSoFar += outputWidth * outputHeight * 1.2;
            if (bytesSoFar > MAX_EXPORT_BYTES) throw new Error("Video export exceeded the 256 MiB safety limit · Choose 720p or a shorter range");
          }
          const blob = await writer.finish(); if (blob.size > MAX_EXPORT_BYTES) throw new Error("The encoded video exceeds the 256 MiB safety limit");
          const extension = video.mime === "video/mp4" ? "mp4" : "webm"; downloadBlob(blob, `${downloadName}.${extension}`);
        } catch (caught) { if (!writer.finalized) await writer.cancel(); throw caught; }
      } else {
        const outputs: Blob[] = [], indexLines = [`${downloadName} · ${selectedFormat}`, `Range ${(rangeStart / 1000).toFixed(3)}–${(rangeEnd / 1000).toFixed(3)} seconds`, `Sampling ${fps} fps`, ""];
        for (let index = 0; index < frames.length; index++) {
          if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
          const item = frames[index], canvas = await svgToCanvas(frameSvg(item, visibility, drawingOptions(item.atMs, Boolean(item.replayEnded), Boolean(item.comparisonEnded))), outputWidth, outputHeight);
          const blob = await canvasBlob(canvas); bytesSoFar += blob.size;
          if (bytesSoFar > MAX_EXPORT_BYTES) throw new Error("Rendered images exceed the 256 MiB safety limit · Shorten the range or reduce sampling");
          outputs.push(blob); indexLines.push(`${String(index + 1).padStart(4, "0")} · ${(item.atMs / 1000).toFixed(3)} s`);
          if (index % 3 === 0) { setProgress(.45 + .53 * (index + 1) / frames.length); await wait(); }
        }
        if (format === "pdf-frames") downloadBlob(await createPdf(outputs, signal), `${downloadName}-frames.pdf`);
        else downloadBlob(await createImageZip(outputs.map((blob, index) => ({ name: `${downloadName}/frame-${String(index + 1).padStart(4, "0")}.png`, blob })), indexLines.join("\n"), signal, `${downloadName}/index.txt`), `${downloadName}-frames.zip`);
      }
      downloadStarted = true; setProgress(1);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") setError("Export cancelled · Your play and previous downloads are unchanged");
      else setError(caught instanceof Error ? caught.message : "Export failed · Retry or choose a smaller range");
    } finally { abortRef.current = null; setProgress(null); if (!downloadStarted && signal.aborted) setError((value) => value || "Export cancelled"); }
  }

  function cancel() { abortRef.current?.abort(); }
  function undoDrawing() { const previous = undoMarks.at(-1); if (!previous) return; setRedoMarks((history) => [...history.slice(-19), marks]); setMarks(previous); setUndoMarks((history) => history.slice(0, -1)); }
  function redoDrawing() { const next = redoMarks.at(-1); if (!next) return; setUndoMarks((history) => [...history.slice(-19), marks]); setMarks(next); setRedoMarks((history) => history.slice(0, -1)); }
  function commitSelectedMarkText() { if (!selectedMarkId) return; const current = marks.find((mark) => mark.id === selectedMarkId); if (!current || current.text === markTextDraft) return; setUndoMarks((history) => [...history.slice(-19), marks]); setRedoMarks([]); setMarks((value) => value.map((mark) => mark.id === selectedMarkId ? { ...mark, text: markTextDraft.slice(0, 160) } : mark)); }
  function removeSelectedMark() { if (!selectedMarkId) return; setUndoMarks((history) => [...history.slice(-19), marks]); setRedoMarks([]); setMarks((current) => current.filter((mark) => mark.id !== selectedMarkId)); setSelectedMarkId(null); }

  return <div className="simulation-export-backdrop" role="presentation"><section className="simulation-export-dialog" role="dialog" aria-modal="true" aria-labelledby="simulation-export-title">
    <header><div><span className="section-kicker">Private browser export</span><h2 id="simulation-export-title">Export replay</h2><p>{title} · {Math.max(1, frameCount)} {format === "video" ? "frames" : format.endsWith("pdf") || format === "pdf-frames" ? "pages" : "images"} · {resolution}p{compare && comparisonAt ? " · Two synchronized courts" : ""} · Estimate {estimate}</p></div><button className="icon-button" onClick={onClose} aria-label="Close export preview"><X size={17}/></button></header>
    <div className={`simulation-export-preview ${comparisonFrame ? "is-comparison" : ""}`}><img src={previewData} alt="Preview of the simulation export"/>{previewLoading ? <span className="simulation-export-preview-loading" role="status">Preparing preview frame…</span> : null}<svg ref={svgRef} className="simulation-export-draw-layer" style={{ pointerEvents: tool ? "auto" : "none" }} viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} aria-label="Temporary export drawing area" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { dragRef.current = null; setGesturePoints(null); }}>
      {gesturePoints?.length ? (() => { const a = courtPointToSvg(gesturePoints[0]), b = courtPointToSvg(gesturePoints.at(-1)!); const path = gesturePoints.map((point,index)=>{const p=courtPointToSvg(point);return `${index?"L":"M"}${p.x} ${p.y}`}).join(" "); return <g className="simulation-export-mark-draft">{tool === "circle" ? <circle cx={a.x} cy={a.y} r={Math.max(8,Math.hypot(b.x-a.x,b.y-a.y))}/> : null}{tool === "spotlight" ? <rect x={Math.min(a.x,b.x)} y={Math.min(a.y,b.y)} width={Math.max(2,Math.abs(b.x-a.x))} height={Math.max(2,Math.abs(b.y-a.y))}/> : null}{tool === "attention-line" || tool === "freehand" ? <path d={path}/> : null}</g>; })() : null}
    </svg></div>
    <div className="simulation-export-controls">
      <div className="simulation-export-format" role="group" aria-label="Export format">{([["current-png","Current frame · PNG"],["current-pdf","Current frame · PDF"],["video","Video"],["pdf-frames","PDF frames"],["image-folder","Image folder"]] as Array<[Format,string]>).map(([value,label])=><button key={value} type="button" className={format===value?"is-active":""} aria-pressed={format===value} onClick={()=>setFormat(value)}>{label}</button>)}</div>
      {comparisonAt ? <label className="simulation-export-comparison"><input type="checkbox" checked={compare} onChange={(event)=>{const enabled=event.currentTarget.checked;setCompare(enabled);if(enabled)setEndMs(Math.max(durationMs,comparisonDurationMs??0));else { setStartMs((value)=>Math.min(value,Math.max(0,durationMs-1000/30))); setEndMs((value)=>Math.min(value,durationMs)); }}}/>Synchronized comparison</label> : null}
      {!isCurrent ? <><label className="simulation-export-range"><span>Start <input type="number" min="0" max={(timelineDurationMs/1000).toFixed(3)} step="0.033333" value={(startMs/1000).toFixed(3)} onChange={(event)=>setStartMs(Math.max(0,Math.min(endMs-1000/30,Number(event.currentTarget.value)*1000||0)))}/></span><input aria-label="Replay export preview position" type="range" min="0" max={Math.max(1,timelineDurationMs)} step="1" value={Math.min(previewTime,endMs)} onChange={(event)=>setPreviewTime(Number(event.currentTarget.value))}/><span>End <input type="number" min={(startMs/1000).toFixed(3)} max={(timelineDurationMs/1000).toFixed(3)} step="0.033333" value={(endMs/1000).toFixed(3)} onChange={(event)=>setEndMs(Math.max(startMs+1000/30,Math.min(timelineDurationMs,Number(event.currentTarget.value)*1000||timelineDurationMs)))}/></span></label><div className="simulation-export-settings"><label>Sampling <select value={sampleFps} disabled={format==="video"} onChange={(event)=>setSampleFps(Number(event.currentTarget.value))}>{fpsValues.map((value)=><option key={value} value={value}>{value} fps</option>)}</select></label><label>Resolution <select value={resolution} onChange={(event)=>setResolution(Number(event.currentTarget.value) as 720|1080)}><option value={720}>720p</option><option value={1080}>1080p</option></select></label></div></> : <label className="simulation-export-current-note">Current frame at <input aria-label="Current frame time" type="range" min="0" max={Math.max(1,timelineDurationMs)} step="1" value={Math.min(previewTime,timelineDurationMs)} onChange={(event)=>setPreviewTime(Number(event.currentTarget.value))}/> {(previewTime/1000).toFixed(2)} seconds · The court’s current route visibility is preserved</label>}
      <label className="simulation-export-note"><span>Temporary note</span><input maxLength={300} value={notes} onChange={(event)=>setNotes(event.currentTarget.value)} placeholder="Add a note to exported frames"/></label><div className="simulation-export-settings simulation-export-mark-tools"><label>Note starts <input type="number" min="0" max={(durationMs/1000).toFixed(2)} step="0.1" value={(noteStart/1000).toFixed(1)} onChange={(event)=>setNoteStart(Math.max(0,Number(event.currentTarget.value)*1000||0))}/></label><label>Note ends <input type="number" min={(noteStart/1000).toFixed(2)} max={(durationMs/1000).toFixed(2)} step="0.1" value={(noteEnd/1000).toFixed(1)} onChange={(event)=>setNoteEnd(Math.min(durationMs,Math.max(noteStart,Number(event.currentTarget.value)*1000||noteStart)))}/></label><div className="simulation-export-tools">{(["circle","spotlight","attention-line","freehand","callout","text"] as const).map((value)=><button key={value} type="button" className={tool===value?"is-active":""} aria-pressed={tool===value} title={`${value} drawing`} onClick={()=>setTool((current)=>current===value?null:value)}>{value==="circle"?<Plus size={14}/>:value==="attention-line"?<Minus size={14}/>:value}</button>)}<button type="button" onClick={undoDrawing} disabled={!undoMarks.length}><Undo2 size={14}/>Undo</button><button type="button" onClick={redoDrawing} disabled={!redoMarks.length}><Redo2 size={14}/>Redo</button><button type="button" onClick={()=>{setUndoMarks((history)=>[...history.slice(-19),marks]);setRedoMarks([]);setMarks([]);setSelectedMarkId(null);}}><Trash2 size={14}/>Clear</button></div></div>
      {marks.length ? <div className="simulation-export-mark-list" aria-label="Temporary drawings">{marks.map((mark,index)=><div key={mark.id}><button type="button" aria-pressed={selectedMarkId===mark.id} onClick={()=>setSelectedMarkId(mark.id)}>{index+1} · {mark.kind}{mark.text ? ` · ${mark.text}` : ""}</button></div>)}</div> : null}{selectedMarkId ? <div className="simulation-export-selected-mark"><label>Mark label <input maxLength={160} value={markTextDraft} onChange={(event)=>setMarkTextDraft(event.currentTarget.value)} onBlur={commitSelectedMarkText} /></label><button type="button" className="button button-subtle" onClick={removeSelectedMark}>Delete mark</button></div> : null}
    </div>
    {progress!=null?<div className="simulation-export-progress" role="status"><span style={{width:`${Math.round(progress*100)}%`}}/><small>{progress<.45?"Preparing recorded positions":"Rendering files"} · {Math.round(progress*100)}%</small></div>:null}
    {error?<div className="playbook-alert" role="alert">{error}</div>:null}
    <footer><button className="button button-subtle" onClick={progress!=null?cancel:onClose}>{progress!=null?"Cancel export":"Close"}</button><button className="button button-primary" onClick={render} disabled={progress!=null || previewLoading || (!isCurrent && endMs<=startMs)}><Download size={15}/>Download {selectedFormat}</button></footer>
  </section></div>;
}
