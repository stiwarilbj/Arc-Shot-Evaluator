import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, Script } from "node:vm";
import { LANDMARKS, align } from "../frontend/src/features/freezeFloor/geometry.ts";
import { COURT_MODEL, PERSON_MODEL } from "../frontend/src/features/freezeFloor/model.ts";
import { id, nextContactLabel, validResponse } from "../frontend/src/features/freezeFloor/types.ts";

// Exercise the actual worker handler and decoders with controlled tensor outputs
// Only browser image plumbing, model downloads, and ONNX execution are replaced
const source = stripTypeScriptTypes(readFileSync(new URL(
  "../frontend/src/features/freezeFloor/inference.worker.ts", import.meta.url,
), "utf8"))
  .replace(/^import[\s\S]*?from\s*"[^"\n]+";\n/gm, "")
  .replaceAll("import.meta.env.BASE_URL", '"/"');
const worker = new Script(source, { filename: "inference.worker.ts" });
function prediction(channels, count) {
  const data = new Float32Array(channels * count);
  return { dims: [1, channels, count], data, dispose() {} };
}
const set = (tensor, row, channel, value) => {
  tensor.data[channel * tensor.dims[2] + row] = value;
};
function court(count = 1) {
  const tensor = prediction(149, count);
  for (let row = 0; row < count; row++) {
    set(tensor, row, 4, 0.9);
    for (const [i, landmark] of LANDMARKS.filter((l) => l.slots.length).entries()) {
      const slot = landmark.slots[0];
      set(tensor, row, 5 + slot * 3, 80 + (i % 4) * 130);
      set(tensor, row, 6 + slot * 3, 80 + Math.floor(i / 4) * 200);
      set(tensor, row, 7 + slot * 3, 0.9);
    }
  }
  return tensor;
}
function people(count = 1) {
  const tensor = prediction(56, count);
  for (let row = 0; row < count; row++) {
    const x = 100 + row * 150;
    for (const [channel, value] of [[0, x], [1, 350], [2, 80], [3, 200], [4, 0.9]])
      set(tensor, row, channel, value);
    for (const ankle of [15, 16]) {
      set(tensor, row, 5 + ankle * 3, x + (ankle === 15 ? -10 : 10));
      set(tensor, row, 6 + ankle * 3, 440);
      set(tensor, row, 7 + ankle * 3, 0.9);
    }
  }
  return tensor;
}
async function run(courtOutput, personOutput) {
  const messages = [], released = [], closed = [];
  class ImageBitmap {
    width = 640;
    height = 640;
    close() { closed.push(this); }
  }
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
    dispose() {}
  }
  const self = {
    location: { origin: "https://freeze-floor.test" },
    postMessage: (message) => messages.push(structuredClone(message)),
  };
  worker.runInContext(createContext({
    self, URL, Float32Array, ImageBitmap, COURT_MODEL, PERSON_MODEL,
    LANDMARKS, align, id, nextContactLabel, wasmUrl: "wasm", wasmMjs: "runtime",
    checkedAsset: async (url) => url,
    OffscreenCanvas: class {
      getContext() {
        return {
          fillRect() {}, drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(640 * 640 * 4) }),
        };
      }
    },
    ort: {
      env: { wasm: {} }, Tensor,
      InferenceSession: {
        create: async (url) => ({
          inputNames: ["images"], outputNames: ["output"],
          run: async () => ({ output: url.includes(COURT_MODEL.file) ? courtOutput : personOutput }),
          release: async () => { released.push(url); },
        }),
      },
    },
  }));
  await self.onmessage({ data: {
    type: "analyze", imageId: "photo", jobId: "job", revision: 7,
    image: new ImageBitmap(),
  } });
  assert.equal(closed.length, 1, "the image is released after decoding");
  assert.equal(released.length, 2, "both model sessions are released");
  const result = messages.at(-1);
  assert.equal(result.type, "result", JSON.stringify(result));
  assert.ok(validResponse(result), "the worker must return an independently valid response");
  assert.equal(result.imageId, "photo");
  assert.equal(result.jobId, "job");
  assert.equal(result.revision, 7);
  return result;
}
const confidenceWarnings = (r) => r.warnings.filter((w) => w.startsWith("Model confidence review"));
let result = await run(court(), people());
const anchorCount = result.anchors.length;
assert.ok(anchorCount >= 4);
assert.equal(result.contacts.length, 1);
assert.equal(result.contacts[0].proposalAnkleKeypointCount, 2);
assert.deepEqual(confidenceWarnings(result), []);

