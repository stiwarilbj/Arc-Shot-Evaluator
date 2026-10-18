import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { validateFinishedVideo } from "../frontend/src/features/jumper/media.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
import {
  detailProof,
  validateDetailPixels,
  SilhouetteCompressionError,
  withCompressionRetry,
} from "../frontend/src/features/jumper/compressionQuality.ts";
const w = 128,
  h = 96,
  pixels = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) pixels.set([224, 224, 224, 255], i * 4);
function rect(x, y, width, height, v) {
  for (let row = y; row < y + height; row++)
    for (let col = x; col < x + width; col++)
      pixels.set([v, v, v, 255], (row * w + col) * 4);
}
rect(25, 30, 25, 50, 0);
rect(49, 18, 2, 35, 0);
rect(48, 14, 5, 4, 0); // thin arm + hand
rect(54, 22, 20, 58, 128);
rect(74, 22, 2, 58, 224);
rect(76, 22, 20, 58, 128); // narrow gap
const proof = detailProof(pixels, w, h);
assert(proof.thin.length > 50);
assert(proof.edge.length > 50);
validateDetailPixels(pixels, proof);
const tolerant = pixels.map((v, i) =>
  i % 4 === 3 ? v : Math.min(255, v + 12),
);
validateDetailPixels(tolerant, proof);
for (const [x, y, width, height, value] of [
  [49, 18, 2, 20, 224],
  [74, 22, 2, 58, 128],
]) {
  const damaged = pixels.slice();
  for (let row = y; row < y + height; row++)
    for (let col = x; col < x + width; col++)
      damaged.set([value, value, value, 255], (row * w + col) * 4);
  assert.throws(
    () => validateDetailPixels(damaged, proof),
    SilhouetteCompressionError,
  );
}
// An isolated off-palette edge pixel is tolerated; ordinary codec noise isn't a retry.
const noise = pixels.slice();
noise.set([100, 100, 100, 255], (30 * w + 25) * 4);
validateDetailPixels(noise, proof);
const busy = new Uint8ClampedArray(1280 * 720 * 4);
for (let i = 0; i < 1280 * 720; i++)
  busy.set([(i % 3) * 100, (i % 3) * 100, (i % 3) * 100, 255], i * 4);
const bounded = detailProof(busy, 1280, 720);
assert(bounded.thin.byteLength + bounded.edge.byteLength <= 8192);
assert.throws(() => detailProof(pixels, w, 1));
const attempts = [];
assert.equal(
  await withCompressionRetry(async (high) => {
    attempts.push(high);
    if (!high) throw new SilhouetteCompressionError();
    return "ready";
  }),
  "ready",
);
assert.deepEqual(attempts, [false, true]);
let calls = 0;
await assert.rejects(
  () =>
    withCompressionRetry(async () => {
      calls++;
      throw new SilhouetteCompressionError();
    }),
  SilhouetteCompressionError,
);
assert.equal(calls, 2);
calls = 0;
await assert.rejects(
  () =>
    withCompressionRetry(async () => {
      calls++;
      throw Error("codec unavailable");
    }),
  /codec unavailable/,
);
assert.equal(calls, 1);
// Shared output fixture confirms exact native/browser sample selection.
const { execFileSync } = await import("node:child_process");
const native = JSON.parse(
  execFileSync(
    root + "/.venv/bin/python",
    [
      "-c",
      `import sys,json,numpy as np
from backend.jumper.compression_quality import detail_proof
v=json.load(sys.stdin)
p=detail_proof(np.array(v,dtype=np.uint8).reshape(96,128,4)[:,:,:3])
print(json.dumps([x.tolist() for x in p]))`,
    ],
    { input: JSON.stringify(Array.from(pixels)), encoding: "utf8", cwd: root },
  ),
);
assert.deepEqual(native, [Array.from(proof.thin), Array.from(proof.edge)]);
console.log(
  "Compression quality: thin-arm/hand loss, filled gaps, noise tolerance, bounded samples, native parity and one quality-only retry passed.",
);

const boundary = new Uint8ClampedArray(150 * 4);
for (let i = 0; i < 3; i++) boundary.set([41, 41, 41, 255], i * 4);
const points = Uint32Array.from({ length: 150 }, (_, i) => i * 256);
validateDetailPixels(boundary, { thin: points, edge: new Uint32Array() }); // exactly 2%
assert.throws(
  () =>
    validateDetailPixels(boundary, {
      thin: points.slice(0, 149),
      edge: new Uint32Array(),
    }),
  SilhouetteCompressionError,
);
for (let i = 0; i < 3; i++) boundary.set([40, 40, 40, 255], i * 4);
validateDetailPixels(boundary, {
  thin: points.slice(0, 100),
  edge: new Uint32Array(),
});
const oversized = new Blob(["x"]);
Object.defineProperty(oversized, "size", { value: 100 * 1024 * 1024 + 1 });
await assert.rejects(
  () => validateFinishedVideo(oversized, { width: 128, height: 96, count: 30 }),
  /100 MB/,
);
