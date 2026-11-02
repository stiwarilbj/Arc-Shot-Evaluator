import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  VIDEO_SAMPLES,
  readSampleVideo,
} from "../frontend/src/features/freezeFloor/videoSamples.ts";
import { readImageHeader } from "../frontend/src/features/freezeFloor/images.ts";
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

const publicRoot = new URL("../frontend/public/freeze-floor/", import.meta.url);
const provenance = JSON.parse(
  readFileSync(new URL("provenance.json", publicRoot), "utf8"),
);
const ids = new Set(),
  hashes = new Set();
try {
  for (const sample of VIDEO_SAMPLES) {
    assert.ok(!ids.has(sample.id));
    ids.add(sample.id);
    assert.ok(
      !hashes.has(sample.sha256),
      "Each example must be distinct footage",
    );
    hashes.add(sample.sha256);
    assert.match(sample.file, /^[a-z0-9-]+\.mp4$/);
    assert.match(sample.poster, /^[a-z0-9-]+\.jpg$/);
    const bytes = readFileSync(new URL(`videos/${sample.file}`, publicRoot));
    const record = provenance.videoSamples.find((v) => v.id === sample.id);
    assert.equal(bytes.length, sample.bytes);
    assert.equal(record.sha256, sample.sha256);
    assert.equal(record.source, sample.attribution.url);
    assert.equal(record.licenseUrl, sample.licenseUrl);
    assert.equal(record.creator, sample.attribution.creator);
    assert.equal(record.license, sample.attribution.license);
    const poster = readFileSync(new URL(`videos/${sample.poster}`, publicRoot));
    assert.equal(
      createHash("sha256").update(poster).digest("hex"),
      record.posterSha256,
    );
    const header = readImageHeader(poster);
    assert.ok(header.width > 0 && header.height > 0);
    assert.ok(
      validateProject({
        ...p,
        attribution: sample.attribution,
        videoFrame: { seconds: 1, duration: 5 },
      }),
    );
    globalThis.fetch = async (url, options) => {
      assert.equal(
        url,
        `/Arc-Shot-Evaluator/freeze-floor/videos/${sample.file}`,
      );
      assert.ok(options.signal);
      return new Response(bytes);
    };
    const file = await readSampleVideo(
      sample,
      "/Arc-Shot-Evaluator/",
      new AbortController().signal,
    );
    assert.equal(file.name, sample.file);
    assert.equal(file.size, bytes.length);
    assert.equal(file.type, "video/mp4");
  }
  assert.equal(VIDEO_SAMPLES.length, 4);
  const sample = { ...VIDEO_SAMPLES[0], ...asset };
  const read = (signal) =>
    readSampleVideo(sample, "/", signal ?? new AbortController().signal);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(payload);
  };
  const before = new AbortController();
  before.abort();
  await assert.rejects(read(before.signal), { name: "AbortError" });
  assert.equal(requests, 0, "Already cancelled selection must never download");
  for (const [response, error] of [
    [new Response(null, { status: 404 }), /could not load/],
    [new Response(null), /empty/],
    [new Response(new Uint8Array(3)), /interrupted/],
    [new Response(new Uint8Array(4)), /integrity/],
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(read(), error);
  }
  let cancelled = false;
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
  await assert.rejects(read(), /exceeded/);
  assert.equal(cancelled, true);
  cancelled = false;
  const during = new AbortController();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(payload);
          during.abort();
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(read(during.signal), { name: "AbortError" });
  assert.equal(
    cancelled,
    true,
    "Cancelled reads must release the response stream",
  );
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.error(Error("interrupted example"));
        },
      }),
    );
  await assert.rejects(read(), /interrupted example/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "Freeze Floor examples: four distinct assets, provenance, thumbnails, checksums, bounded downloads, aborts and recoverable failures passed",
);