// A corrupt high-scoring court candidate must not displace a valid one
for (const bad of [-0.001, 1.001, 2, Number.MAX_VALUE]) {
  // Keep finite float32 values here; existing nonfinite tensor checks stay strict
  const value = Math.min(bad, 1e30);
  const c = court(2);
  set(c, 0, 4, value);
  set(c, 1, 4, 1);
  for (const l of LANDMARKS.filter((l) => l.slots.length))
    set(c, 0, 5 + l.slots[0] * 3, -100);
  result = await run(c, people());
  assert.equal(result.anchors.length, anchorCount);
  assert.match(confidenceWarnings(result).join(" "), /1 court prediction/);

  const p = people(2);
  set(p, 0, 4, value);
  result = await run(court(), p);
  assert.equal(result.contacts.length, 1, "only the valid person is proposed");
  assert.equal(result.contacts[0].image.x, 250 / 640);
  assert.match(confidenceWarnings(result).join(" "), /1 person prediction/);
}
const c = court();
set(c, 0, 7 + LANDMARKS[0].slots[0] * 3, 1.1);
set(c, 0, 7 + LANDMARKS[1].slots[0] * 3, -0.1);
result = await run(c, people());
assert.equal(result.anchors.length, anchorCount - 2);
assert.ok(result.anchors.every((a) => a.landmark !== LANDMARKS[0].id && a.landmark !== LANDMARKS[1].id));
assert.match(confidenceWarnings(result).join(" "), /2 floor landmark confidences/);

const p = people(2);
set(p, 0, 7 + 15 * 3, 1.1);
set(p, 1, 7 + 15 * 3, -0.1);
set(p, 1, 7 + 16 * 3, 1.1);
result = await run(court(), p);
assert.equal(result.contacts.length, 1);
assert.equal(result.contacts[0].proposalAnkleKeypointCount, 1);
assert.equal(result.contacts[0].image.x, 110 / 640, "an invalid ankle cannot shift the contact midpoint");
assert.match(confidenceWarnings(result).join(" "), /3 ankle keypoint confidences/);
assert.match(result.warnings.join(" "), /1 valid person box had no usable ankle/);

// Inclusive endpoints are valid confidences, even when too low for a proposal
for (const bound of [0, 1]) {
  const c = court(), p = people();
  set(c, 0, 4, bound);
  set(p, 0, 4, bound);
  for (const l of LANDMARKS.filter((l) => l.slots.length)) set(c, 0, 7 + l.slots[0] * 3, bound);
  for (const ankle of [15, 16]) set(p, 0, 7 + ankle * 3, bound);
  result = await run(c, p);
  assert.deepEqual(confidenceWarnings(result), []);
  assert.equal(result.contacts.length, bound);
  assert.equal(result.anchors.length, bound ? anchorCount : 0);
}
// Aggregate diagnostics remain within the browser response contract
const allCourt = court(2), allPeople = people(3);
set(allCourt, 0, 4, 1.2);
set(allCourt, 1, 7 + LANDMARKS[0].slots[0] * 3, -0.1);
set(allPeople, 0, 4, 1.2);
set(allPeople, 1, 7 + 15 * 3, 1.2);
result = await run(allCourt, allPeople);
assert.equal(confidenceWarnings(result).length, 1);
for (const category of ["1 court prediction", "1 floor landmark confidence", "1 person prediction", "1 ankle keypoint confidence"])
  assert.ok(confidenceWarnings(result)[0].includes(category));
assert.ok(result.warnings.length <= 10);
// An unusable finite batch remains a valid, editable empty proposal result
const invalidCourt = court(2), invalidPeople = people(2);
for (let i = 0; i < 2; i++) {
  set(invalidCourt, i, 4, i ? -0.1 : 1.1);
  set(invalidPeople, i, 4, i ? -0.1 : 1.1);
}
result = await run(invalidCourt, invalidPeople);
assert.equal(result.anchors.length, 0);
assert.equal(result.contacts.length, 0);
assert.match(confidenceWarnings(result).join(" "), /2 court predictions, 2 person predictions/);
// Retain strict rejection of nonfinite tensors rather than weakening that guard
for (const bad of [NaN, Infinity, -Infinity]) {
  const p = people();
  set(p, 0, 7 + 15 * 3, bad);
  result = await run(court(), p);
  assert.equal(result.anchors.length, anchorCount);
  assert.equal(result.contacts.length, 0);
  assert.match(result.warnings.join(" "), /Player proposals unavailable/);
}
console.log("Freeze Floor worker confidence checks passed: detection ranking, floor landmarks, ankle filtering, exact warning counts, inclusive boundaries, valid partial results, identities, and cleanup");
