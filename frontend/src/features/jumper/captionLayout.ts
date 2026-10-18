import type { Caption } from "./editProject";

export const captionPositions = ["top", "center", "bottom"] as const;

/** Shared by the renderer and preview hit targets, in intrinsic video pixels. */
export function captionLayout(
  context: { font: string; measureText: (text: string) => { width: number } },
  width: number,
  height: number,
  caption: Caption,
) {
  const size = Math.max(
    10,
    Math.round(
      height * { small: 0.045, medium: 0.065, large: 0.09 }[caption.size],
    ),
  );
  const font = `600 ${size}px JumperCaption, monospace`;
  context.font = font;
  const lines: string[] = [];
  let line = "";
  for (const char of caption.text.replace(/[\r\n]+/g, " ")) {
    if (line && context.measureText(line + char).width > width * 0.88) {
      lines.push(line);
      line = char;
    } else line += char;
  }
  if (line) lines.push(line);
  const lineHeight = size * 1.25,
    boxHeight = lineHeight * lines.length + size * 0.5;
  const centers = {
    top: boxHeight / 2 + height * 0.04,
    center: height / 2,
    bottom: height - boxHeight / 2 - height * 0.04,
  };
  const cy = centers[caption.position];
  return {
    font,
    lines,
    lineHeight,
    boxHeight,
    centers,
    cy,
    x: width * 0.04,
    y: cy - boxHeight / 2,
    width: width * 0.92,
  };
}

export function snapCaptionPosition(
  y: number,
  centers: Record<Caption["position"], number>,
): Caption["position"] {
  return captionPositions.reduce((best, position) =>
    Math.abs(centers[position] - y) < Math.abs(centers[best] - y)
      ? position
      : best,
  );
}
