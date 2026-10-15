import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
const examples = JSON.parse(readFileSync(new URL('../tests/fixtures/playbook-documents.json', import.meta.url)));
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
    if (!options) return new Response(content);
    const value = { ...JSON.parse(options.body), id: 'play-server01', created_at: '2026-10-15', updated_at: '2026-10-15' };
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
  unsubscribe();
  console.log(`${target}: malformed creates/updates rejected before writes; valid save/reload and preserved-data retry passed`);
}
