import assert from 'node:assert/strict';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { newCreationId } from '../frontend/src/features/playbook/creationAttempt.ts';
import { createPlaybookDraftSession } from '../frontend/src/features/playbook/playbookDraftSession.ts';
import { installBrowserLocks } from './helpers/browser-locks.mjs';
const draft = { version: 1, id: 'draft-retry-one', name: 'First submission', defenders_visible: false, players: [{ id: 1, x: 50, y: 70 }], defenders: [], ball: null, arrows: [] };
const content = raw => { const parsed = JSON.parse(raw); return parsed.plays ?? parsed; };
const compile = async target => {
 const result = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify(target) }, build: { write: false, lib: { entry: new URL('../frontend/src/features/playbook/api.ts', import.meta.url).pathname, formats: ['es'], fileName: 'api' }, minify: false } });
 const code = (Array.isArray(result) ? result[0] : result).output[0].code;
 return Promise.all([1, 2].map(client => import(`data:text/javascript;base64,${Buffer.from(code + `\n// idempotency ${target} ${client}`).toString('base64')}`)));
};
installBrowserLocks();
for (const target of ['local', 'github-pages']) {
 const [api, secondClient] = await compile(target);
 const window = new EventTarget(); globalThis.window = window;
 let raw = '[]', writes = 0, mode = 'uncertain', postCount = 0;
 window.localStorage = { getItem: () => raw, setItem: (_key, value) => { raw = value; writes++; if (mode === 'uncertain') throw new Error('lost acknowledgement'); } };
 const receipts = new Map(); let live = new Map();
 globalThis.fetch = async (url, options) => {
  const id = url.split('/').at(-1);
  if (options.method === 'POST') {
   postCount++;
   const key = options.headers['X-ARC-Create-ID'], input = JSON.parse(options.body), previous = receipts.get(key);
   if (previous && JSON.stringify(input) !== previous.input) return Response.json({ detail: 'Identity conflict' }, { status: 409 });
   if (!previous) {
    const result = { ...input, id: key, created_at: '2026-10-15T12:00:00Z', updated_at: '2026-10-15T12:00:00Z' };
    receipts.set(key, { input: JSON.stringify(input), result }); live.set(key, result); writes++;
   }
   if (mode === 'uncertain') throw new TypeError('Response lost');
   return Response.json(receipts.get(key).result);
  }
  if (options.method === 'PUT') { const result = { ...JSON.parse(options.body), updated_at: '2026-10-15T13:00:00Z' }; live.set(id, result); return Response.json(result); }
  if (options.method === 'DELETE') { live.delete(id); return Response.json({ deleted: true, id }); }
  if (mode === 'uncertain') return Response.json({ detail: 'Verification unavailable' }, { status: 503 });
  if (id === 'playbooks') return Response.json([...live.values()]);
  return live.has(id) ? Response.json(live.get(id)) : new Response('', { status: 404 });
 };
 const session = createPlaybookDraftSession(draft); session.edit({ ...draft, name: 'Original saved snapshot' });
 const first = session.beginSave(); let error;
 try { await api.createPlaybook(first.draft, first.creationId); assert.fail('response must be uncertain'); } catch (caught) { error = caught; }
 assert.equal(error.retainAttempt, true); session.failSave(first, error.retainAttempt); assert.equal(writes, 1);
 session.edit({ ...session.current, name: 'Newer edits while uncertain', players: [{ id: 1, x: 72, y: 70 }] });
 const retry = session.beginSave(); assert.equal(retry.creationId, first.creationId); assert.equal(retry.draft.name, 'Original saved snapshot');
 mode = 'normal'; const result = await api.createPlaybook(retry.draft, retry.creationId);
 const applied = session.completeSave(retry, result);
 assert.equal(applied.unchanged, false); assert.equal(session.current.name, 'Newer edits while uncertain'); assert.equal(session.current.players[0].x, 72); assert.equal(session.dirty, true); assert.equal(session.current.id, result.id);
 assert.equal(writes, 1, 'retry returns receipt without another storage write');
 // A fresh module/tab reuses the durable receipt. Copies cannot share an ID by content alone.
 assert.deepEqual(await secondClient.createPlaybook(retry.draft, retry.creationId), result); assert.equal(writes, 1);
 const copy = await api.createPlaybook(retry.draft, newCreationId()); assert.notEqual(copy.id, result.id); assert.equal(writes, 2);
 await assert.rejects(api.createPlaybook({ ...retry.draft, name: 'Mismatched payload' }, retry.creationId), /different drawing|Identity conflict/);
 assert.equal(writes, 2);
 // Later edits and deletion must not change or erase the original result.
 await api.updatePlaybook({ ...result, name: 'Later rename' });
 assert.deepEqual(await secondClient.createPlaybook(retry.draft, retry.creationId), result);
 await api.deletePlaybook(result.id);
 assert.deepEqual(await api.createPlaybook(retry.draft, retry.creationId), result);
 const plays = target === 'github-pages' ? content(raw) : [...live.values()];
 assert.ok(!plays.some(play => play.id === result.id), 'retry never resurrects a deleted play');
 assert.equal(plays.length, 1);
 // Read/export shapes contain only documents, not receipt metadata.
 assert.equal((await api.fetchPlaybooks()).length, 1);
 assert.ok(!('creations' in (await api.fetchPlaybooks())[0]));
 if (target === 'github-pages') {
  const stored = raw, parsed = JSON.parse(raw); parsed.creations[0].result.name = 'Damaged receipt'; raw = JSON.stringify(parsed);
  await assert.rejects(api.fetchPlaybooks(), /preserved/); assert.equal(raw, JSON.stringify(parsed)); raw = stored;
  assert.equal((await api.fetchPlaybooks()).length, 1);
 }
 console.log(`${target}: uncertain create retry, stable original snapshot, newer edits, independent clients, fresh copies, payload conflicts, immutable receipts, deletion and reload passed`);
}
// Explicitly loading another document abandons a failed attempt; history does not.
const session = createPlaybookDraftSession(draft), first = session.beginSave(); session.failSave(first, true);
session.load({ ...draft, id: 'draft-other-one' }); assert.notEqual(session.beginSave().creationId, first.creationId);
console.log('Creation attempts are scoped to their owning document and never modify exported drawings');
