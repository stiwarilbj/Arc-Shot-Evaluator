import assert from 'node:assert/strict';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { validatePlaybookDocument } from '../frontend/src/features/playbook/documentValidation.ts';
import { reviseHostedLibrary, upgradeHostedLibrary, validateHostedLibrary, verifyHostedLibrary } from '../frontend/src/features/playbook/hostedLibrary.ts';
import { applyEditedPath, branchActionStatus, createBranchFromAction, flattenPlaybookPath, resolvePlaybookPath } from '../frontend/src/features/playbook/playbookBranches.ts';
import { clonePlaybook, DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { bindAuthoredActions, createSimulationRun, getSimulationFrame, advanceSimulationRun, SIMULATION_STEP_MS } from '../frontend/src/features/playbook/simulation.ts';

const base = clonePlaybook(STARTER_PLAYS[0]);
base.players = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, x: 25 + index * 10, y: 68, ratings: { threePoint: 3, midrange: 3, finishing: 3 }, badges: [] }));
base.defenders = [];
base.ball = { x: 45, y: 68 };
const action = (id, sequence, actorId, start, end, kind = 'movement') => ({ id, sequence, actor_id: actorId, kind, start, end, timing: 1.2, path: 'straight' });
base.arrows = [
  action('move-one', 1, 1, { x: 25, y: 68 }, { x: 30, y: 62 }),
  action('move-two-a', 2, 2, { x: 35, y: 68 }, { x: 40, y: 62 }),
  action('move-two-b', 2, 3, { x: 45, y: 68 }, { x: 50, y: 62 }, 'pass'),
  action('move-three', 3, 4, { x: 55, y: 68 }, { x: 60, y: 62 }),
  action('move-four', 4, 5, { x: 65, y: 68 }, { x: 70, y: 62 }),
];
delete base.branches;

const branch = createBranchFromAction(base, 'move-two-a', 1);
assert.deepEqual(branch.fork.actionIds, ['move-two-a', 'move-two-b'], 'a fork copies the whole simultaneous group');
assert.equal(branch.fork.sequence, 2);
assert.deepEqual(branch.continuation.map(({ id }) => id), ['move-two-a', 'move-two-b', 'move-three', 'move-four']);

const family = clonePlaybook(base);
family.branches = [branch];
const resolved = resolvePlaybookPath(family, branch.id);
assert.deepEqual(resolved.play.arrows.map(({ id }) => id), ['move-one', 'move-two-a', 'move-two-b', 'move-three', 'move-four']);
assert.equal(resolved.sharedCount, 1);
assert.deepEqual([...resolved.sharedIds], ['move-one']);
validatePlaybookDocument(family);

const flat = flattenPlaybookPath(family, branch.id, branch.label);
assert.equal(flat.branches, undefined, 'simulation and Counter Lab receive one standalone path');
assert.equal(flat.name, `${base.name} — Ending 1`);
const independentlyDrawn = clonePlaybook(flat);
assert.deepEqual(bindAuthoredActions(flat).map(({ arrow, actorId, recipientId, sequence }) => [arrow.id, actorId, recipientId, sequence]),
  bindAuthoredActions(independentlyDrawn).map(({ arrow, actorId, recipientId, sequence }) => [arrow.id, actorId, recipientId, sequence]));
const runA = createSimulationRun(flat, DEFAULT_SIMULATION_SETTINGS, undefined, { seed: 2718 }), runB = createSimulationRun(independentlyDrawn, DEFAULT_SIMULATION_SETTINGS, undefined, { seed: 2718 });
const sample = (run) => {
  let frame = getSimulationFrame(run);
  const samples = [];
  while (run.elapsedMs < run.durationMs - 1e-6) {
    samples.push([frame.players.map(({ id, x, y }) => [id, x, y]), frame.ball, frame.execution.map(({ actionId, phase, outcome }) => [actionId, phase, outcome])]);
    frame = advanceSimulationRun(run, SIMULATION_STEP_MS);
  }
  return samples;
};
assert.deepEqual(sample(runA), sample(runB), 'the flattened ending has the same deterministic execution as its standalone drawing');

const sharedEdit = resolvePlaybookPath(family, branch.id);
sharedEdit.play.arrows[0].end = { x: 31, y: 61 };
const afterSharedEdit = applyEditedPath(family, branch.id, sharedEdit.play, sharedEdit);
assert.deepEqual(afterSharedEdit.arrows.find(({ id }) => id === 'move-one').end, { x: 31, y: 61 });
assert.deepEqual(resolvePlaybookPath(afterSharedEdit, branch.id).play.arrows[0].end, { x: 31, y: 61 }, 'shared opening edits flow into the ending');

