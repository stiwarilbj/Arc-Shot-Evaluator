import assert from 'node:assert/strict';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { validatePlaybookDocument } from '../frontend/src/features/playbook/documentValidation.ts';
import { pocketInsertionBranchTarget } from '../frontend/src/features/playbook/playbookBranches.ts';
import {
  STARTER_POCKET_ACTIONS,
  buildPocketInsertion,
  createPocketFromSelection,
  freshPocketCopy,
  inspectPocketCapture,
  transformPocketActions,
  validatePocketAction,
} from '../frontend/src/features/playbook/pocketActions.ts';

for (const pocket of STARTER_POCKET_ACTIONS) validatePocketAction(pocket);
assert.equal(STARTER_POCKET_ACTIONS.length, 4);
assert.deepEqual(STARTER_POCKET_ACTIONS.map((pocket) => pocket.name), [
  'Handoff into rescreen', 'Corner cut plus replacement', 'Give and go', 'Staggered screen',
]);
assert.equal(STARTER_POCKET_ACTIONS[0].actions[1].waits[0].event, 'catch', 'rescreen waits for the recorded handoff catch');
assert.equal(STARTER_POCKET_ACTIONS[2].actions[1].waits[0].event, 'catch', 'give-and-go cut waits for the entry pass');
assert.equal(STARTER_POCKET_ACTIONS[2].actions[2].waits[1].event, 'complete', 'return pass waits for the cut');
assert.equal(STARTER_POCKET_ACTIONS[3].actions[1].waits[0].event, 'screen-use', 'staggered screen waits for the first screen to be used');
assert.equal(pocketInsertionBranchTarget('ending-a', 4, 2, false), null, 'insertions before a fork extend the shared opening');
assert.equal(pocketInsertionBranchTarget('ending-a', 4, 4, false), 'ending-a', 'the fork boundary defaults to its private ending');
assert.equal(pocketInsertionBranchTarget('ending-a', 4, 4, true), null, 'the fork boundary can explicitly target the shared opening');
assert.equal(pocketInsertionBranchTarget(null, null, null, false), null, 'Main remains the only target for unbranched plays');

const source = structuredClone(STARTER_PLAYS.find((play) => play.name === 'Give and go'));
source.arrows = [
  {
    id: 'entry-pass', kind: 'pass', actor_id: 1, recipient_id: 2, sequence: 1,
    start: { x: 50, y: 77 }, end: { x: 35, y: 52 }, timing: 0.9,
    timingPlan: { startAtMs: 0 },
  },
  {
    id: 'curved-cut', kind: 'movement', actor_id: 1, sequence: 2, path: 'curve',
    start: { x: 50, y: 77 }, control: { x: 43, y: 62 }, end: { x: 52, y: 44 }, timing: 1.2,
    timingPlan: { startAtMs: 900, syncId: 'cut-fill', waits: [{ id: 'wait-catch', actionId: 'entry-pass', event: 'catch' }] },
  },
  {
    id: 'weak-fill', kind: 'movement', actor_id: 3, sequence: 2,
    start: { x: 76, y: 31 }, end: { x: 65, y: 45 }, timing: 1,
    timingPlan: { startAtMs: 900, syncId: 'cut-fill' },
  },
  {
    id: 'route-wait', kind: 'movement', actor_id: 4, sequence: 3,
    start: { x: 24, y: 31 }, end: { x: 26, y: 50 }, timing: 1,
    timingPlan: { startAtMs: 2100, waits: [{ id: 'wait-route', actionId: 'curved-cut', event: 'route-point', playerId: 1, routePhase: 'main', routeSegment: 4, progress: 0.6 }] },
  },
];
const issues = inspectPocketCapture(source.arrows, ['curved-cut']);
assert.ok(issues.some((issue) => issue.kind === 'simultaneous'));
assert.ok(issues.some((issue) => issue.kind === 'sync'));
assert.ok(issues.some((issue) => issue.kind === 'external-wait'));
assert.throws(() => createPocketFromSelection(source, ['curved-cut'], 'Partial'), /Include every action|pinned action|outside this combination/);

