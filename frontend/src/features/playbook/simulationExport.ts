import { advanceSimulationState, getSimulationFrame, type SimulationFrame, type SimulationRun } from "./simulation.ts";
import { advanceRecordedSimulation, getSimulationSessionInfo, seekSimulationSession } from "./simulationSession.ts";
import type { CourtPoint, SpacingGate } from "./types.ts";
import { COURT_SCALE, COURT_VIEWBOX, COURT_MARKING_PATHS, NBA_COURT_GEOMETRY, courtPointToSvg } from "./courtGeometry.ts";
import { routeVisible, type ArrowVisibility, type CourtRoute } from "./arrowVisibility.ts";

export type ExportMark = { id: string; kind: "circle" | "spotlight" | "attention-line" | "freehand" | "callout" | "text"; points: CourtPoint[]; text?: string; number?: number; startMs: number; endMs: number };
export type ExportFrame = { atMs: number; frame: SimulationFrame; comparison?: SimulationFrame | null; replayEnded?: boolean; comparisonEnded?: boolean };
export type ExportTheme = "dark" | "light";
export type ExportFocus = { playerIds: number[]; defenderIds: number[]; actionIds: string[] };
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validPoint = (value: unknown) => isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
function validCourtFrame(value: unknown): value is SimulationFrame {
  if (!isRecord(value) || !Array.isArray(value.players) || value.players.length > 5 || !Array.isArray(value.defenders) || value.defenders.length > 5 || !Array.isArray(value.routes)) return false;
  for (const roster of [value.players, value.defenders]) {
    const ids = new Set<number>();
    for (const item of roster) {
      if (!isRecord(item) || !Number.isSafeInteger(item.id) || Number(item.id) < 1 || !validPoint(item) || ids.has(item.id as number)) return false;
      ids.add(item.id as number);
    }
  }
  if (value.ball !== null && value.ball !== undefined && !validPoint(value.ball)) return false;
  for (const raw of value.routes) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || !Number.isSafeInteger(raw.playerId) || !value.players.some((player) => isRecord(player) && player.id === raw.playerId)
      || !["on-ball", "off-ball"].includes(String(raw.scope)) || !["main", "adjustment"].includes(String(raw.importance)) || !validPoint(raw.start) || !validPoint(raw.end)
      || raw.control !== undefined && !validPoint(raw.control) || raw.via !== undefined && !validPoint(raw.via)
      || raw.points !== undefined && (!Array.isArray(raw.points) || raw.points.length > 128 || !raw.points.every(validPoint))) return false;
  }
  if (value.spacingGateResults !== undefined && (!Array.isArray(value.spacingGateResults) || value.spacingGateResults.length > 30
    || !value.spacingGateResults.every((result) => isRecord(result) && typeof result.gateId === "string" && ["pending", "checking", "met", "missed", "not-evaluated"].includes(String(result.status))))) return false;
  return true;
}
export function isExportFrame(value: unknown): value is ExportFrame {
  return isRecord(value) && typeof value.atMs === "number" && Number.isFinite(value.atMs) && value.atMs >= 0 && validCourtFrame(value.frame)
    && (value.comparison === undefined || value.comparison === null || validCourtFrame(value.comparison))
    && (value.replayEnded === undefined || typeof value.replayEnded === "boolean")
    && (value.comparisonEnded === undefined || typeof value.comparisonEnded === "boolean");
}

/** Replay recorded settings and paused edits exactly, then simulate only the
 * unrecorded tail using the last acknowledged run settings. */
export function advanceExportRunTo(run: SimulationRun, targetMs: number, recordedUntilMs: number, hoop: CourtPoint) {
  if (!Number.isFinite(targetMs) || targetMs < 0 || !Number.isFinite(recordedUntilMs) || recordedUntilMs < 0) throw new Error("Replay export time is invalid");
  let now = getSimulationSessionInfo(run)?.positionMs ?? run.elapsedMs;
  if (targetMs < now - 1e-6) {
    seekSimulationSession(run, targetMs);
    now = getSimulationSessionInfo(run)?.positionMs ?? run.elapsedMs;
  }
  while (now + 1e-6 < targetMs) {
    const remaining = Math.min(50, targetMs - now);
    if (now < recordedUntilMs - 1e-6) {
      const recordedDelta = Math.min(remaining, recordedUntilMs - now);
      if (!advanceRecordedSimulation(run, recordedDelta)) throw new Error("Recorded replay data ended before the export range");
    } else advanceSimulationState(run, remaining, run.settings, hoop);
    const next = getSimulationSessionInfo(run)?.positionMs ?? run.elapsedMs;
    if (next <= now + 1e-9) throw new Error("Replay export could not advance the recorded simulation");
    now = next;
  }
  return getSimulationFrame(run);
}
const courtPoint = (point: CourtPoint) => { const p = courtPointToSvg(point); return `${p.x.toFixed(2)} ${p.y.toFixed(2)}`; };
const escapeXml = (value: string) => value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);
const curve = (route: CourtRoute) => {
  if (route.points?.length) return `M${route.points.map(courtPoint).join(" L")}`;
  const start = courtPoint(route.start), end = courtPoint(route.end);
  if (route.via) return `M${start} L${courtPoint(route.via)} L${end}`;
  return route.control ? `M${start} Q${courtPoint(route.control)} ${end}` : `M${start} L${end}`;
};

