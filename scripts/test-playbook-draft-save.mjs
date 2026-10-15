import assert from 'node:assert/strict';
import { createPlaybookDraftSession, playbookContentKey } from '../frontend/src/features/playbook/playbookDraftSession.ts';

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
      assert.equal(applied.unchanged, edit === 'none', `${source}/${id}/${edit}: only the unchanged revision can replace the draft`);
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

{
  const baseline = saved(draft());
  baseline.arrows = [{ id: 'move-one', kind: 'movement', start: { x: 20, y: 30 }, end: { x: 40, y: 50 }, actor_id: 1 }];
  const session = createPlaybookDraftSession(baseline);
  const changed = { ...structuredClone(baseline), name: 'Edited name' };
  session.edit(changed); assert.equal(session.dirty, true);
  session.edit(structuredClone(baseline)); assert.equal(session.dirty, false, 'undo to saved content clears unsaved state');
  session.edit(changed); assert.equal(session.dirty, true, 'redo restores unsaved state');
  session.edit({ ...baseline, id: 'metadata-only', created_at: 'older', updated_at: 'newer', selection: 1, playbackPosition: 500, arrowVisibility: 'off' });
  assert.equal(session.dirty, false, 'identity, timestamps, and transient display state do not affect content');
  const reordered = Object.fromEntries(Object.entries(baseline).reverse());
  reordered.players = baseline.players.map((player) => Object.fromEntries(Object.entries(player).reverse()));
  session.edit(reordered); assert.equal(session.dirty, false, 'object property insertion order is irrelevant');

  const changes = [
    (p) => { p.name = 'Renamed'; },
    (p) => { p.defenders_visible = !p.defenders_visible; },
    (p) => { p.players[0].x++; },
    (p) => { p.players[0].ratings = { threePoint: 5, midrange: 3, finishing: 3 }; },
    (p) => { p.players[0].badges = ['slasher']; },
    (p) => { p.defenders = [{ id: 1, x: 30, y: 40, badges: ['helper'] }]; },
    (p) => { p.ball = null; },
    (p) => { p.arrows[0].end.x++; },
    (p) => { p.arrows[0].sequence = 2; },
    (p) => { p.arrows[0].timing = 2; },
    (p) => { p.arrows[0].path = 'curve'; p.arrows[0].control = { x: 35, y: 30 }; },
    (p) => { p.arrows[0].recipient_id = 1; },
    (p) => { p.arrows[0].exit_target = { x: 50, y: 50 }; },
  ];
  for (const change of changes) {
    const next = structuredClone(baseline); change(next);
    session.edit(next); assert.equal(session.dirty, true, 'every persisted content edit remains protected');
    session.edit(structuredClone(baseline)); assert.equal(session.dirty, false);
  }
  const implicit = { ...draft(), players: [{ id: 1, x: 20, y: 30 }] };
  const explicit = structuredClone(implicit);
  explicit.players[0].ratings = { threePoint: 3, midrange: 3, finishing: 3 }; explicit.players[0].badges = [];
  assert.equal(playbookContentKey(implicit), playbookContentKey(explicit), 'legacy default ratings and empty badges are equivalent');
  session.edit(changed);
  const failed = session.beginSave(); session.failSave(failed);
  session.edit(baseline); assert.equal(session.dirty, false, 'failed saves cannot advance the baseline');
  session.load({ ...draft('draft-copy-one'), name: 'Unsaved duplicate' }, true);
  session.edit(structuredClone(session.current)); assert.equal(session.dirty, true, 'an unsaved copy has no saved baseline');
  const copySave = session.beginSave(); session.completeSave(copySave, saved(copySave.draft));
  assert.equal(session.dirty, false, 'the first successful copy save establishes a baseline');
  session.load(baseline); assert.equal(session.dirty, false, 'loading resets the baseline');
}

{
  const original = { ...draft(), players: [{ id: 1, x: 20, y: 30 }] };
  const session = createPlaybookDraftSession(original);
  const request = session.beginSave();
  session.edit({ ...original, name: 'Temporary change' }); session.edit(structuredClone(original));
  const applied = session.completeSave(request, saved(request.draft));
  assert.equal(applied.unchanged, false, 'revision guards still reject save-then-replace after intervening edits');
  assert.equal(session.dirty, false, 'returning to the saved content is clean despite intervening revisions');
  session.edit({ ...session.current, name: 'Snapshot being saved' });
  const second = session.beginSave();
  session.edit({ ...session.current, name: 'Different latest edit' });
  session.completeSave(second, saved(second.draft)); assert.equal(session.dirty, true);
  session.edit({ ...session.current, name: original.name });
  assert.equal(session.dirty, true, 'the previous baseline is no longer the saved document');
  session.edit({ ...session.current, name: 'Snapshot being saved' });
  assert.equal(session.dirty, false, 'a pending save establishes its actual saved content as the new baseline');
}

console.log('Playbook draft save regressions passed: save races, locking, saved-content baselines, undo/redo, display exclusions, duplicates, and failures.');
