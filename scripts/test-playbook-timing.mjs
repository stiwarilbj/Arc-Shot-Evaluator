import assert from 'node:assert/strict';
import { validatePlaybookDocument } from '../frontend/src/features/playbook/documentValidation.ts';
import { upgradeHostedLibrary, reviseHostedLibrary, validateHostedLibrary, verifyHostedLibrary } from '../frontend/src/features/playbook/hostedLibrary.ts';
import { flattenPlaybookPath } from '../frontend/src/features/playbook/playbookBranches.ts';
import { createSimulationRun, advanceSimulationState } from '../frontend/src/features/playbook/simulation.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { moveTimingGroup, projectPointToRoute, resizeActionMinimum, shiftConnectedTiming, snapTimingMs } from '../frontend/src/features/playbook/timingMixer.ts';
import { createCounterLabRepairs, preservesTimingContracts } from '../frontend/src/features/playbook/counterLabTypes.ts';

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'off', offenseMode: 'scripted' };
const players = [1, 2, 3, 4].map((id) => ({ id, x: 17 + id * 14, y: 70, ratings: { threePoint: 3, midrange: 3, finishing: 3 }, badges: [] }));
const play = (arrows) => ({ version: 1, id: 'timing-test', name: 'Timing mixer', defenders_visible: true, players: structuredClone(players), defenders: [{ id: 1, x: 8, y: 8 }], ball: { ...players[0] }, arrows });
const action = (id, kind, actor_id, sequence, start, end, extra = {}) => ({ id, kind, actor_id, sequence, start, end, timing: 0.5, ...extra });
function runUntil(run, predicate, limit = 16000) {
  let count = 0;
  while (!predicate() && run.elapsedMs < limit && run.elapsedMs < run.durationMs) {
    advanceSimulationState(run, 1000 / 60);
    assert.ok(++count < 2000, 'timing prerequisites cannot hold a run forever');
  }
  assert.ok(predicate(), `Expected timing event at ${run.elapsedMs}ms: ${JSON.stringify(run.actions.map((item) => [item.arrow.id, item.startTime, item.execution?.phase, item.execution?.notice]))}`);
}

assert.equal(snapTimingMs(149), 100);
assert.equal(snapTimingMs(150), 200);
const baseActions = [
  action('source', 'movement', 2, 1, { x: players[1].x, y: 70 }, { x: players[1].x + 5, y: 70 }, { timingPlan: { startAtMs: 400 } }),
  action('waiting', 'movement', 3, 2, { x: players[2].x, y: 70 }, { x: players[2].x + 5, y: 65 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'wait-start', actionId: 'source', event: 'start' }] } }),
  action('independent', 'movement', 4, 2, { x: players[3].x, y: 70 }, { x: players[3].x + 5, y: 66 }, { timingPlan: { startAtMs: 200 } }),
];
const startRun = createSimulationRun(play(baseActions), settings, undefined, { seed: 123 });
assert.equal(startRun.actions[1].execution?.startedAtMs ?? null, null, 'a start wait blocks the dependent move before the source begins');
runUntil(startRun, () => startRun.actions[0].execution?.startedAtMs != null);
assert.equal(startRun.actions[1].execution.startedAtMs, startRun.actions[0].execution.startedAtMs, 'a dependent start follows the actual source start');
runUntil(startRun, () => startRun.actions[2].execution?.startedAtMs != null);
assert.ok(Math.abs(startRun.actions[2].execution.startedAtMs - 200) < 1e-6, 'an independent lane keeps its planned time');

