import { editFrame, type EditProject } from "./editProject";
import { framingRect } from "./framingGeometry";
import { captionLayout } from "./captionLayout";
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
    crop = framingRect(state.framing);
  context.save();
  context.globalAlpha = 1;
  context.fillStyle = "rgb(224,224,224)";
  context.fillRect(0, 0, width, height);
  const sw = width * crop.width,
    sh = height * crop.height;
  context.globalAlpha = state.opacity;
  context.drawImage(
    image,
    width * crop.left,
    height * crop.top,
    sw,
    sh,
    0,
    0,
    width,
    height,
  );
  for (const caption of state.captions) {
    const {
      font,
      lines,
      lineHeight,
      baselineOffset,
      boxHeight,
      cy,
      safe,
      x: left,
      width: boxWidth,
    } = captionLayout(context, width, height, caption);
    context.save();
    context.beginPath();
    context.rect(safe.x, safe.y, safe.width, safe.height);
    context.clip();
    context.font = font;
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    context.fillStyle = "black";
    context.fillRect(left, cy - boxHeight / 2, boxWidth, boxHeight);
    context.fillStyle = "white";
    lines.forEach((text, i) =>
      context.fillText(
        text,
        width / 2,
        cy + (i - (lines.length - 1) / 2) * lineHeight + baselineOffset,
      ),
    );
    context.restore();
  }
  context.restore();
}
