import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { compareSavedPlaybooks } from '../frontend/src/features/playbook/playbookOrder.ts';
const { entries, expected } = JSON.parse(readFileSync(new URL('../tests/fixtures/playbook-order.json', import.meta.url)));
const original = structuredClone(entries);
assert.deepEqual([...entries].sort(compareSavedPlaybooks).map(play => play.id), expected);
assert.deepEqual(entries, original);
const documents = entries.map(entry => ({ version: 1, name: entry.id, players: [], defenders: [], arrows: [], ball: null, defenders_visible: false, ...entry }));
for (const target of ['local', 'github-pages']) {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify(target) }, build: { write: false, lib: { entry: new URL('../frontend/src/features/playbook/api.ts', import.meta.url).pathname, formats: ['es'], fileName: 'api' }, minify: false } });
  const code = (Array.isArray(result) ? result[0] : result).output[0].code;
  const api = await import(`data:text/javascript;base64,${Buffer.from(code + `\n// order ${target}`).toString('base64')}`);
  const window = new EventTarget(); globalThis.window = window;
  let source = documents, raw = JSON.stringify(source), writes = 0;
  window.localStorage = { getItem: () => raw, setItem: () => { writes++; } };
  globalThis.fetch = async () => Response.json(source);
  for (const envelope of [false, true]) {
    for (let rotation = 0; rotation < documents.length; rotation++) {
      source = [...documents.slice(rotation), ...documents.slice(0, rotation)];
      raw = JSON.stringify(envelope ? { version: 1, plays: source, creations: [] } : source);
      const before = raw;
      const [first, concurrent] = await Promise.all([api.fetchPlaybooks(), api.fetchPlaybooks()]);
      assert.deepEqual(first.map(play => play.id), expected);
      assert.deepEqual(concurrent.map(play => play.id), expected);
      first[0].name = 'Consumer edit'; first.reverse();
      assert.equal(concurrent[0].name, expected[0]);
      assert.deepEqual((await api.fetchPlaybooks()).map(play => play.id), expected);
      assert.equal(raw, before);
    }
  }
  assert.equal(writes, 0);
  console.log(`${target}: stable ties, timestamp priority, legacy timestamps, Unicode IDs, reordered refreshes, independent consumers, unchanged storage passed`);
}
