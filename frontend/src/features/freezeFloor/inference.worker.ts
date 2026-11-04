import * as ort from "onnxruntime-web/webgpu";
import { COURT_MODEL, PERSON_MODEL } from "./model.ts";
import { checkedAsset } from "./checkedAsset.ts";
import { LANDMARKS, align } from "./geometry.ts";
import {
  id,
  type Anchor,
  type Contact,
  type InferenceRequest,
  type InferenceResponse,
} from "./types.ts";
ort.env.wasm.numThreads = 1;
// Vite serves the runtime from its pinned package, on the same origin.
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmMjs };
async function session(asset: typeof COURT_MODEL | typeof PERSON_MODEL) {
  const url = new URL(
    `${import.meta.env.BASE_URL}${asset.file}`,
    self.location.origin,
  ).href;
  const data = await checkedAsset(url, asset);
  try {
    return {
      data,
      session: await ort.InferenceSession.create(data, {
        executionProviders: ["webgpu"],
      }),
      provider: "webgpu" as "webgpu" | "wasm",
    };
  } catch {
    return {
      data,
      session: await ort.InferenceSession.create(data, {
        executionProviders: ["wasm"],
      }),
      provider: "wasm" as "webgpu" | "wasm",
    };
  }
}
async function run(
  model: Awaited<ReturnType<typeof session>>,
  tensor: ort.Tensor,
  attach: (session: ort.InferenceSession | undefined) => void,
) {
  attach(model.session);
  try {
    return await model.session.run({ [model.session.inputNames[0]]: tensor });
  } catch (error) {
    if (model.provider === "wasm") throw error;
    await model.session.release();
    attach(undefined);
    model.session = await ort.InferenceSession.create(model.data, {
      executionProviders: ["wasm"],
    });
    model.provider = "wasm";
    attach(model.session);
    return await model.session.run({ [model.session.inputNames[0]]: tensor });
  }
}
function input(image: ImageBitmap) {
  const canvas = new OffscreenCanvas(640, 640),
    ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const scale = Math.min(640 / image.width, 640 / image.height),
    w = Math.max(1, Math.round(image.width * scale)),
    h = Math.max(1, Math.round(image.height * scale)),
    x = Math.round((640 - w) / 2 - 0.1),
    y = Math.round((640 - h) / 2 - 0.1);
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, 640, 640);
  ctx.drawImage(image, x, y, w, h);
  const rgba = ctx.getImageData(0, 0, 640, 640).data,
    rgb = new Float32Array(3 * 640 * 640);
  for (let i = 0; i < 640 * 640; i++)
    for (let c = 0; c < 3; c++) rgb[c * 640 * 640 + i] = rgba[i * 4 + c] / 255;
  return {
    tensor: new ort.Tensor("float32", rgb, [1, 3, 640, 640]),
    contentBounds: { left: x, top: y, right: x + w, bottom: y + h },
    map: (px: number, py: number) => ({ x: (px - x) / w, y: (py - y) / h }),
  };
}
function output(t: ort.Tensor, channels: number) {
  if (
    !t ||
    t.dims.length !== 3 ||
    t.dims[0] !== 1 ||
    t.dims[1] !== channels ||
    t.dims[2] < 1 ||
    t.dims[2] > 20000 ||
    !(t.data instanceof Float32Array) ||
    t.data.length !== channels * t.dims[2] ||
    !t.data.every(Number.isFinite)
  )
    throw Error("Invalid model predictions · Use manual alignment or retry");
  return { values: t.data, n: t.dims[2] };
}
const valid = (p: { x: number; y: number }) =>
  p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const ANKLE_KEYPOINT_CONFIDENCE = 0.5;
type Payload<R = InferenceResponse> = R extends InferenceResponse
  ? Omit<R, "imageId" | "jobId" | "revision">
  : never;
