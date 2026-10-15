import assert from 'node:assert/strict';
import { createCounterLabDetailQueue } from '../frontend/src/features/playbook/counterLabDetailQueue.ts';
import { packReplay, unpackReplay, replayResponse } from '../frontend/src/features/playbook/counterLabReplayArchive.ts';
import { createSharedLibraryRead } from '../frontend/src/features/playbook/sharedLibraryRead.ts';
import { createParsedLibraryCache } from '../frontend/src/features/playbook/parsedLibraryCache.ts';
import { createFrameBatch } from '../frontend/src/features/playbook/frameBatch.ts';
import { exportPlaybookPng } from '../frontend/src/features/playbook/exportPlaybookPng.ts';
import { editPlaybookPoint } from '../frontend/src/features/playbook/editPlaybookPoint.ts';
import { createPlaybookDraftSession } from '../frontend/src/features/playbook/playbookDraftSession.ts';

import { createMiniCourtCache } from '../frontend/src/features/playbook/miniCourtGeometry.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { ARROW_VISIBILITY_OPTIONS, routeVisible } from '../frontend/src/features/playbook/arrowVisibility.ts';
import { authoredCourtRoutes } from '../frontend/src/features/playbook/simulation.ts';
import { actionPath, actionPointAt, arrowSequence, markerPoint, screenCutterPath } from '../frontend/src/features/playbook/playbookPaths.ts';

