import assert from "node:assert/strict";
import {
  compositePixels,
  silhouettePixels,
} from "../frontend/src/features/jumper/media.ts";
const source = new Uint8ClampedArray([
  255, 0, 0, 255, 0, 0, 255, 255, 40, 180, 60, 255,
]);
const owners = new Uint8Array([0, 1, 2]);
assert.deepEqual(
  [...compositePixels(source, owners, 1, "quiz")],
  [224, 224, 224, 255, 0, 0, 0, 255, 128, 128, 128, 255],
);
source.fill(72);
assert.deepEqual(
  silhouettePixels(owners, 1),
  compositePixels(source, owners, 1, "quiz"),
);
assert.throws(() => silhouettePixels(owners, 0), /identity/);
assert.throws(
  () => compositePixels(source.subarray(0, 4), owners, 1, "quiz"),
  /size/,
);
assert.deepEqual(
  [...compositePixels(source, owners, 1, "quiz")],
  [224, 224, 224, 255, 0, 0, 0, 255, 128, 128, 128, 255],
);
console.log(
  "Browser compositor uses only assigned silhouette colors; source pixels cannot leak",
);
