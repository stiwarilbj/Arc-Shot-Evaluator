import {
  validateDetailPixels,
  type DetailProof,
} from "./compressionQuality.ts";
import {
  validateBoundaryPixels,
  validateGeometry,
  validateFrameTime,
  validateDecodedPixels,
  validateNeutralPixels,
  type ExportGeometry,
} from "./videoValidation.ts";
import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  VideoSampleSink,
  Input,
  canEncodeVideo,
  CanvasSource,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  WebMOutputFormat,
} from "mediabunny";
export async function openVideo(file: Blob) {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode()))
      throw Error(
        "This video codec cannot be decoded on this device. Try an MP4 or the downloaded app.",
      );
    let origin = await track.getFirstTimestamp();
    if (origin < 0) {
      const frames = new VideoSampleSink(track).samples(0);
      try {
        const first = await frames.next();
        if (first.done) throw Error("Video has no presentable frames.");
        origin = first.value.timestamp;
        first.value.close();
      } finally { await frames.return(); }
    }
    const duration = (await track.computeDuration()) - origin;
    if (!Number.isFinite(duration) || duration <= 0)
      throw Error("The video has no usable timeline.");
    return { input, track, duration, origin };
  } catch (error) {
    input.dispose();
    throw error;
  }
}
export async function preview(
  file: Blob,
  time: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const { input, track, origin } = await openVideo(file);
  const abort = () => input.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const sample = await new CanvasSink(track, {
      width: 960,
      fit: "contain",
    }).getCanvas(origin + time);
    if (!sample) throw Error("No frame at this timestamp");
    const canvas = sample.canvas;
    return "convertToBlob" in canvas
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value ? resolve(value) : reject(Error("Preview encoding failed")),
            "image/png",
          ),
        );
  } finally {
    signal?.removeEventListener("abort", abort);
    input.dispose();
  }
}
export async function writers(width: number, height: number) {
  const codec = (await canEncodeVideo("avc", { width, height }))
    ? "avc"
    : (await canEncodeVideo("vp9", { width, height }))
      ? "vp9"
      : (await canEncodeVideo("vp8", { width, height }))
        ? "vp8"
        : null;
  if (!codec)
    throw Error("Video export is unsupported here. Use the downloaded app.");
  const mime = codec === "avc" ? "video/mp4" : "video/webm";
  const create = async (highQuality = false) => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("Could not create output canvas");
    const target = new BufferTarget();
    const output = new Output({
      target,
      format:
        codec === "avc"
          ? new Mp4OutputFormat({ fastStart: "in-memory" })
          : new WebMOutputFormat(),
    });
    const source = new CanvasSource(canvas, {
      codec,
      bitrate: highQuality ? 8_000_000 : 2_500_000,
    });
    output.addVideoTrack(source, { frameRate: 30 });
    await output.start();
    let finalized = false;
    return {
      get finalized() {
        return finalized;
      },
      canvas,
      context,
      source,
      output,
      async finish() {
        source.close();
        await output.finalize();
        finalized = true;
        if (!target.buffer) throw Error("Export produced no video");
        return new Blob([target.buffer], { type: mime });
      },
    };
  };
  return { mime, create };
}
export function compositePixels(
  source: Uint8ClampedArray,
  owners: Uint8Array,
  target: number,
  kind: "highlight" | "quiz" | "reveal",
) {
  if (source.length !== owners.length * 4)
    throw Error("Invalid source frame size");
  if (kind === "quiz") return silhouettePixels(owners, target);
  const result = new Uint8ClampedArray(source.length);
  for (let i = 0; i < owners.length; i++) {
    const at = i * 4;
    const original =
      owners[i] !== 0 &&
      (kind === "reveal" || (kind === "highlight" && owners[i] === target));
    const neutral = owners[i] === 0 ? 224 : 128;
    for (let c = 0; c < 3; c++)
      result[at + c] = original ? source[at + c] : neutral;
    result[at + 3] = 255;
  }
  return result;
}

