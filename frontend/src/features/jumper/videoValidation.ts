/** Export checks are about media integrity, never segmentation accuracy. */
export const BLOCK = 8;
export const CHROMA_TOLERANCE = 8;
export const LUMA_TOLERANCE = 16;
export type ExportGeometry = { width: number; height: number; count: number };
export function validateGeometry({ width, height, count }: ExportGeometry) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 1280 ||
    height > 720 ||
    width % 2 ||
    height % 2 ||
    !Number.isInteger(count) ||
    count < 2 ||
    count > 450
  )
    throw Error("Invalid finished-video geometry or frame count");
}
export function validateComposite(
  pixels: Uint8ClampedArray,
  owners: Uint8Array,
  target: number,
  kind: "quiz" | "highlight" | "reveal",
) {
  if (pixels.length !== owners.length * 4)
    throw Error("Invalid output frame size");
  for (let i = 0; i < owners.length; i++) {
    const at = i * 4;
    if (pixels[at + 3] !== 255) throw Error("Output frame must be opaque");
    if (
      owners[i] &&
      (kind === "reveal" || (kind === "highlight" && owners[i] === target))
    )
      continue;
    const expected = !owners[i]
      ? 224
      : kind === "quiz" && owners[i] === target
        ? 0
        : 128;
    if (
      pixels[at] !== expected ||
      pixels[at + 1] !== expected ||
      pixels[at + 2] !== expected
    )
      throw Error("Output frame contains an incorrect silhouette color");
  }
}
/** Uniform 8px blocks plus a 2px guard exclude lossy silhouette edges.
 * At most 6.2 MiB for an entire 720p/15s job; no source pixels are retained. */
export function silhouetteProof(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const columns = Math.ceil(width / BLOCK),
    rows = Math.ceil(height / BLOCK);
  const proof = new Uint8Array(columns * rows).fill(255);
  for (let by = 0; by < rows; by++)
    for (let bx = 0; bx < columns; bx++) {
      const x0 = bx * BLOCK,
        y0 = by * BLOCK;
      const value = pixels[(y0 * width + x0) * 4];
      let same = true;
      for (
        let y = Math.max(0, y0 - 2);
        same && y < Math.min(height, y0 + BLOCK + 2);
        y++
      )
        for (
          let x = Math.max(0, x0 - 2);
          x < Math.min(width, x0 + BLOCK + 2);
          x++
        )
          if (pixels[(y * width + x) * 4] !== value) {
            same = false;
            break;
          }
      if (same) proof[by * columns + bx] = value;
    }
  return proof;
}
export function validateDecodedPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  proof: Uint8Array,
) {
  const columns = Math.ceil(width / BLOCK);
  if (
    pixels.length !== width * height * 4 ||
    proof.length !== columns * Math.ceil(height / BLOCK)
  )
    throw Error("Invalid decoded output size");
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const lo = Math.min(pixels[at], pixels[at + 1], pixels[at + 2]);
      const hi = Math.max(pixels[at], pixels[at + 1], pixels[at + 2]);
      const expected =
        proof[Math.floor(y / BLOCK) * columns + Math.floor(x / BLOCK)];
      if (
        hi - lo > CHROMA_TOLERANCE ||
        (expected !== 255 &&
          Math.max(Math.abs(hi - expected), Math.abs(lo - expected)) >
            LUMA_TOLERANCE)
      )
        throw Error("Encoded video changed the silhouette colors");
    }
}

/** Imported neutral videos have no original mask proof. Check grayscale and
 * palette interiors, allowing compression edges; identity still needs review. */
export function validateNeutralPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (pixels.length !== width * height * 4)
    throw Error("Invalid decoded output size");
  const quantized = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const lo = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
    // Nearest palette value; ties select the lower value on both targets.
    const value = lo <= 64 ? 0 : lo <= 176 ? 128 : 224;
    quantized[i] = quantized[i + 1] = quantized[i + 2] = value;
    quantized[i + 3] = 255;
  }
  validateDecodedPixels(
    pixels,
    width,
    height,
    silhouetteProof(quantized, width, height),
  );
}
export function validateFrameTime(
  index: number,
  timestamp: number,
  duration: number,
) {
  // MP4/WebM timebases quantize 1/30s; allow 2ms, not a missing/duplicated frame.
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(duration) ||
    Math.abs(timestamp - index / 30) > 0.002 ||
    Math.abs(duration - 1 / 30) > 0.002
  )
    throw Error("Encoded video has an incorrect frame timeline");
}
