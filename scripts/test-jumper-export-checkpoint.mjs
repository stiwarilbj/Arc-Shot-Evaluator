import assert from "node:assert/strict";
import {
  ExportCheckpoint,
  EXPORT_CHECKPOINT_TTL,
  retryExport,
} from "../frontend/src/features/jumper/exportCheckpoint.ts";
const mask = Uint8Array.from([0, 0, 0, 0, 1, 1, 128, 128, 255, 255, 255, 255]);
const checkpoint = new ExportCheckpoint(4, 3, 2, 1.25);
checkpoint.add(0, mask);
mask[0] = 99;
assert.throws(() => checkpoint.frame(0), /expired|incompatible/);
checkpoint.add(1, mask);
checkpoint.seal(100);
assert.deepEqual(
  checkpoint.frame(0, 100),
  Uint8Array.from([0, 0, 0, 0, 1, 1, 128, 128, 255, 255, 255, 255]),
);
const detached = checkpoint.frame(1, 100);
detached.fill(0);
assert.equal(checkpoint.frame(1, 100)[0], 99);
assert(checkpoint.ready(100 + EXPORT_CHECKPOINT_TTL));
assert(!checkpoint.ready(101 + EXPORT_CHECKPOINT_TTL));
assert(!checkpoint.ready(99));
const compressible = new ExportCheckpoint(32, 32, 2, 0, 30, 8);
compressible.add(0, new Uint8Array(1024).fill(255));
compressible.add(1, new Uint8Array(1024).fill(1));
compressible.seal(100);
assert.deepEqual(compressible.frame(0, 100), new Uint8Array(1024).fill(255));
const tooBig = new ExportCheckpoint(4, 3, 2, 0, 30, 1);
tooBig.add(0, mask);
tooBig.add(1, mask);
tooBig.seal(100);
assert(!tooBig.ready(100));
const partial = new ExportCheckpoint(4, 3, 2, 0);
assert.throws(() => partial.add(1, mask), /Invalid/);
partial.add(0, mask);
partial.seal(100);
assert(!partial.ready(100));
checkpoint.version = 2;
assert(!checkpoint.ready(100));
checkpoint.clear();
compressible.masks[0].runs[0] = 0;
assert.throws(() => compressible.frame(0, 100), /Invalid/);
compressible.clear();
assert(!compressible.ready(100));
let exports = 0,
  retries = 0;
assert.equal(
  await retryExport(
    async () => {
      exports++;
      throw Error("encoder");
    },
    async () => {
      retries++;
      return 42;
    },
    () => true,
  ),
  42,
);
assert.equal(exports, 1);
assert.equal(retries, 1);
await assert.rejects(
  retryExport(
    async () => {
      throw Error("first");
    },
    async () => {
      throw Error("second");
    },
    () => true,
  ),
  /second/,
);
await assert.rejects(
  retryExport(
    async () => {
      throw Error("first");
    },
    async () => assert.fail("invalid checkpoint reused"),
    () => false,
  ),
  /first/,
);
assert.equal(
  await retryExport(
    async () => 8,
    async () => assert.fail("successful export retried"),
    () => true,
  ),
  8,
);
for (const args of [
  [0, 3, 2, 0],
  [4, 3, 451, 0],
  [4, 3, 2, -1],
  [4, 3, 2, 0, 60],
])
  assert.throws(() => new ExportCheckpoint(...args), /timeline/);
console.log(
  "Export checkpoints: lossless raw/RLE, independent frames, bounded memory, sequence/timeline/version validation, expiry, cleanup and exactly one export-only retry passed",
);