// Exercise resource ownership even when browser APIs fail partway through export.
for (const failure of [null, 'serialize', 'image-constructor', 'svg-url', 'image-source', 'image-load', 'canvas', 'context', 'draw', 'blob-throw', 'blob-null', 'png-url', 'link', 'download']) {
  const descriptors = new Map(['XMLSerializer', 'Image', 'document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const allocated = [], revoked = [], timers = [], drawing = [];
  let image, link, canvas;
  const fail = (stage) => { if (failure === stage) throw new Error(stage); };
  try {
    globalThis.XMLSerializer = class { serializeToString(svg) { fail('serialize'); assert.equal(svg, 'prepared-svg'); return '<svg />'; } };
    globalThis.Image = class {
      constructor() { fail('image-constructor'); image = this; }
      set src(value) { fail('image-source'); assert.equal(value, allocated[0]); queueMicrotask(() => failure === 'image-load' ? this.onerror() : this.onload()); }
    };
    globalThis.window = { setTimeout(callback, delay) { assert.equal(delay, 1000); timers.push(callback); } };
    globalThis.document = { createElement(tag) {
      if (tag === 'canvas') {
        fail('canvas');
        return canvas = {
          getContext(type) {
            assert.equal(type, '2d');
            return failure === 'context' ? null : {
              fillRect(...args) { drawing.push(['fillRect', ...args]); },
              fillText(...args) { drawing.push(['fillText', ...args]); },
              drawImage(source, ...args) { assert.equal(source, image); fail('draw'); drawing.push(['drawImage', ...args]); },
            };
          },
          toBlob(callback, type) { fail('blob-throw'); assert.equal(type, 'image/png'); queueMicrotask(() => callback(failure === 'blob-null' ? null : new Blob(['png'], { type }))); },
        };
      }
      assert.equal(tag, 'a'); fail('link');
      return link = { click() { fail('download'); } };
    } };
    URL.createObjectURL = (blob) => {
      fail(blob.type === 'image/svg+xml' ? 'svg-url' : 'png-url');
      const url = `blob:export-${allocated.length}`; allocated.push(url); return url;
    };
    URL.revokeObjectURL = url => revoked.push(url);
    if (failure) {
      await assert.rejects(exportPlaybookPng('prepared-svg', 'A / Play'), undefined, `${failure}: must reject rather than silently succeed`);
      assert.deepEqual(timers, [], `${failure}: failed downloads release URLs immediately`);
    } else {
      await exportPlaybookPng('prepared-svg', 'A / Play');
      assert.equal(canvas.width, 1600); assert.equal(canvas.height, 1232);
      assert.deepEqual(drawing, [['fillRect', 0, 0, 1600, 1232], ['fillText', 'A / Play', 48, 48], ['drawImage', 0, 80, 1600, 1152]]);
      assert.equal(link.download, 'a-play.png'); assert.equal(link.href, allocated[1]);
      assert.deepEqual(revoked, [allocated[0]], 'successful download stays alive until the delayed cleanup');
      assert.equal(timers.length, 1); timers[0]();
    }
    assert.deepEqual(revoked, allocated, `${failure ?? 'success'}: every allocated URL is released exactly once`);
    if (image) { assert.equal(image.onload, null); assert.equal(image.onerror, null); }
  } finally {
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

// Freeze old branches so any mutation of shared data fails immediately.
const freezeTree = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeTree); Object.freeze(value); }
  return value;
};
const editFixture = freezeTree({
  version: 1, id: 'draft-edit', name: 'Copy branches', defenders_visible: true,
  players: [1, 2].map(id => ({ id, x: id * 10, y: 30, ratings: { threePoint: 4, midrange: 2, finishing: 3 }, badges: ['cutter'] })),
  defenders: [1, 2].map(id => ({ id, x: id * 20, y: 40, badges: ['helper'] })),
  ball: { x: 10, y: 30 },
  arrows: [1, 2].map(id => ({ id: `route-${id}`, kind: 'movement', start: { x: 10, y: 30 }, end: { x: 40, y: 50 }, path: 'straight', control: { x: 20, y: 45 }, exit_target: { x: 60, y: 30 }, actor_id: id, sequence: id })),
});
for (const type of ['player', 'defender', 'ball', 'arrow-start', 'arrow-end', 'arrow-exit', 'arrow-control']) {
  const target = { type, id: type.startsWith('arrow') ? 'route-1' : 1 };
  const point = { x: 75.123456789, y: 65.987654321 };
  const before = structuredClone(editFixture), expected = structuredClone(editFixture);
  const field = type === 'arrow-start' ? 'start' : type === 'arrow-end' ? 'end' : type === 'arrow-exit' ? 'exit_target' : 'control';
  const edited = type === 'player' ? 'players' : type === 'defender' ? 'defenders' : type === 'ball' ? 'ball' : 'arrows';
  if (type === 'ball') expected.ball = { ...point };
  else if (type === 'player' || type === 'defender') Object.assign(expected[edited][0], point);
  else { expected.arrows[0][field] = { ...point }; if (type === 'arrow-control') expected.arrows[0].path = 'curve'; }
  const next = editPlaybookPoint(editFixture, target, point);
  assert.deepEqual(next, expected, `${type}: same edit at full precision`);
  assert.deepEqual(editFixture, before, `${type}: unchanged source`);
  assert.notEqual(next, editFixture);
  for (const branch of ['players', 'defenders', 'arrows', 'ball']) {
    if (branch !== edited) assert.equal(next[branch], editFixture[branch], `${type}: shared untouched ${branch}`);
    else assert.notEqual(next[branch], editFixture[branch]);
  }
  if (type === 'player' || type === 'defender') {
    assert.notEqual(next[edited][0], editFixture[edited][0]);
    assert.equal(next[edited][1], editFixture[edited][1]);
    assert.equal(next[edited][0].badges, editFixture[edited][0].badges);
    assert.equal(next[edited][0].ratings, editFixture[edited][0].ratings);
  } else if (type !== 'ball') {
    assert.equal(next.arrows[1], editFixture.arrows[1]);
    for (const key of ['start', 'end', 'control', 'exit_target']) if (key !== field) assert.equal(next.arrows[0][key], editFixture.arrows[0][key]);
  }
  point.x = 1;
  assert.deepEqual(next, expected, 'caller coordinates cannot mutate the edit');
  const again = editPlaybookPoint(next, target, { x: 15, y: 20 });
  assert.deepEqual(next, expected, 'subsequent edits preserve the earlier drawing');
  const session = createPlaybookDraftSession(editFixture);
  session.edit(again); assert.equal(session.dirty, true);
  session.edit(editFixture); assert.equal(session.dirty, false, 'undo restores saved content');
  session.edit(next); assert.deepEqual(session.current, expected, 'redo restores the exact drawing');
}

const miniCache = createMiniCourtCache();
for (const play of [...STARTER_PLAYS, editFixture, { ...editFixture, players: [], defenders: [], ball: null, arrows: [] }]) {
  for (const { value: visibility } of ARROW_VISIBILITY_OPTIONS) {
    const before = structuredClone(play);
    const preview = miniCache(play, visibility);
    const routes = authoredCourtRoutes(play);
    const visible = play.arrows.filter(arrow => routes.some(route => route.actionId === arrow.id && routeVisible(route, visibility)));
    assert.deepEqual(preview.arrows.map(a => a.id), visible.map(a => a.id));
    for (const arrow of visible) {
      const prepared = preview.arrows.find(a => a.id === arrow.id);
      assert.equal(prepared.path, actionPath(arrow));
      assert.equal(prepared.supportPath, screenCutterPath(arrow, play.players));
      assert.equal(prepared.sequence, arrowSequence(arrow, play.arrows.indexOf(arrow)), 'filtering never renumbers original actions');
      assert.deepEqual(prepared.badge, markerPoint(actionPointAt(arrow, 0.5)));
      assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.badge));
    }
    assert.equal(preview.players.length, play.players.length);
    assert.equal(preview.defenders.length, play.defenders_visible ? play.defenders.length : 0);
    assert.deepEqual(preview.ball, play.ball ? markerPoint(play.ball) : null);
    assert.deepEqual(play, before, 'preparation preserves source documents');
    const refreshed = { ...structuredClone(play), id: 'fresh-id', name: 'New title', created_at: 'changed', updated_at: 'changed' };
    assert.equal(miniCache(refreshed, visibility), preview, 'fresh documents and metadata-only changes reuse all prepared geometry');
    assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview.players) && Object.isFrozen(preview.arrows));
    assert.throws(() => preview.arrows.push({}), TypeError);
    if (preview.players.length) assert.throws(() => { preview.players[0].x++; }, TypeError);
  }
}
const miniBaseline = miniCache(editFixture, 'all');
for (const mutate of [
  p => { p.players[0].x++; }, p => { p.players[0].id = 7; },
  p => { p.players[0].ratings.finishing++; }, p => { p.players[0].badges = ['slasher']; },
  p => { p.defenders[0].y++; }, p => { p.defenders_visible = false; }, p => { p.ball.x++; },
  p => { p.arrows[0].end.x++; }, p => { p.arrows[0].start.y++; }, p => { p.arrows[0].control.x++; },
  p => { p.arrows[0].path = 'curve'; }, p => { p.arrows[0].kind = 'pass'; },
  p => { p.arrows[0].actor_id = 2; }, p => { p.arrows[0].recipient_id = 2; },
  p => { p.arrows[0].screener_id = 2; }, p => { p.arrows[0].cutter_id = 2; },
  p => { p.arrows[0].handler_id = 2; }, p => { p.arrows[0].sequence = 7; },
  p => { p.arrows[0].timing = 3; }, p => { p.arrows[0].exit_target.y++; },
  p => { p.arrows.reverse(); }, p => { p.players.reverse(); },
]) {
  const changed = structuredClone(editFixture); mutate(changed);
  const preview = miniCache(changed, 'all');
  assert.notEqual(preview, miniBaseline, 'every binding/render input invalidates the cache');
  assert.deepEqual(preview, createMiniCourtCache(0)(changed, 'all'), 'changed content renders immediately, without stale cached geometry');
}
assert.notEqual(miniCache(editFixture, 'off'), miniBaseline);
assert.equal(miniCache(editFixture, 'off').arrows.length, 0);
const numbered = { ...structuredClone(editFixture), arrows: editFixture.arrows.map((a, i) => ({ ...a, sequence: i ? 9 : 4 })) };
assert.deepEqual(miniCache(numbered, 'all').arrows.map(a => a.sequence), [4, 9]);
const boundedMini = createMiniCourtCache(2);
const firstMini = boundedMini(editFixture, 'off');
const originalAllMini = boundedMini(editFixture, 'all'); boundedMini(editFixture, 'off'); boundedMini(editFixture, 'main-on-ball');
assert.equal(boundedMini(editFixture, 'off'), firstMini, 'recently used previews survive eviction');
const evictedMini = boundedMini(editFixture, 'all');
assert.notEqual(evictedMini, originalAllMini, 'least recently used preview is rebuilt after eviction');
for (const cache of [createMiniCourtCache(0), createMiniCourtCache(128, 1)]) {
  assert.notEqual(cache(editFixture, 'all'), cache(editFixture, 'all'), 'disabled or oversized entries are never retained');
}

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
// Superseded selections never reach the response allocator. The final request
// retains its complete identity and both full-precision comparison replays.
const detailResponses = [], allocations = [];
const detailQueue = createCounterLabDetailQueue(request => {
  allocations.push(request.detailId);
  const original = replayResponse(archive);
  const repaired = request.repairId === 'original' ? null : replayResponse(archive);
  detailResponses.push(structuredClone({ ...request, original: original.archive, repaired: repaired?.archive ?? null },
    { transfer: [...original.transfer, ...(repaired?.transfer ?? [])] }));
});
const settleDetails = () => new Promise(resolve => setTimeout(resolve, 10));
const detailRequest = { type: 'details', id: 'report', detailId: 'first', key: 'switch:scripted', repairId: 'original' };
for (let i = 0; i < 100; i++) detailQueue.request({ ...detailRequest, detailId: `superseded-${i}`, key: `defense-${i}:adaptive`, repairId: `repair-${i}` });
const finalRequest = { ...detailRequest, detailId: 'latest', key: 'drop:adaptive', repairId: 'slip-screen' };
detailQueue.request(finalRequest);
assert.equal(allocations.length, 0, 'no outgoing buffers are allocated before yielding to selection messages');
await settleDetails();
assert.deepEqual(allocations, ['latest'], 'only the latest pending replay allocates response buffers');
assert.deepEqual(detailResponses[0], { ...finalRequest, original: archive, repaired: archive });
assert.deepEqual(unpackReplay(detailResponses[0].original), frames);
assert.deepEqual(unpackReplay(detailResponses[0].repaired), frames);
assert.deepEqual(unpackReplay(archive), frames, 'coalescing and transfer preserve reusable worker archives');
detailQueue.request({ ...detailRequest, detailId: 'released' });
detailQueue.release('report');
await settleDetails();
assert.equal(allocations.length, 1, 'releasing a report cancels its pending replay before allocation');
detailQueue.request({ ...detailRequest, id: 'new-report', detailId: 'new-report-detail' });
detailQueue.release('report');
await settleDetails();
assert.equal(allocations.at(-1), 'new-report-detail', 'releasing an older report cannot cancel the current selection');
assert.equal(detailResponses.at(-1).repaired, null, 'original-only requests keep their original response shape');
detailQueue.request({ ...detailRequest, detailId: 'retry' });
await settleDetails();
assert.equal(allocations.at(-1), 'retry', 'later retries still receive a response after a queue flush or release');

assert.deepEqual(unpackReplay(packReplay([])), []);
assert.throws(() => unpackReplay({ ...archive, version: 2 }), /Unsupported/);
assert.throws(() => unpackReplay({ ...archive, roots: new Uint32Array([4294967295]).buffer }), /incomplete/);
console.log(`Performance regressions passed: superseded replay requests, content-keyed mini-courts, PNG success/failure cleanup, immutable point edits and branch sharing, unchanged JSON reuse, immutable cached libraries, visible parse/source errors, shared reads, write barriers, retry/storage invalidation, lossless replay tables, independent transfers; fixture replay ${bytes} bytes versus ${JSON.stringify(frames).length * 2} bytes of JSON`);
