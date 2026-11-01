import { caughtAt } from "../frontend/src/features/playbook/ballState.ts";
import assert from 'node:assert/strict';
import { compileActionDependencies, cyclicActionKeys } from '../frontend/src/features/playbook/actionDependencies.ts';
import { createSimulationRun, prepareSimulationRun, advanceSimulationState, editPausedSimulationMarker, observeCounterLabRun } from '../frontend/src/features/playbook/simulation.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'off', offenseMode: 'scripted' };
const play = (arrows, players = [{ id: 1, x: 40, y: 70 }, { id: 2, x: 48, y: 70 }, { id: 3, x: 80, y: 60 }]) => ({
  version: 1, id: 'dependencies-test', name: 'Action dependencies', defenders_visible: true,
  players, defenders: [{ id: 1, x: 5, y: 10 }], ball: { ...players[0] }, arrows,
});
const arrow = (id, kind, actor_id, recipient_id, sequence, start, end, extra = {}) => ({ id, kind, actor_id, recipient_id, sequence, start, end, timing: 1, ...extra });
function until(run, predicate, limit = 30000) {
  let iterations = 0;
  while (!predicate() && run.elapsedMs < run.durationMs && run.elapsedMs < limit) {
    advanceSimulationState(run, 1000 / 60);
    assert.ok(++iterations < 10000, 'Dependency waits cannot hang a possession');
  }
  assert.ok(predicate(), `Condition not reached at ${run.elapsedMs}: ${JSON.stringify(run.actions.map(a => [a.arrow.id,a.startTime,a.execution]))}`);
}
const fixture = play([
  arrow('handoff', 'handoff', 1, 2, 1, { x: 40, y: 70 }, { x: 48, y: 70 }),
  arrow('drive', 'movement', 2, undefined, 2, { x: 48, y: 70 }, { x: 55, y: 58 }),
  arrow('independent', 'movement', 3, undefined, 2, { x: 80, y: 60 }, { x: 85, y: 50 }),
]);
const original = structuredClone(fixture);
const run = createSimulationRun(fixture, settings);
const [handoff, drive, independent] = run.actions;
const cutStart = independent.startTime, driveStart = drive.startTime;
assert.ok(drive.plan.dependencies.some(edge => edge.key === handoff.plan.key && edge.milestone === 'catch'));
assert.deepEqual(independent.plan.dependencies, []);
until(run, () => run.elapsedMs >= 700);
editPausedSimulationMarker(run, 'player', 2, { x: 55, y: 70 });
until(run, () => run.elapsedMs > cutStart + 50);
assert.ok(handoff.durationMs > 1000, 'The fixture produces an actual delayed handoff');
assert.ok(Math.abs(independent.execution.startedAtMs - cutStart) < 1e-6, 'Unrelated cut retains its authored start despite the handoff delay');
assert.equal(drive.execution?.startedAtMs ?? null, null, 'Recipient cannot drive before catching');
assert.ok(drive.startTime > driveStart);
until(run, () => caughtAt(handoff.transfer) != null);
until(run, () => drive.execution?.startedAtMs != null);
assert.ok(drive.execution.startedAtMs >= caughtAt(handoff.transfer));
assert.equal(run.ballHandlerId, 2);
assert.deepEqual(fixture, original, 'Runtime schedules never alter saved version-1 arrows');

// A failed prerequisite blocks its descendants, but cannot cancel independent work.
const abandoned = createSimulationRun(fixture, settings);
abandoned.actions[0].recipientId = 99;
until(abandoned, () => abandoned.actions[1].execution?.phase === 'obstructed');
assert.equal(abandoned.actions[1].execution.startedAtMs, null);
assert.match(abandoned.actions[1].execution.notice, /prerequisite move 1/);
until(abandoned, () => abandoned.actions[2].execution?.startedAtMs != null);
assert.ok(Math.abs(abandoned.actions[2].execution.startedAtMs - cutStart) < 1e-6);
assert.ok(observeCounterLabRun(abandoned).frame.execution.some(action => action.actionId === 'drive' && /prerequisite/.test(action.notice)));

const simultaneous = play([
  arrow('first', 'movement', 3, undefined, 1, { x: 80, y: 60 }, { x: 82, y: 50 }),
  arrow('loser', 'movement', 3, undefined, 1, { x: 80, y: 60 }, { x: 70, y: 50 }),
  arrow('next', 'movement', 3, undefined, 2, { x: 82, y: 50 }, { x: 85, y: 45 }),
]);
const conflicted = createSimulationRun(simultaneous, settings);
assert.equal(conflicted.actions[1].execution.phase, 'conflict', 'Competing ownership is diagnosed before the first step');
assert.equal(conflicted.actions[1].execution.startedAtMs, null);
assert.deepEqual(conflicted.actions[2].plan.dependencies.map(edge => edge.key), [conflicted.actions[0].plan.key], 'Losing routes do not become prerequisites of later actions');

