import type { Caption } from "./editProject";

export const captionPositions = ["top", "center", "bottom"] as const;

/** Greedy word wrapping; only overlong words are split, without losing text. */
export function wrapCaption(
  text: string,
  measure: (text: string) => number,
  maxWidth: number,
) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/u).filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word;
    if (measure(joined) <= maxWidth) {
      line = joined;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    for (const char of word) {
      if (line && measure(line + char) > maxWidth) {
        lines.push(line);
        line = char;
      } else line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Shared by preview, hit targets, and browser export, in intrinsic video pixels. */
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
  const safe = {
    x: width * 0.04,
    y: height * 0.04,
    width: width * 0.92,
    height: height * 0.92,
  };
  const textWidth = width * 0.88;
  const lines = wrapCaption(
    caption.text,
    (text) => context.measureText(text).width,
    textWidth,
  );
  const lineHeight = size * 1.25,
    boxHeight = lineHeight * lines.length + size * 0.5;
  const fits =
    boxHeight <= safe.height &&
    lines.every((line) => context.measureText(line).width <= textWidth);
  // Oversized text stays inside the editor's clipped guide until corrected.
  const centers = {
    top: safe.y + boxHeight / 2,
    center: height / 2,
    bottom: height - safe.y - boxHeight / 2,
  };
  const cy = centers[caption.position];
  return {
    font,
    lines,
    lineHeight,
    baselineOffset: size * 0.3,
    boxHeight,
    centers,
    cy,
    safe,
    fits,
    x: safe.x,
    y: cy - boxHeight / 2,
    width: safe.width,
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
