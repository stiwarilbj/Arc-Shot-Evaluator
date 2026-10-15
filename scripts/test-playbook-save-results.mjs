import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { INVALID_PLAYBOOK_SAVE, validatePlaybookSaveResult, validateSavedPlaybook } from '../frontend/src/features/playbook/documentValidation.ts';
import { createPlaybookDraftSession } from '../frontend/src/features/playbook/playbookDraftSession.ts';
const saved = { version: 1, id: 'play-server01', name: 'Saved play', created_at: '2026-10-15T12:00:00-0400', updated_at: '2026-10-15T16:00:00Z', defenders_visible: true, players: [{ id: 1, x: 50, y: 70 }], defenders: [], ball: null, arrows: [] };
const create = { operation: 'create', sourceId: 'draft-test01' }, update = { operation: 'update', id: saved.id };
const bad = [null, [], false, 1, 'play', {}];
for (const field of Object.keys(saved)) {
  const missing = structuredClone(saved); delete missing[field]; bad.push(missing);
}
for (const id of ['', ' ', ' draft-pending', 'draft-pending', 'play/../../bad', 'UPPERCASE-ID', 'a'.repeat(65), 1, null]) bad.push({ ...saved, id });
for (const field of ['created_at', 'updated_at']) for (const value of ['', ' ', 'not a date', 1, null, {}, []]) bad.push({ ...saved, [field]: value });
const examples = JSON.parse(readFileSync(new URL('../tests/fixtures/playbook-documents.json', import.meta.url)));
for (const example of examples.filter((entry) => !entry.valid)) bad.push({ ...saved, ...example.document, id: saved.id });
for (const value of bad) {
  assert.throws(() => validatePlaybookSaveResult(value, create), { message: INVALID_PLAYBOOK_SAVE });
  assert.throws(() => validatePlaybookSaveResult(value, update), { message: INVALID_PLAYBOOK_SAVE });
}
const legacy = { ...saved }; delete legacy.version; delete legacy.created_at; delete legacy.updated_at;
validateSavedPlaybook(legacy); // Legacy loads do not inherit the stricter response contract.
validatePlaybookSaveResult(saved, create); validatePlaybookSaveResult(saved, update);
assert.throws(() => validatePlaybookSaveResult(saved, { operation: 'update', id: 'play-another01' }));
assert.throws(() => validatePlaybookSaveResult(saved, { operation: 'create', sourceId: saved.id }));
const empty = { ...saved, players: [], ball: null }; validatePlaybookSaveResult(empty, create);

for (const target of ['local', 'github-pages']) {
  const output = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify(target) }, build: { write: false, lib: { entry: new URL('../frontend/src/features/playbook/api.ts', import.meta.url).pathname, formats: ['es'], fileName: 'api' }, minify: false } });
  const code = (Array.isArray(output) ? output[0] : output).output[0].code;
  const api = await import(`data:text/javascript;base64,${Buffer.from(code + `\n// save results ${target}`).toString('base64')}`);
  const window = new EventTarget(); globalThis.window = window;
  let content = JSON.stringify([saved]), writes = 0, notifications = 0;
  window.localStorage = { getItem: () => content, setItem: (_key, value) => { content = value; writes++; } };
  const unsubscribe = api.subscribePlaybooks(() => notifications++);
  const source = { ...structuredClone(saved), id: create.sourceId, name: 'Unsaved edit' };
  const session = createPlaybookDraftSession(source);session.edit({ ...source, name: 'Dirty draft' });
  if (target === 'local') {
    let body = null;
    globalThis.fetch = async () => Response.json(body);
    for (const malformed of bad) {
      body = malformed;
      const before = structuredClone(session.current), pending = session.beginSave();
      await assert.rejects(api.createPlaybook(pending.draft), { message: INVALID_PLAYBOOK_SAVE });
      session.failSave(pending);
      assert.deepEqual(session.current, before); assert.equal(session.dirty, true);
      await assert.rejects(api.updatePlaybook({ ...pending.draft, id: saved.id }), { message: INVALID_PLAYBOOK_SAVE });
    }
    body = { ...saved, id: 'play-wrong-target' };
    await assert.rejects(api.updatePlaybook(saved), { message: INVALID_PLAYBOOK_SAVE });
    body = saved;
    await assert.rejects(api.createPlaybook(saved), { message: INVALID_PLAYBOOK_SAVE }, 'a create/copy cannot reuse the source identity');
    for (const raw of ['', '{broken', '<html>OK</html>']) {
      globalThis.fetch = async () => new Response(raw, { status: 200 });
      await assert.rejects(api.createPlaybook(source), { message: INVALID_PLAYBOOK_SAVE });
    }
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await assert.rejects(api.createPlaybook(source), { message: INVALID_PLAYBOOK_SAVE });
    globalThis.fetch = async () => Response.json({ detail: 'Server refused save' }, { status: 503 });
    await assert.rejects(api.createPlaybook(source), /Server refused save/);
    assert.equal(notifications, 0, 'no malformed save result announces a saved play');
    globalThis.fetch = async () => Response.json(saved);
    const pending = session.beginSave();
    session.completeSave(pending, await api.createPlaybook(pending.draft));
    assert.equal(session.dirty, false);assert.equal(session.current.id, saved.id);assert.equal(notifications, 1);
  } else {
    const before = content;
    for (const created_at of ['', 'not a date', 17]) {
      // These pass content validation but must fail result validation before writing.
      await assert.rejects(api.updatePlaybook({ ...saved, created_at }), { message: INVALID_PLAYBOOK_SAVE });
    }
    assert.equal(writes, 0);assert.equal(notifications, 0);assert.equal(content, before);
    const pending = session.beginSave();
    const result = await api.createPlaybook(pending.draft);
    validatePlaybookSaveResult(result, { operation: 'create', sourceId: pending.draft.id });
    session.completeSave(pending, result);
    assert.equal(session.dirty, false);assert.equal(writes, 1);assert.equal(notifications, 1);
    const updated = await api.updatePlaybook(result);
    validatePlaybookSaveResult(updated, { operation: 'update', id: result.id });
    assert.equal(updated.id, result.id);
  }
  unsubscribe();console.log(`${target}: malformed save results cannot clear dirty drafts, notify saved libraries or block a valid retry`);
}
console.log(`Save-result validation passed: ${bad.length} malformed bodies plus identity, JSON/status, browser pre-write, legacy and retry checks`);
