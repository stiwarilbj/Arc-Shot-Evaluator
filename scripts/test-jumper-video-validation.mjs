import assert from "node:assert/strict";
import {
  validateComposite,
  silhouetteProof,
  validateDecodedPixels,
  validateGeometry,
  validateFrameTime,
} from "../frontend/src/features/jumper/videoValidation.ts";
const width = 64,
  height = 32;
const owners = Uint8Array.from({ length: width * height }, (_, i) =>
  Math.floor((i % width) / 24),
);
const pixels = new Uint8ClampedArray(width * height * 4);
for (let i = 0; i < owners.length; i++) {
  const c = [224, 0, 128][owners[i]];
  pixels.set([c, c, c, 255], i * 4);
}
validateComposite(pixels, owners, 1, "quiz");
const proof = silhouetteProof(pixels, width, height);
validateDecodedPixels(pixels, width, height, proof);
const lossy = pixels.slice();
for (let i = 0; i < lossy.length; i += 4) {
  const c = Math.min(255, lossy[i] + 6);
  lossy.set([c, c + 1, c, 255], i);
}
validateDecodedPixels(lossy, width, height, proof);
const bad = pixels.slice();
bad[0] = 200;
assert.throws(() => validateComposite(bad, owners, 1, "quiz"), /color/);
assert.throws(() => validateDecodedPixels(bad, width, height, proof), /color/);
bad.set([100, 100, 100, 255]);
assert.throws(() => validateDecodedPixels(bad, width, height, proof), /color/);
bad.set([224, 224, 224, 0]);
assert.throws(() => validateComposite(bad, owners, 1, "quiz"), /opaque/);
validateGeometry({ width, height, count: 9 });
for (const geometry of [
  { width: 65, height, count: 9 },
  { width, height, count: 0 },
  { width: 1282, height, count: 9 },
])
  assert.throws(() => validateGeometry(geometry));
validateFrameTime(1, 0.033, 0.033);
for (const [time, duration] of [
  [0, 1 / 30],
  [1 / 30, 0],
  [NaN, 1 / 30],
  [1 / 30, 2 / 30],
])
  assert.throws(() => validateFrameTime(1, time, duration));
assert.throws(
  () => validateDecodedPixels(pixels, width, height, new Uint8Array(1)),
  /size/,
);
console.log(
  "Finished-video exact palette, opaque compositing, lossy tolerance, geometry and frame-clock checks passed",
);