function courtContents(frame: SimulationFrame, visibility: ArrowVisibility, gates: SpacingGate[] = [], showGates = false, focus?: ExportFocus) {
  const { boundary, basket } = NBA_COURT_GEOMETRY;
  const routes = frame.routes.filter((route) => routeVisible(route, visibility)).map((route) => `<path d="${curve(route)}" class="route ${route.importance === "adjustment" ? "adjustment" : ""} ${focus?.actionIds.includes(route.actionId ?? "") ? "focus" : ""}" marker-end="url(#export-arrow)"/>`).join("");
  const defenders = frame.defenders.map((player) => { const p = courtPointToSvg(player); return `<g class="defender ${focus?.defenderIds.includes(player.id) ? "focus" : ""}"><circle cx="${p.x}" cy="${p.y}" r="15"/><text x="${p.x}" y="${p.y + 1}">D${player.id}</text></g>`; }).join("");
  const players = frame.players.map((player) => { const p = courtPointToSvg(player); return `<g class="player ${frame.ballHandlerId === player.id ? "handler" : ""} ${focus?.playerIds.includes(player.id) ? "focus" : ""}"><circle cx="${p.x}" cy="${p.y}" r="17"/><text x="${p.x}" y="${p.y + 1}">${player.id}</text></g>`; }).join("");
  const ball = frame.ball ? (() => { const p = courtPointToSvg(frame.ball!); return `<circle class="ball" cx="${p.x}" cy="${p.y}" r="7"/>`; })() : "";
  const statuses = new Map((frame.spacingGateResults ?? []).map((result) => [result.gateId, result]));
  const gateMarkup = showGates ? gates.map((gate, index) => {
    const center = courtPointToSvg(gate.area.center), result = statuses.get(gate.id);
    const extentX = gate.area.shape === "circle" ? gate.area.radiusFeet : gate.area.widthFeet / 2;
    const extentY = gate.area.shape === "circle" ? gate.area.radiusFeet : gate.area.heightFeet / 2;
    const shape = gate.area.shape === "circle"
      ? `<circle cx="${center.x}" cy="${center.y}" r="${gate.area.radiusFeet * COURT_SCALE}"/>`
      : `<rect x="${center.x - gate.area.widthFeet * COURT_SCALE / 2}" y="${center.y - gate.area.heightFeet * COURT_SCALE / 2}" width="${gate.area.widthFeet * COURT_SCALE}" height="${gate.area.heightFeet * COURT_SCALE}" rx="3"/>`;
    const label = `GATE ${index + 1} · P${gate.playerId}`;
    const status = result ? `<text class="gate-status" x="${center.x}" y="${center.y + extentY * COURT_SCALE + 18}">${result.status === "met" ? "✓ Met" : result.status === "missed" ? "× Missed" : result.status === "not-evaluated" ? "— Not evaluated" : "○ Pending"}</text>` : "";
    return `<g class="export-spacing-gate gate-${result?.status ?? "pending"}">${shape}<text class="gate-label" x="${center.x}" y="${center.y - extentY * COURT_SCALE - 10}">${label}</text>${gate.instruction ? svgTextLines(gate.instruction, center.x, center.y + extentY * COURT_SCALE + 40, 26, "gate-instruction", 13, "middle") : ""}${status}<title>${label} · ${gate.rule === "inside" ? "Stay inside" : "Stay outside"}</title></g>`;
  }).join("") : "";
  const court = `<rect class="floor" width="${COURT_VIEWBOX.width}" height="${COURT_VIEWBOX.height}"/><rect class="court-line" x="${boundary.left}" y="${boundary.top}" width="${boundary.width}" height="${boundary.height}" rx="3"/><path class="court-line" d="${COURT_MARKING_PATHS.lane}"/><path class="court-dash" d="${COURT_MARKING_PATHS.freeThrowDashed}"/><path class="court-line" d="${COURT_MARKING_PATHS.freeThrowSolid}"/><path class="court-line" d="${COURT_MARKING_PATHS.threePointCorners}"/><path class="court-line" d="${COURT_MARKING_PATHS.threePointArc}"/><path class="basket-mark" d="${COURT_MARKING_PATHS.backboard}"/><circle class="basket-mark" cx="${basket.center.x}" cy="${basket.center.y}" r="${basket.rimRadius}"/><path class="court-line" d="${COURT_MARKING_PATHS.net}"/>`;
  return `${court}<g>${routes}</g>${gateMarkup}${defenders}${players}${ball}`;
}

