import { installBrowserLocks } from './helpers/browser-locks.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePlaybookPrecision } from '../frontend/src/features/playbook/documentPrecision.ts';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
const examples = JSON.parse(readFileSync(new URL('../tests/fixtures/playbook-documents.json', import.meta.url)));
installBrowserLocks();
for (const target of ['github-pages', 'local']) {
  // Bundle the real persistence module with the same deployment flag as Vite.
  const output = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify(target) }, build: { write: false, lib: { entry: new URL('../frontend/src/features/playbook/api.ts', import.meta.url).pathname, formats: ['es'], fileName: 'api' }, minify: false } });
  const api = await import(`data:text/javascript;base64,${Buffer.from((Array.isArray(output) ? output[0] : output).output[0].code + `\n// ${target}`).toString('base64')}`);
  let content = '[]', writes = 0, calls = 0;
  const window = new EventTarget();
  window.localStorage = { getItem: () => content, setItem: (_key, value) => { content = value; writes++; } };
  globalThis.window = window;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (!options?.method) return new Response(content);
    const value = { ...JSON.parse(options.body), id: options.headers?.['X-ARC-Create-ID'] ?? JSON.parse(options.body).id, created_at: '2026-10-15', updated_at: '2026-10-15' };
    content = JSON.stringify([value]); writes++;
    return Response.json(value);
  };
  for (const { name, valid, document } of examples.filter((entry) => !entry.valid)) {
    const before = { content, writes, calls };
    await assert.rejects(api.createPlaybook(document), undefined, `${target}: create ${name}`);
    await assert.rejects(api.updatePlaybook(document), undefined, `${target}: update ${name}`);
    assert.deepEqual({ content, writes, calls }, before, 'invalid inputs never touch storage or network');
  }
  const play = structuredClone(examples[0].document);
  const saved = await api.createPlaybook(play);
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.arrows, play.arrows);
  const updated = await api.updatePlaybook({ ...saved, name: 'Updated drawing' });
  assert.equal(updated.name, 'Updated drawing');
  assert.equal((await api.fetchPlaybooks())[0].name, 'Updated drawing');
  const corrupt = { ...saved, players: [{ id: 1, x: 101, y: 50 }] };
  content = JSON.stringify([corrupt]);
  const badContent = content;
  // Changing the stored source invalidates any completed read before retry.
  const unsubscribe = api.subscribePlaybooks(() => {});
  // The real storage listener checks the key; dispatch a matching event.
  const event = new Event('storage'); Object.defineProperty(event, 'key', { value: 'arc-playbooks-v1' }); window.dispatchEvent(event);
  await assert.rejects(api.fetchPlaybooks(), /preserved/);
  assert.equal(content, badContent);
  content = JSON.stringify([saved]);
  const retryEvent = new Event('storage'); Object.defineProperty(retryEvent, 'key', { value: 'arc-playbooks-v1' }); window.dispatchEvent(retryEvent);
  assert.equal((await api.fetchPlaybooks())[0].id, saved.id);
  if (target === 'github-pages') {
    const invalidate = () => {
      const event = new Event('storage'); Object.defineProperty(event, 'key', { value: 'arc-playbooks-v1' }); window.dispatchEvent(event);
    };
    // Both legacy arrays and current envelopes reject even identical duplicates.
    for (const duplicate of [saved, { ...saved, name: 'Different drawing, same identity' }]) {
      for (const library of [[saved, duplicate], { version: 1, plays: [saved, duplicate], creations: [] }]) {
        content = JSON.stringify(library, null, 2); invalidate();
        const before = { content, writes, calls };
        await assert.rejects(api.fetchPlaybooks(), /preserved/);
        await assert.rejects(api.updatePlaybook({ ...saved, name: 'Do not overwrite' }), /preserved/);
        await assert.rejects(api.deletePlaybook(saved.id), /preserved/);
        await assert.rejects(api.createPlaybook(play), /preserved/);
        assert.deepEqual({ content, writes, calls }, before, 'duplicate identities leave raw storage untouched on every path');
      }
    }
    content = JSON.stringify([saved]); invalidate();
    assert.deepEqual(await api.fetchPlaybooks(), [saved], 'repairing storage explicitly makes it readable again');
    // A receipt and its live play legitimately share an ID; deleted receipts
    // also remain valid when the play is absent.
    const created = await api.createPlaybook(play);
    assert.ok(JSON.parse(content).creations.some((receipt) => receipt.id === created.id));
    assert.ok((await api.fetchPlaybooks()).some((item) => item.id === created.id));
    await api.deletePlaybook(created.id);
    assert.ok(JSON.parse(content).creations.some((receipt) => receipt.id === created.id));
    assert.deepEqual((await api.fetchPlaybooks()).map((item) => item.id), [saved.id]);
    console.log('Hosted duplicate identities rejected without writes; matching live/deleted receipt identities remain valid');
  }
  const precise = { ...structuredClone(play), id: 'draft-precision-api',
    players: [{ id: 1, x: 12.3456789, y: 99.99995 }, { id: 2, x: 35, y: 60 }],
    defenders: [{ id: 1, x: .00015, y: 1.23445 }], ball: { x: 1.23455, y: .00005 },
    arrows: [{ id: 'precise-pop', kind: 'pick-pop', screener_id: 1, handler_id: 2,
      start: { x: 1.23445, y: 12.3456789 }, end: { x: 1.23455, y: .00015 },
      control: { x: 99.99995, y: 1.23445 }, exit_target: { x: .00005, y: 12.3456789 }, timing: 2.675 }] };
  const original = structuredClone(precise), normalized = normalizePlaybookPrecision(precise);
  let persisted = await api.createPlaybook(precise);
  const numericFields = (value) => Object.fromEntries(['players', 'defenders', 'ball', 'arrows'].map((key) => [key, value[key]]));
  assert.deepEqual(numericFields(persisted), numericFields(normalized), `${target}: create returns normalized precision`);
  assert.deepEqual(precise, original, 'caller draft was not modified');
  assert.deepEqual(numericFields((JSON.parse(content).plays ?? JSON.parse(content)).find((p) => p.id === persisted.id)), numericFields(normalized), 'stored JSON is normalized');
  for (let i = 0; i < 5; i++) {
    persisted = await api.updatePlaybook(persisted);
    assert.deepEqual(numericFields((await api.fetchPlaybooks()).find((p) => p.id === persisted.id)), numericFields(normalized), 'update and reload do not drift');
  }
  // Reading a legacy library is deliberately lossless; unrelated saves must not
  // round a play the user has not explicitly saved.
  content = JSON.stringify([{ ...original, id: 'play-legacy-precision' }]);
  const changed = new Event('storage'); Object.defineProperty(changed, 'key', { value: 'arc-playbooks-v1' }); window.dispatchEvent(changed);
  assert.equal((await api.fetchPlaybooks())[0].players[0].x, 12.3456789);
  await api.createPlaybook(play);
  if (target === 'github-pages') assert.equal((JSON.parse(content).plays ?? JSON.parse(content)).find((p) => p.id === 'play-legacy-precision').players[0].x, 12.3456789);
  unsubscribe();
  console.log(`${target}: malformed creates/updates rejected before writes; valid save/reload, preserved-data retry, normalized creates/updates, no drift and lossless legacy reads passed`);
}
