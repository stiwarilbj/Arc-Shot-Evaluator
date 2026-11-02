import assert from "node:assert/strict";
import { normalizeImage } from "../frontend/src/features/freezeFloor/images.ts";

const header = new Uint8Array(24);
header.set([137, 80, 78, 71, 13, 10, 26, 10]);
header.set([73, 72, 68, 82], 12);
new DataView(header.buffer).setUint32(16, 1600);
new DataView(header.buffer).setUint32(20, 1200);
const source = new Blob([header], { type: "image/png" });
const output = new Blob(["normalized"], { type: "image/jpeg" });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const originals = ["document", "createImageBitmap"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
let decodes, closes, draws, conversions, canvas, onDecode, onDraw, onEncode, contextAvailable, dimensions;
function reset() {
  decodes = closes = draws = conversions = 0;
  canvas = undefined;
  onDecode = onDraw = onEncode = undefined;
  contextAvailable = true;
  dimensions = { width: 1600, height: 1200 };
}
globalThis.createImageBitmap = async (_, options) => {
  decodes++;
  assert.equal(options.imageOrientation, "from-image");
  const bitmap = { ...dimensions, close() { closes++; } };
  return onDecode ? onDecode(bitmap) : bitmap;
};
globalThis.document = { createElement(tag) {
  assert.equal(tag, "canvas");
  canvas = { width: 0, height: 0,
    getContext() { return contextAvailable ? {
      fillRect() {},
      drawImage() { draws++; onDraw?.(); },
    } : null; },
    toBlob(callback, type, quality) {
      conversions++;
      assert.equal(closes, 1, "release the full-resolution bitmap before conversion");
      assert.equal(type, "image/jpeg");
      assert.equal(quality, 0.92);
      if (onEncode) onEncode(callback); else callback(output);
    },
  };
  return canvas;
} };
const aborted = (p) => assert.rejects(p, { name: "AbortError" });
const releasedCanvas = () => assert.deepEqual([canvas.width, canvas.height], [0, 0]);
try {
  reset();
  const cancelled = new AbortController();
  cancelled.abort();
  await aborted(normalizeImage(source, { signal: cancelled.signal }));
  await aborted(normalizeImage(source, { isCurrent: () => false }));
  assert.equal(decodes, 0, "obsolete jobs never decode");

  for (const change of ["abort", "identity"]) {
    reset();
    const gate = deferred(), started = deferred(), controller = new AbortController();
    let current = true;
    const pendingHeader = { size: source.size, slice: () => ({ arrayBuffer() {
      started.resolve();
      return gate.promise;
    } }) };
    const pending = aborted(normalizeImage(pendingHeader, { signal: controller.signal, isCurrent: () => current }));
    await started.promise;
    if (change === "abort") controller.abort(); else current = false;
    gate.resolve(header.buffer);
    await pending;
    assert.equal(decodes, 0, "a superseded header read must not start decoding");

    reset();
    const decoded = deferred(), began = deferred(), c = new AbortController();
    current = true;
    onDecode = async (bitmap) => { began.resolve(); await decoded.promise; return bitmap; };
    const decoding = aborted(normalizeImage(source, { signal: c.signal, isCurrent: () => current }));
    await began.promise;
    if (change === "abort") c.abort(); else current = false;
    decoded.resolve();
    await decoding;
    assert.equal(closes, 1, "a late decoded bitmap closes exactly once");
    assert.equal(canvas, undefined, "stale decoding cannot allocate a conversion canvas");
    assert.equal(conversions, 0);
  }

  reset();
  const c = new AbortController();
  onDraw = () => c.abort();
  await aborted(normalizeImage(source, { signal: c.signal }));
  assert.equal(conversions, 0, "cancellation before conversion skips encoding");
  assert.equal(closes, 1);
  releasedCanvas();

  reset();
  const encoded = deferred(), entered = deferred(), conversion = new AbortController();
  onEncode = async (callback) => { entered.resolve(); await encoded.promise; callback(output); };
  const encoding = aborted(normalizeImage(source, { signal: conversion.signal }));
  await entered.promise;
  conversion.abort();
  assert.equal(closes, 1);
  encoded.resolve();
  await encoding;
  releasedCanvas();

  for (const failure of ["context", "draw", "encode", "dimensions"]) {
    reset();
    if (failure === "context") contextAvailable = false;
    if (failure === "draw") onDraw = () => { throw Error("draw failed"); };
    if (failure === "encode") onEncode = (callback) => callback(null);
    if (failure === "dimensions") dimensions = { width: 10000, height: 10000 };
    await assert.rejects(normalizeImage(source));
    assert.equal(closes, 1);
    if (canvas) releasedCanvas();
  }

  for (const [width, height, expected] of [[4000, 3000, [2048, 1536]], [1200, 1600, [1200, 1600]]]) {
    reset();
    dimensions = { width, height };
    const result = await normalizeImage(source);
    assert.deepEqual([result.width, result.height], expected);
    assert.strictEqual(result.blob, output);
    assert.deepEqual([decodes, closes, draws, conversions], [1, 1, 1, 1]);
    releasedCanvas();
  }
  console.log("Freeze Floor image loading: pre-abort, identity changes, delayed headers/decodes/conversions, early bitmap release, canvas cleanup, failures, orientation and resize passed");
} finally {
  for (const [key, descriptor] of originals)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
}
