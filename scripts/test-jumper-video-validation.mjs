import assert from "node:assert/strict";
import {
  validateComposite,
  silhouetteProof,
  validateDecodedPixels,
  validateGeometry,
  validateFrameTime,
  validateNeutralPixels,
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
validateNeutralPixels(pixels, width, height);
const lossy = pixels.slice();
for (let i = 0; i < lossy.length; i += 4) {
  const c = Math.min(255, lossy[i] + 6);
  lossy.set([c, c + 1, c, 255], i);
}
validateDecodedPixels(lossy, width, height, proof);
validateNeutralPixels(lossy, width, height);
assert.throws(
  () =>
    validateNeutralPixels(
      new Uint8ClampedArray(pixels.length).fill(64),
      width,
      height,
    ),
  /color/,
);
const colored = pixels.slice();
colored.set([200, 220, 224, 255]);
assert.throws(() => validateNeutralPixels(colored, width, height), /color/);
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

const { boundaryProof, validateBoundaryPixels } = await import("../frontend/src/features/jumper/videoValidation.ts");
function boundaryFrame(offset) {
  const frame = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = x >= offset && x < offset + 12 && y >= 4 && y < 28 ? 0 : 224;
    frame.set([v, v, v, 255], (y * width + x) * 4);
  }
  return frame;
}
const opening = boundaryFrame(4), finish = boundaryFrame(44);
const openingProof = boundaryProof(opening, width, height);
validateBoundaryPixels(opening, width, height, openingProof, "first");
const compressed = opening.slice();
for (let i = 0; i < compressed.length; i += 4) for (let c = 0; c < 3; c++) compressed[i + c] += 3;
validateBoundaryPixels(compressed, width, height, openingProof, "first");
assert.throws(() => validateBoundaryPixels(finish, width, height, openingProof, "first"), /first frame.*timeline/);
assert.throws(() => validateBoundaryPixels(opening, width, height, boundaryProof(finish, width, height), "last"), /last frame.*timeline/);
assert.throws(() => validateBoundaryPixels(opening, width, height, new Uint8Array(), "first"), /proof/);
// Partial blocks and RGB ordering match the native implementation.
const small = Uint8ClampedArray.from({ length: 6 * 2 * 4 }, (_, i) => i % 4 === 3 ? 255 : Math.floor(i / 4) * 10 + i % 4);
assert.deepEqual([...boundaryProof(small, 6, 2)], [45, 46, 47, 75, 76, 77]);
console.log("First/last intended-frame evidence, lossy tolerance and partial-block RGB checks passed");
