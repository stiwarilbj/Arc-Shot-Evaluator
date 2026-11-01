import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const paletteOwners = Uint8Array.from({ length: 256 }, (_, i) => i);
const palette = silhouettePixels(paletteOwners, 7, true);
const nativePalette = JSON.parse(
  execFileSync(
    new URL("../.venv/bin/python", import.meta.url).pathname,
    [
      "-c",
      "import json,numpy as np;from backend.jumper.pipeline import silhouette_pixels;print(json.dumps(silhouette_pixels(np.arange(256,dtype=np.uint8)[None,:],7,True)[0,:,0].tolist()))",
    ],
    { cwd: new URL("../", import.meta.url) },
  ).toString(),
);
assert.deepEqual(
  Array.from(paletteOwners, (_, i) => palette[i * 4]),
  nativePalette,
);
assert.equal(palette[0], 224);
assert.equal(palette[7 * 4], 0);
for (let id = 1; id < 256; id++)
  if (id !== 7) {
    assert(palette[id * 4] >= 64 && palette[id * 4] <= 200);
    assert.equal(
      silhouettePixels(new Uint8Array([id]), 7, true)[0],
      palette[id * 4],
    );
  }
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
