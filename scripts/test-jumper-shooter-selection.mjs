import assert from "node:assert/strict";
import { ShooterSelectionCache } from "../frontend/src/features/jumper/shooterSelection.ts";
import { validateMaskRequest } from "../frontend/src/features/jumper/domain.ts";

const cache = new ShooterSelectionCache();
const file = new File(["private footage"], "shot.mp4");
const signal = new AbortController().signal;
const request = {
  start: 2,
  end: 2.1,
  target_id: 7,
  auto_detect_others: true,
  presentation: "silhouette",
  objects: [{ id: 7, prompts: [{ frame: 0, points: [[0.3, 0.4]], labels: [1] }] }],
};
const original = structuredClone(request);
const body = [0.1, 0.1, 0.5, 0.9];
let detections = 0;
const detect = async (source, time) => {
  assert.equal(source, file);
  assert.equal(time, request.start);
  detections++;
  return [body, [0.6, 0.1, 0.9, 0.9]];
};
const preview = await cache.resolve(file, request, detect, signal);
assert.deepEqual(preview.objects[0].prompts[0].box, body);
assert.equal(preview.shooter_selection_resolved, true);
assert.deepEqual(request, original, "preparation must not edit correction history");
const fullRequest = structuredClone(request);
fullRequest.end = 8;
fullRequest.objects[0].prompts.push({ frame: 20, points: [[0.4, 0.5]], labels: [1] });
fullRequest.objects.push({ id: 9, prompts: [{ frame: 40, box: [0.6, 0.1, 0.9, 0.9] }] });
const full = await cache.resolve(file, fullRequest, detect, signal);
assert.equal(detections, 1, "the preview's resolved seed must serve the full run");
assert.deepEqual(full.objects[0].prompts[0], preview.objects[0].prompts[0]);
assert.deepEqual(full.objects[0].prompts[1], fullRequest.objects[0].prompts[1]);
assert.deepEqual(full.objects[1], fullRequest.objects[1]);
assert.equal(full.auto_detect_others, true);
preview.objects[0].prompts[0].box[0] = 0;
full.objects[0].prompts[0].points[0][0] = 0;
const again = await cache.resolve(file, request, detect, signal);
assert.deepEqual(again.objects[0].prompts[0].box, body);
assert.deepEqual(again.objects[0].prompts[0].points, [[0.3, 0.4]]);

const never = async () => { throw Error("This selection must not be detected again"); };
await cache.resolve(file, { ...again, auto_detect_others: false }, never, signal);
const manual = await cache.resolve(file, { ...request, auto_detect_others: false }, never, signal);
assert.equal(manual.objects[0].prompts[0].box, undefined);
const boxed = structuredClone(request);
boxed.objects[0].prompts[0].box = [0.2, 0.2, 0.4, 0.8];
assert.deepEqual((await cache.resolve(file, boxed, never, signal)).objects, boxed.objects);

for (const variant of [
  { ...request, start: 3, end: 4 },
  { ...request, target_id: 8, objects: [{ ...request.objects[0], id: 8 }] },
  { ...request, objects: [{ id: 7, prompts: [{ frame: 0, points: [[0.31, 0.4]], labels: [1] }] }] },
]) {
  let called = false;
  await cache.resolve(file, variant, async () => { called = true; return [body]; }, signal);
  assert.equal(called, true, "changed start, target, or points need a fresh selection");
}
let newSource = false;
await cache.resolve(new File(["different footage"], file.name), request, async () => {
  newSource = true; return [body];
}, signal);
assert.equal(newSource, true, "matching filenames must not share selections");

for (const boxes of [[], [body, body]]) {
  const isolated = new ShooterSelectionCache();
  const uncertain = await isolated.resolve(file, request, async () => boxes, signal);
  assert.equal(uncertain.objects[0].prompts[0].box, undefined);
  const repeated = await isolated.resolve(file, fullRequest, never, signal);
  assert.equal(repeated.shooter_selection_resolved, true);
  assert.deepEqual(repeated.objects[0].prompts[0], uncertain.objects[0].prompts[0]);
}

const aborted = new AbortController();
const isolated = new ShooterSelectionCache();
await assert.rejects(isolated.resolve(file, request, async () => {
  aborted.abort(); return [body];
}, aborted.signal), { name: "AbortError" });
let retried = false;
await isolated.resolve(file, request, async () => { retried = true; return [body]; }, signal);
assert.equal(retried, true, "cancelled detection must not populate the cache");
const failing = new ShooterSelectionCache();
await assert.rejects(failing.resolve(file, request, async () => { throw Error("offline"); }, signal), /offline/);
await failing.resolve(file, request, detect, signal);
assert.throws(() => validateMaskRequest({ ...request, shooter_selection_resolved: "yes" }));
console.log("Shooter preview/full-run seeds match; cache isolation, invalidation, manual selections, ambiguity, cancellation and retries passed");
