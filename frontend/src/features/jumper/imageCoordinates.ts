/** Prompts use normalized coordinates in the decoded, upright image, not its CSS box. */
export interface ImageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function containedImageRect(
  box: ImageRect,
  width: number,
  height: number,
): ImageRect | undefined {
  if (
    ![box.left, box.top, box.width, box.height, width, height].every(Number.isFinite) ||
    box.width <= 0 || box.height <= 0 || width <= 0 || height <= 0
  ) return;
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale, h = height * scale;
  return {
    left: box.left + (box.width - w) / 2,
    top: box.top + (box.height - h) / 2,
    width: w,
    height: h,
  };
}

export function imagePoint(
  rect: ImageRect,
  clientX: number,
  clientY: number,
): number[] | undefined {
  if (
    ![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 || rect.height <= 0
  ) return;
  const x = (clientX - rect.left) / rect.width,
    y = (clientY - rect.top) / rect.height;
  // Ignore letterbox clicks; tolerate only floating-point roundoff at image edges.
  if (x < -1e-12 || x > 1 + 1e-12 || y < -1e-12 || y > 1 + 1e-12) return;
  return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
}

export function previewImageRect(image: HTMLImageElement): ImageRect | undefined {
  const bounds = image.getBoundingClientRect(), style = getComputedStyle(image);
  const inset = (value: string) => Number.parseFloat(value) || 0;
  const horizontal = inset(style.borderLeftWidth) + inset(style.paddingLeft) +
    inset(style.borderRightWidth) + inset(style.paddingRight);
  const vertical = inset(style.borderTopWidth) + inset(style.paddingTop) +
    inset(style.borderBottomWidth) + inset(style.paddingBottom);
  // Preserve fractional layout sizes; offsetWidth/Height round to whole CSS pixels.
  const layoutWidth = inset(style.width) +
    (style.boxSizing === "border-box" ? 0 : horizontal);
  const layoutHeight = inset(style.height) +
    (style.boxSizing === "border-box" ? 0 : vertical);
  const sx = layoutWidth ? bounds.width / layoutWidth : 1;
  const sy = layoutHeight ? bounds.height / layoutHeight : 1;
  // object-fit is resolved before CSS transforms; scale its result, not its box.
  const rect = containedImageRect(
    {
      left: inset(style.borderLeftWidth) + inset(style.paddingLeft),
      top: inset(style.borderTopWidth) + inset(style.paddingTop),
      width: layoutWidth - horizontal,
      height: layoutHeight - vertical,
    },
    image.naturalWidth,
    image.naturalHeight,
  );
  if (!rect) return;
  return {
    left: bounds.left + rect.left * sx,
    top: bounds.top + rect.top * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
}
