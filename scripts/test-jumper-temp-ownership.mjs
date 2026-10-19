import assert from 'node:assert/strict';
import { retainTemporaryMedia, discardAbandonedMedia } from '../frontend/src/features/jumper/temporaryMedia.ts';
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const locks = new Set(), deleted = [];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
  async request(key, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (locks.has(key)) {
      assert(options.ifAvailable, 'test must not queue a second owner');
      return callback(null);
    }
    locks.add(key);
    try { return await callback({name:key}); }
    finally { locks.delete(key); }
  },
}}});
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
  deleteDatabase(name) {
    deleted.push(name);
    const request = {};
    queueMicrotask(() => request.onsuccess());
    return request;
  },
}});
try {
  const release = await retainTemporaryMedia('old-active-job');
  // Wall-clock age and absent heartbeats do not override an explicit live owner.
  assert.equal(await discardAbandonedMedia('old-active-job'), false);
  assert.deepEqual(deleted, []);
  assert.equal(await discardAbandonedMedia('abandoned-job'), true);
  assert.deepEqual(deleted, ['abandoned-job']);
  release(); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await discardAbandonedMedia('old-active-job'), true);
  assert.equal(locks.size, 0);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  assert.equal(await discardAbandonedMedia('unknown-owner'), false);
  await assert.rejects(retainTemporaryMedia('no-locks'), /ownership unavailable/);
  assert(!deleted.includes('unknown-owner'));
  console.log('Private temporary media: live ownership, age-independent refusal, independent jobs, released owners and safe unsupported fallback passed');
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  if (originalDB) Object.defineProperty(globalThis, 'indexedDB', originalDB); else delete globalThis.indexedDB;
}
