import assert from 'node:assert/strict';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { withPersistenceDeadline, PersistenceDeadlineError, PERSISTENCE_TIMEOUT_MS, PERSISTENCE_CHECK_TIMEOUT_MS } from '../frontend/src/features/playbook/persistenceDeadline.ts';
import { createPlaybookDraftSession } from '../frontend/src/features/playbook/playbookDraftSession.ts';
import { installBrowserLocks } from './helpers/browser-locks.mjs';
const compile = async target => {
 const output = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify(target) }, build: { write: false, lib: { entry: new URL('../frontend/src/features/playbook/api.ts', import.meta.url).pathname, formats: ['es'], fileName: 'api' }, minify: false } });
 const code = (Array.isArray(output) ? output[0] : output).output[0].code;
 return import(`data:text/javascript;base64,${Buffer.from(code + `\n// deadlines ${target}`).toString('base64')}`);
};
const api = await compile('local'), hosted = await compile('github-pages');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const never = () => new Promise(() => {});
const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
let now = 0, next = 0; const timers = new Map();
globalThis.setTimeout = (fn, delay) => { const id = ++next; timers.set(id, { at: now + delay, fn }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
const tick = async ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); };
const draft = { version: 1, id: 'draft-deadline', name: 'Deadline fixture', defenders_visible: false, players: [{ id: 1, x: 50, y: 70 }], defenders: [], ball: null, arrows: [] };
const saved = (id = 'play-deadline01', input = draft) => ({ ...structuredClone(input), id, created_at: '2026-10-15T12:00:00Z', updated_at: '2026-10-15T12:00:01Z' });
const window = new EventTarget(); globalThis.window = window;
let notifications = 0; window.addEventListener('arc-playbooks-changed', () => notifications++);
try {
 let signal;
 const timed = withPersistenceDeadline(s => { signal = s; return never(); });
 const rejected = assert.rejects(timed, PersistenceDeadlineError);
 await flush(); await tick(PERSISTENCE_TIMEOUT_MS - 1); assert.equal(signal.aborted, false);
 await tick(1); await rejected; assert.equal(signal.aborted, true); assert.equal(timers.size, 0);
 assert.equal(await withPersistenceDeadline(async () => 7), 7); assert.equal(timers.size, 0);
 await assert.rejects(withPersistenceDeadline(() => { throw new Error('sync'); }), /sync/); assert.equal(timers.size, 0);

 // Stalled headers and stalled body both release coalesced reads; late data is ignored.
 for (const body of [false, true]) {
  let resolveLate, calls = 0;
  globalThis.fetch = async (_url, options) => {
   calls++; signal = options.signal;
   if (!body) return new Promise(resolve => resolveLate = resolve);
   return { ok: true, text: () => new Promise(resolve => resolveLate = resolve) };
  };
  const first = api.fetchPlaybooks(), second = api.fetchPlaybooks();
  const failures = [assert.rejects(first, /timed out/), assert.rejects(second, /timed out/)];
  await flush(); assert.equal(calls, 1); await tick(PERSISTENCE_TIMEOUT_MS); await Promise.all(failures);
  assert.equal(signal.aborted, true);
  globalThis.fetch = async () => Response.json([saved()]);
  assert.equal((await api.fetchPlaybooks())[0].name, draft.name);
  resolveLate(body ? '[]' : Response.json([])); await flush();
  assert.equal((await api.fetchPlaybooks()).length, 1); assert.equal(timers.size, 0);
 }

 // An interrupted POST is checked using its exact reserved ID, never resent.
 for (const method of ['POST', 'PUT']) for (const body of [false, true]) {
  let value, releaseLate, checks = 0, writes = 0, writeSignal;
  const before = notifications;
  globalThis.fetch = async (url, options) => {
   if (options.method) {
    writes++; writeSignal = options.signal;
    value = saved(method === 'POST' ? options.headers['X-ARC-Create-ID'] : draft.id.replace('draft-', 'play-'), JSON.parse(options.body));
    return body ? { ok: true, json: () => new Promise(resolve => releaseLate = resolve) } : new Promise(resolve => releaseLate = resolve);
   }
   checks++; assert.equal(options.cache, 'no-store'); assert.equal(url, `/api/playbooks/${value.id}`); return Response.json(value);
  };
  const input = method === 'POST' ? draft : saved(draft.id.replace('draft-', 'play-'));
  const session = createPlaybookDraftSession(input); session.edit({ ...input, name: 'New drawing' });
  const request = session.beginSave();
  const promise = method === 'POST' ? api.createPlaybook(request.draft) : api.updatePlaybook(request.draft);
  await flush(); await tick(PERSISTENCE_TIMEOUT_MS);
  const result = await promise; assert.equal(result.id, value.id); assert.equal(result.name, 'New drawing');
  session.completeSave(request, result); assert.equal(session.dirty, false);
  assert.equal(writeSignal.aborted, true); assert.equal(checks, 1); assert.equal(writes, 1); assert.equal(notifications, before + 1);
  releaseLate(body ? value : Response.json(value)); await flush(); assert.equal(notifications, before + 1); assert.equal(timers.size, 0);
 }

 // No false success for a missing/different/malformed result, or when verification stalls.
 for (const verification of ['missing', 'different', 'malformed', 'stalled']) {
  let writes = 0, checks = 0;
  globalThis.fetch = async (url, options) => {
   if (options.method) { writes++; return never(); }
   if (url === '/api/playbooks') return Response.json([input]);
   checks++;
   if (verification === 'stalled') return never();
   if (verification === 'missing') return new Response('', { status: 404 });
   return Response.json(verification === 'malformed' ? {} : saved('play-deadline01', { ...draft, name: 'Someone else changed it' }));
  };
  const before = notifications, input = saved();
  const session = createPlaybookDraftSession(input); session.edit({ ...input, name: 'Unsaved latest' }); const request = session.beginSave();
  const pending = api.updatePlaybook(request.draft); const failure = assert.rejects(pending, /outcome could not be confirmed/);
  let readDone = false; const read = api.fetchPlaybooks().then(() => readDone = true, () => readDone = true);
  await flush(); await tick(PERSISTENCE_TIMEOUT_MS); assert.equal(checks, 1);
  if (verification === 'stalled') { assert.equal(readDone, false); await tick(PERSISTENCE_CHECK_TIMEOUT_MS); }
  // Allow readers released by the failed mutation to use a fresh transport.
  // For immediate verification, the waiting read may already have started.
  globalThis.fetch = async (_url, options) => Response.json(options?.method ? input : [input]);
  await failure; session.failSave(request); assert.equal(session.dirty, true); assert.equal(session.current.name, 'Unsaved latest');
  await tick(PERSISTENCE_TIMEOUT_MS); await read;
  assert.equal(writes, 1); assert.equal(notifications, before); assert.equal(timers.size, 0);
  assert.ok(session.beginSave(), 'save lock is released after uncertainty');
  assert.equal((await api.fetchPlaybooks()).length, 1);
  assert.equal((await api.updatePlaybook(input)).id, input.id, 'per-ID mutation queue accepts a later save');
 }

 // A DELETE that reached storage is confirmed by 404, with no second DELETE.
 let writes = 0;
 globalThis.fetch = async (_url, options) => options.method ? (writes++, never()) : new Response('', { status: 404 });
 const deletion = api.deletePlaybook('play-deadline01'); await flush(); await tick(PERSISTENCE_TIMEOUT_MS);
 assert.deepEqual(await deletion, { deleted: true, id: 'play-deadline01' }); assert.equal(writes, 1);

 // A 2xx DELETE is only an acknowledgement with true and the exact requested ID.
 // Malformed/interrupted responses verify the outcome once, without another write.
 const id = 'play-deadline01';
 const malformedDeletes = [
  () => new Response('', { status: 200 }),
  () => new Response(null, { status: 204 }),
  () => new Response('{invalid JSON'),
  ...[null, [], false, 'deleted', {}, { id }, { deleted: true },
   { deleted: false, id }, { deleted: 'true', id }, { deleted: 1, id },
   { deleted: true, id: 'play-other01' }, { deleted: true, id: null }].map(value => () => Response.json(value)),
  () => ({ ok: true, json: async () => { throw new TypeError('Response body interrupted'); } }),
  () => { throw new TypeError('Connection interrupted after deletion'); },
 ];
 for (const response of malformedDeletes) for (const outcome of ['absent', 'present', 'unavailable', 'invalid']) {
  let writes = 0, checks = 0;
  const before = notifications;
  globalThis.fetch = async (url, options) => {
   assert.equal(url, `/api/playbooks/${id}`);
   if (options.method) { assert.equal(options.method, 'DELETE'); writes++; return response(); }
   checks++; assert.equal(options.cache, 'no-store');
   if (outcome === 'absent') return new Response(null, { status: 404 });
   if (outcome === 'unavailable') throw new TypeError('Verification unavailable');
   return Response.json(outcome === 'invalid' ? {} : saved());
  };
  if (outcome === 'absent') {
   assert.deepEqual(await api.deletePlaybook(id), { deleted: true, id });
   assert.equal(notifications, before + 1, 'announce only the confirmed deletion');
  } else {
   await assert.rejects(api.deletePlaybook(id), /delete response.*outcome could not be confirmed/);
   assert.equal(notifications, before, 'no success notification for uncertain deletion');
  }
  assert.equal(writes, 1); assert.equal(checks, 1); assert.equal(timers.size, 0);
 }
 // Valid acknowledgements need no extra read; explicit server errors stay errors.
 for (const status of [200, 403, 404, 503]) {
  let calls = 0; const before = notifications;
  globalThis.fetch = async (_url, options) => {
   calls++; assert.equal(options.method, 'DELETE');
   return Response.json(status === 200 ? { deleted: true, id } : { detail: 'Deletion rejected' }, { status });
  };
  if (status === 200) {
   assert.deepEqual(await api.deletePlaybook(id), { deleted: true, id });
   assert.equal(notifications, before + 1);
  } else {
   await assert.rejects(api.deletePlaybook(id), /Deletion rejected/);
   assert.equal(notifications, before);
  }
  assert.equal(calls, 1); assert.equal(timers.size, 0);
 }
 console.log('Deletion acknowledgements passed: empty/invalid JSON, incorrect IDs/types, interrupted responses, exact-ID outcome checks and exactly-once notifications');


 for (const verification of ['present', 'stalled']) {
  writes = 0;
  globalThis.fetch = async (_url, options) => {
   if (options.method) { writes++; return never(); }
   return verification === 'stalled' ? never() : Response.json(saved());
  };
  const pending = api.deletePlaybook('play-deadline01');
  const rejected = assert.rejects(pending, /delete response.*outcome could not be confirmed/);
  await flush(); await tick(PERSISTENCE_TIMEOUT_MS);
  if (verification === 'stalled') await tick(PERSISTENCE_CHECK_TIMEOUT_MS);
  await rejected; assert.equal(writes, 1); assert.equal(timers.size, 0);
 }

 // Network interruption also performs a bounded read-only check.
 const value = saved(); writes = 0;
 globalThis.fetch = async (_url, options) => { if (options.method) { writes++; throw new TypeError('Network lost'); } return Response.json(value); };
 assert.equal((await api.updatePlaybook(value)).id, value.id); assert.equal(writes, 1); assert.equal(timers.size, 0);

 // Pending hosted lock acquisition is bounded too; expired callbacks cannot write later.
 const locks = installBrowserLocks(); let release, storageWrites = 0, raw = '[]';
 window.localStorage = { getItem: () => raw, setItem: (_key, value) => { raw = value; storageWrites++; } };
 const holding = locks.request('arc-playbooks-v1:write', {}, () => new Promise(resolve => release = resolve)); await flush();
 const waiting = hosted.createPlaybook(draft), failure = assert.rejects(waiting, /timed out/);
 await flush(); await tick(PERSISTENCE_TIMEOUT_MS); await failure; assert.equal(storageWrites, 0);
 release(); await holding; await flush(); assert.equal(storageWrites, 0);
 await hosted.createPlaybook(draft); assert.equal(storageWrites, 1); assert.equal(timers.size, 0);
 console.log('Persistence deadlines passed: headers/body, coalesced reads, write verification, uncertain outcomes, late results, cleanup, retry, no repeated writes and hosted lock waits');
} finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
