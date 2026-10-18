import { validateDecoderOutputs, validateModelTensor } from "./modelOutputs";
import { detailProof, type DetailProof } from "./compressionQuality";
/// <reference lib="webworker" />
import { latestShooterAnchor, shooterAnchors } from "./trackingAnchors";
import { MaskJoins } from "./maskJoins";
import { OverlapPalette } from "./overlapPalette";
import { PaletteFrames } from "./paletteFrames";
import { neutralEdges } from "./neutralEdges";
import { CameraCuts } from "./cameraCuts";
import * as ort from "onnxruntime-web/webgpu";
import ortModule from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import {
  validateMaskRequest,
  maskingErrorMessage,
  MAX_BYTES,
  type MaskResult,
  type PointPrompt,
  type WorkerRequest,
  type WorkerResponse,
} from "./domain";
import {
  compositePixels,
  silhouettePixels,
  openVideo,
  writers,
  validateFinishedVideo,
} from "./media";
import { createPersonDetector, PERSON_DETECTOR_SHA } from "./personDetector";
import {
  FrameCache,
  validFeatures,
  validDetections,
  type CachedFeatures,
} from "./frameCache";
import { requireShooterBox, PeopleDiscovery } from "./discovery";
import {
  smallPlayerCrop,
  sourceCrop,
  acceptRefinement,
  type PlayerCrop,
} from "./smallPlayer";
import { MaskQuality } from "./maskQuality";
import {
  confirmedShooterFrame,
  trackingCheckSegments,
  ShooterTrackingCheck,
} from "./trackingCheck";
import { MaskOwnership } from "./maskOwnership";
import { checkResources, estimateResources } from "./resources";
import { ExportCheckpoint, retryExport } from "./exportCheckpoint";
import { validateComposite, silhouetteProof } from "./videoValidation";
import { samPixels } from "./preprocessing";
import { downloadProgress } from "./processingEstimate";
import {
  bilinear,
  buildBank,
  channelsFirst,
  sequenceFirst,
  type Memory,
  type TrackerWeights,
} from "./trackingMath";
const context = self as unknown as DedicatedWorkerGlobalScope;
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: ortWasm, mjs: ortModule };
const REVISION = "3cb090d9d0b4c897281fdcac7765c0f3a888c49f";
const HF = `https://huggingface.co/jax-image-tools/sam21-tiny-video-onnx/resolve/${REVISION}/`;
const LOCAL = `${import.meta.env.BASE_URL}jumper/models/`;
const ASSETS = {
  vision: {
    url: HF + "vision_encoder.onnx",
    sha: "98311f41182f40c57cac2522180fff34b53931ce981412ddd8643ec27fb830e3",
  },
  attention: {
    url: HF + "memory_attention.onnx",
    sha: "afd5045a8fe48628d4da49a82b77351a43f7554f1f101a5052ab74aae69e3737",
  },
  decoder: {
    url: LOCAL + "native_mask_decoder.onnx",
    sha: "b9ca43b2d2bd4c8db6363b555d924ff2ab1ceed400a34503ae5ffc4098abbc0a",
  },
  memory: {
    url: LOCAL + "native_memory_encoder.onnx",
    sha: "fb8951150c52c7765cededa9bf8fc1fab4d213c087b3c230f641e4f87cae6fa3",
  },
  weights: {
    url: LOCAL + "native_tracker.json",
    sha: "5cf5f2391e7a7a196ed5b15f21850d1b16c2282aae5f00179831c5b1ea61d646",
  },
};
async function checkedAsset(
  asset: { url: string; sha: string },
  progress: (done: number, fraction: number) => void,
) {
  const url = new URL(asset.url, context.location.href).href;
  let cache: Cache | undefined;
  try {
    cache = await caches.open("arc-jumper-models-v1");
  } catch {}
  let response = await cache?.match(url);
  if (!response) {
    const fetched = await fetch(url);
    if (!fetched.ok || !fetched.body)
      throw Error(`Model download failed (${fetched.status}); retry Create.`);
    const reader = fetched.body.getReader();
    const pieces: Uint8Array<ArrayBuffer>[] = [];
    const total = Number(fetched.headers.get("Content-Length") ?? 0);
    const encoding = fetched.headers.get("Content-Encoding");
    let done = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pieces.push(new Uint8Array(chunk.value));
      done += chunk.value.length;
      progress(done, downloadProgress(done, total, encoding));
    }
    response = new Response(new Blob(pieces));
  }
  const bytes = await response.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== asset.sha) {
    await cache?.delete(url);
    throw Error(
      "Model integrity check failed. Retry to download a fresh copy.",
    );
  }
  try {
    await cache?.put(url, new Response(bytes));
  } catch {
    /* Model works even when persistent cache is unavailable. */
  }
  return bytes;
}
const tensor = (values: Float32Array, dims: number[]) =>
  new ort.Tensor("float32", values, dims);