const routePlay = play([
  action('curved-route', 'movement', 2, 1, { x: 45, y: 70 }, { x: 65, y: 50 }, { path: 'curve', control: { x: 62, y: 70 }, timingPlan: { startAtMs: 0 } }),
  action('route-wait', 'movement', 3, 2, { x: 59, y: 76 }, { x: 61, y: 68 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'wait-route', actionId: 'curved-route', event: 'route-point', playerId: 2, routePhase: 'main', routeSegment: 20, progress: 0.55 }] } }),
]);
const routeRun = createSimulationRun(routePlay, settings, undefined, { seed: 55 });
assert.equal(routeRun.actions[1].execution?.startedAtMs ?? null, null, 'route wait starts only after actual movement reaches its route point');
runUntil(routeRun, () => routeRun.actions[1].execution?.startedAtMs != null);
assert.ok(routeRun.actions[0].execution.routeProgress.get('main:2') >= 0.55);
assert.ok(routeRun.actions[1].execution.startedAtMs > 0);

const screenPlay = play([
  { ...action('screen', 'pick-roll', 2, 1, { x: players[1].x, y: 70 }, { x: players[1].x, y: 70 }, { screener_id: 2, handler_id: 1, timingPlan: { startAtMs: 0 } }) },
  action('after-set', 'movement', 3, 2, { x: players[2].x, y: 70 }, { x: players[2].x + 5, y: 65 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'wait-set', actionId: 'screen', event: 'screen-set' }] } }),
  action('after-use', 'movement', 4, 3, { x: players[3].x, y: 70 }, { x: players[3].x + 5, y: 65 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'wait-use', actionId: 'screen', event: 'screen-use' }] } }),
]);
const screenRun = createSimulationRun(screenPlay, settings, undefined, { seed: 91 });
runUntil(screenRun, () => screenRun.actions[1].execution?.startedAtMs != null);
assert.ok(screenRun.actions[0].execution.setAtMs != null);
assert.ok(screenRun.actions[1].execution.startedAtMs >= screenRun.actions[0].execution.setAtMs);
runUntil(screenRun, () => screenRun.actions[2].execution?.startedAtMs != null);
assert.ok(screenRun.actions[0].execution.usedAtMs != null);
assert.ok(screenRun.actions[2].execution.startedAtMs >= screenRun.actions[0].execution.usedAtMs);

const contractedScreen = play([
  action('contract-screen', 'pick-roll', 2, 1, { x: 45, y: 70 }, { x: 50, y: 65 }, { screener_id: 2, handler_id: 1, timingPlan: { startAtMs: 0 } }),
  action('contract-waiter', 'movement', 3, 2, { x: 65, y: 70 }, { x: 65, y: 60 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'screen-use-contract', actionId: 'contract-screen', event: 'screen-use' }] } }),
]);
assert.equal(preservesTimingContracts(contractedScreen, { ...contractedScreen, arrows: contractedScreen.arrows.map((arrow) => arrow.id === 'contract-screen' ? { ...arrow, kind: 'slip-screen' } : arrow) }), false, 'a repair cannot turn a required screen-use event into a slip that bypasses screen set/use');
assert.ok(!createCounterLabRepairs(contractedScreen).some((repair) => repair.id === 'slip-contract-screen'), 'Counter Lab omits a slip candidate that would change a required screen-use event');
const contractedRoute = play([
  action('contract-route', 'movement', 2, 1, { x: 45, y: 70 }, { x: 65, y: 50 }, { path: 'curve', control: { x: 62, y: 70 }, timingPlan: { startAtMs: 0 } }),
  action('route-contract-waiter', 'movement', 3, 2, { x: 59, y: 76 }, { x: 61, y: 68 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'route-contract', actionId: 'contract-route', event: 'route-point', playerId: 2, routePhase: 'main', routeSegment: 2, progress: 0.5 }] } }),
]);
assert.equal(preservesTimingContracts(contractedRoute, { ...contractedRoute, arrows: contractedRoute.arrows.map((arrow) => arrow.id === 'contract-route' ? { ...arrow, end: { x: 70, y: 50 } } : arrow) }), false, 'a repair cannot move the route underneath a court-picked event point');

