import { renderToStaticMarkup } from "react-dom/server";
import { FloorScene } from "./FloorScene";
import { align, measure } from "./geometry.ts";
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
export async function exportPng(p: FloorProject, blob: Blob, check: boolean) {
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(Error("Could not read current image"));
    r.readAsDataURL(blob);
  });
  const alignment = align(p.anchors, p.reviewed),
    width = 1800,
    left = 1050,
    right = width - left - 60,
    photoH = Math.min(900, (left * p.height) / p.width),
    height = Math.ceil(
      Math.max(photoH, (right * 51) / 54) +
        250 +
        p.measurements.length * 22 +
        (p.attribution ? 50 : 0),
    );
  const scene = (view: "photo" | "court", x: number, w: number, h: number) =>
    renderToStaticMarkup(
      <FloorScene
        project={p}
        alignment={alignment}
        imageUrl={data}
        view={view}
        check={check}
      />,
    )
      .replace("<svg ", `<svg x="${x}" y="115" width="${w}" height="${h}" `)
      .replace(/style="[^"]*"/g, "");
  const notes = p.measurements
    .map((m, i) => {
      const r = measure(p, alignment, m.a, m.b);
      return `<text x="30" y="${Math.max(photoH, (right * 51) / 54) + 180 + i * 22}" fill="#d4dcdd" font-size="16">${escape(r.value === undefined ? `Measurement ${i + 1} withheld · ${r.reason}` : `Approx ${r.value.toFixed(1)} ${p.units} · Estimated range ${r.low!.toFixed(1)}–${r.high!.toFixed(1)} ${p.units}`)}</text>`;
    })
    .join("");
  const attribution = p.attribution
    ? `${p.attribution.title} · ${p.attribution.creator} · ${p.attribution.license} · ${p.attribution.url}`
    : "Your private photograph";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Arial,sans-serif"><rect width="100%" height="100%" fill="#101516"/><text x="30" y="40" font-size="28" fill="#f8f5ee">Freeze Floor · ${escape(p.name)}</text><text x="30" y="72" font-size="16" fill="#b3bdbe">NBA half-court · ${escape(alignment.reason)}</text><text x="30" y="102" font-size="16" fill="white">Photograph${p.videoFrame ? ` · Video still ${videoTime(p.videoFrame.seconds)}` : ""}</text><text x="${left + 45}" y="102" font-size="16" fill="white">Overhead court</text>${scene("photo", 30, Math.min(left, (photoH * p.width) / p.height), photoH)}${scene("court", left + 45, right, (right * 51) / 54)}${notes}<text x="30" y="${height - 67}" font-size="14" fill="#b3bdbe">Estimated sensitivity ranges are not calibrated confidence intervals · Hidden or airborne feet remain uncertain</text><foreignObject x="30" y="${height - 48}" width="1740" height="45"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#b3bdbe;font:12px Arial">${escape(attribution)}</div></foreignObject></svg>`;
  // foreignObject is blocked by some image decoders, so keep attribution as wrapped SVG text.
  const clean = svg.replace(
    /<foreignObject[\s\S]*?<\/foreignObject>/,
    `<text x="30" y="${height - 28}" font-size="11" fill="#b3bdbe">${escape(attribution.slice(0, 240))}</text>`,
  );
  const url = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("PNG canvas unavailable");
    ctx.drawImage(img, 0, 0);
    const result = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(Error("PNG encoding failed"))),
        "image/png",
      ),
    );
    const output = URL.createObjectURL(result),
      a = document.createElement("a");
    a.href = output;
    a.download = `freeze-floor-${p.name.replace(/[^a-z0-9-]/gi, "-").slice(0, 50)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(output), 30000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
