import assert from 'node:assert/strict';
import { packReplay, unpackReplay, replayResponse } from '../frontend/src/features/playbook/counterLabReplayArchive.ts';
import { createSharedLibraryRead } from '../frontend/src/features/playbook/sharedLibraryRead.ts';
import { createParsedLibraryCache } from '../frontend/src/features/playbook/parsedLibraryCache.ts';
import { createFrameBatch } from '../frontend/src/features/playbook/frameBatch.ts';

for (const hz of [30, 60, 120]) {
  let nextId = 0;
  const frames = new Map(), applied = [];
  const batch = createFrameBatch((value) => applied.push(value),
    (callback) => { frames.set(++nextId, callback); return nextId; },
    (id) => frames.delete(id));
  for (let frame = 0; frame < hz; frame++) {
    for (let move = 0; move < 100; move++) batch.queue({ x: frame * 100 + move });
    assert.equal(frames.size, 1, 'a burst of pointer input schedules one display update');
    const callback = [...frames.values()][0]; frames.clear(); callback();
    assert.deepEqual(applied.at(-1), { x: frame * 100 + 99 });
  }
  assert.equal(applied.length, hz, 'updates follow display frames, not input frequency');
  batch.queue({ x: 1000 }); batch.queue({ x: 1001 });
  batch.flush({ x: 1002 });
  assert.deepEqual(applied.at(-1), { x: 1002 }, 'pointer-up overrides queued movement with its final position');
  assert.equal(frames.size, 0, 'the flushed frame cannot update again after drag completion');
  const count = applied.length;
  batch.flush(); assert.equal(applied.length, count, 'empty completion does not create another edit');
  batch.queue({ x: 2000 }); batch.cancel(); batch.flush();
  assert.equal(applied.length, count, 'cancelled or unmounted work never applies');
  assert.equal(frames.size, 0);
  batch.queue({ x: 3000 }); batch.flush();
  assert.deepEqual(applied.at(-1), { x: 3000 }, 'the next gesture can reuse the scheduler');
}