const floats = (value: ort.Tensor) =>
  Float32Array.from(value.data as Float32Array);
function dispose(values: Record<string, ort.Tensor>) {
  Object.values(values).forEach((value) => value.dispose());
}
interface Prediction {
  low: Float32Array;
  pointer: Float32Array;
  score: Float32Array;
}
async function process(
  request: WorkerRequest,
  report: (stage: string, progress: number) => void,
): Promise<MaskResult> {
  if (
    request.kind !== "process" ||
    typeof request.id !== "string" ||
    !(request.file instanceof Blob) ||
    request.file.size > MAX_BYTES
  )
    throw Error("Invalid masking request");
  validateMaskRequest(request.request);
  const opened = await openVideo(request.file);
  const input = opened.input,
    video = opened.track;
  const { start, end, target_id } = request.request;
  const objects = structuredClone(request.request.objects);
  const silhouette =
    request.request.presentation?.startsWith("silhouette") === true;
  const trackedObjects = objects.filter(
    (object) => !object.ignored || request.request.auto_detect_others,
  );
  let detector: Awaited<ReturnType<typeof createPersonDetector>> | undefined;
  if (end > opened.duration + 0.01) {
    input.dispose();
    throw Error("Trim extends beyond the video");
  }
  const width = Math.max(
    2,
    Math.floor(
      (Math.min(1, 1280 / video.displayWidth, 720 / video.displayHeight) *
        video.displayWidth) /
        2,
    ) * 2,
  );
  const height = Math.max(
    2,
    Math.floor(
      (Math.min(1, 1280 / video.displayWidth, 720 / video.displayHeight) *
        video.displayHeight) /
        2,
    ) * 2,
  );
  const count = Math.ceil((end - start) * 30);
  const anchor = request.request.verify_shooter
    ? confirmedShooterFrame(objects, target_id)
    : undefined;
  const trackingCheck =
    anchor === undefined
      ? undefined
      : new ShooterTrackingCheck(anchor, target_id);
  let trackingSummary: MaskResult["tracking_check"];
  const sessions: ort.InferenceSession[] = [];
  const outputs: Awaited<
    ReturnType<Awaited<ReturnType<typeof writers>>["create"]>
  >[] = [];
  let cache: FrameCache | undefined;
  const exportCheckpoint = new ExportCheckpoint(width, height, count, start);
  const overlapPalette = silhouette && request.request.presentation === "silhouette-palette-v1"
    ? new OverlapPalette(target_id) : undefined;
  const paletteFrames = overlapPalette ? new PaletteFrames(width * height, count) : undefined;
  let grayShades: Uint8Array | undefined;
  let encodingError: unknown;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    const gpu = adapter?.info;
    const resourceLimits = {
      deviceMemoryGB: (navigator as WorkerNavigator & { deviceMemory?: number })
        .deviceMemory,
      maxBufferSize: adapter?.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter?.limits.maxStorageBufferBindingSize,
    };
    const checkWorkload = () =>
      checkResources(
        estimateResources(
          { ...request.request, objects },
          width,
          height,
          video.displayWidth,
          video.displayHeight,
        ),
        resourceLimits,
      );
    report("Checking device resources", 0);
    checkWorkload();
    cache = await FrameCache.open(request.file, {
      schema: "sam-pixels-v1-canvas-v1",
      start,
      end,
      width,
      height,
      fps: 30,
      models: ASSETS,
      detector: PERSON_DETECTOR_SHA,
      runtime: ort.env.versions,
      execution: "webgpu-default-fp32",
      browser: navigator.userAgent,
      adapter: gpu
        ? [gpu.vendor, gpu.architecture, gpu.device, gpu.description]
        : null,
      detection: { size: 640, confidence: 0.25, iou: 0.45 },
    });
    const format = await writers(width, height);
    if (request.request.auto_detect_others) {
      report("Preparing automatic player detection", 0);
      detector = await createPersonDetector();
    }
    const sessionsByName: Record<string, ort.InferenceSession> = {};
    for (const [key, asset] of Object.entries(ASSETS)) {
      if (key === "weights") continue;
      report(`Checking cached masking model · ${key}`, 0);
      const bytes = await checkedAsset(asset, (done, fraction) =>
        report(
          `Downloading masking model · ${key} · ${(done / 1024 / 1024).toFixed(1)} MB`,
          fraction,
        ),
      );
      report(`Preparing ${key} model`, 0);
      sessionsByName[key] = await ort.InferenceSession.create(bytes, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "disabled",
      }).catch((error) => {
        throw Error(`${key}: ${String(error)}`);
      });
      sessions.push(sessionsByName[key]);
    }
    const weights: TrackerWeights = JSON.parse(
      new TextDecoder().decode(await checkedAsset(ASSETS.weights, () => {})),
    );
    const { vision, attention, decoder, memory } = sessionsByName;
    const sink = new CanvasSink(video, {
      width,
      height,
      fit: "fill",
      poolSize: 2,
    });
    const fineScale = Math.min(
      1,
      2560 / video.displayWidth,
      1440 / video.displayHeight,
    );
    const fineWidth = Math.max(
      2,
      Math.floor((video.displayWidth * fineScale) / 2) * 2,
    );
    const fineHeight = Math.max(
      2,
      Math.floor((video.displayHeight * fineScale) / 2) * 2,
    );
    const fineSink = request.request.refine_small_players
      ? new CanvasSink(video, {
          width: fineWidth,
          height: fineHeight,
          fit: "fill",
          poolSize: 1,
        })
      : undefined;
    const cropCanvas = new OffscreenCanvas(1, 1);
    const cropContext = cropCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!cropContext) throw Error("Could not initialize detail canvas");
    const sourceCanvas = new OffscreenCanvas(width, height),
      sourceContext = sourceCanvas.getContext("2d", {
        willReadFrequently: true,
      });
    if (!sourceContext) throw Error("Could not initialize masking canvas");
    const conditions = new Map<number, Map<number, Memory>>(
      trackedObjects.map((object) => [object.id, new Map()]),
    );
    const recents = new Map<number, Map<number, Memory>>(
      trackedObjects.map((object) => [object.id, new Map()]),
    );
    const corrected = new Map<number, Map<number, Prediction>>();
    async function detect(
      frame: number,
      canvas: HTMLCanvasElement | OffscreenCanvas,
    ) {
      const cached = await cache?.get<unknown>(`people:${frame}`);
      if (validDetections(cached)) return cached;
      const boxes = await detector!.detect(canvas);
      await cache?.put(`people:${frame}`, boxes, 256 + boxes.length * 32);
      return boxes;
    }
    async function features(
      frame: number,
      canvas: HTMLCanvasElement | OffscreenCanvas,
      crop?: PlayerCrop,
    ) {
      const region = crop
        ? sourceCrop(crop, width, height, fineWidth, fineHeight)
        : undefined;
      const key = region
        ? `detail-v1:${frame}:${Object.values(region).join(":")}`
        : `features:${frame}`;
      const cached = await cache?.get<unknown>(key);
      if (validFeatures(cached))
        return Object.fromEntries(
          Object.entries(cached).map(([key, item]) => [
            key,
            tensor(item.data, item.dims),
          ]),
        );
      let pixels: Float32Array;
      if (region) {
        cropCanvas.width = region.width;
        cropCanvas.height = region.height;
        cropContext!.drawImage(
          canvas,
          region.x,
          region.y,
          region.width,
          region.height,
          0,
          0,
          region.width,
          region.height,
        );
        pixels = samPixels(
          cropContext!.getImageData(0, 0, region.width, region.height).data,
          region.width,
          region.height,
        );
      } else {
        sourceContext!.drawImage(canvas, 0, 0, width, height);
        pixels = samPixels(
          sourceContext!.getImageData(0, 0, width, height).data,
          width,
          height,
        );
      }
      const value = tensor(pixels, [1, 3, 1024, 1024]);
      try {
        const result = await vision.run({ pixel_values: value }, [
          "feats0",
          "feats1",
          "feats2",
          "pos2",
        ]);
        if (
          cache &&
          (await cache.canPut(
            key,
            512 +
              Object.values(result).reduce(
                (sum, item) => sum + item.size * 4,
                0,
              ),
          ))
        ) {
          try {
            const stored: Record<string, CachedFeatures> = {};
            for (const [key, item] of Object.entries(result))
              stored[key] = {
                dims: [...item.dims],
                data: Float32Array.from((await item.getData()) as Float32Array),
              };
            await cache.put(
              key,
              stored,
              512 +
                Object.values(stored).reduce(
                  (sum, item) => sum + item.data.byteLength,
                  0,
                ),
            );
          } catch {
            /* Retain live tensors and continue without caching. */
          }
        }
        return result;
      } finally {
        value.dispose();
      }
    }
    async function predict(
      feats: Record<string, ort.Tensor>,
      conditioned: Float32Array,
      prompt?: PointPrompt,
    ): Promise<Prediction> {
      const points = [
        ...(prompt?.box
          ? [
              [prompt.box[0], prompt.box[1]],
              [prompt.box[2], prompt.box[3]],
            ]
          : []),
        ...(prompt?.points ?? []),
      ];
      const labels = [
        ...(prompt?.box ? [2, 3] : []),
        ...(prompt?.labels ?? []),
      ];
      if (!points.length) {
        points.push([0, 0]);
        labels.push(-1);
      }
      const args = {
        feats0: feats.feats0,
        feats1: feats.feats1,
        feats2: tensor(conditioned, [1, 256, 64, 64]),
        points: tensor(
          Float32Array.from(points.flat().map((value) => value * 1024)),
          [1, points.length, 2],
        ),
        labels: new ort.Tensor(
          "int64",
          BigInt64Array.from(labels.map(BigInt)),
          [1, labels.length],
        ),
      };
      let result: Record<string, ort.Tensor> | undefined;
      try {
        result = await decoder.run(args);
        validateDecoderOutputs(result);
        const quality = result.quality.data as Float32Array;
        const useMulti = points.length <= 1 && labels[0] !== 2;
        let selected = 0;
        if (useMulti) {
          selected = 1;
          for (let i = 2; i < 4; i++)
            if (quality[i] > quality[selected]) selected = i;
        }
        const masks = result.masks.data as Float32Array;
        const pointers = result.pointers.data as Float32Array;
        return {
          low: masks.slice(selected * 256 * 256, (selected + 1) * 256 * 256),
          pointer: pointers.slice(selected * 256, (selected + 1) * 256),
          score: floats(result.scores),
        };
      } finally {
        args.feats2.dispose();
        args.points.dispose();
        args.labels.dispose();
        if (result) dispose(result);
      }
    }
    async function remember(
      feats: Record<string, ort.Tensor>,
      prediction: Prediction,
      frame: number,
    ): Promise<Memory> {
      const high = tensor(
        bilinear(prediction.low, 256, 256, 1024, 1024),
        [1, 1, 1024, 1024],
      );
      const score = tensor(prediction.score, [1, 1]);
      let result: Record<string, ort.Tensor> | undefined;
      try {
        result = await memory.run({
          vision_features: feats.feats2,
          pred_masks_high_res: high,
          object_score_logits: score,
        });
        validateModelTensor(result.memory_tokens, [4096, 1, 64], "tracking memory");
        validateModelTensor(result.memory_pos_enc, [4096, 1, 64], "tracking position");
        return {
          frame,
          tokens: floats(result.memory_tokens),
          position: floats(result.memory_pos_enc),
          pointer: prediction.pointer,
        };
      } finally {
        high.dispose();
        score.dispose();
        if (result) dispose(result);
      }
    }
    async function propagate(
      feats: Record<string, ort.Tensor>,
      frame: number,
      conditionFrames: Map<number, Memory>,
      recentFrames: Map<number, Memory>,
      reverse = false,
    ): Promise<Prediction> {
      const bank = buildBank(
        frame,
        count,
        conditionFrames,
        recentFrames,
        weights,
        reverse,
      );
      const args = {
        current_vision_features: tensor(
          sequenceFirst(floats(feats.feats2)),
          [4096, 1, 256],
        ),
        current_vision_position_embeddings: tensor(
          sequenceFirst(floats(feats.pos2)),
          [4096, 1, 256],
        ),
        spatial_memory: tensor(bank.spatial, [bank.spatial.length / 64, 1, 64]),
        spatial_memory_position_embeddings: tensor(bank.positions, [
          bank.positions.length / 64,
          1,
          64,
        ]),
        pointer_memory: tensor(bank.pointerData, [
          bank.pointerData.length / 64,
          1,
          64,
        ]),
        pointer_memory_position_embeddings: tensor(bank.pointerPosition, [
          bank.pointerPosition.length / 64,
          1,
          64,
        ]),
      };
      let result: Record<string, ort.Tensor> | undefined;
      try {
        result = await attention.run(args);
        validateModelTensor(result.conditioned_features, [4096, 1, 256], "conditioned features");
        return await predict(
          feats,
          channelsFirst(floats(result.conditioned_features)),
        );
      } finally {
        dispose(args);
        if (result) dispose(result);
      }
    }
    if (detector) {
      const initial = objects.find((object) => object.id === target_id)!
        .prompts[0];
      const point = initial.points?.find((_, i) => initial.labels?.[i] === 1);
      if (initial.frame === 0 && !initial.box && point) {
        report("Detecting the selected shooter", 0);
        const sample = await sink.getCanvas(start);
        if (!sample) throw Error("Could not decode the starting frame");
        initial.box = requireShooterBox(
          await detect(0, sample.canvas),
          initial.points!,
          initial.labels!,
        );
      }
    }
    const promptFrames = [
      ...new Set(
        trackedObjects.flatMap((object) =>
          object.prompts.map((prompt) => prompt.frame),
        ),
      ),
    ].sort((a, b) => a - b);
    for (const frame of promptFrames) {
      report(`Applying selections · frame ${frame + 1}`, frame / count);
      const sample = await sink.getCanvas(start + frame / 30);
      if (!sample) throw Error("Could not decode a correction frame");
      const feats = await features(frame, sample.canvas);
      try {
        for (const object of trackedObjects) {
          const prompt = object.prompts.find(
            (prompt) => prompt.frame === frame,
          );
          if (!prompt) continue;
          const raw = floats(feats.feats2);
          for (let c = 0; c < 256; c++)
            for (let i = 0; i < 4096; i++)
              raw[c * 4096 + i] += weights.no_mem_embed[c];
          const prediction = await predict(feats, raw, prompt);
          conditions
            .get(object.id)!
            .set(frame, await remember(feats, prediction, frame));
          if (!corrected.has(frame)) corrected.set(frame, new Map());
          corrected.get(frame)!.set(object.id, prediction);
        }
      } finally {
        dispose(feats);
      }
    }
    async function cancelOutputs() {
      for (const output of outputs.splice(0)) {
        try {
          if (!output.finalized) await output.output.cancel();
        } catch {}
      }
    }
    const colorProofs: Uint8Array[] = [];
    const detailProofs: DetailProof[] = [];
    let highQuality = false;
    async function createOutputs() {
      colorProofs.length = 0;
      detailProofs.length = 0;
      for (let i = 0; i < (silhouette ? 1 : 3); i++)
        outputs.push(await format.create(highQuality));
    }
    async function finishOutputs() {
      const completed = await Promise.allSettled(
        outputs.map((output) => output.finish()),
      );
      const failure = completed.find((value) => value.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const blobs = completed.map(
        (value) => (value as PromiseFulfilledResult<Blob>).value,
      );
      for (let i = 0; i < blobs.length; i++) {
        await validateFinishedVideo(
          blobs[i],
          { width, height, count },
          silhouette || i === 1 ? colorProofs : undefined,
          false, "legacy",
          silhouette || i === 1 ? detailProofs : undefined,
        );
      }
      return blobs;
    }
    function renderPixels(owners: Uint8Array, rgb?: Uint8ClampedArray) {
      for (let i = 0; i < outputs.length; i++) {
        const kind = silhouette
          ? "quiz"
          : (["highlight", "quiz", "reveal"] as const)[i];
        if (!silhouette && !rgb) throw Error("Missing source frame");
        const pixels = silhouette
          ? silhouettePixels(
              owners,
              target_id,
              request.request.presentation === "silhouette-palette-v1",
              grayShades,
            )
          : compositePixels(rgb!, owners, target_id, kind);
        validateComposite(
          pixels,
          owners,
          target_id,
          kind,
          request.request.presentation === "silhouette-palette-v1",
          grayShades,
        );
        if (silhouette) neutralEdges(pixels, width, height);
        if (kind === "quiz") {
          colorProofs.push(silhouetteProof(pixels, width, height));
          detailProofs.push(detailProof(pixels, width, height));
        }
        outputs[i].context.putImageData(
          new ImageData(pixels, width, height),
          0,
          0,
        );
      }
    }
    try {
      if (!paletteFrames) await createOutputs();
    } catch (error) {
      encodingError = error ?? Error("Video encoding failed");
      await cancelOutputs();
    }
    const warnings: MaskResult["warnings"] = [];
    const discovery = new PeopleDiscovery();
    const cameraCuts = new CameraCuts();
    const quality = new MaskQuality();
    const joins = new MaskJoins(width, height);
    const ownership = new MaskOwnership(width, height);
    const recoveryAnchors = shooterAnchors(objects, target_id);
    const small = new OffscreenCanvas(64, 36),
      smallContext = small.getContext("2d", { willReadFrequently: true })!;
    for (let frame = 0; frame < count; frame++) {
      report(
        `Tracking and rendering · frame ${frame + 1} / ${count}`,
        frame / count,
      );
      const sample = await sink.getCanvas(start + frame / 30);
      if (!sample)
        throw Error("The selected segment could not be fully decoded");
      const feats = await features(frame, sample.canvas);
      joins.begin();
      let frameBoxes: number[][] = [];
      const frameMasks = fineSink ? new Map<number, Float32Array>() : undefined;
      ownership.begin();
      const owners = ownership.owners;
      try {
        for (const object of trackedObjects) {
          if (frame < object.prompts[0].frame) continue;
          if (object.id === target_id && recoveryAnchors.some(prompt => prompt.frame === frame))
            recents.get(object.id)!.clear();
          let prediction = corrected.get(frame)?.get(object.id);
          if (!prediction) {
            const available = conditions.get(object.id)!;
            // Future shooter confirmations must not leak into the independent forward pass.
            const causal =
              (trackingCheck || recoveryAnchors.length) && object.id === target_id
                ? new Map([...available].filter(([at]) =>
                    at <= frame && at >= latestShooterAnchor(objects, target_id, frame)))
                : available;
            prediction = await propagate(
              feats,
              frame,
              causal,
              recents.get(object.id)!,
            );
            recents
              .get(object.id)!
              .set(frame, await remember(feats, prediction, frame));
          }
          // propagate_in_video resizes its stored 256px logits directly to the
          // source frame. The 1024px masks are used only by the memory encoder.
          const values = bilinear(prediction.low, 256, 256, width, height);
          frameMasks?.set(object.id, values);
          joins.add(object.id, values, width, height);
          ownership.add(object.id, values);
          if (object.id === target_id)
            trackingCheck?.record(frame, values, width, height);
          for (const old of recents.get(object.id)!.keys())
            if (old < frame - 15) recents.get(object.id)!.delete(old);
        }
        if (detector) {
          report(
            `Finding players · frame ${frame + 1} / ${count}`,
            frame / count,
          );
          const boxes = await detect(frame, sample.canvas);
          frameBoxes = boxes;
          const resolution = discovery.resolve(
            frame,
            boxes,
            owners,
            width,
            height,
            objects,
          );
          if (resolution.ambiguous)
            warnings.push({
              frame,
              kind: "ambiguous_players",
              ...(resolution.ambiguousTracks.length
                ? { track_ids: resolution.ambiguousTracks }
                : {}),
            });
          for (const box of resolution.unmatched) {
            if (objects.length >= 20)
              throw Error(
                "More than 20 tracks are needed. Remove spectators or use manual selection in corrections.",
              );
            const id = Math.max(0, ...objects.map((o) => o.id)) + 1;
            if (id > 255)
              throw Error(
                "Too many player selections. Start a fresh selection.",
              );
            const prompt = { frame, box };
            const object = { id, prompts: [prompt] };
            objects.push(object);
            checkWorkload();
            trackedObjects.push(object);
            conditions.set(id, new Map());
            recents.set(id, new Map());
            const sampleFeatures = feats;
            {
              const raw = floats(sampleFeatures.feats2);
              for (let c = 0; c < 256; c++)
                for (let i = 0; i < 4096; i++)
                  raw[c * 4096 + i] += weights.no_mem_embed[c];
              const prediction = await predict(sampleFeatures, raw, prompt);
              conditions
                .get(id)!
                .set(frame, await remember(sampleFeatures, prediction, frame));
              const values = bilinear(prediction.low, 256, 256, width, height);
              frameMasks?.set(id, values);
              joins.add(id, values, width, height);
              ownership.add(id, values);
            }
          }
        }
      } finally {
        dispose(feats);
      }
      if (fineSink && frameMasks) {
        const rawOwners = owners.slice();
        let fineSample: Awaited<ReturnType<typeof fineSink.getCanvas>>;
        for (const object of trackedObjects) {
          const values = frameMasks.get(object.id);
          if (!values || object.ignored) continue;
          const crop = smallPlayerCrop(
            values,
            width,
            height,
            object.prompts.find((p) => p.frame === frame),
          );
          if (!crop) continue;
          report(
            `Refining small player ${object.id} · frame ${frame + 1} / ${count}`,
            frame / count,
          );
          let refined: Float32Array | undefined;
          if (!crop.unusable) {
            fineSample ??= await fineSink.getCanvas(start + frame / 30);
            if (!fineSample) throw Error("Could not decode the detail frame");
            const detail = await features(frame, fineSample.canvas, crop);
            try {
              const raw = floats(detail.feats2);
              for (let c = 0; c < 256; c++)
                for (let i = 0; i < 4096; i++)
                  raw[c * 4096 + i] += weights.no_mem_embed[c];
              const prediction = await predict(detail, raw, {
                frame,
                box: crop.box,
                points: crop.points,
                labels: crop.labels,
              });
              refined = acceptRefinement(
                values,
                bilinear(
                  prediction.low.map((v) => Math.max(-32, Math.min(32, v))),
                  256,
                  256,
                  crop.width,
                  crop.height,
                ),
                crop,
                width,
                height,
                rawOwners,
                object.id,
              );
            } finally {
              dispose(detail);
            }
          }
          if (refined) {
            frameMasks.set(object.id, refined);
            joins.add(object.id, refined, width, height);
          } else
            warnings.push({
              frame,
              kind: "refinement_uncertain",
              track_ids: [object.id],
            });
        }
        ownership.begin();
        for (const [id, values] of frameMasks) ownership.add(id, values);
      }
      smallContext.drawImage(sample.canvas, 0, 0, 64, 36);
      const pixels = smallContext.getImageData(0, 0, 64, 36).data;
      const transition = cameraCuts.inspect(frame, pixels);
      const cut = transition.reset;
      for (const at of transition.cuts)
        warnings.push({ frame: at, kind: "possible_camera_cut" });
      // Discovery and tracking above retain raw scores; only output ownership is stabilized.
      const labels = ownership.finish(
        new Set(objects.filter((o) => o.ignored).map((o) => o.id)),
        cut || objects.some((o) => o.prompts.some((p) => p.frame === frame)),
      );
      warnings.push(
        ...joins.inspect(
          frame,
          labels,
          width,
          height,
          objects,
          frameBoxes,
          cut,
        ),
      );
      warnings.push(
        ...quality.inspect(
          frame,
          labels,
          width,
          height,
          objects,
          target_id,
          cut,
        ),
      );
      if (paletteFrames && overlapPalette) {
        overlapPalette.observe(labels, width, height);
        await paletteFrames.add(frame, labels);
      } else exportCheckpoint.add(frame, labels);
      if (!paletteFrames && !encodingError) {
        report(
          `Rendering silhouettes · frame ${frame + 1} / ${count}`,
          frame / count,
        );
        try {
          let rgb: Uint8ClampedArray | undefined;
          if (!silhouette) {
            sourceContext.drawImage(sample.canvas, 0, 0, width, height);
            rgb = sourceContext.getImageData(0, 0, width, height).data;
          }
          renderPixels(labels, rgb);
          for (const output of outputs)
            await output.source.add(frame / 30, 1 / 30);
        } catch (error) {
          encodingError = error ?? Error("Video encoding failed");
          await cancelOutputs();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    exportCheckpoint.seal();
    // Independent reverse memory: only the human-confirmed anchor is seeded.
    // Reuse encoder features, never forward tracking memories or final owner maps.
    if (trackingCheck) {
      const segments = trackingCheckSegments(objects, target_id).map(
        (segment) => ({
          ...segment,
          prediction: corrected.get(segment.anchor)?.get(target_id),
          memory: conditions.get(target_id)?.get(segment.anchor),
        }),
      );
      conditions.clear();
      recents.clear();
      corrected.clear();
      let checkedFrames = 0;
      for (const segment of segments) {
        if (!segment.prediction || !segment.memory)
          throw Error("The confirmed shooter frame is missing");
        const reverseConditions = new Map([[segment.anchor, segment.memory]]);
        const reverseRecent = new Map<number, Memory>();
        for (let frame = segment.anchor; frame >= segment.first; frame--) {
          report(
            `Checking shooter backward · frame ${frame + 1} / ${trackingCheck.anchor + 1}`,
            checkedFrames / (trackingCheck.anchor + 1),
          );
          const sample = await sink.getCanvas(start + frame / 30);
          if (!sample) throw Error("Could not decode a backward-check frame");
          const feats = await features(frame, sample.canvas);
          try {
            const prediction =
              frame === segment.anchor
                ? segment.prediction
                : await propagate(
                    feats,
                    frame,
                    reverseConditions,
                    reverseRecent,
                    true,
                  );
            trackingCheck.compare(
              frame,
              bilinear(prediction.low, 256, 256, width, height),
              width,
              height,
            );
            if (frame !== segment.anchor)
              reverseRecent.set(
                frame,
                await remember(feats, prediction, frame),
              );
            for (const old of reverseRecent.keys())
              if (old > frame + 15) reverseRecent.delete(old);
          } finally {
            dispose(feats);
          }
          checkedFrames++;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        reverseConditions.clear();
        reverseRecent.clear();
      }
      const checked = trackingCheck.finish();
      trackingSummary = checked.tracking_check;
      warnings.push(...checked.warnings);
    }
    // Tracking is complete. Free inference resources before allocating encoders again.
    conditions.clear();
    recents.clear();
    corrected.clear();
    for (const session of sessions.splice(0)) {
      try {
        await session.release();
      } catch {}
    }
    try {
      await detector?.release();
    } catch {}
    detector = undefined;
    for (const at of cameraCuts.finish())
      warnings.push({ frame: at, kind: "possible_camera_cut" });
    async function renderRecorded(stage: string) {
      report(stage, 0);
      await cancelOutputs();
      await createOutputs();
      for (let frame = 0; frame < count; frame++) {
        const owners = paletteFrames ? await paletteFrames.frame(frame) : exportCheckpoint.frame(frame);
        let rgb: Uint8ClampedArray | undefined;
        if (!silhouette) {
          const sample = await sink.getCanvas(start + frame / 30);
          if (!sample) throw Error("Could not decode the export retry frame");
          sourceContext!.drawImage(sample.canvas, 0, 0, width, height);
          rgb = sourceContext!.getImageData(0, 0, width, height).data;
        }
        renderPixels(owners, rgb);
        for (const output of outputs) await output.source.add(frame / 30, 1 / 30);
        report(`${stage} · frame ${frame + 1} / ${count}`, frame / count);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (paletteFrames && overlapPalette) {
      grayShades = overlapPalette.finish();
      try {
        await renderRecorded("Rendering fixed overlap-aware gray shades");
      } catch (error) {
        encodingError = error ?? Error("Video encoding failed");
        await cancelOutputs();
      }
    }
    const [highlight, quiz, reveal] = await retryExport(
      async () => {
        if (encodingError) throw encodingError;
        report("Finalizing videos", 1);
        return finishOutputs();
      },
      async () => {
        highQuality = true;
        await renderRecorded("Retrying higher-quality export from completed masks");
        report("Finalizing retried export", 1);
        return finishOutputs();
      },
      () => paletteFrames ? paletteFrames.ready() : exportCheckpoint.ready(),
    );
    return {
      highlight,
      quiz: silhouette ? highlight : quiz,
      reveal: silhouette ? highlight : reveal,
      duration: count / 30,
      ...(trackingSummary ? { tracking_check: trackingSummary } : {}),
      warnings,
      objects,
    };
  } finally {
    exportCheckpoint.clear();
    paletteFrames?.close();
    cache?.close();
    input.dispose();
    try {
      await detector?.release();
    } catch {}
    for (const output of outputs) {
      try {
        await output.output.cancel();
      } catch {}
    }
    for (const session of sessions) {
      try {
        await session.release();
      } catch {}
    }
  }
}
let running = false;
context.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const send = (value: WorkerResponse) => context.postMessage(value);
  if (running || typeof data?.id !== "string") return;
  running = true;
  try {
    const result = await process(data, (stage, progress) =>
      send({ kind: "progress", id: data.id, stage, progress }),
    );
    send({ kind: "done", id: data.id, result });
  } catch (error) {
    send({
      kind: "error",
      id: data.id,
      error: maskingErrorMessage(error),
    });
  } finally {
    running = false;
  }
};
