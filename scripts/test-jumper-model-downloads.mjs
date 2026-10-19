import assert from 'node:assert/strict';
import { checkedAsset } from '../frontend/src/features/jumper/checkedAsset.ts';

const bytes = Uint8Array.of(1, 2, 3, 4);
const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
const asset = { url: 'model.onnx', sha, maxBytes: 4 };
const original = Object.fromEntries(['fetch', 'caches'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let fetched, puts, deletes, reads, cancelled, cached, response, unavailable;
const reset = () => { fetched = puts = deletes = reads = 0; cancelled = cached = unavailable = false; };
function stream(chunks, headers = {}) {
  let i = 0;
  return new Response(new ReadableStream({
    pull(controller) { reads++; if (i < chunks.length) controller.enqueue(Uint8Array.from(chunks[i++])); else controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers });
}
try {
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: async () => {
    if (unavailable) throw Error('Storage denied');
    return { match: async () => cached ? response : undefined, delete: async () => { deletes++; }, put: async () => { puts++; } };
  } } });
  globalThis.fetch = async () => { fetched++; return response; };
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': '999', 'Content-Encoding': 'gzip' }]) {
    reset(); response = stream([[1, 2], [3, 4]], headers);
    const progress = [];
    assert.deepEqual(new Uint8Array(await checkedAsset(asset, (...args) => progress.push(args), 'https://models.test/')), bytes);
    assert.equal(progress.at(-1)[0], 4); assert.equal(puts, 1); assert.equal(cancelled, false);
  }
  for (const fromCache of [false, true]) {
    reset(); cached = fromCache;
    response = stream([[1, 2], [3, 4, 5], [6, 7]], { 'Content-Length': '1', 'Content-Encoding': 'gzip' });
    const progress = [];
    await assert.rejects(checkedAsset(asset, done => progress.push(done), 'https://models.test/'), /size limit/);
    assert.equal(reads, 2, 'Stop reading at the first oversized chunk');
    assert.equal(cancelled, true); assert.equal(response.body.locked, false);
    assert.equal(puts, 0); assert.equal(deletes, 1); assert.equal(fetched, fromCache ? 0 : 1);
    assert.deepEqual(progress, fromCache ? [] : [2]);
  }
  for (const chunks of [[[1, 2, 3]], [[1, 2, 3, 5]]]) {
    reset(); response = stream(chunks);
    await assert.rejects(checkedAsset(asset, () => {}, 'https://models.test/'), /integrity/);
    assert.equal(puts, 0); assert.equal(deletes, 1);
  }
  reset(); cached = true; response = stream([[1, 2, 3, 4]]);
  assert.deepEqual(new Uint8Array(await checkedAsset(asset, () => { throw Error('Cached bodies should not report download progress'); }, 'https://models.test/')), bytes);
  assert.equal(fetched, 0);
  reset(); unavailable = true; response = stream([[1, 2, 3, 4]]);
  assert.deepEqual(new Uint8Array(await checkedAsset(asset, () => {}, 'https://models.test/')), bytes);
} finally {
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
console.log('Model downloads: streamed/cached byte caps, cancellation, header independence, exact limits, checksums and unavailable cache passed');
