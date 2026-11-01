/** Bounded, job-private evidence from intended output pixels; never source colors.
 * Separate narrow extrema (hands/arms/gaps) from ordinary high-contrast edges so
 * a large body perimeter cannot hide the loss of a small feature. */
export type DetailProof = { thin: Uint32Array; edge: Uint32Array };
export class SilhouetteCompressionError extends Error {
  constructor() {
    super(
      "Compression damaged silhouette details · Try a shorter or lower-resolution clip if higher-quality export also fails",
    );
    this.name = "SilhouetteCompressionError";
  }
}
const LIMIT = 1024;
export function detailProof(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): DetailProof {
  if (pixels.length !== width * height * 4)
    throw Error("Invalid detail-proof frame");
  function kind(i: number, x: number, y: number) {
    const v = pixels[i * 4];
    const l = pixels[(i - (x > 0 ? 1 : 0)) * 4],
      r = pixels[(i + (x + 1 < width ? 1 : 0)) * 4];
    const u = pixels[(i - (y > 0 ? width : 0)) * 4],
      d = pixels[(i + (y + 1 < height ? width : 0)) * 4];
    if (
      Math.max(
        Math.abs(v - l),
        Math.abs(v - r),
        Math.abs(v - u),
        Math.abs(v - d),
      ) < 24
    )
      return 0;
    const a = pixels[(i - Math.min(2, x)) * 4],
      b = pixels[(i + Math.min(2, width - 1 - x)) * 4];
    const c = pixels[(i - Math.min(2, y) * width) * 4],
      e = pixels[(i + Math.min(2, height - 1 - y) * width) * 4];
    return v <= Math.min(a, b) - 24 ||
      v >= Math.max(a, b) + 24 ||
      v <= Math.min(c, e) - 24 ||
      v >= Math.max(c, e) + 24
      ? 1
      : 2;
  }
  const counts = [0, 0, 0];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) counts[kind(y * width + x, x, y)]++;
  const stride = counts.map((count) => Math.max(1, Math.ceil(count / LIMIT)));
  const thin = new Uint32Array(Math.ceil(counts[1] / stride[1])),
    edge = new Uint32Array(Math.ceil(counts[2] / stride[2]));
  const seen = [0, 0, 0],
    used = [0, 0, 0];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        k = kind(i, x, y);
      if (k && seen[k]++ % stride[k] === 0)
        (k === 1 ? thin : edge)[used[k]++] = i * 256 + pixels[i * 4];
    }
  return { thin, edge };
}
export function validateDetailPixels(
  pixels: Uint8ClampedArray,
  proof: DetailProof,
) {
  for (const points of [proof.thin, proof.edge]) {
    let damaged = 0;
    for (const packed of points) {
      const i = Math.floor(packed / 256) * 4,
        expected = packed & 255;
      if (i + 2 >= pixels.length) throw Error("Invalid detail-proof sample");
      const decoded = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      if (Math.abs(decoded - expected) > 40) damaged++;
    }
    if (damaged >= 3 && damaged / points.length > 0.02)
      throw new SilhouetteCompressionError();
  }
}
/** One quality retry only. Cancellation, codec, storage and integrity errors
 * remain errors; this never calls inference or silently accepts a bad result. */
export async function withCompressionRetry<T>(
  run: (highQuality: boolean) => Promise<T>,
  retrying: () => void = () => {},
): Promise<T> {
  try {
    return await run(false);
  } catch (error) {
    if (!(error instanceof SilhouetteCompressionError)) throw error;
    retrying();
    return run(true);
  }
}