const descriptor = (key, actorId, recipientId) => ({ key, sequence: 1, startTime: 0, kind: 'pass', actorId, recipientId, userId: null, onBall: true, automatic: false });
const cyclic = compileActionDependencies([descriptor('a', 2, 3), descriptor('b', 3, 2)], 1);
assert.deepEqual([...cyclicActionKeys(cyclic)].sort(), ['a', 'b']);
assert.ok([...cyclic.values()].every(plan => plan.failure.phase === 'conflict' && /Circular/.test(plan.failure.notice)));
const elevator = compileActionDependencies([
  { key: 'left', sequence: 1, startTime: 0, kind: 'pin-down', actorId: 4, recipientId: 2, userId: 2, onBall: false, automatic: false, userTarget: { x: 50, y: 61 } },
  { key: 'right', sequence: 1, startTime: 0, kind: 'pin-down', actorId: 5, recipientId: 2, userId: 2, onBall: false, automatic: false, userTarget: { x: 50, y: 61 } },
], 1);
assert.ok([...elevator.values()].every(plan => !plan.failure), 'Cooperative elevator screens do not compete for contradictory cutter routes');
const circularRun = createSimulationRun(play([
  arrow('a', 'pass', 2, 3, 1, { x: 48, y: 70 }, { x: 80, y: 60 }),
  arrow('b', 'pass', 3, 2, 1, { x: 80, y: 60 }, { x: 48, y: 70 }),
]), settings);
assert.ok(circularRun.actions.every(action => action.execution.phase === 'conflict'));
const connectedCycles = new Map([
  ['a', ['b', 'd']], ['b', ['c']], ['c', ['a']], ['d', ['b']], ['descendant', ['a']], ['self', ['self']],
].map(([key, dependencies]) => [key, { key, dependencies: dependencies.map(key => ({ key, milestone: 'completed', playerId: null })) }]));
assert.deepEqual([...cyclicActionKeys(connectedCycles)].sort(), ['a', 'b', 'c', 'd', 'self'], 'All cycle members are found; a dependent outside the cycle is not mislabeled');
const missing = createSimulationRun(play([arrow('wrong', 'pass', 2, 3, 1, { x: 48, y: 70 }, { x: 80, y: 60 })]), settings);
assert.match(missing.actions[0].execution.notice, /initial possession/);

// Prepared plans are copied per run, while each graph points to its own actions.
const factory = prepareSimulationRun(fixture);
const first = factory(settings), second = factory(settings);
assert.deepEqual(first, second);
first.actions[1].plan.dependencies.length = 0;
assert.ok(second.actions[1].plan.dependencies.length);
for (const action of second.actions) assert.strictEqual(second.actionGraph.get(action.plan.key), action);
console.log('Action dependency tests passed: delayed real catch, independent movement, failed prerequisites, compile-time ownership/cycles, possession gates, stable version-1 source and isolated prepared graphs.');

// Two real catches gate the next passer and the final handler's drive.
const chain = createSimulationRun(play([
  arrow('one-two', 'pass', 1, 2, 1, { x: 40, y: 70 }, { x: 50, y: 70 }),
  arrow('two-three', 'pass', 2, 3, 2, { x: 50, y: 70 }, { x: 60, y: 70 }),
  arrow('finish', 'movement', 3, undefined, 3, { x: 60, y: 70 }, { x: 63, y: 62 }),
], [{ id: 1, x: 40, y: 70 }, { id: 2, x: 50, y: 70 }, { id: 3, x: 60, y: 70 }]), settings);
until(chain, () => chain.actions[2].execution?.startedAtMs != null);
assert.ok(chain.actions[1].execution.startedAtMs >= caughtAt(chain.actions[0].transfer));
assert.ok(chain.actions[2].execution.startedAtMs >= caughtAt(chain.actions[1].transfer));

const movingReceiver = createSimulationRun(play([
  arrow('pass', 'pass', 1, 2, 1, { x: 40, y: 70 }, { x: 54, y: 65 }, { timing: 2 }),
  arrow('receive-cut', 'movement', 2, undefined, 1, { x: 48, y: 70 }, { x: 54, y: 65 }, { timing: 2 }),
]), settings);
assert.ok(movingReceiver.actions.every(action => !action.plan.failure), 'A simultaneous receiver route remains compatible with its pass');
until(movingReceiver, () => caughtAt(movingReceiver.actions[0].transfer) != null);
assert.equal(movingReceiver.actions[0].execution.startedAtMs, movingReceiver.actions[1].execution.startedAtMs);

const screenPlay = play([
  { id: 'roll', kind: 'pick-roll', screener_id: 2, handler_id: 1, start: { x: 56, y: 70 }, end: { x: 54, y: 68 }, sequence: 1, timing: 2 },
  arrow('feed', 'pass', 1, 2, 2, { x: 50, y: 70 }, { x: 54, y: 55 }),
], [{ id: 1, x: 50, y: 70 }, { id: 2, x: 56, y: 70 }, { id: 3, x: 80, y: 60 }]);
const screen = createSimulationRun(screenPlay, settings);
until(screen, () => screen.actions[0].execution?.releasedAtMs != null);
assert.ok(screen.actions[0].execution.releasedAtMs >= screen.actions[0].execution.usedAtMs, 'Roll release requires actual screen use');
assert.equal(screen.actions[1].execution?.startedAtMs ?? null, null, 'The feed cannot begin while its screen/roll prerequisite is executing');
const abandonedScreen = createSimulationRun(screenPlay, settings);
advanceSimulationState(abandonedScreen, 50);
abandonedScreen.players = abandonedScreen.players.filter(player => player.id !== 1);
advanceSimulationState(abandonedScreen, 50);
assert.equal(abandonedScreen.actions[0].execution.phase, 'obstructed');
assert.equal(abandonedScreen.actions[0].execution.releasedAtMs, undefined, 'Losing a screen participant cannot manufacture screen use or a roll');
assert.equal(abandonedScreen.actions[1].execution.phase, 'obstructed');
assert.equal(abandonedScreen.actions[1].execution.startedAtMs, null);
const partial = createSimulationRun(play([
  { id: 'self-screen', kind: 'screen', screener_id: 1, start: { x: 40, y: 70 }, end: { x: 45, y: 65 }, sequence: 1 },
], [{ id: 1, x: 40, y: 70 }]), settings);
assert.equal(partial.actions[0].execution.phase, 'obstructed');
assert.match(partial.actions[0].execution.notice, /screen user/);
console.log('Additional dependency fixtures passed: chained catches, moving receiver, screen-use/roll gate, abandoned screen and partial roster.');
