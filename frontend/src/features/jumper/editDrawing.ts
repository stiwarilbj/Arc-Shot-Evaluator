import { editFrame, type EditProject } from "./editProject";
/** Used by preview and export; only receives a decoded masked-base frame. */
export function drawEdit(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  project: EditProject,
  frame: number,
  clean = false,
) {
  const state = editFrame(project, frame, clean),
    { zoom, x, y } = state.framing;
  context.save();
  context.globalAlpha = 1;
  context.fillStyle = "rgb(224,224,224)";
  context.fillRect(0, 0, width, height);
  const sw = width / zoom,
    sh = height / zoom;
  context.globalAlpha = state.opacity;
  context.drawImage(
    image,
    x * (width - sw),
    y * (height - sh),
    sw,
    sh,
    0,
    0,
    width,
    height,
  );
  for (const caption of state.captions) {
    const size = Math.max(
      10,
      Math.round(
        height * { small: 0.045, medium: 0.065, large: 0.09 }[caption.size],
      ),
    );
    context.font = `600 ${Math.max(10, size)}px JumperCaption, monospace`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const maxWidth = width * 0.88;
    // Wrap explicitly, consistently in preview/export, instead of horizontal distortion.
    const lines: string[] = [];
    let line = "";
    for (const char of caption.text.replace(/[\r\n]+/g, " ")) {
      if (line && context.measureText(line + char).width > maxWidth) {
        lines.push(line);
        line = char;
      } else line += char;
    }
    if (line) lines.push(line);
    const lineHeight = Math.max(10, size) * 1.25,
      boxHeight = lineHeight * lines.length + size * 0.5;
    const cy =
      caption.position === "top"
        ? boxHeight / 2 + height * 0.04
        : caption.position === "bottom"
          ? height - boxHeight / 2 - height * 0.04
          : height / 2;
    context.fillStyle = "black";
    context.fillRect(width * 0.04, cy - boxHeight / 2, width * 0.92, boxHeight);
    context.fillStyle = "white";
    lines.forEach((text, i) =>
      context.fillText(
        text,
        width / 2,
        cy + (i - (lines.length - 1) / 2) * lineHeight,
      ),
    );
  }
  context.restore();
}