function wrappedSvgText(value: string, maxCharacters: number) {
  const words = value.trim().split(/\s+/).filter(Boolean), lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxCharacters && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function svgTextLines(value: string, x: number, y: number, maxCharacters: number, className: string, lineHeight = 26, anchor = "start") {
  const lines = wrappedSvgText(value, maxCharacters);
  return `<text class="${className}" x="${x}" y="${y}" text-anchor="${anchor}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function annotationMarkup(mark: ExportMark) {
  const points = mark.points.map(courtPointToSvg), first = points[0], last = points.at(-1) ?? first;
  if (!first) return "";
  const label = mark.text ? svgTextLines(mark.text.slice(0, 160), first.x + 20, first.y - 16, 30, "mark-label", 24) : "";
  if (mark.kind === "circle") return `<circle class="mark" cx="${first.x}" cy="${first.y}" r="${Math.max(10, Math.hypot(last.x - first.x, last.y - first.y))}"/>${label}`;
  if (mark.kind === "spotlight") return `<rect class="mark spotlight" x="${Math.min(first.x, last.x)}" y="${Math.min(first.y, last.y)}" width="${Math.max(2, Math.abs(last.x - first.x))}" height="${Math.max(2, Math.abs(last.y - first.y))}" rx="5"/>${label}`;
  if (mark.kind === "attention-line" || mark.kind === "freehand") return `<path class="mark ${mark.kind}" d="M${points.map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" L")}"/>${label}`;
  if (mark.kind === "callout") return `<g class="callout"><circle cx="${first.x}" cy="${first.y}" r="19"/><text x="${first.x}" y="${first.y + 1}">${mark.number ?? "!"}</text></g>${label}`;
  return `<text class="mark-label" x="${first.x}" y="${first.y}">${escapeXml(mark.text ?? "")}</text>`;
}

export function frameSvg(item: ExportFrame, visibility: ArrowVisibility, options: { notes?: string; marks?: ExportMark[]; atMs?: number; replayEnded?: boolean; comparisonEnded?: boolean; theme?: ExportTheme; spacingGates?: SpacingGate[]; showSpacingGates?: boolean; frameLabel?: string; comparisonLabel?: string; focus?: ExportFocus } = {}) {
  const width = item.comparison ? COURT_VIEWBOX.width * 2 : COURT_VIEWBOX.width;
  const height = COURT_VIEWBOX.height;
  const compare = item.comparison ? `<g transform="translate(${COURT_VIEWBOX.width} 0)">${courtContents(item.comparison, visibility, options.spacingGates, options.showSpacingGates)}</g>` : "";
  const noteText = options.notes?.trim().slice(0, 300) ?? "";
  const noteLines = wrappedSvgText(noteText, 66);
  const note = noteLines.length ? svgTextLines(noteText, width / 2, height - 22 - (noteLines.length - 1) * 25, 66, "note", 25, "middle") : "";
  const atMs = options.atMs ?? item.atMs;
  const marks = (options.marks ?? []).filter((mark) => mark.points.length && mark.startMs <= atMs && mark.endMs >= atMs).map(annotationMarkup).join("");
  const comparisonMarks = item.comparison ? `<g transform="translate(${COURT_VIEWBOX.width} 0)">${marks}</g>` : "";
  const elapsed = (atMs / 1000).toFixed(2);
  const light = options.theme === "light";
  const background = light ? "#eee9df" : "#111617", floor = light ? "#d6d0c5" : "#111617";
  const line = light ? "#34413e" : "#d8d3c8", text = light ? "#17201f" : "#fff", playerFill = light ? "#df6332" : "#f07a43";
  const primaryEnded = options.replayEnded || item.replayEnded;
  const comparisonEnded = options.comparisonEnded || item.comparisonEnded;
  const safeLabel = (value: string | undefined) => value ? `<text x="20" y="58" fill="${text}" font="700 17px sans-serif">${escapeXml(value.slice(0, 80))}</text>` : "";
  const replayLabels = `${safeLabel(options.frameLabel)}${comparisonEnded ? `<text x="${COURT_VIEWBOX.width + 20}" y="80" fill="${text}" font="700 16px sans-serif">Replay ended</text>` : ""}${options.comparisonLabel ? `<text x="${COURT_VIEWBOX.width + 20}" y="58" fill="${text}" font="700 17px sans-serif">${escapeXml(options.comparisonLabel.slice(0, 80))}</text>` : ""}${primaryEnded ? `<text x="20" y="80" fill="${text}" font="700 16px sans-serif">Replay ended</text>` : ""}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="export-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#f07a43"/></marker></defs><style>.floor{fill:${floor}}.court-line{fill:none;stroke:${line};stroke-width:3}.court-dash{fill:none;stroke:${light ? "#65706a" : "#919893"};stroke-width:2;stroke-dasharray:9 10}.basket-mark{fill:none;stroke:${line};stroke-width:3}.route{fill:none;stroke:#f07a43;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.route.adjustment{stroke:${light ? "#5d6964" : "#b7bdb8"};stroke-dasharray:8 10}.route.focus{stroke:#ffb12e;stroke-width:8}.player circle{fill:${playerFill};stroke:${light ? "#fff" : "#fff2ea"};stroke-width:3}.player.handler circle{stroke:${text};stroke-width:6}.player.focus circle{stroke:#ffb12e;stroke-width:7}.player text,.defender text{fill:#fff;font:700 20px sans-serif;text-anchor:middle;dominant-baseline:central}.defender circle{fill:${light ? "#dcecf4" : "#17232a"};stroke:#3b9ac4;stroke-width:4}.defender.focus circle{stroke:#ffb12e;stroke-width:7}.ball{fill:#f07a43;stroke:#fff2ea;stroke-width:3}.mark{fill:none;stroke:#ffb12e;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.mark.spotlight{fill:#ffb12e20;stroke-dasharray:10 7}.mark.attention-line{stroke-dasharray:12 9}.callout circle{fill:#f07a43;stroke:white;stroke-width:3}.callout text{fill:white;font:800 18px sans-serif;text-anchor:middle;dominant-baseline:central}.mark-label{fill:${text};stroke:${background};stroke-width:5;paint-order:stroke;stroke-linejoin:round;font:700 22px sans-serif}.note{fill:${text};stroke:${background};stroke-width:6;paint-order:stroke;font:700 22px sans-serif}.export-spacing-gate circle,.export-spacing-gate rect{fill:#ffb12e20;stroke:#ffb12e;stroke-width:3;stroke-dasharray:10 7}.export-spacing-gate text{fill:${text};stroke:${background};stroke-width:4;paint-order:stroke;text-anchor:middle;font:700 15px sans-serif}.export-spacing-gate .gate-instruction{font-size:12px;font-weight:600}.export-spacing-gate .gate-status{font-size:13px}.replay-ended{fill:${text};background:${background};font:700 18px sans-serif}</style><rect width="100%" height="100%" fill="${background}"/>${courtContents(item.frame, visibility, options.spacingGates, options.showSpacingGates, options.focus)}${compare}${replayLabels}${marks}${comparisonMarks}${note}<text x="20" y="32" fill="${text}" font="600 17px sans-serif">${elapsed}s</text></svg>`;
}

export async function svgToCanvas(svg: string, width = 1152, height = Math.round(1152 * COURT_VIEWBOX.height / COURT_VIEWBOX.width)) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("The court frame could not be rendered")); image.src = url; });
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas export is unavailable in this browser");
    context.fillStyle = "#111617"; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

