import assert from 'node:assert/strict';
import { createPlaybookDraftSession } from '../frontend/src/features/playbook/playbookDraftSession.ts';

const draft = (id = 'draft-test') => ({
  version: 1, id, name: 'Original', defenders_visible: true,
  players: [{ id: 1, x: 20.123456, y: 30 }], defenders: [], ball: { x: 20, y: 30 }, arrows: [],
});
const saved = (snapshot) => ({ ...structuredClone(snapshot), id: 'saved-play-123', created_at: '2026-10-15T08:00:00Z', updated_at: '2026-10-15T08:01:00Z', players: snapshot.players.map((p) => ({ ...p, x: Math.round(p.x * 10000) / 10000 })) });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

// Exercise the same async boundary for browser storage and delayed server I/O.
for (const source of ['browser', 'server']) {
  for (const id of ['draft-test', 'saved-play-123']) {
    for (const edit of ['none', 'position', 'name', 'undo-redo']) {
      const session = createPlaybookDraftSession(draft(id));
      const request = session.beginSave();
      const response = deferred();
      const operation = response.promise.then((value) => session.completeSave(request, value));
      const history = structuredClone(session.current);
      if (edit === 'position') session.edit({ ...session.current, players: [{ id: 1, x: 80, y: 70 }] });
      if (edit === 'name') session.edit({ ...session.current, name: 'Newer name' });
      if (edit === 'undo-redo') {
        session.edit({ ...session.current, name: 'Temporary edit' });
        session.edit(history);
      }
      const latest = structuredClone(session.current);
      if (source === 'server') await new Promise((resolve) => setTimeout(resolve, 0));
      response.resolve(saved(request.draft));
      const applied = await operation;
      assert.equal(applied.unchanged, edit === 'none', `${source}/${id}/${edit}: only the saved revision can clear dirty state or replace the play`);
      assert.equal(session.isCurrent(request), edit === 'none');
      assert.equal(applied.draft.id, 'saved-play-123');
      assert.equal(applied.draft.created_at, '2026-10-15T08:00:00Z');
      assert.equal(applied.draft.updated_at, '2026-10-15T08:01:00Z');
      if (edit === 'none') {
        assert.deepEqual(applied.draft, saved(request.draft), 'unchanged drafts accept server normalization');
      } else {
        assert.equal(applied.draft.name, latest.name);
        assert.deepEqual(applied.draft.players, latest.players, 'newer coordinates are not replaced or rounded');
      }
      // An old undo snapshot or drag origin must not restore a temporary ID.
      session.edit(history);
      assert.equal(session.current.id, 'saved-play-123');
      const next = session.beginSave();
      assert.equal(next.draft.id, 'saved-play-123', 'the next save updates the existing play');
      assert.equal(session.isCurrent(request), false, 'edits between completion and replacement invalidate replacement');
    }
  }
}

for (const sameId of [false, true]) {
  const session = createPlaybookDraftSession(draft());
  const request = session.beginSave();
  const replacement = { ...draft(sameId ? 'draft-test' : 'draft-other'), name: 'Different loaded document' };
  session.load(replacement);
  assert.equal(session.completeSave(request, saved(request.draft)), null, 'late successes never replace a different document session, even with the same ID');
  assert.deepEqual(session.current, replacement);
  assert.equal(session.isCurrent(request), false);
  assert.ok(session.beginSave(), 'late completion releases the pending operation');
}

{
  const session = createPlaybookDraftSession(draft());
  const request = session.beginSave();
  session.edit({ ...session.current, name: 'Edited while saving' });
  assert.equal(session.beginSave(), null, 'edits cannot enable a second overlapping create');
  assert.equal(request.draft.name, 'Original', 'requests own an isolated snapshot');
  assert.equal(session.failSave(request), true);
  assert.equal(session.current.name, 'Edited while saving', 'failure preserves newer edits');
  const retry = session.beginSave();
  assert.equal(retry.draft.name, 'Edited while saving');
  assert.equal(session.failSave(request), false, 'an obsolete failure cannot clear a retry');
  assert.equal(session.beginSave(), null);
  session.load(draft('draft-other'));
  assert.equal(session.failSave(retry), false, 'old-document errors must not change the new document status');
  assert.ok(session.beginSave());
}

console.log('Playbook draft save regressions passed.');