const pinPlay = play([
  action('pass', 'pass', 1, 1, { x: players[0].x, y: 70 }, { x: players[1].x, y: 70 }, { recipient_id: 2, timingPlan: { startAtMs: 0 } }),
  action('pin-a', 'movement', 2, 2, { x: players[1].x, y: 70 }, { x: players[1].x + 4, y: 65 }, { timingPlan: { startAtMs: 0, syncId: 'group', waits: [{ id: 'wait-catch-a', actionId: 'pass', event: 'catch' }] } }),
  action('pin-b', 'movement', 3, 2, { x: players[2].x, y: 70 }, { x: players[2].x + 4, y: 65 }, { timingPlan: { startAtMs: 0, syncId: 'group', waits: [{ id: 'wait-catch-b', actionId: 'pass', event: 'catch' }] } }),
  action('independent', 'movement', 4, 2, { x: players[3].x, y: 70 }, { x: players[3].x + 4, y: 65 }, { timingPlan: { startAtMs: 200 } }),
]);
const pinRun = createSimulationRun(pinPlay, settings, undefined, { seed: 77 });
assert.equal(pinRun.actions[1].execution?.startedAtMs ?? null, null);
assert.equal(pinRun.actions[2].execution?.startedAtMs ?? null, null);
runUntil(pinRun, () => pinRun.actions[1].execution?.startedAtMs != null && pinRun.actions[2].execution?.startedAtMs != null);
assert.equal(pinRun.actions[1].execution.startedAtMs, pinRun.actions[2].execution.startedAtMs, 'a start-together group waits until every event and possession requirement is met');
assert.ok(pinRun.actions[3].execution.startedAtMs < pinRun.actions[1].execution.startedAtMs, 'independent movement is not pulled behind the pinned group');

