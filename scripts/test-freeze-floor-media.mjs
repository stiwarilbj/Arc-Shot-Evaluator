import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  validateVideoFile,
  validateVideoMetadata,
  videoTime,
  seekTime,
  VIDEO_STEP,
} from "../frontend/src/features/freezeFloor/video.ts";
import {
  newProject,
  validateProject,
  MAX_VIDEO_BYTES,
  validVideoFrameSource,
} from "../frontend/src/features/freezeFloor/types.ts";
import { checkedAsset } from "../frontend/src/features/freezeFloor/checkedAsset.ts";

for (const type of ["video/mp4", "video/webm", "video/quicktime", ""]) {
  validateVideoFile({ size: 1000, type, name: "clip.mov" });
}
assert.throws(
  () => validateVideoFile({ size: 0, type: "video/mp4", name: "clip.mp4" }),
  /empty/,
);
assert.throws(
  () =>
    validateVideoFile({
      size: MAX_VIDEO_BYTES + 1,
      type: "video/mp4",
      name: "clip.mp4",
    }),
  /100 MiB/,
);
assert.throws(
  () => validateVideoFile({ size: 100, type: "image/jpeg", name: "clip.jpg" }),
  /video/,
);
for (const [w, h, d] of [
  [0, 100, 2],
  [100, Infinity, 2],
  [8000, 8000, 2],
  [640, 480, NaN],
  [640, 480, Infinity],
  [640, 480, 0],
  [640, 480, 601],
])
  assert.throws(() => validateVideoMetadata(w, h, d));
validateVideoMetadata(3840, 2160, 600);
assert.equal(seekTime(NaN, 10), null);
assert.equal(seekTime(1, Infinity), null);
assert.equal(seekTime(-100, 10), 0);
assert.equal(seekTime(100, 10), 10 - VIDEO_STEP);
assert.ok(seekTime(100, 0.01) < 0.01);
assert.equal(videoTime(59.999), "1:00.00");
assert.equal(videoTime(600), "10:00.00");
const p = newProject(640, 480, "Video still");
assert.ok(validateProject(p));
assert.ok(validateProject({ ...p, videoFrame: { seconds: 5, duration: 10 } }));
for (const frame of [
  null,
  {},
  { seconds: -1, duration: 10 },
  { seconds: 11, duration: 10 },
  { seconds: 1, duration: Infinity },
  { seconds: NaN, duration: 10 },
  { seconds: 0, duration: 0 },
  { seconds: 0, duration: 601 },
]) {
  assert.ok(!validVideoFrameSource(frame));
  assert.ok(!validateProject({ ...p, videoFrame: frame }));
}
const originalFetch = globalThis.fetch,
  originalCaches = globalThis.caches;
const payload = new Uint8Array([1, 2, 3, 4]);
const asset = {
  sha256: createHash("sha256").update(payload).digest("hex"),
  bytes: 4,
};
let cached = () => new Response(new Uint8Array(5)),
  reads = 0,
  writes = 0,
  removals = 0;
const cache = {
  match: async () => cached?.(),
  delete: async () => {
    cached = undefined;
    removals++;
    return true;
  },
  put: async (_url, response) => {
    const b = await response.arrayBuffer();
    cached = () => new Response(b);
    writes++;
  },
};
try {
  globalThis.caches = { open: async () => cache };
  globalThis.fetch = async () => {
    reads++;
    return new Response(payload);
  };
  await assert.rejects(
    checkedAsset("https://test.invalid/model", asset),
    /size limit/,
  );
  assert.equal(removals, 1);
  assert.equal(reads, 0);
  assert.deepEqual(
    await checkedAsset("https://test.invalid/model", asset),
    payload,
  );
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.deepEqual(
    await checkedAsset("https://test.invalid/model", asset),
    payload,
  );
  assert.equal(reads, 1);
  assert.equal(writes, 1, "Verified cache hits must not be rewritten");
  cached = () => new Response(new Uint8Array([9]));
  await assert.rejects(
    checkedAsset("https://test.invalid/model", asset),
    /integrity/,
  );
  assert.equal(removals, 2);
  cached = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(Error("interrupted cache"));
        },
      }),
    );
  await assert.rejects(
    checkedAsset("https://test.invalid/model", asset),
    /interrupted cache/,
  );
  assert.equal(removals, 3);
  let cancelled = false;
  cached = undefined;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(5));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(
    checkedAsset("https://test.invalid/model", asset),
    /size limit/,
  );
  assert.equal(cancelled, true);
} finally {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
}
console.log(
  "Freeze Floor media: video limits, seek bounds, timestamps, still metadata, corrupt/oversized/interrupted cache eviction and cache reuse passed",
);