const continuationEdit = resolvePlaybookPath(afterSharedEdit, branch.id);
continuationEdit.play.arrows.find(({ id }) => id === 'move-two-a').end = { x: 42, y: 60 };
const afterContinuationEdit = applyEditedPath(afterSharedEdit, branch.id, continuationEdit.play, continuationEdit);
assert.deepEqual(afterContinuationEdit.arrows.find(({ id }) => id === 'move-two-a').end, base.arrows[1].end, 'continuation edits do not alter Main');
assert.deepEqual(afterContinuationEdit.branches[0].continuation.find(({ id }) => id === 'move-two-a').end, { x: 42, y: 60 });
assert.equal(branchActionStatus(resolvePlaybookPath(afterContinuationEdit, branch.id).play.arrows, afterContinuationEdit.arrows, 'move-two-a'), 'changed');
assert.equal(branchActionStatus([...resolvePlaybookPath(afterContinuationEdit, branch.id).play.arrows, action('new-move', 5, 2, { x: 50, y: 50 }, { x: 55, y: 50 })], afterContinuationEdit.arrows, 'new-move'), 'added');

const mainEdit = resolvePlaybookPath(afterContinuationEdit, null).play;
mainEdit.arrows.find(({ id }) => id === 'move-three').timing = 2;
const afterMainEdit = applyEditedPath(afterContinuationEdit, null, mainEdit, resolvePlaybookPath(afterContinuationEdit, null));
assert.equal(afterMainEdit.branches.length, 1, 'editing Main preserves the branch family');
assert.equal(resolvePlaybookPath(afterMainEdit, branch.id).play.arrows.find(({ id }) => id === 'move-three').timing, 1.2, 'Main continuation edits do not replace a branch-specific copied continuation');
assert.equal(resolvePlaybookPath(afterMainEdit, branch.id).play.arrows.find(({ id }) => id === 'move-one').end.x, 31, 'shared Main edits remain inherited');

const emptyEnding = clonePlaybook(family);
emptyEnding.branches[0].continuation = [];
assert.deepEqual(resolvePlaybookPath(emptyEnding, branch.id).play.arrows.map(({ id }) => id), ['move-one']);
validatePlaybookDocument(emptyEnding);

const missingAnchor = clonePlaybook(family);
missingAnchor.arrows = missingAnchor.arrows.filter(({ id }) => id !== 'move-two-a' && id !== 'move-two-b');
const reanchored = resolvePlaybookPath(missingAnchor, branch.id);
assert.deepEqual(reanchored.play.arrows.map(({ id }) => id), ['move-one', 'move-two-a', 'move-two-b', 'move-three', 'move-four']);

const shiftedCopy = clonePlaybook(family);
shiftedCopy.arrows.find(({ id }) => id === 'move-four').sequence = 1;
const shiftedPath = resolvePlaybookPath(shiftedCopy, branch.id).play.arrows;
assert.equal(shiftedPath.filter(({ id }) => id === 'move-four').length, 1, 'a Main action moved before the fork is inherited once, not duplicated');
assert.equal(shiftedPath.find(({ id }) => id === 'move-four').end.x, shiftedCopy.arrows.find(({ id }) => id === 'move-four').end.x);

const reorderedContinuation = clonePlaybook(family);
reorderedContinuation.branches[0].continuation[0].sequence = 1;
reorderedContinuation.branches[0].continuation[1].sequence = 1;
reorderedContinuation.branches[0].continuation.at(-1).sequence = 30;
const numberedEnding = resolvePlaybookPath(reorderedContinuation, branch.id).play;
assert.deepEqual(numberedEnding.arrows.map(({ sequence }) => sequence), [1, 2, 2, 3, 4], 'ending move groups follow the shared opening without running past the 30-move limit');
validatePlaybookDocument(reorderedContinuation);

assert.throws(() => validatePlaybookDocument({ ...family, branches: [{ ...branch, label: 'x'.repeat(41) }] }), /Ending labels/);
assert.throws(() => validatePlaybookDocument({ ...family, branches: [{ ...branch, continuation: [...branch.continuation, ...branch.continuation, ...branch.continuation, ...branch.continuation, ...branch.continuation, ...branch.continuation, ...branch.continuation, ...branch.continuation] }] }), /30 actions/);
const invalidParticipant = clonePlaybook(family);
invalidParticipant.branches[0].continuation[0].actor_id = 99;
assert.throws(() => validatePlaybookDocument(invalidParticipant), /participants/);

const savedFamily = {
  ...clonePlaybook(family),
  id: `play-${'a'.repeat(32)}`,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
  revision: 'b'.repeat(32),
};
let hosted = await upgradeHostedLibrary({ version: 1, plays: [], creations: [] });
hosted = await reviseHostedLibrary(hosted, savedFamily.id, savedFamily);
assert.equal(hosted.version, 3, 'hosted storage upgrades atomically to the branch-aware envelope');
await verifyHostedLibrary(hosted);
assert.deepEqual(validateHostedLibrary(hosted).plays[0].branches, savedFamily.branches);
const editedFamily = clonePlaybook(savedFamily);
editedFamily.branches[0].label = 'Corner kick';
editedFamily.revision = 'c'.repeat(32);
hosted = await reviseHostedLibrary(hosted, savedFamily.id, editedFamily);
await verifyHostedLibrary(hosted);
assert.equal(validateHostedLibrary(hosted).plays[0].branches[0].label, 'Corner kick', 'revision history preserves the complete edited family');

console.log('Playbook branch fork groups, shared edits, private continuations, stable anchors, validation and flattened simulation pass');