for (const asyncLoad of [false, true]) {
  let parses = 0, validations = 0, reads = 0, unavailable = false;
  let content = '[{"id":"one","players":[{"id":1,"x":20}],"arrows":[]}]';
  const originalParse = JSON.parse;
  JSON.parse = (...args) => { parses++; return originalParse(...args); };
  try {
    const parse = createParsedLibraryCache((value) => {
      validations++;
      assert.ok(Array.isArray(value), 'invalid libraries still fail validation');
      return value;
    });
    const reader = createSharedLibraryRead(() => {
      reads++;
      if (unavailable) throw new Error('Source unavailable');
      return asyncLoad ? Promise.resolve(content).then(parse) : parse(content);
    });
    const first = await reader.read();
    first[0].players[0].x = 99; first.push({ id: 'caller edit' });
    assert.deepEqual(await reader.read(), originalParse(content), 'caller mutations cannot reach cached documents');
    assert.equal(reads, 2, 'every settled refresh still checks the underlying source');
    assert.equal(parses, 1); assert.equal(validations, 1, 'identical content skips parsing and validation');
    const retained = parse(content);
    assert.ok(Object.isFrozen(retained[0].players[0]));
    assert.throws(() => { retained[0].players[0].x = 50; }, TypeError);
    assert.throws(() => retained.push({}), TypeError, 'the retained library is immutable');
    reader.invalidate(); await reader.read();
    assert.equal(parses, 1, 'persistence notifications do not discard an identical parse');
    content = content.replace('20', '21');
    assert.equal((await reader.read())[0].players[0].x, 21);
    assert.equal(parses, 2); assert.equal(validations, 2, 'changed content is processed');
    content = ` ${content}`; await reader.read();
    assert.equal(parses, 3, 'comparison uses exact JSON content, including whitespace');
    const valid = content;
    content = '{broken';
    await assert.rejects(reader.read(), SyntaxError); await assert.rejects(reader.read(), SyntaxError);
    assert.equal(parses, 5, 'malformed JSON is never cached or hidden by a previous success');
    content = '{}';
    await assert.rejects(reader.read()); await assert.rejects(reader.read());
    assert.equal(validations, 5, 'validation errors also remain visible on every retry');
    content = valid; await reader.read();
    assert.equal(parses, 7, 'failures preserve only the last successful parse');
    unavailable = true; await assert.rejects(reader.read(), /unavailable/);
    unavailable = false; await reader.read();
    assert.equal(parses, 7, 'recovery can reuse identical content after checking the source');
    content = '[]'; assert.deepEqual(await reader.read(), []);
    content = valid; await reader.read();
    assert.equal(parses, 9, 'only one successful content value is retained');
  } finally { JSON.parse = originalParse; }
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
for (const asyncLoad of [false, true]) {
  let count = 0, library = [{ id: 'one', name: 'Original' }];
  const reader = createSharedLibraryRead(() => { count++; return asyncLoad ? Promise.resolve(library) : library; });
  const [a, b] = await Promise.all([reader.read(), reader.read()]);
  assert.equal(count, 1, 'concurrent storage/API reads coalesce');
  a[0].name = 'caller edit';
  assert.equal(b[0].name, 'Original', 'callers receive isolated libraries');
  await reader.read(); assert.equal(count, 2, 'completed reads are not retained');
  const write = deferred();
  const mutation = reader.mutate(async () => { await write.promise; library = [{ id: 'new', name: 'Saved' }]; });
  const during = [reader.read(), reader.read()];
  await flush(); assert.equal(count, 2, 'readers wait for saves');
  write.resolve(); await mutation;
  assert.deepEqual(await Promise.all(during), [library, library]);
  assert.equal(count, 3, 'post-save readers share the fresh library');
  await reader.mutate(() => { library = []; });
  assert.deepEqual(await reader.read(), [], 'deletions invalidate earlier results');
}
{
  const loads = []; let value = [{ id: 'old' }];
  const reader = createSharedLibraryRead(() => { const read = deferred(); loads.push(read); return read.promise; });
  const old = reader.read(); await flush();
  const write = deferred();
  const mutation = reader.mutate(async () => { await write.promise; value = [{ id: 'new' }]; });
  const fresh = reader.read(); loads[0].resolve([{ id: 'old' }]);
  await flush(); assert.equal(loads.length, 1, 'stale responses cannot escape the write barrier');
  write.resolve(); await mutation; await flush();
  assert.equal(loads.length, 2);
  loads[1].resolve(value);
  assert.deepEqual(await old, value); assert.deepEqual(await fresh, value);
  const failed = reader.read(); await flush();
  const failedWrite = reader.mutate(() => { throw new Error('save failed'); });
  await assert.rejects(failedWrite, /save failed/);
  loads[2].reject(new Error('obsolete read failed')); await flush();
  loads[3].resolve(value); assert.deepEqual(await failed, value, 'stale errors retry after failed writes');
  const broken = reader.read(); await flush(); loads[4].reject(new Error('unavailable'));
  await assert.rejects(broken, /unavailable/);
  const retry = reader.read(); await flush(); loads[5].resolve(value);
  assert.deepEqual(await retry, value, 'failed reads are retryable');
}
{
  const writes = [deferred(), deferred()]; let reads = 0;
  const reader = createSharedLibraryRead(() => { reads++; return ['latest']; });
  const a = reader.mutate(() => writes[0].promise), b = reader.mutate(() => writes[1].promise);
  const result = reader.read(); writes[0].resolve(); await a; await flush();
  assert.equal(reads, 0, 'overlapping writes keep the barrier until both finish');
  writes[1].resolve(); await b; assert.deepEqual(await result, ['latest']);
  const pending = reader.read(); reader.invalidate();
  assert.deepEqual(await pending, ['latest'], 'external storage invalidation refreshes pending reads');
}

const route = { id: 'curve', actionId: 'move-1', sequence: 7, kind: 'movement', playerId: 2,
  scope: 'on-ball', importance: 'main', start: { x: -0, y: 18.123456789012345 }, end: { x: 60, y: 45 },
  control: { x: 40.98765432109876, y: 50 }, via: { x: 25, y: 40 }, points: [{ x: 20, y: 30 }, { x: 40, y: 50 }] };
const frame = { elapsedMs: 1000 / 30, sequence: 7, action: 'Pass · Cut', ballHandlerId: 2, assignments: [{ defenderId: 1, playerId: 2 }],
  opportunities: [{ kind: 'pass', playerId: 3, quality: NaN, score: Infinity, receiverGap: -Infinity, laneGap: .12345678901234567 }],
  blockedPass: null, involvedPlayerIds: [2, 3], execution: undefined, activeRoutes: [route],
  players: [{ id: 2, x: 18.123456789012345, y: -0 }], defenders: [], ball: { x: 21, y: 30 }, shotPhase: 'idle' };
const frames = Array.from({ length: 120 }, (_, i) => ({ ...structuredClone(frame), elapsedMs: i * 1000 / 30 }));
frames[50].ball = null; frames[75].ballHandlerId = 3; frames[90].shotPhase = 'air'; delete frames[100].execution;
const archive = packReplay(frames), decoded = unpackReplay(archive);
assert.deepEqual(decoded, frames, 'all samples and optional fields survive without rounding');
assert.equal(decoded[0].activeRoutes, decoded[1].activeRoutes, 'identical route metadata is stored and decoded once');
assert.ok(Object.isFrozen(decoded[0].activeRoutes[0].control));
const bytes = archive.roots.byteLength + archive.offsets.byteLength + archive.tokens.byteLength + archive.numbers.byteLength + JSON.stringify(archive.strings).length * 2;
assert.ok(bytes < JSON.stringify(frames).length * 2, 'repeated metadata uses less replay storage');
const retainedSizes = [archive.roots.byteLength, archive.offsets.byteLength, archive.tokens.byteLength, archive.numbers.byteLength];
for (let i = 0; i < 2; i++) {
  const outgoing = replayResponse(archive), received = structuredClone(outgoing.archive, { transfer: outgoing.transfer });
  assert.ok(outgoing.transfer.every((buffer) => buffer.byteLength === 0), 'outgoing buffers detach on transfer');
  assert.deepEqual(unpackReplay(received), frames);
  assert.deepEqual([archive.roots.byteLength, archive.offsets.byteLength, archive.tokens.byteLength, archive.numbers.byteLength], retainedSizes, 'transfer never detaches reusable source data');
}
assert.deepEqual(unpackReplay(packReplay([])), []);
assert.throws(() => unpackReplay({ ...archive, version: 2 }), /Unsupported/);
assert.throws(() => unpackReplay({ ...archive, roots: new Uint32Array([4294967295]).buffer }), /incomplete/);
console.log(`Performance regressions passed: unchanged JSON reuse, immutable cached libraries, visible parse/source errors, shared reads, write barriers, retry/storage invalidation, lossless replay tables, independent transfers; fixture replay ${bytes} bytes versus ${JSON.stringify(frames).length * 2} bytes of JSON`);
