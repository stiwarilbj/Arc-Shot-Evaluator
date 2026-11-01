import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePlaybookPrecision } from '../frontend/src/features/playbook/documentPrecision.ts';
import { createPlaybookDraftSession } from '../frontend/src/features/playbook/playbookDraftSession.ts';
const examples = JSON.parse(readFileSync(new URL('../tests/fixtures/playbook-precision.json', import.meta.url)));
const play = (coordinate, timing = 1.2) => ({
  version: 1, id: 'draft-precision', name: 'Precision', defenders_visible: true,
  players: [{ id: 1, x: coordinate, y: coordinate, ratings: { threePoint: 5, midrange: 2, finishing: 4 }, badges: ['playmaker'] }],
  defenders: [{ id: 1, x: coordinate, y: coordinate, badges: ['helper'] }], ball: { x: coordinate, y: coordinate },
  arrows: [{ id: 'precision-action', kind: 'movement', start: { x: coordinate, y: coordinate }, end: { x: coordinate, y: coordinate }, control: { x: coordinate, y: coordinate }, exit_target: { x: coordinate, y: coordinate }, timing, sequence: 3, actor_id: 1 }],
});
for (const example of examples) {
  const draft = example.field === 'coordinate' ? play(example.value) : play(12.3456789, example.value);
  const before = structuredClone(draft);
  const saved = normalizePlaybookPrecision(draft);
  assert.deepEqual(draft, before, 'save normalization never mutates the draft or its undo snapshots');
  if (example.field === 'coordinate') {
    for (const point of [...saved.players, ...saved.defenders, saved.ball, saved.arrows[0].start, saved.arrows[0].end, saved.arrows[0].control, saved.arrows[0].exit_target]) {
      assert.equal(point.x, example.expected, `Python coordinate ${example.value}`);
      assert.equal(point.y, example.expected);
    }
  } else assert.equal(saved.arrows[0].timing, example.expected, `Python timing ${example.value}`);
  assert.deepEqual(normalizePlaybookPrecision(saved), saved, 'normalization is idempotent');
  let reloaded = JSON.parse(JSON.stringify(saved));
  for (let n = 0; n < 5; n++) reloaded = JSON.parse(JSON.stringify(normalizePlaybookPrecision(reloaded)));
  assert.deepEqual(reloaded, JSON.parse(JSON.stringify(saved)), 'repeated saves cannot accumulate drift');
  assert.deepEqual(saved.players[0].ratings, draft.players[0].ratings);
  assert.deepEqual(saved.players[0].badges, draft.players[0].badges);
  assert.equal(saved.arrows[0].sequence, 3);
  assert.equal(saved.arrows[0].actor_id, 1);
}
const legacy = play(12.3456789);delete legacy.arrows[0].timing;delete legacy.arrows[0].control;delete legacy.arrows[0].exit_target;legacy.ball = null;
const clean = normalizePlaybookPrecision(legacy);
assert.equal(clean.ball, null);assert.ok(!('timing' in clean.arrows[0]));assert.ok(!('control' in clean.arrows[0]));
const session = createPlaybookDraftSession(play(12.3456789, 2.675));
const request = session.beginSave();
const saved = { ...normalizePlaybookPrecision(request.draft), id: 'saved-precision', created_at: '2026-10-15', updated_at: '2026-10-15' };
session.edit({ ...session.current, name: 'Newer unsaved edit' });
session.completeSave(request, saved);
assert.equal(session.current.players[0].x, 12.3456789, 'pending saves preserve newer drafts at their original precision');
assert.equal(session.dirty, true);
console.log(`Precision passed: ${examples.length} Python-compatible examples, every point field, immutable inputs, idempotence, repeated saves, optional fields and pending-edit protection`);
