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

// Failed automatic selections must never become authoritative or cached.
for (const [boxes, message] of [[[], /Clear the first-frame points/], [[body, body], /Add another Include point/]]) {
  const isolated = new ShooterSelectionCache();
  await assert.rejects(isolated.resolve(file, request, async () => boxes, signal), message);
  await assert.rejects(isolated.resolve(file, fullRequest, async () => boxes, signal), message);
  await assert.rejects(isolated.resolve(file, { ...request, shooter_selection_resolved: true }, async () => boxes, signal), message);
  const recovered = await isolated.resolve(file, request, async () => [body], signal);
  assert.deepEqual(recovered.objects[0].prompts[0].box, body);
}
const { requireShooterBox, ShooterSelectionError } = await import("../frontend/src/features/jumper/discovery.ts");
const overlap = [[0.1, 0.1, 0.6, 0.9], [0.3, 0.2, 0.8, 0.9]];
assert.throws(() => requireShooterBox(overlap, [[0.4, 0.4]], [1]), ShooterSelectionError);
const corrected = structuredClone(request);
corrected.objects[0].prompts[0] = {
  frame: 0, points: [[0.4, 0.4], [0.2, 0.5], [0.5, 0.5]], labels: [1, 1, 0],
};
const correctedCache = new ShooterSelectionCache();
const confirmed = await correctedCache.resolve(file, corrected, async () => overlap, signal);
assert.deepEqual(confirmed.objects[0].prompts[0].box, overlap[0]);
assert.deepEqual(confirmed.objects[0].prompts[0].points, corrected.objects[0].prompts[0].points);
await correctedCache.resolve(file, { ...corrected, end: 8 }, never, signal);
assert.throws(() => requireShooterBox(overlap, [[0.2, 0.5], [0.7, 0.5]], [1, 1]), /Clear the first-frame points/);
assert.throws(() => requireShooterBox(overlap, [[0.2, 0.5]], [0]), /Clear the first-frame points/);
assert.deepEqual(requireShooterBox(overlap, [[0.1, 0.1]], [1]), overlap[0]);

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