/** Finished personal videos have no dependency on original image pixels. */
export function silhouettePixels(
  owners: Uint8Array,
  target: number,
  palette = false,
  shades?: Uint8Array,
) {
  if (!Number.isInteger(target) || target < 1 || target > 255)
    throw Error("Invalid target identity");
  const result = new Uint8ClampedArray(owners.length * 4);
  for (let i = 0; i < owners.length; i++) {
    const at = i * 4;
    const value =
      owners[i] === 0
        ? 224
        : owners[i] === target
          ? 0
          : palette
            ? (shades?.[owners[i]] ?? 64 + (((owners[i] - 1) * 47) % 137))
            : 128;
    result[at] = result[at + 1] = result[at + 2] = value;
    result[at + 3] = 255;
  }
  return result;
}

/** Decode every exported sample before the worker may announce readiness. */
export async function validateFinishedVideo(
  blob: Blob,
  geometry: ExportGeometry,
  proofs?: readonly Uint8Array[],
  neutral = false,
  profile: "legacy" | "palette" | "edited" = "legacy",
  details?: readonly DetailProof[],
  boundaries?: readonly Uint8Array[],
) {
  if (boundaries && boundaries.length !== 2)
    throw Error("Missing timeline boundary checks");
  validateGeometry(geometry, profile === "edited");
  if (proofs && proofs.length !== geometry.count)
    throw Error("Missing output color checks");
  if (blob.size > 100 * 1024 * 1024)
    throw Error("Finished video exceeds the 100 MB limit");
  if (details && details.length !== geometry.count)
    throw Error("Missing output detail checks");
  const { input, track, duration } = await openVideo(blob);
  try {
    if (
      (await input.getVideoTracks()).length !== 1 ||
      (await input.getAudioTracks()).length !== 0
    )
      throw Error("Export must contain one video track and no audio");
    if (
      (await track.getRotation()) !== 0 ||
      (await track.getFlip()) ||
      (await track.getDisplayWidth()) !== geometry.width ||
      (await track.getDisplayHeight()) !== geometry.height ||
      (await track.getCodedWidth()) !== geometry.width ||
      (await track.getCodedHeight()) !== geometry.height
    )
      throw Error("Export dimensions or orientation changed");
    if (Math.abs(duration - geometry.count / 30) > 0.002)
      throw Error("Export duration changed");
    let index = 0;
    for await (const sample of new CanvasSink(track, {
      poolSize: 2,
    }).canvases()) {
      if (index >= geometry.count) throw Error("Export contains extra frames");
      validateFrameTime(index, sample.timestamp, sample.duration);
      if (
        sample.canvas.width !== geometry.width ||
        sample.canvas.height !== geometry.height
      )
        throw Error("Decoded frame dimensions changed");
      if (proofs || neutral || details || boundaries) {
        const context = sample.canvas.getContext("2d", {
          willReadFrequently: true,
        });
        if (!context) throw Error("Cannot inspect finished video");
        const pixels = context.getImageData(
          0,
          0,
          geometry.width,
          geometry.height,
        ).data;
        if (details) validateDetailPixels(pixels, details[index]);
        if (boundaries && (index === 0 || index === geometry.count - 1))
          validateBoundaryPixels(
            pixels, geometry.width, geometry.height,
            boundaries[index === 0 ? 0 : 1], index === 0 ? "first" : "last",
          );
        if (proofs)
          validateDecodedPixels(
            pixels,
            geometry.width,
            geometry.height,
            proofs[index],
          );
        else if (neutral && profile === "legacy")
          validateNeutralPixels(pixels, geometry.width, geometry.height);
        else if (neutral) {
          for (let i = 0; i < pixels.length; i += 4)
            if (
              Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) -
                Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >
              8
            )
              throw Error("Edited video contains original colors");
        }
      }
      index++;
    }
    if (index !== geometry.count)
      throw Error("Export contains missing or undecodable frames");
  } finally {
    input.dispose();
  }
}
