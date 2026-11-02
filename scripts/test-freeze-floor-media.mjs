import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
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
const modelUrl = "https://test.invalid/model";
let cached, reads = 0, writes = 0, removals = 0, requestOptions;
let fetched = () => new Response(payload);
const cache = {
  match: async (url) => { assert.equal(url, modelUrl); return cached?.(); },
  delete: async (url) => {
    assert.equal(url, modelUrl, "eviction must target only the rejected model");
    cached = undefined;
    removals++;
    return true;
  },
  put: async (url, response) => {
    assert.equal(url, modelUrl);
    const b = await response.arrayBuffer();
    cached = () => new Response(b);
    writes++;
  },
};
const storage = { open: async (name) => {
  assert.equal(name, "arc-freeze-floor-models-v1");
  return cache;
} };
const reset = (entry) => {
  cached = entry;
  reads = writes = removals = 0;
  requestOptions = undefined;
  fetched = () => new Response(payload);
  globalThis.caches = storage;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, modelUrl);
    reads++;
    requestOptions = options;
    return fetched();
  };
};
const interrupted = () => new Response(new ReadableStream({ start(c) {
  c.error(Error("interrupted stream"));
} }));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const load = (signal) => checkedAsset(modelUrl, asset, signal);
try {
  for (const entry of [
    () => new Response(new Uint8Array(5)),
    () => new Response(new Uint8Array([9])),
    () => new Response(null),
    () => new Response(null, { status: 500 }),
    interrupted,
  ]) {
    reset(entry);
    assert.deepEqual(await load(), payload);
    assert.deepEqual([removals, reads, writes], [1, 1, 1]);
    assert.equal(requestOptions.cache, "reload", "recovery bypasses the HTTP cache");
    assert.deepEqual(await load(), payload);
    assert.deepEqual([removals, reads, writes], [1, 1, 1],
      "verified cache hits must not download or rewrite");
  }
  reset(undefined);
  assert.deepEqual(await load(), payload);
  assert.deepEqual([removals, reads, writes], [0, 1, 1]);
  assert.equal(requestOptions.cache, "default");

  // Neither a cache miss nor a rejected hit may retry a failed fresh response
  for (const entry of [undefined, () => new Response(new Uint8Array([9]))]) {
    for (const [download, error] of [
      [() => new Response(null, { status: 404 }), /download failed/],
      [() => new Response(null), /empty/],
      [() => new Response(new Uint8Array([9])), /integrity/],
      [() => new Response(new Uint8Array(5)), /size limit/],
      [interrupted, /interrupted stream/],
      [() => { throw Error("offline"); }, /offline/],
    ]) {
      reset(entry);
      fetched = download;
      await assert.rejects(load(), error);
      assert.deepEqual([removals, reads, writes], [entry ? 1 : 0, 1, 0]);
      assert.equal(cached, undefined, "a failed download must not enter storage");
    }
  }
  reset(() => new Response(new Uint8Array([9])));
  let cancelled = false;
  fetched = () => new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(load(), /size limit/);
  assert.ok(cancelled, "the recovery stream is cancelled on actual-byte overflow");
  assert.deepEqual([removals, reads, writes], [1, 1, 0]);

  reset(() => new Response(new Uint8Array([9])));
  const before = new AbortController();
  before.abort();
  await assert.rejects(load(before.signal), { name: "AbortError" });
  assert.deepEqual([removals, reads, writes], [0, 0, 0]);

  // Cancellation of a cached read is not corruption and must never start recovery
  reset(undefined);
  const reading = deferred(), duringRead = new AbortController();
  let cachedCancelled = false;
  const response = new Response(new ReadableStream({
    pull() { reading.resolve(); },
    cancel() { cachedCancelled = true; },
  }, { highWaterMark: 0 }));
  cached = () => response;
  const readAbort = assert.rejects(load(duringRead.signal), { name: "AbortError" });
  await reading.promise;
  duringRead.abort();
  await readAbort;
  assert.ok(cachedCancelled);
  assert.equal(response.body.locked, false);
  assert.deepEqual([removals, reads, writes], [0, 0, 0]);

  // Cancellation during eviction cannot slip through to the recovery fetch
  reset(() => new Response(new Uint8Array([9])));
  const deleting = deferred(), resumeDelete = deferred(), duringDelete = new AbortController();
  const remove = cache.delete;
  cache.delete = async (...args) => { deleting.resolve(); await resumeDelete.promise; return remove(...args); };
  try {
    const deleteAbort = assert.rejects(load(duringDelete.signal), { name: "AbortError" });
    await deleting.promise;
    duringDelete.abort();
    resumeDelete.resolve();
    await deleteAbort;
    assert.deepEqual([removals, reads, writes], [1, 0, 0]);
  } finally { cache.delete = remove; }

  reset(() => new Response(new Uint8Array([9])));
  const downloading = deferred(), duringDownload = new AbortController();
  let freshCancelled = false;
  const fresh = new Response(new ReadableStream({
    pull() { downloading.resolve(); },
    cancel() { freshCancelled = true; },
  }, { highWaterMark: 0 }));
  fetched = () => fresh;
  const downloadAbort = assert.rejects(load(duringDownload.signal), { name: "AbortError" });
  await downloading.promise;
  assert.equal(requestOptions.signal.aborted, false);
  duringDownload.abort();
  await downloadAbort;
  assert.equal(requestOptions.signal.aborted, true);
  assert.ok(freshCancelled);
  assert.equal(fresh.body.locked, false);
  assert.deepEqual([removals, reads, writes], [1, 1, 0]);

  reset(undefined);
  globalThis.caches = { open: async () => { throw Error("storage blocked"); } };
  assert.deepEqual(await load(), payload, "unavailable caching must remain playable");
  assert.deepEqual([reads, writes], [1, 0]);

  // Simulated elapsed time keeps inactivity checks deterministic and fast
  mock.timers.enable({ apis: ["setTimeout"] });
  const idleMs = 30_000;
  const nextTurn = () => new Promise(setImmediate);
  try {
    for (const entry of [undefined, () => new Response(new Uint8Array([9]))]) {
      for (const partial of [false, true]) {
        reset(entry);
        const ready = deferred();
        let streamCancelled = false;
        const stalled = new Response(new ReadableStream({
          start(c) { if (partial) c.enqueue(payload.slice(0, 1)); },
          pull() { ready.resolve(); },
          cancel() { streamCancelled = true; },
        }, { highWaterMark: 0 }));
        fetched = () => stalled;
        const rejected = assert.rejects(load(), /Model download stalled.*30 seconds.*Retry/);
        await ready.promise;
        mock.timers.tick(idleMs);
        await nextTurn();
        assert.equal(streamCancelled, true, "an idle response must release its stream promptly");
        await rejected;
        assert.equal(stalled.body.locked, false);
        assert.deepEqual([removals, reads, writes], [entry ? 1 : 0, 1, 0],
          "a stalled fresh copy must not retry or enter the cache");
      }
    }

    reset(undefined);
    const headers = deferred();
    let headerCancelled = false;
    fetched = () => new Promise((_resolve, reject) => {
      requestOptions.signal?.addEventListener("abort", () => {
        headerCancelled = true;
        reject(new DOMException("Network aborted", "AbortError"));
      }, { once: true });
      headers.resolve();
    });
    const noHeaders = assert.rejects(load(), /Model download stalled/);
    await headers.promise;
    mock.timers.tick(idleMs);
    await nextTurn();
    assert.equal(headerCancelled, true, "waiting for response headers is also download inactivity");
    await noHeaders;

    reset(undefined);
    let controller;
    const started = deferred();
    fetched = () => new Response(new ReadableStream({
      start(c) { controller = c; started.resolve(); },
    }));
    const slow = load();
    await started.promise;
    await nextTurn();
    for (const byte of payload) {
      mock.timers.tick(idleMs - 1);
      controller.enqueue(Uint8Array.of(byte));
      await nextTurn();
      assert.equal(requestOptions.signal.aborted, false,
        "received bytes reset the deadline even when total download time exceeds it");
    }
    controller.close();
    assert.deepEqual(await slow, payload);
    mock.timers.tick(idleMs * 2);
    assert.equal(requestOptions.signal.aborted, false, "successful reads clear the deadline");
    assert.deepEqual([reads, writes], [1, 1]);

    reset(undefined);
    const hashing = deferred(), finishHashing = deferred();
    const originalDigest = crypto.subtle.digest;
    crypto.subtle.digest = async function (...args) {
      hashing.resolve();
      await finishHashing.promise;
      return originalDigest.apply(this, args);
    };
    try {
      const checking = load();
      await hashing.promise;
      mock.timers.tick(idleMs * 2);
      assert.equal(requestOptions.signal.aborted, false, "slow checksum work is processing, not stalled download data");
      finishHashing.resolve();
      assert.deepEqual(await checking, payload);
    } finally {
      finishHashing.resolve();
      crypto.subtle.digest = originalDigest;
    }

    reset(undefined);
    let emptyController, emptyCancelled = false;
    const emptyReady = deferred();
    fetched = () => new Response(new ReadableStream({
      start(c) { emptyController = c; emptyReady.resolve(); },
      cancel() { emptyCancelled = true; },
    }));
    const empty = assert.rejects(load(), /Model download stalled/);
    await emptyReady.promise;
    await nextTurn();
    mock.timers.tick(idleMs - 1);
    emptyController.enqueue(new Uint8Array(0));
    await nextTurn();
    mock.timers.tick(1);
    await nextTurn();
    assert.equal(emptyCancelled, true, "empty chunks must not extend the deadline");
    await empty;

    reset(undefined);
    const abortReady = deferred(), abortIdle = new AbortController();
    fetched = () => new Response(new ReadableStream({ pull() { abortReady.resolve(); } }, { highWaterMark: 0 }));
    const cancelled = assert.rejects(load(abortIdle.signal), { name: "AbortError" });
    await abortReady.promise;
    mock.timers.tick(idleMs - 1);
    abortIdle.abort();
    await cancelled;
    mock.timers.tick(idleMs * 2);
    assert.deepEqual([removals, reads, writes], [0, 1, 0], "cancellation never becomes recovery or a late cache write");
  } finally {
    mock.timers.reset();
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
}
console.log(
  "Freeze Floor media: video limits, seek bounds, timestamps, still metadata, one-shot corrupt-cache recovery, strict fresh-response verification, byte limits, inactivity deadlines, cancellation and cache reuse passed",
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