let busy = false;
self.onmessage = async (e: MessageEvent<InferenceRequest>) => {
  const r = e.data;
  if (
    !r ||
    r.type !== "analyze" ||
    typeof r.imageId !== "string" ||
    typeof r.jobId !== "string" ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0 ||
    !(r.image instanceof ImageBitmap) ||
    r.image.width > 2048 ||
    r.image.height > 2048 ||
    busy
  ) {
    if (r?.image instanceof ImageBitmap) r.image.close();
    return;
  }
  busy = true;
  const send = (data: Payload) =>
    self.postMessage({
      ...data,
      imageId: r.imageId,
      jobId: r.jobId,
      revision: r.revision,
    });
  let tensor: ort.Tensor | undefined;
  let current: ort.InferenceSession | undefined;
  let values: Record<string, ort.Tensor> | undefined;
  try {
    send({
      type: "progress",
      message:
        "Downloading and checking court model · First use can take a moment",
    });
    const feed = input(r.image);
    tensor = feed.tensor;
    const court = await session(COURT_MODEL);
    current = court.session;
    send({
      type: "progress",
      message: `Finding floor landmarks · ${court.provider === "wasm" ? "CPU fallback" : "WebGPU"}`,
    });
    values = await run(court, tensor, (s) => {
      current = s;
    });
    const raw = output(values[court.session.outputNames[0]], 149);
    let best = -1,
      score = 0.2;
    for (let i = 0; i < raw.n; i++)
      if (raw.values[4 * raw.n + i] > score) {
        score = raw.values[4 * raw.n + i];
        best = i;
      }
    const alternatives: Anchor[][] = [[], []];
    if (best >= 0)
      for (const landmark of LANDMARKS)
        for (const slot of landmark.slots) {
          const c = raw.values[(7 + slot * 3) * raw.n + best],
            p = feed.map(
              raw.values[(5 + slot * 3) * raw.n + best],
              raw.values[(6 + slot * 3) * raw.n + best],
            );
          if (c >= 0.45 && valid(p))
            alternatives[slot < 24 ? 0 : 1].push({
              id: id(),
              landmark: landmark.id,
              image: p,
              enabled: true,
              origin: "model",
              confidence: c,
            });
        }
    alternatives.sort((a, b) => {
      const aa = align(a),
        bb = align(b);
      return bb.inliers.length - aa.inliers.length || b.length - a.length;
    });
    const anchors = alternatives[0];
    Object.values(values).forEach((t) => t.dispose());
    values = undefined;
    await current.release();
    current = undefined;
    const warnings = [
      "Automatic alignment has not passed the independent real-photo benchmark · Review all proposed landmarks",
    ];
    let contacts: Contact[] = [],
      provider = court.provider;
    try {
      send({
        type: "progress",
        message:
          "Finding people and possible ankle contacts · Grounding still needs your review",
      });
      const person = await session(PERSON_MODEL);
      current = person.session;
      values = await run(person, tensor, (s) => {
        current = s;
      });
      if (person.provider === "wasm") provider = "wasm";
      const raw = output(values[person.session.outputNames[0]], 56);
      const candidates: {
        box: [number, number, number, number];
        score: number;
        foot: { x: number; y: number };
        proposalAnkleKeypointCount: 1 | 2;
        boxTouchesImageEdge: boolean;
      }[] = [];
      let rejectedAnkleProposals = 0,
        personBoxesWithoutAnkles = 0;
      for (let i = 0; i < raw.n; i++) {
        const score = raw.values[4 * raw.n + i];
        if (score < 0.4) continue;
        const x = raw.values[i],
          y = raw.values[raw.n + i],
          w = raw.values[2 * raw.n + i],
          h = raw.values[3 * raw.n + i];
        const content = feed.contentBounds;
        if (w <= 0 || h <= 0) continue;
        const left = x - w / 2,
          top = y - h / 2,
          right = x + w / 2,
          bottom = y + h / 2,
          overlapWidth = Math.min(right, content.right) - Math.max(left, content.left),
          overlapHeight = Math.min(bottom, content.bottom) - Math.max(top, content.top);
        // Require at least one model pixel on each axis and 5% of the box area.
        if (
          overlapWidth < 1 ||
          overlapHeight < 1 ||
          (overlapWidth * overlapHeight) / (w * h) < 0.05
        )
          continue;
        if (
          x < content.left ||
          x > content.right ||
          y < content.top ||
          y > content.bottom
        )
          continue;
        const boxTouchesImageEdge =
          left <= content.left ||
          top <= content.top ||
          right >= content.right ||
          bottom >= content.bottom;
        const tl = feed.map(left, top),
          br = feed.map(right, bottom),
          box: [number, number, number, number] = [
            Math.max(0, tl.x),
            Math.max(0, tl.y),
            Math.min(1, br.x),
            Math.min(1, br.y),
          ];
        if (box[2] <= box[0] || box[3] <= box[1]) continue;
        const ankles = [15, 16].flatMap((j) => {
          const p = feed.map(
            raw.values[(5 + j * 3) * raw.n + i],
            raw.values[(6 + j * 3) * raw.n + i],
          );
          return (
            raw.values[(7 + j * 3) * raw.n + i] >= ANKLE_KEYPOINT_CONFIDENCE &&
            valid(p)
          )
            ? [p]
            : [];
        });
        if (!ankles.length) {
          personBoxesWithoutAnkles++;
          continue;
        }
        const boxWidth = box[2] - box[0],
          boxHeight = box[3] - box[1],
          // Allow a small 5% of box size for keypoint/box edge disagreement.
          marginX = boxWidth * 0.05,
          marginY = boxHeight * 0.05;
        if (
          ankles.some(
            (p) =>
              p.x < box[0] - marginX ||
              p.x > box[2] + marginX ||
              p.y < box[1] - marginY ||
              p.y > box[3] + marginY,
          )
        ) {
          rejectedAnkleProposals++;
          continue;
        }
        candidates.push({
          box,
          score,
          proposalAnkleKeypointCount: ankles.length === 1 ? 1 : 2,
          boxTouchesImageEdge,
          foot: {
            x: ankles.reduce((s, p) => s + p.x, 0) / ankles.length,
            y: Math.max(...ankles.map((p) => p.y)),
          },
        });
      }
      candidates.sort((a, b) => b.score - a.score);
      let overlapSuppressedCandidates = 0;
      const overlapReviewLabels = new Set<string>();
      for (const c of candidates) {
        const overlappingContact = contacts.find((k) => {
          const b = k.box!,
            a = c.box,
            inter =
              Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
              Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
          return (
            inter /
              ((a[2] - a[0]) * (a[3] - a[1]) +
                (b[2] - b[0]) * (b[3] - b[1]) -
                inter) >
            0.45
          );
        });
        if (overlappingContact) {
          overlapSuppressedCandidates++;
          overlapReviewLabels.add(overlappingContact.label);
          continue;
        }
        if (contacts.length === 40) {
          warnings.push(
            "More people were found than the 40-contact limit · Remove spectators and add missing court players manually",
          );
          break;
        }
        contacts.push({
          id: id(),
          label: String(contacts.length + 1),
          image: c.foot,
          status: "uncertain",
          box: c.box,
          proposalAnkleKeypointCount: c.proposalAnkleKeypointCount,
          boxTouchesImageEdge: c.boxTouchesImageEdge,
        });
      }
      if (overlapSuppressedCandidates > 0) {
        const players = [...overlapReviewLabels]
          .map((label) => `Player ${label}`)
          .join(", ");
        warnings.push(
          `Near-duplicate review · ${overlapSuppressedCandidates} person candidate${overlapSuppressedCandidates === 1 ? " was" : "s were"} skipped against ${players} · Check for a nearby player the detector may have missed`,
        );
      }
      if (rejectedAnkleProposals > 0) {
        warnings.push(
          `${rejectedAnkleProposals} ankle proposal${rejectedAnkleProposals === 1 ? " was" : "s were"} rejected because at least one predicted ankle fell outside the accompanying person box (5% size margin) · Review contacts manually`,
        );
      }
      if (personBoxesWithoutAnkles > 0) {
        warnings.push(
          `${personBoxesWithoutAnkles} valid person box${personBoxesWithoutAnkles === 1 ? " had" : "es had"} no usable ankle keypoint at confidence ${ANKLE_KEYPOINT_CONFIDENCE} or higher · Review the photo and add any missing court players manually`,
        );
      }
      const edgeContacts = contacts.filter((c) => c.boxTouchesImageEdge);
      if (edgeContacts.length > 0) {
        const labels = edgeContacts.map((c) => c.label).join(", ");
        warnings.push(
          `Photo-edge review · ${edgeContacts.length} proposed contact${edgeContacts.length === 1 ? " touches" : "s touch"} the photo boundary · Player${edgeContacts.length === 1 ? "" : "s"} ${labels} · Check whether their shoes are visible`,
        );
      }
    } catch (e) {
      warnings.push(
        e instanceof Error && e.name === "TimeoutError"
          ? `Player proposals unavailable · ${e.message}`
          : "Player proposals unavailable · Add contacts manually",
      );
    }
    send({ type: "result", anchors, contacts, provider, warnings } as Payload);
  } catch (e) {
    send({
      type: "error",
      message:
        e instanceof Error
          ? e.message
          : "Automatic alignment interrupted · Manual landmarks remain available",
    });
  } finally {
    try {
      if (values)
        for (const t of Object.values(values)) {
          try {
            t.dispose();
          } catch {
            // Continue releasing the remaining resources
          }
        }
    } catch {
      // A damaged output map must not block the other cleanup steps
    }
    try {
      tensor?.dispose();
    } catch {
      // Continue cleanup even if tensor disposal fails
    }
    try {
      await current?.release();
    } catch {
      // Continue cleanup even if the inference session cannot release
    }
    try {
      r.image.close();
    } catch {
      // Always reset the worker state, even if the bitmap is already closed
    }
    busy = false;
  }
};
