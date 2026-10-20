import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { checkPlaybookJsonText, parsePlaybookJson, readPlaybookJson, readPlaybookJsonText, MAX_PLAYBOOK_JSON_BYTES as budget, MAX_PLAYBOOK_LIBRARY_BYTES as libraryBudget } from '../frontend/src/features/playbook/jsonIntake.ts';
import { validateSavedPlaybook } from '../frontend/src/features/playbook/documentValidation.ts';
import { createParsedLibraryCache } from '../frontend/src/features/playbook/parsedLibraryCache.ts';
import { createPlaybookDraftSession } from '../frontend/src/features/playbook/playbookDraftSession.ts';
import { installBrowserLocks } from './helpers/browser-locks.mjs';

const maximumText = readFileSync(new URL('../tests/fixtures/playbook-intake-maximum.json', import.meta.url), 'utf8');
const maximum = parsePlaybookJson(maximumText);
validateSavedPlaybook(maximum);
assert.equal(maximum.arrows.length, 30);
assert.equal(maximum.players.length + maximum.defenders.length, 10);
assert.ok(Buffer.byteLength(maximumText) < budget / 4);
const unicode = JSON.stringify({ unused: 'é🏀'.repeat(100) });
const exact = unicode + ' '.repeat(budget - Buffer.byteLength(unicode));
assert.deepEqual(parsePlaybookJson(exact), JSON.parse(unicode));
assert.throws(() => parsePlaybookJson(exact + ' '), /byte limit/);
assert.throws(() => parsePlaybookJson(JSON.stringify({ unused: '🏀'.repeat(budget / 3) })), /byte limit/);
for (const depth of [31, 32, 33, 2000]) {
  const text = '{"unused":' + '['.repeat(depth - 1) + '0' + ']'.repeat(depth - 1) + '}';
  if (depth <= 32) parsePlaybookJson(text);
  else assert.throws(() => parsePlaybookJson(text), /nesting/);
}
parsePlaybookJson(JSON.stringify({ unused: '[{"quoted":"'.repeat(1000) + '\\"'.repeat(50) }));
assert.throws(() => parsePlaybookJson('{bad'), SyntaxError);
// Rejection must precede parsing, including for aggregate browser storage.
const originalParse = JSON.parse;
JSON.parse = () => { assert.fail('Oversized/deep input reached JSON.parse'); };
try {
  assert.throws(() => parsePlaybookJson(' '.repeat(budget + 1)), /byte limit/);
  assert.throws(() => parsePlaybookJson('['.repeat(2000)), /nesting/);
  assert.throws(() => createParsedLibraryCache(value => value)(' '.repeat(libraryBudget + 1)), /preserved/);
} finally { JSON.parse = originalParse; }

let cancelled = false, pulls = 0;
const oversized = new Response(new ReadableStream({
  pull(controller) { pulls++; controller.enqueue(new Uint8Array(16)); },
  cancel() { cancelled = true; },
}), { headers: { 'Content-Length': '1' } });
await assert.rejects(readPlaybookJsonText(oversized, 32), /byte limit/);
assert.ok(cancelled && pulls <= 4, 'Stop reading and cancel before the rest of an oversized stream');
const encoded = new TextEncoder().encode(unicode);
let offset = 0;
const bytewise = new Response(new ReadableStream({ pull(controller) {
  if (offset === encoded.length) controller.close();
  else controller.enqueue(encoded.slice(offset, ++offset));
} }));
assert.deepEqual(await readPlaybookJson(bytewise), JSON.parse(unicode), 'UTF-8 characters may cross chunks');
await assert.rejects(readPlaybookJson(new Response(new Uint8Array([255]))));
await assert.rejects(readPlaybookJson(new Blob([' '.repeat(budget + 1)])), /byte limit/);
validateSavedPlaybook(await readPlaybookJson(new Blob([maximumText])));
const cached = createParsedLibraryCache(value => { value.forEach(validateSavedPlaybook); return value; });
const healthy = cached(JSON.stringify([maximum]));
assert.throws(() => cached('['.repeat(2000)), /nesting/);
assert.strictEqual(cached(JSON.stringify([maximum])), healthy, 'Failed intake cannot poison the last verified cache');

installBrowserLocks();
for (const target of ['local', 'github-pages']) {
  const output = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify(target) }, build: { write: false, lib: { entry: new URL('../frontend/src/features/playbook/api.ts', import.meta.url).pathname, formats: ['es'], fileName: 'api' }, minify: false } });
  const code = (Array.isArray(output) ? output[0] : output).output[0].code;
  const api = await import(`data:text/javascript;base64,${Buffer.from(code + '\n// intake ' + target).toString('base64')}`);
  let content = JSON.stringify([maximum]), writes = 0;
  globalThis.window = new EventTarget();
  window.localStorage = { getItem: () => content, setItem: () => { writes++; } };
  globalThis.fetch = async () => new Response(content, { headers: { 'Content-Length': '1' } });
  const unsubscribe = api.subscribePlaybooks(() => {});
  const invalidate = () => { const event = new Event('storage'); Object.defineProperty(event, 'key', { value: 'arc-playbooks-v1' }); window.dispatchEvent(event); };
  const session = createPlaybookDraftSession(maximum);
  session.edit({ ...maximum, name: 'Keep my newer drawing' });
  const before = JSON.stringify(session);
  const healthyLibrary = await api.fetchPlaybooks();
  for (const rejected of [' '.repeat(libraryBudget + 1), '['.repeat(2000)]) {
    content = rejected; invalidate();
    await assert.rejects(api.fetchPlaybooks().then(plays => session.load(plays[0])), /preserved/);
    assert.equal(JSON.stringify(session), before);
    assert.equal(healthyLibrary[0].id, maximum.id);
    assert.equal(content, rejected); assert.equal(writes, 0);
  }
  content = JSON.stringify([maximum]); invalidate();
  assert.equal((await api.fetchPlaybooks())[0].id, maximum.id, 'Retry with corrected content succeeds');
  if (target === 'local') {
    const draft = { ...maximum, id: 'draft-intake' };
    const saving = createPlaybookDraftSession(draft);
    saving.edit({ ...draft, name: 'Unsent drawing' });
    const request = saving.beginSave();
    globalThis.fetch = async () => Response.json({ detail: 'Playbook JSON exceeds the 256 KiB document limit' }, { status: 413 });
    await assert.rejects(api.createPlaybook(request.draft, request.creationId).then(saved => saving.completeSave(request, saved)), error => {
      assert.equal(error.retainAttempt, false, '413 definitively rejects intake; do not pin an old creation attempt');
      saving.failSave(request, error.retainAttempt); return true;
    });
    assert.equal(saving.current.name, 'Unsent drawing'); assert.equal(saving.dirty, true);
    saving.edit({ ...saving.current, name: 'Corrected drawing' });
    const next = saving.beginSave();
    assert.equal(next.draft.name, 'Corrected drawing');
    assert.notEqual(next.creationId, request.creationId);
  }
  unsubscribe();
}
// Write checks cannot create a library that the subsequent loader rejects.
assert.throws(() => checkPlaybookJsonText(' '.repeat(libraryBudget + 1), libraryBudget), /byte limit/);
console.log('Playbook intake passed: maximum v1 drawing, exact UTF-8 limits, depth/escaping, early stream cancellation, file reads, cache recovery and draft/storage preservation on both targets');
