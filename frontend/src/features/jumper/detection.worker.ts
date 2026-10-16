/// <reference lib="webworker" />
import * as ort from "onnxruntime-web/webgpu";
import ortModule from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { openVideo } from "./media";
import { CanvasSink } from "mediabunny";
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm, mjs: ortModule };
self.onmessage = async ({ data }) => {
  let session: ort.InferenceSession | undefined;
  let input: Awaited<ReturnType<typeof openVideo>> | undefined;
  try {
    if (
      !(data.file instanceof Blob) ||
      !Number.isFinite(data.time) ||
      data.time < 0
    )
      throw Error("Invalid detection request");
    input = await openVideo(data.file);
    const frame = await new CanvasSink(input.track, {
      width: 640,
      height: 640,
      fit: "contain",
    }).getCanvas(data.time);
    if (!frame) throw Error("No decodable starting frame");
    const canvas = new OffscreenCanvas(640, 640),
      ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(frame.canvas, 0, 0);
    const rgb = ctx.getImageData(0, 0, 640, 640).data,
      pixels = new Float32Array(3 * 640 * 640);
    for (let i = 0; i < 640 * 640; i++)
      for (let c = 0; c < 3; c++)
        pixels[c * 640 * 640 + i] = rgb[i * 4 + c] / 255;
    const response = await fetch(
      new URL(
        `${import.meta.env.BASE_URL}jumper/models/person-detector.onnx`,
        self.location.href,
      ),
    );
    if (!response.ok) throw Error("Person detector could not download");
    const bytes = await response.arrayBuffer();
    const sha = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (
      sha !== "ae0eb4ed805163adc419b3db5454b3dfcf8b3620148fc4e294b0a1e5cccc26d5"
    )
      throw Error("Person detector integrity check failed");
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["webgpu"],
    });
    const tensor = new ort.Tensor("float32", pixels, [1, 3, 640, 640]);
    const output = await session.run({ [session.inputNames[0]]: tensor });
    tensor.dispose();
    const value = output[session.outputNames[0]],
      values = value.data as Float32Array,
      n = value.dims[2];
    const width = input.track.displayWidth,
      height = input.track.displayHeight,
      scale = Math.min(640 / width, 640 / height),
      ox = (640 - width * scale) / 2,
      oy = (640 - height * scale) / 2;
    const candidates: { box: number[]; score: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (values[4 * n + i] < 0.25) continue;
      const x = values[i],
        y = values[n + i],
        w = values[2 * n + i],
        h = values[3 * n + i];
      const clamp = (v: number) => Math.max(0, Math.min(1, v));
      const box = [
        clamp((x - w / 2 - ox) / (width * scale)),
        clamp((y - h / 2 - oy) / (height * scale)),
        clamp((x + w / 2 - ox) / (width * scale)),
        clamp((y + h / 2 - oy) / (height * scale)),
      ];
      if (box[2] > box[0] && box[3] > box[1])
        candidates.push({ box, score: values[4 * n + i] });
    }
    candidates.sort((a, b) => b.score - a.score);
    const kept: number[][] = [];
    for (const { box } of candidates) {
      if (
        kept.some((other) => {
          const intersect =
            Math.max(
              0,
              Math.min(box[2], other[2]) - Math.max(box[0], other[0]),
            ) *
            Math.max(
              0,
              Math.min(box[3], other[3]) - Math.max(box[1], other[1]),
            );
          return (
            intersect /
              ((box[2] - box[0]) * (box[3] - box[1]) +
                (other[2] - other[0]) * (other[3] - other[1]) -
                intersect) >
            0.45
          );
        })
      )
        continue;
      kept.push(box);
      if (kept.length === 20) break;
    }
    Object.values(output).forEach((t) => t.dispose());
    self.postMessage({ boxes: kept });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    input?.input.dispose();
    await session?.release();
  }
};
