/// <reference lib="webworker" />
import * as ort from "onnxruntime-web/webgpu";
import ortModule from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { MAX_BYTES } from "./domain";
import { openVideo } from "./media";
import { CanvasSink } from "mediabunny";
import { createPersonDetector } from "./personDetector";
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm, mjs: ortModule };
self.onmessage = async ({ data }) => {
  let input: Awaited<ReturnType<typeof openVideo>> | undefined;
  let detector: Awaited<ReturnType<typeof createPersonDetector>> | undefined;
  try {
    if (
      !(data?.file instanceof Blob) ||
      !data.file.size ||
      data.file.size > MAX_BYTES ||
      !Number.isFinite(data.time) ||
      data.time < 0
    )
      throw Error("Invalid detection request");
    input = await openVideo(data.file);
    const sample = await new CanvasSink(input.track, { poolSize: 1 }).getCanvas(
      data.time,
    );
    if (!sample) throw Error("No decodable starting frame");
    detector = await createPersonDetector();
    self.postMessage({ boxes: await detector.detect(sample.canvas) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  } finally {
    input?.input.dispose();
    try {
      await detector?.release();
    } catch {}
  }
};