const pocket = createPocketFromSelection(source, source.arrows.map((arrow) => arrow.id), 'Give and go variation');
assert.equal(pocket.actions.length, 4);
assert.equal(pocket.actions[1].arrow.path, 'curve');
assert.ok(pocket.actions[1].arrow.control);
assert.equal(pocket.actions[1].syncGroup, pocket.actions[2].syncGroup);
const capturedRouteWait = pocket.actions[3].waits[0];
assert.equal(capturedRouteWait.event, 'route-point');
assert.equal(capturedRouteWait.playerRole, pocket.roles.find((role) => role.sourcePlayerId === 1).id);
assert.equal('playerId' in capturedRouteWait, false, 'captured waits store roles rather than source roster IDs');
assert.equal('actionId' in capturedRouteWait, false, 'captured waits point to pocket-local action identities');

const implicitScreenSource = structuredClone(source);
const screener = implicitScreenSource.players[0];
implicitScreenSource.arrows = [{ id: 'implicit-screen', kind: 'screen', start: { x: screener.x, y: screener.y }, end: { x: 52, y: 65 }, sequence: 1, timing: 1.2 }];
const implicitScreenPocket = createPocketFromSelection(implicitScreenSource, ['implicit-screen'], 'Bound screen roles');
assert.equal(implicitScreenPocket.actions[0].participants.screener, implicitScreenPocket.roles.find((role) => role.sourcePlayerId === screener.id)?.id, 'capture uses the engine-bound actor when a screen has no explicit screener ID');
assert.ok(implicitScreenPocket.actions[0].participants.handler, 'capture preserves the engine-bound live handler as the screen partner');

const stripped = createPocketFromSelection(source, ['curved-cut'], 'Independent', true);
assert.equal(stripped.actions[0].waits.length, 0, 'explicit removal strips waits whose sources were not captured');
assert.equal(stripped.actions.every((action) => !action.syncGroup), true, 'partial pinned groups become unpinned in the saved copy');

const assignments = Object.fromEntries(pocket.roles.map((role, index) => [role.id, index + 1]));
const transformed = transformPocketActions(pocket, assignments, { anchor: { x: 50, y: 70 }, rotation: 35, mirrored: true });
assert.notEqual(transformed.arrows[1].id, pocket.actions[1].id);
assert.notDeepEqual(transformed.arrows[1].control, pocket.actions[1].arrow.control, 'curved routes rotate and mirror in physical court coordinates');
assert.ok(transformed.arrows[3].timingPlan.waits[0].playerId, 'route-point waits bind to the explicitly assigned player');
assert.equal(transformed.arrows[1].timingPlan.syncId, transformed.arrows[2].timingPlan.syncId);
assert.notEqual(transformed.arrows[1].timingPlan.syncId, pocket.actions[1].syncGroup, 'pocket sync identities are fresh for each placement');
assert.notEqual(transformed.arrows[3].timingPlan.waits[0].actionId, pocket.actions[1].id, 'waits bind to freshly generated inserted action IDs');
assert.throws(() => transformPocketActions(pocket, Object.fromEntries(pocket.roles.map((role) => [role.id, 1])), { anchor: { x: 50, y: 70 }, rotation: 0, mirrored: false }), /different offensive player/);
assert.throws(() => transformPocketActions(pocket, assignments, { anchor: { x: Number.NaN, y: 70 }, rotation: 0, mirrored: false }), /coordinates or rotation/);

