import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
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
    const duration = await track.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0)
      throw Error("The video has no usable timeline.");
    return { input, track, duration };
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
  const { input, track } = await openVideo(file);
  const abort = () => input.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const sample = await new CanvasSink(track, {
      width: 960,
      fit: "contain",
    }).getCanvas(time);
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
  const create = async () => {
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
    const source = new CanvasSource(canvas, { codec, bitrate: 2_500_000 });
    output.addVideoTrack(source, { frameRate: 30 });
    await output.start();
    return {
      canvas,
      context,
      source,
      output,
      async finish() {
        source.close();
        await output.finalize();
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
  const result = new Uint8ClampedArray(source.length);
  for (let i = 0; i < owners.length; i++) {
    const at = i * 4;
    const original =
      owners[i] !== 0 &&
      (kind === "reveal" || (kind === "highlight" && owners[i] === target));
    const neutral =
      owners[i] === 0 ? 224 : kind === "quiz" && owners[i] === target ? 0 : 128;
    for (let c = 0; c < 3; c++)
      result[at + c] = original ? source[at + c] : neutral;
    result[at + 3] = 255;
  }
  return result;
}
