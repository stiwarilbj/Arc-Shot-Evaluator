/// <reference lib="webworker" />
import { installWorkerControl } from "./workerControl";
import { sourceFrameTime, validFrameMap, verifySourceFrame } from "./sourceFrames";
import * as ort from "onnxruntime-web/webgpu";
import ortModule from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { MAX_BYTES } from "./domain";
import { openVideo } from "./media";
import { CanvasSink } from "mediabunny";
import { createPersonDetector } from "./personDetector";
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm, mjs: ortModule };
installWorkerControl(self);
self.onmessage = async ({ data }) => {
  let input: Awaited<ReturnType<typeof openVideo>> | undefined;
  let detector: Awaited<ReturnType<typeof createPersonDetector>> | undefined;
  try {
    if (
      !(data?.file instanceof Blob) ||
      !data.file.size ||
      data.file.size > MAX_BYTES ||
      !Number.isFinite(data.time) ||
      data.time < 0 ||
      (data.frame_map !== undefined && !validFrameMap(data.frame_map))
    )
      throw Error("Invalid detection request");
    input = await openVideo(data.file);
    const sample = await new CanvasSink(input.track, { poolSize: 1 }).getCanvas(
      data.frame_map ? sourceFrameTime(data.frame_map, 0) : input.origin + data.time,
    );
    if (!sample) throw Error("No decodable starting frame");
    if (data.frame_map) verifySourceFrame(data.frame_map, 0, sample);
    detector = await createPersonDetector();
    self.postMessage({ id: data.id, boxes: await detector.detect(sample.canvas) });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  } finally {
    input?.input.dispose();
    try {
      await detector?.release();
    } catch {}
  }
};
