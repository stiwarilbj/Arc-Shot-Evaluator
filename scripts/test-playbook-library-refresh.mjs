import assert from 'node:assert/strict';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';

const output = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify('local') }, build: { write: false, lib: { entry: new URL('../frontend/src/features/playbook/api.ts', import.meta.url).pathname, formats: ['es'], fileName: 'api' }, minify: false } });
const code = (Array.isArray(output) ? output[0] : output).output[0].code;
const api = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
globalThis.window = new EventTarget();
const plays = Array.from({ length: 4 }, (_, index) => ({ version: 1, id: `play-refresh-${index}`, name: `Play ${index}`, players: [], defenders: [], arrows: [], ball: null, defenders_visible: false }));
let source = plays, headers = {}, calls = 0, notifications = 0;
window.addEventListener('arc-playbooks-changed', () => notifications++);
globalThis.fetch = async (url, options) => {
  calls++; assert.equal(url, '/api/playbooks'); assert.equal(options.method, undefined); assert.equal(options.cache, 'no-store');
  return Response.json(source, { headers });
};
let displayed = [], error;
// Same successful-refresh/error behavior used by both workspace consumers.
const refresh = async () => { try { displayed = await api.fetchPlaybooks(); error = undefined; } catch (caught) { error = caught; } };
await refresh(); assert.deepEqual(displayed, plays); assert.equal(error, undefined);
const previous = structuredClone(displayed);
const cases = [
  [{ 'X-ARC-Playbook-Status': 'partial', 'X-ARC-Playbook-Issues': JSON.stringify([{ file: 'damaged.json', kind: 'invalid' }]) }, 'invalid', /invalid documents/],
  [{ 'X-ARC-Playbook-Status': 'partial', 'X-ARC-Playbook-Issues': JSON.stringify([{ file: 'busy.json', kind: 'unavailable' }]) }, 'unavailable', /temporarily unavailable/],
  [{ 'X-ARC-Playbook-Warnings': 'legacy.json' }, 'unknown', /could not be read/],
  [{ 'X-ARC-Playbook-Status': 'partial' }, undefined, /incomplete/],
  [{ 'X-ARC-Playbook-Warnings': '' }, undefined, /incomplete/],
  [{ 'X-ARC-Playbook-Status': 'complete', 'X-ARC-Playbook-Warnings': 'contradictory.json' }, 'unknown', /incomplete/],
  [{ 'X-ARC-Playbook-Status': 'unexpected' }, undefined, /incomplete/],
];
for (const malformed of ['{broken', 'null', '{}', '[]', '[{"file":1,"kind":"invalid"}]', '[{"file":"a","kind":"other"}]']) {
  cases.push([{ 'X-ARC-Playbook-Issues': malformed }, undefined, /incomplete/]);
}
for (const [warningHeaders, kind, message] of cases) {
  source = plays.slice(0, 3); headers = warningHeaders;
  await refresh();
  assert.ok(error instanceof api.IncompletePlaybookLibraryError);
  assert.equal(error.complete, false); assert.match(error.message, message);
  assert.deepEqual(error.availablePlays, source); assert.equal(error.issues[0]?.kind, kind);
  assert.deepEqual(displayed, previous, 'an incomplete list cannot erase previously loaded plays');
  const before = calls;
  const results = await Promise.allSettled([api.fetchPlaybooks(), api.fetchPlaybooks()]);
  assert.equal(calls, before + 1, 'partial refreshes still share only in-flight requests');
  assert.ok(results.every(result => result.status === 'rejected'));
  results[0].reason.availablePlays[0].name = 'Consumer edit';
  results[0].reason.issues.push({ file: 'consumer.json', kind: 'unknown' });
  assert.equal(results[1].reason.availablePlays[0].name, plays[0].name, 'consumers have isolated warning snapshots');
  headers = { 'X-ARC-Playbook-Status': 'complete' };
  await refresh(); assert.equal(error, undefined); assert.deepEqual(displayed, source, 'a complete refresh may confirm a real removal');
  source = plays; headers = {}; await refresh();
}
// Identical bodies do not hide changed header status in the parsed-content cache.
source = plays; headers = { 'X-ARC-Playbook-Status': 'partial' };
await refresh(); assert.ok(error instanceof api.IncompletePlaybookLibraryError); assert.deepEqual(displayed, plays);
// With no previous complete library, partial data remains explicitly incomplete.
displayed = []; source = plays.slice(0, 3); await refresh();
assert.deepEqual(displayed, []); assert.equal(error.availablePlays.length, 3);
source = []; headers = { 'X-ARC-Playbook-Status': 'complete' };
await refresh(); assert.equal(error, undefined); assert.deepEqual(displayed, [], 'an explicitly complete empty library is valid');
globalThis.fetch = async () => Response.json({ detail: 'Playbook storage is temporarily unavailable; retry' }, { status: 503 });
displayed = previous; await refresh(); assert.match(error.message, /temporarily unavailable/); assert.deepEqual(displayed, previous);
assert.equal(notifications, 0, 'listing errors never announce a mutation');
console.log('Library refresh passed: partial/complete status, invalid/unavailable reasons, legacy warnings, malformed metadata, preserved complete views, isolated consumers, header-aware caching and recovery');
