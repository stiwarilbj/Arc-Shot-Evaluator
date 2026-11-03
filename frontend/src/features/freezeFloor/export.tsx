import { renderToStaticMarkup } from "react-dom/server";
import { FloorScene } from "./FloorScene";
import { align, measure, measurementPointSupported } from "./geometry.ts";
import type { FloorProject } from "./types.ts";
import { videoTime } from "./video.ts";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export async function exportPng(
  p: FloorProject,
  blob: Blob,
  check: boolean,
  coverage = false,
) {
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(Error("Could not read current image"));
    r.readAsDataURL(blob);
  });
  const textCanvas = document.createElement("canvas"),
    attribution = p.attribution
      ? `${p.attribution.title} · ${p.attribution.creator} · ${p.attribution.license} · ${p.attribution.url}`
      : "Your private photograph";
  let titleLines: string[], attributionLines: string[];
  try {
    const textContext = textCanvas.getContext("2d");
    if (!textContext) throw Error("PNG text layout unavailable");
    const textWidth = 1740,
      graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const wrap = (text: string, fontSize: number): string[] => {
      textContext.font = `${fontSize}px Arial,sans-serif`;
      const lines: string[] = [];
      for (const paragraph of text.split(/\r\n?|\n/u)) {
        let line = "";
        for (const word of paragraph.trim().split(/\s+/u)) {
          if (!word) continue;
          const joined = line ? `${line} ${word}` : word;
          if (textContext.measureText(joined).width <= textWidth) {
            line = joined;
            continue;
          }
          if (textContext.measureText(word).width <= textWidth) {
            if (line) lines.push(line);
            line = word;
            continue;
          }
          // Break long URLs and unspaced names without splitting Unicode glyphs
          if (line) line += " ";
          for (const { segment } of graphemes.segment(word)) {
            if (line && textContext.measureText(line + segment).width > textWidth) {
              lines.push(line.trimEnd());
              line = "";
            }
            line += segment;
          }
        }
        lines.push(line);
      }
      return lines;
    };
    titleLines = wrap(`Freeze Floor · ${p.name}`, 28);
    attributionLines = wrap(attribution, 11);
  } finally {
    textCanvas.width = 0;
    textCanvas.height = 0;
  }
  const alignment = align(p.anchors, p.reviewed),
    width = 1800,
    left = 1050,
    right = width - left - 60,
    photoH = Math.min(900, (left * p.height) / p.width),
    titleExtra = (titleLines.length - 1) * 34,
    sceneY = 115 + titleExtra,
    sceneBottom = sceneY + Math.max(photoH, (right * 51) / 54),
    notesY = sceneBottom + 65,
    disclaimerY = notesY + p.measurements.length * 22 + 30,
    attributionY = disclaimerY + 30,
    height = Math.ceil(attributionY + (attributionLines.length - 1) * 16 + 30);
  const textLines = (lines: string[], y: number, step: number) =>
    lines
      .map((line, i) => `<tspan x="30" y="${y + i * step}">${escape(line)}</tspan>`)
      .join("");
  const scene = (view: "photo" | "court", x: number, w: number, h: number) =>
    renderToStaticMarkup(
      <FloorScene
        project={p}
        alignment={alignment}
        imageUrl={data}
        view={view}
        check={check}
        measurementCoverage={coverage}
      />,
    )
      .replace("<svg ", `<svg x="${x}" y="${sceneY}" width="${w}" height="${h}" `)
      .replace(/style="[^"]*"/g, "");
  const notes = p.measurements
    .map((m, i) => {
      const r = measure(p, alignment, m.a, m.b);
      const outside = [m.a, m.b].some(
        (v) => measurementPointSupported(p, alignment, v) === false,
      );
      const reason =
        outside && r.reason !== "Outside supported region"
          ? `Outside supported region · ${r.reason}`
          : r.reason;
      return `<text x="30" y="${notesY + i * 22}" fill="#d4dcdd" font-size="16">${escape(r.value === undefined ? `Measurement ${i + 1} withheld · ${reason}` : `Approx ${r.value.toFixed(1)} ${p.units} · Estimated range ${r.low!.toFixed(1)}–${r.high!.toFixed(1)} ${p.units}`)}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Arial,sans-serif">
    <rect width="100%" height="100%" fill="#101516"/>
    <text id="ff-export-title" font-size="28" fill="#f8f5ee">${textLines(titleLines, 40, 34)}</text>
    <text x="30" y="${72 + titleExtra}" font-size="16" fill="#b3bdbe">NBA half-court · ${escape(alignment.reason)}</text>
    <text x="30" y="${102 + titleExtra}" font-size="16" fill="white">Photograph${p.videoFrame ? ` · Video still ${videoTime(p.videoFrame.seconds)}` : ""}</text>
    <text x="${left + 45}" y="${102 + titleExtra}" font-size="16" fill="white">Overhead court</text>
    ${scene("photo", 30, Math.min(left, (photoH * p.width) / p.height), photoH)}
    ${scene("court", left + 45, right, (right * 51) / 54)}
    ${notes}
    <text x="30" y="${disclaimerY}" font-size="14" fill="#b3bdbe">Estimated sensitivity ranges are not calibrated confidence intervals · Hidden or airborne feet remain uncertain</text>
    <text id="ff-export-attribution" font-size="11" fill="#b3bdbe">${textLines(attributionLines, attributionY, 16)}</text>
  </svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  let img: HTMLImageElement | undefined, canvas: HTMLCanvasElement | undefined;
  try {
    img = new Image();
    img.src = url;
    await img.decode();
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("PNG canvas unavailable");
    ctx.drawImage(img, 0, 0);
    const result = await new Promise<Blob>((resolve, reject) =>
      ctx.canvas.toBlob(
        (b) => (b ? resolve(b) : reject(Error("PNG encoding failed"))),
        "image/png",
      ),
    );
    const output = URL.createObjectURL(result);
    setTimeout(() => URL.revokeObjectURL(output), 30000);
    const a = document.createElement("a");
    a.href = output;
    a.download = `freeze-floor-${p.name.replace(/[^a-z0-9-]/gi, "-").slice(0, 50)}.png`;
    a.click();
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    img?.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
