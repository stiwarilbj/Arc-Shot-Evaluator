import assert from 'node:assert/strict';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { installBrowserLocks } from './helpers/browser-locks.mjs';
import { contentChecksum, PLAYBOOK_HISTORY_LIMIT } from '../frontend/src/features/playbook/revisionHistory.ts';
import { inspectHostedRecovery, validateHostedLibrary, verifyHostedLibrary } from '../frontend/src/features/playbook/hostedLibrary.ts';
installBrowserLocks();
const built = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify('github-pages') }, build: { write: false, lib: { entry: new URL('../frontend/src/features/playbook/api.ts', import.meta.url).pathname, formats: ['es'], fileName: 'api' }, minify: false } });
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const api = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const window = new EventTarget(); globalThis.window = window;
let raw = '[]', failWrite = false, loseResponse = false, writes = 0;
window.localStorage = { getItem: () => raw, setItem: (_key, value) => { if (failWrite) throw new Error('quota'); raw = value; writes++; if (loseResponse) throw new Error('response interrupted'); } };
const original = { version: 1, id: 'play-legacy-history', name: 'Before migration', defenders_visible: false, players: [{ id: 1, x: 12.1234567, y: 50 }], defenders: [], ball: null, arrows: [], created_at: '2026-10-01', updated_at: '2026-10-01' };
raw = JSON.stringify([original]); const legacy = raw;
assert.deepEqual(await api.fetchPlaybooks(), [original]); assert.equal(raw, legacy, 'read does not migrate');
failWrite = true;
await assert.rejects(api.updatePlaybook({ ...original, name: 'Failed migration' }), /could not be saved/);
assert.equal(raw, legacy, 'migration failure retains exact legacy bytes');
failWrite = false;
let saved = await api.updatePlaybook({ ...original, name: 'After migration' });
let library = JSON.parse(raw); assert.equal(library.version, 2); assert.deepEqual(library.migration.source.plays, [original]);
assert.equal(library.histories[0].entries[0].document.players[0].x, original.players[0].x, 'migration never rounds the old revision');
await verifyHostedLibrary(validateHostedLibrary(library));
for (let index = 0; index < 13; index++) saved = await api.updatePlaybook({ ...saved, name: `Revision ${index}` });
let history = await api.fetchPlaybookHistory(saved.id);
assert.equal(history.revisions.length, PLAYBOOK_HISTORY_LIMIT); assert.equal(history.integrity, 'verified');
library = JSON.parse(raw); assert.ok(library.histories[0].anchor); assert.ok(history.revisions.every(entry => entry.valid));
const snapshot = raw, count = writes;
const digest = crypto.subtle.digest;
crypto.subtle.digest = async () => { throw new Error('Interrupted checksum preparation'); };
try { await assert.rejects(api.updatePlaybook({ ...saved, name: 'Failed checksum' })); assert.equal(raw, snapshot); }
finally { crypto.subtle.digest = digest; }
failWrite = true;
for (const operation of [() => api.updatePlaybook({ ...saved, name: 'Quota failure' }), () => api.deletePlaybook(saved.id), () => api.createPlaybook({ ...saved, name: 'Failed copy' })]) {
 await assert.rejects(operation(), /could not be saved/); assert.equal(raw, snapshot);
}
assert.equal(writes, count); failWrite = false;
const recovered = await api.recoverPlaybookRevision(saved.id, history.revisions[0].revision);
assert.notEqual(recovered.id, saved.id); assert.equal(recovered.name, `${history.revisions[0].document.name} (recovered)`);
assert.equal(JSON.parse(raw).plays.find(play => play.id === saved.id).name, saved.name, 'recover copy preserves original');
const beforeDelete = await api.fetchPlaybookHistory(saved.id);
loseResponse = true; await assert.rejects(api.deletePlaybook(saved.id), /could not be saved/); loseResponse = false;
history = await api.fetchPlaybookHistory(saved.id); assert.equal(history.deleted, true); assert.equal(history.revisions.at(-1).kind, 'delete');
assert.ok(!JSON.parse(raw).plays.some(play => play.id === saved.id));
await assert.rejects(api.updatePlaybook(saved), /not found/);
const deletedCopy = await api.recoverPlaybookRevision(saved.id, beforeDelete.revisions.at(-1).revision);
assert.notEqual(deletedCopy.id, saved.id); assert.equal((await api.fetchPlaybookHistory(saved.id)).deleted, true);
// Structural validity alone is insufficient: tamper with a valid coordinate.
library = JSON.parse(raw); const target = library.histories.find(item => item.id === recovered.id);
target.entries.at(-1).document.players[0].x = 25; raw = JSON.stringify(library); const damaged = raw;
await assert.rejects(api.fetchPlaybooks(), /integrity|preserved/);
await assert.rejects(api.updatePlaybook(recovered), /integrity|preserved/); assert.equal(raw, damaged);
const damagedHistory = await api.fetchPlaybookHistory(recovered.id); assert.equal(damagedHistory.integrity, 'damaged'); assert.equal(damagedHistory.revisions.at(-1).valid, false);
// Corrupt only the current revision of another play. Its earlier revision is
// independently recoverable; explicit recovery preserves the entire bad source.
raw = snapshot; saved = JSON.parse(raw).plays[0]; saved = await api.updatePlaybook({ ...saved, name: 'Current revision' });
library = JSON.parse(raw); library.histories[0].entries.at(-1).document.name = 'Corrupted current'; raw = JSON.stringify(library); const corruptSource = raw;
history = await api.fetchPlaybookHistory(saved.id); assert.equal(history.integrity, 'damaged');
const earlier = history.revisions.find(entry => entry.valid && entry.document);
const retryId = `play-${'f'.repeat(32)}`;
failWrite = true; await assert.rejects(api.recoverPlaybookRevision(saved.id, earlier.revision, retryId), /could not be saved/); assert.equal(raw, corruptSource);
failWrite = false;
const copy = await api.recoverPlaybookRevision(saved.id, earlier.revision, retryId);
assert.notEqual(copy.id, saved.id); library = JSON.parse(raw);
assert.equal(library.preservedSources[0].content, corruptSource, 'exact damaged transaction is retained, never rewritten');
assert.equal(library.preservedSources[0].checksum, await contentChecksum(corruptSource));
assert.ok(library.reservedIds.includes(saved.id)); assert.equal(library.plays.length, 1, 'uncertain heads are never silently resurrected');
await assert.rejects(api.fetchPlaybooks(), error => error.complete === false && error.availablePlays.some(play => play.id === copy.id));
assert.deepEqual(await api.recoverPlaybookRevision(saved.id, earlier.revision, retryId), copy, 'uncertain recovery retries are idempotent');
assert.equal((await api.fetchPlaybookHistory(saved.id)).integrity, 'damaged');
const copyHistory = await api.fetchPlaybookHistory(copy.id); assert.equal(copyHistory.integrity, 'verified');
// Repeated corruption must not lose access to the earlier preserved transaction.
library = JSON.parse(raw); library.histories[0].entries.at(-1).document.name = 'Second corruption'; raw = JSON.stringify(library);
const secondCopy = await api.recoverPlaybookRevision(saved.id, earlier.revision);
assert.notEqual(secondCopy.id, copy.id);
assert.ok((await api.fetchPlaybookHistory(saved.id)).revisions.some(entry => entry.valid && entry.revision === earlier.revision));
// The same record remains independently inspectable without trusting its head.
assert.equal((await inspectHostedRecovery(JSON.parse(corruptSource), saved.id)).revisions.filter(entry => entry.valid).length, PLAYBOOK_HISTORY_LIMIT - 1);
console.log('Playbook history passed: checksums/parents, eight-revision retention, verified atomic migration, quota at every mutation, uncertain delete, tombstones, explicit fresh-copy recovery, corruption preservation and idempotent recovery');
