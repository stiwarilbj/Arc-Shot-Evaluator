/** Narrow, source-free antialiasing. Integer weights match the native renderer.
 * One-pixel support preserves solid interiors and does not change track labels.
 * Call only after validating the opaque, label-derived neutral compositor. */
export function neutralEdges(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || pixels.length !== width * height * 4)
    throw Error("Invalid neutral-edge geometry");
  const horizontal = new Uint16Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      horizontal[i] = pixels[(y * width + Math.max(0, x - 1)) * 4] +
        6 * pixels[i * 4] + pixels[(y * width + Math.min(width - 1, x + 1)) * 4];
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const value = Math.floor((horizontal[Math.max(0, y - 1) * width + x] +
        6 * horizontal[i] + horizontal[Math.min(height - 1, y + 1) * width + x] + 32) / 64);
      pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = value;
    }
  return pixels;
}