const simplePocket = {
  version: 1,
  id: 'pocket-test-simple',
  revision: 'revision-1',
  name: 'Quick cut',
  createdAt: '2026-10-22T12:00:00Z',
  updatedAt: '2026-10-22T12:00:00Z',
  roles: [{ id: 'role-handler', label: 'Handler', entry: { x: 70, y: 60 }, sourcePlayerId: 1 }],
  requiredBallRole: 'role-handler',
  actions: [{
    id: 'pact-cut',
    arrow: { id: 'pact-cut', kind: 'movement', start: { x: 70, y: 60 }, end: { x: 60, y: 42 }, sequence: 1, path: 'straight', timing: 1 },
    participants: { actor: 'role-handler' }, startAtMs: 0, durationMs: 1000, waits: [],
  }],
};
validatePocketAction(simplePocket);
const original = structuredClone(source);
const assignment = { 'role-handler': 2 };
const insertion = buildPocketInsertion({
  source,
  pocket: simplePocket,
  assignments: assignment,
  transform: { anchor: { x: 70, y: 60 }, rotation: 0, mirrored: false },
  beforeSequence: 2,
  currentPositions: source.players.map(({ id, x, y }) => ({ id, x, y })),
  currentBallHandlerId: 1,
  includeConnectionPass: true,
  baseStartAtMs: 750,
  idFactory: (() => { let index = 0; return () => `generated-${++index}`; })(),
});
assert.equal(insertion.insertedIds.length, 3, 'insertion creates a connection pass, a setup move, and a pocket move');
assert.equal(insertion.startAtMs, 800, 'insertion boundaries snap to the shared 100ms timing grid');
assert.ok(insertion.insertedIds.every((id) => Number.isSafeInteger(insertion.arrows.find((arrow) => arrow.id === id).timingPlan.startAtMs)));
validatePlaybookDocument({ ...source, arrows: insertion.arrows });
assert.equal(insertion.arrows.find((arrow) => arrow.id === insertion.insertedIds[0]).kind, 'pass');
assert.ok(insertion.arrows.find((arrow) => arrow.id === insertion.insertedIds[1]).timingPlan.waits[0].event === 'catch');
assert.ok(insertion.arrows.find((arrow) => arrow.id === insertion.insertedIds[2]).timingPlan.waits.some((wait) => wait.event === 'complete'));
assert.ok(source.arrows.filter((arrow) => arrow.sequence >= 2).every((originalArrow) => insertion.arrows.find((arrow) => arrow.id === originalArrow.id).sequence > originalArrow.sequence), 'existing moves at and after the selected boundary shift without replacement');
assert.deepEqual(source, original, 'preview generation never mutates the source play');
assert.throws(() => buildPocketInsertion({
  source, pocket: simplePocket, assignments: assignment,
  transform: { anchor: { x: 70, y: 60 }, rotation: 0, mirrored: false },
  beforeSequence: 2, currentPositions: source.players.map(({ id, x, y }) => ({ id, x, y })),
  currentBallHandlerId: 1, includeConnectionPass: false, baseStartAtMs: 750,
}), /Confirm the setup pass/);
assert.throws(() => buildPocketInsertion({
  source, pocket: simplePocket, assignments: assignment,
  transform: { anchor: { x: 70, y: 60 }, rotation: 0, mirrored: false },
  beforeSequence: 2, currentPositions: source.players.map(({ id, x, y }) => ({ id, x, y })),
  currentBallHandlerId: null, includeConnectionPass: true, baseStartAtMs: 750,
}), /ball handler is unresolved/);
assert.throws(() => buildPocketInsertion({
  source, pocket: simplePocket, assignments: assignment,
  transform: { anchor: { x: 70, y: 60 }, rotation: 0, mirrored: false },
  beforeSequence: null, currentPositions: source.players.map(({ id, x, y }) => ({ id, x, y })),
  currentBallHandlerId: 1, includeConnectionPass: true, baseStartAtMs: 119_950,
}), /120-second play timeline/);

const copy = freshPocketCopy(pocket);
assert.notEqual(copy.id, pocket.id);
assert.notEqual(copy.actions[0].id, pocket.actions[0].id);
assert.notEqual(copy.actions[3].waits[0].sourceAction, pocket.actions[3].waits[0].sourceAction);
assert.equal(copy.starter, undefined);
validatePocketAction(copy);

assert.throws(() => validatePocketAction({ ...simplePocket, actions: [{ ...simplePocket.actions[0], arrow: { ...simplePocket.actions[0].arrow, end: { x: 150, y: 30 } } }] }), /details|outside/i);
assert.throws(() => validatePocketAction({ ...simplePocket, actions: [{ ...simplePocket.actions[0], waits: [{ id: 'a', sourceAction: 'pact-cut', event: 'complete' }] }] }), /internal wait|cycle/i);
console.log('Pocket Actions regressions passed: starters, capture, partial groups, curves, role remapping, transformed placement, setup passes, timing dependencies, source independence, and invalid input');