export function canvasBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The browser could not create this export")), type, quality));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function concat(chunks: Uint8Array[]) { const size = chunks.reduce((total, chunk) => total + chunk.length, 0); const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out; }

export async function createPdf(images: Blob[], signal?: AbortSignal) {
  const encoder = new TextEncoder(), objects: Uint8Array[] = [];
  const add = (value: string | Uint8Array) => objects.push(typeof value === "string" ? encoder.encode(value) : value);
  const jpegImages: Array<{ data: Uint8Array; width: number; height: number }> = [];
  let bufferedJpegBytes = 0;
  for (const image of images) {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d"); if (!context) { bitmap.close(); throw new Error("PDF conversion is unavailable"); }
    context.drawImage(bitmap, 0, 0); const width = bitmap.width, height = bitmap.height; bitmap.close();
    const data = new Uint8Array(await (await canvasBlob(canvas, "image/jpeg", .88)).arrayBuffer());
    bufferedJpegBytes += data.length;
    if (bufferedJpegBytes > MAX_EXPORT_BYTES) throw new Error("The PDF exceeds the 256 MiB safety limit · Reduce the frame rate or range");
    jpegImages.push({ data, width, height });
    canvas.width = 0; canvas.height = 0;
  }
  const totalObjects = 2 + jpegImages.length * 3;
  add("%PDF-1.4\n%âãÏÓ\n");
  const offsets: number[] = [0]; let byteOffset = objects[0].length;
  const object = (id: number, bytes: Uint8Array) => { offsets[id] = byteOffset; const start = encoder.encode(`${id} 0 obj\n`), end = encoder.encode("\nendobj\n"); add(concat([start, bytes, end])); byteOffset += start.length + bytes.length + end.length; };
  object(1, encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"));
  const kids = jpegImages.map((_, index) => `${3 + index * 3} 0 R`).join(" "); object(2, encoder.encode(`<< /Type /Pages /Count ${jpegImages.length} /Kids [${kids}] >>`));
  jpegImages.forEach(({ data: jpeg, width: imageWidth, height: imageHeight }, index) => {
    const pageId = 3 + index * 3, contentId = pageId + 1, imageId = pageId + 2;
    object(pageId, encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    const pageWidth = 560, pageHeight = pageWidth * imageHeight / imageWidth;
    const commands = encoder.encode(`q\n${pageWidth} 0 0 ${pageHeight} 26 ${(792 - pageHeight) / 2} cm\n/Im${index} Do\nQ\n`);
    object(contentId, concat([encoder.encode(`<< /Length ${commands.length} >>\nstream\n`), commands, encoder.encode("endstream")]));
    object(imageId, concat([encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, encoder.encode("\nendstream")]));
  });
  let output = concat(objects); const xrefOffset = output.length;
  const xref = ["xref\n", `0 ${totalObjects + 1}\n`, "0000000000 65535 f \n", ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`), `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`].join("");
  output = concat([output, encoder.encode(xref)]);
  if (output.length > MAX_EXPORT_BYTES) throw new Error("The PDF exceeds the 256 MiB safety limit · Reduce the frame rate or range");
  return new Blob([output], { type: "application/pdf" });
}

const crcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(data: Uint8Array) { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zipHeader(size: number) { const header = new Uint8Array(size), view = new DataView(header.buffer); return { header, view }; }
export async function createImageZip(entries: Array<{ name: string; blob: Blob }>, indexText: string, signal?: AbortSignal, indexName = "index.txt") {
  const encoder = new TextEncoder(), locals: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  const files = [...entries, { name: indexName, blob: new Blob([indexText], { type: "text/plain" }) }];
  if (files.length > 5401) throw new Error("This image folder contains too many frames · Reduce the range or sampling rate");
  for (const file of files) {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    const name = encoder.encode(file.name), data = new Uint8Array(await file.blob.arrayBuffer()), crc = crc32(data);
    if (offset + data.length + name.length + 100 > MAX_EXPORT_BYTES) throw new Error("The image folder exceeds the 256 MiB safety limit · Reduce the frame rate or range");
    const { header, view } = zipHeader(30 + name.length); view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true); view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, name.length, true); header.set(name, 30);
    locals.push(header, data);
    const { header: dir, view: directory } = zipHeader(46 + name.length); directory.setUint32(0, 0x02014b50, true); directory.setUint16(4, 20, true); directory.setUint16(6, 20, true); directory.setUint16(8, 0x0800, true); directory.setUint32(16, crc, true); directory.setUint32(20, data.length, true); directory.setUint32(24, data.length, true); directory.setUint16(28, name.length, true); directory.setUint32(42, offset, true); dir.set(name, 46); central.push(dir); offset += header.length + data.length;
  }
  const centralBytes = concat(central), { header: end, view } = zipHeader(22); view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true); view.setUint32(12, centralBytes.length, true); view.setUint32(16, offset, true);
  const output = concat([...locals, centralBytes, end]);
  if (output.length > MAX_EXPORT_BYTES) throw new Error("The image folder exceeds the 256 MiB safety limit · Reduce the frame rate or range");
  return new Blob([output], { type: "application/zip" });
}
