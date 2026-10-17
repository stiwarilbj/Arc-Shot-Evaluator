import assert from "node:assert/strict";
import {
  admission,
  contentHash,
  validFeatures,
  validDetections,
  FRAME_CACHE_TTL,
} from "../frontend/src/features/jumper/frameCache.ts";
const now = FRAME_CACHE_TTL + 100;
const entry = (key, scope, bytes, touched = now) => ({
  key,
  scope,
  bytes,
  touched,
});
const entries = [
  entry("a0", "a", 40),
  entry("a1", "a", 40),
  entry("b0", "b", 10, now - 1),
  entry("expired", "c", 90, 0),
];
const plan = admission(entries, "a", 10, now, 90);
assert.equal(plan.fits, true);
assert.deepEqual(
  plan.removed.map((e) => e.key),
  ["expired", "b0"],
);
assert.equal(admission(entries, "a", 20, now, 90).fits, false);
assert.equal(admission(entries, "d", 80, now, 90).fits, true);
assert.equal(admission([], "a", 100, now, 90).fits, false);
const original = await contentHash(new TextEncoder().encode("video"));
assert.equal(original, await contentHash(new TextEncoder().encode("video")));
assert.notEqual(original, await contentHash(new TextEncoder().encode("Video")));
assert.equal(validDetections([]), true);
assert.equal(validDetections([[0.1, 0.2, 0.3, 0.4]]), true);
for (const value of [
  null,
  [[NaN, 0, 1, 1]],
  [[0, 0, 2, 1]],
  [[0.5, 0, 0.2, 1]],
  Array(21).fill([0, 0, 1, 1]),
])
  assert.equal(validDetections(value), false);
const shapes = {
  feats0: [1, 32, 256, 256],
  feats1: [1, 64, 128, 128],
  feats2: [1, 256, 64, 64],
  pos2: [1, 256, 64, 64],
};
const features = Object.fromEntries(
  Object.entries(shapes).map(([key, dims]) => [
    key,
    { dims, data: new Float32Array(dims.reduce((a, b) => a * b, 1)) },
  ]),
);
assert.equal(validFeatures(features), true);
assert.equal(validFeatures({ ...features, unexpected: {} }), false);
features.feats0.data[3] = NaN;
assert.equal(validFeatures(features), false);
features.feats0.data[3] = 0;
features.feats2.dims = [1, 1, 1, 1];
assert.equal(validFeatures(features), false);
console.log(
  "Frame cache: stable content hashes, bounded admission, expiry, active-clip retention, detection/feature validation passed",
);

assert.equal(
  admission(
    Array.from({ length: 1024 }, (_, i) => entry(String(i), "same", 1)),
    "same",
    1,
    now,
  ).fits,
  false,
);
assert.equal(
  admission(
    Array.from({ length: 1024 }, (_, i) => entry(String(i), "old", 1)),
    "new",
    1,
    now,
  ).fits,
  true,
);