const source = action('start', 'movement', 1, 1, { x: 10, y: 10 }, { x: 12, y: 12 });
const successor = action('next', 'movement', 2, 2, { x: 20, y: 20 }, { x: 22, y: 22 });
source.timingPlan = { startAtMs: 0, syncId: 'same' };
successor.timingPlan = { startAtMs: 0, syncId: 'same' };
assert.equal(moveTimingGroup([source, successor], 'start', 650)[1].timingPlan.startAtMs, 700);
assert.equal(resizeActionMinimum(source, 9).timing, 4);
const projection = projectPointToRoute({ x: 5, y: 1 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
assert.equal(projection.progress, 0.5);
assert.equal(projection.distance, 1);
const shifted = shiftConnectedTiming([
  { ...source, timingPlan: { startAtMs: 0 } },
  { ...successor, actor_id: 1, timingPlan: { startAtMs: 900 } },
], [
  { arrow: source, sequence: 1, actorId: 1, recipientId: null },
  { arrow: { ...successor, actor_id: 1 }, sequence: 2, actorId: 1, recipientId: null },
], 'start', 300);
assert.equal(shifted[1].timingPlan.startAtMs, 1200, 'connected later actions shift while their shared player lane remains ordered');
const explicitWaitShift = shiftConnectedTiming([
  action('late-number-source', 'movement', 1, 3, { x: 10, y: 10 }, { x: 15, y: 10 }, { timingPlan: { startAtMs: 900 } }),
  action('earlier-number-waiter', 'movement', 3, 1, { x: 30, y: 30 }, { x: 35, y: 30 }, { timingPlan: { startAtMs: 100, waits: [{ id: 'wait-late-number', actionId: 'late-number-source', event: 'complete' }] } }),
  action('unrelated-lane', 'movement', 4, 2, { x: 55, y: 55 }, { x: 60, y: 55 }, { timingPlan: { startAtMs: 500 } }),
], [
  { arrow: { id: 'late-number-source', kind: 'movement', actor_id: 1 }, sequence: 3, actorId: 1, recipientId: null },
  { arrow: { id: 'earlier-number-waiter', kind: 'movement', actor_id: 3, timingPlan: { startAtMs: 100, waits: [{ id: 'wait-late-number', actionId: 'late-number-source', event: 'complete' }] } }, sequence: 1, actorId: 3, recipientId: null },
  { arrow: { id: 'unrelated-lane', kind: 'movement', actor_id: 4 }, sequence: 2, actorId: 4, recipientId: null },
], 'late-number-source', 300);
assert.equal(explicitWaitShift[1].timingPlan.startAtMs, 400, 'an explicit wait shifts with its source even when move numbers run in reverse');
assert.equal(explicitWaitShift[2].timingPlan.startAtMs, 500, 'an unrelated lane retains its planned time');

const legacy = play([action('legacy', 'movement', 2, 1, { x: 45, y: 70 }, { x: 50, y: 60 })]);
validatePlaybookDocument(legacy);
const partial = play([action('timed', 'movement', 2, 1, { x: 45, y: 70 }, { x: 50, y: 60 }, { timingPlan: { startAtMs: 0 } }), action('legacy-two', 'movement', 3, 2, { x: 58, y: 70 }, { x: 60, y: 60 })]);
assert.throws(() => validatePlaybookDocument(partial), /every action/);
const cycle = play([
  action('cycle-a', 'movement', 2, 1, { x: 45, y: 70 }, { x: 50, y: 60 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'a', actionId: 'cycle-b', event: 'start' }] } }),
  action('cycle-b', 'movement', 3, 2, { x: 58, y: 70 }, { x: 60, y: 60 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'b', actionId: 'cycle-a', event: 'complete' }] } }),
]);
assert.throws(() => validatePlaybookDocument(cycle), /cycle/i);
const duplicateOwner = play([source, { ...successor, actor_id: 1 }]);
duplicateOwner.arrows[0].timingPlan = { startAtMs: 0, syncId: 'same' };
duplicateOwner.arrows[1].timingPlan = { startAtMs: 0, syncId: 'same' };
assert.throws(() => validatePlaybookDocument(duplicateOwner), /movement owner/);
const cycleThroughPin = play([
  action('pinned-a', 'movement', 1, 1, { x: 20, y: 70 }, { x: 24, y: 64 }, { timingPlan: { startAtMs: 0, syncId: 'same-pin', waits: [{ id: 'wait-x', actionId: 'outside-pin', event: 'start' }] } }),
  action('pinned-b', 'movement', 2, 1, { x: 35, y: 70 }, { x: 38, y: 64 }, { timingPlan: { startAtMs: 0, syncId: 'same-pin' } }),
  action('outside-pin', 'movement', 3, 2, { x: 50, y: 70 }, { x: 54, y: 64 }, { timingPlan: { startAtMs: 0, waits: [{ id: 'wait-b', actionId: 'pinned-b', event: 'start' }] } }),
]);
assert.throws(() => validatePlaybookDocument(cycleThroughPin), /cycle/i, 'wait cycles through a synchronized group are rejected');

const timed = {
  ...legacy, id: `play-${'a'.repeat(32)}`, created_at: '2026-10-22T12:00:00Z', updated_at: '2026-10-22T12:00:00Z', revision: 'b'.repeat(32),
  arrows: legacy.arrows.map((arrow) => ({ ...arrow, timingPlan: { startAtMs: 150, waits: [] } })),
};
let hosted = await upgradeHostedLibrary({ version: 1, plays: [], creations: [] });
hosted = await reviseHostedLibrary(hosted, timed.id, timed);
assert.equal(hosted.version, 4, 'hosted storage moves to a timing-aware envelope atomically');
assert.equal(validateHostedLibrary(hosted).plays[0].arrows[0].timingPlan.startAtMs, 150);
await verifyHostedLibrary(hosted);
assert.equal(flattenPlaybookPath(timed).arrows[0].timingPlan.startAtMs, 150, 'Counter Lab handoff keeps the selected schedule');
console.log('Timing Mixer regressions passed: actual start and route milestones, catches and pins, independent lanes, graph validation, legacy behavior, precision helpers and hosted timing envelope');
