import assert from 'node:assert/strict';
import { createSimulationRun, advanceSimulationState, editPausedSimulationMarker, rebasePausedSimulation, getSimulationFrame, pointDistanceFeet } from '../frontend/src/features/playbook/simulation.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { preparedPlayerRating, preparedHasBadge } from '../frontend/src/features/playbook/simulationAttributes.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'off', offenseMode: 'scripted' };
const step = run => advanceSimulationState(run, 1000 / 60);
function until(run, predicate) {
  for (let n = 0; n < 2000 && !predicate() && run.elapsedMs < run.durationMs; n++) step(run);
  assert.ok(predicate(), `Condition not reached at ${run.elapsedMs}`);
}
const source = () => ({ version: 1, id: 'paused-transaction', name: 'Paused transaction', defenders_visible: true,
  players: [{ id: 1, x: 35, y: 75 }, { id: 2, x: 78, y: 70 }, { id: 3, x: 15, y: 35 }],
  defenders: [{ id: 1, x: 10, y: 10 }, { id: 2, x: 90, y: 10 }], ball: { x: 35, y: 75 },
  arrows: [{ id: 'drive', kind: 'movement', actor_id: 1, start: { x: 35, y: 75 }, end: { x: 40, y: 45 }, timing: 4, sequence: 1 },
    { id: 'cut', kind: 'movement', actor_id: 2, start: { x: 78, y: 70 }, end: { x: 82, y: 45 }, timing: 4, sequence: 1 }] });
const paused = () => { const run = createSimulationRun(source(), settings); until(run, () => run.elapsedMs >= 600); return run; };

// Attribute-only edits update the active markers and prepared decision inputs,
// while keeping their actual positions, velocities, action progress and clock.
const run = paused(), initial = structuredClone(run), authored = structuredClone(run.source);
const edited = structuredClone(authored);
edited.players[1].ratings = { threePoint: 5, midrange: 2, finishing: 1 };
edited.players[1].badges = ['deep-range']; edited.defenders[0].badges = ['helper'];
assert.equal(rebasePausedSimulation(run, edited), true);
assert.equal(run.elapsedMs, initial.elapsedMs); assert.equal(run.accumulatorMs, initial.accumulatorMs);
assert.deepEqual(run.players.map(({ id, x, y }) => ({ id, x, y })), initial.players);
assert.deepEqual(run.velocities, initial.velocities);
assert.deepEqual(run.actions.map(a => a.execution), initial.actions.map(a => a.execution));
assert.equal(preparedPlayerRating(run.players[1], 'threePoint'), 5);
assert.equal(preparedHasBadge(run.players[1], 'deep-range'), true);
assert.equal(preparedHasBadge(run.defenders[0], 'helper'), true);
assert.equal(run.offBallTargetSkills.get(2), 'threePoint');
edited.players[1].ratings.threePoint = 1;
assert.equal(run.players[1].ratings.threePoint, 5, 'caller cannot mutate committed attributes');
assert.deepEqual(authored, source(), 'the original drawing stays untouched');

// Fractional playback must not nudge untouched display markers on any edit.
const fractional = paused(); advanceSimulationState(fractional, 7);
const fractionalBefore = getSimulationFrame(fractional), fractionEdit = structuredClone(fractional.source);
fractionEdit.players[0].ratings = { threePoint: 5, midrange: 5, finishing: 5 };
assert.equal(rebasePausedSimulation(fractional, fractionEdit), true);
const positions = frame => frame.players.map(({ id, x, y }) => ({ id, x, y }));
assert.deepEqual(positions(getSimulationFrame(fractional)), positions(fractionalBefore));
assert.deepEqual(getSimulationFrame(fractional).ball, fractionalBefore.ball);
editPausedSimulationMarker(fractional, 'player', 3, { x: 19, y: 39 });
assert.deepEqual(positions(getSimulationFrame(fractional)).slice(0, 2), positions(fractionalBefore).slice(0, 2));

// An unrelated edit preserves both simultaneous actions and their route progress.
const unaffected = run.actions.map(a => structuredClone(a)), references = [...run.actions];
const keys = structuredClone(run.movementBuffers.solver.congestion.agents);
const previousDisplay = getSimulationFrame(run), previousCopy = structuredClone(previousDisplay);
editPausedSimulationMarker(run, 'player', '3', { x: 18, y: 38 });
assert.deepEqual(run.actions, unaffected); assert.deepEqual(run.actions, references);
assert.strictEqual(run.actions[0], references[0], 'bound action identity survives a transaction');
for (const [key, agent] of keys) if (key !== 'player:3') assert.deepEqual(run.movementBuffers.solver.congestion.agents.get(key), agent);
assert.deepEqual(previousDisplay, previousCopy, 'prior display snapshots remain immutable');

// Rebase/undo/redo/resume runs the same dependency preparation each time.
const clock = run.elapsedMs, changed = structuredClone(run.source);
assert.equal(rebasePausedSimulation(run, authored), true);
assert.equal(run.players[1].ratings, undefined); assert.equal(run.defenders[0].badges, undefined);
assert.equal(rebasePausedSimulation(run, changed), true);
assert.equal(run.players[1].ratings.threePoint, 5);
const editedPosition = { x: 37, y: 66 };
editPausedSimulationMarker(run, 'player', 1, editedPosition);
assert.equal(run.elapsedMs, clock); assert.deepEqual(run.ball, editedPosition);
assert.equal(run.actions[0].execution.paths.size, 0);
assert.deepEqual(run.actions[1].execution, unaffected[1].execution, 'the second simultaneous action retains its path');
const beforeResume = structuredClone(run.players[0]); step(run);
assert.ok(run.elapsedMs > clock); assert.ok(pointDistanceFeet(beforeResume, run.players[0]) < 0.1, 'resume accelerates from the relocated origin');

// A pending catch retains the same release and authoritative transfer record.
const passPlay = source(); passPlay.players[0] = { id: 1, x: 30, y: 70 }; passPlay.players[1] = { id: 2, x: 50, y: 70 };
passPlay.ball = { x: 30, y: 70 }; passPlay.arrows = [
  { id: 'pass', kind: 'pass', actor_id: 1, recipient_id: 2, start: { x: 30, y: 70 }, end: { x: 50, y: 70 }, timing: 1, sequence: 1 },
  { id: 'after-catch', kind: 'movement', actor_id: 2, start: { x: 50, y: 70 }, end: { x: 55, y: 55 }, timing: 1, sequence: 2 },
];
const catchRun = createSimulationRun(passPlay, settings); step(catchRun);
assert.equal(catchRun.ballState.kind, 'pass-in-flight'); const released = structuredClone(catchRun.ballState.transfer.release);
editPausedSimulationMarker(catchRun, 'player', 2, { x: 52, y: 72 });
assert.equal(catchRun.ballHandlerId, null);
assert.strictEqual(catchRun.ballState.transfer, catchRun.actions[0].transfer);
assert.deepEqual(catchRun.ballState.transfer.release, released);
assert.deepEqual(catchRun.recipientStartOverrides.get('pass').point, { x: 52, y: 72 });
until(catchRun, () => catchRun.actions[0].transfer.outcome.kind !== 'pending');
assert.equal(catchRun.actions[0].transfer.outcome.kind, 'caught');
assert.deepEqual(catchRun.actions[0].transfer.release, released);
until(catchRun, () => catchRun.actions[1].execution.startedAtMs != null);
assert.ok(catchRun.actions[1].execution.startedAtMs >= catchRun.actions[0].transfer.outcome.atMs);

// Moving an unused, set screener resets approach/coverage, never historical use.
const screenPlay = source(); screenPlay.players[0] = { id: 1, x: 50, y: 75 }; screenPlay.players[1] = { id: 2, x: 55, y: 64 };
screenPlay.ball = { x: 50, y: 75 }; screenPlay.arrows = [{ id: 'screen', kind: 'pick-roll', screener_id: 2, handler_id: 1,
  start: { x: 55, y: 64 }, end: { x: 55, y: 64 }, timing: 2, sequence: 1 }];
const screenRun = createSimulationRun(screenPlay, { ...settings, defenseStrategy: 'switch' });
until(screenRun, () => screenRun.actions[0].execution?.phase === 'set');
assert.ok(screenRun.screenCoverageLocks.has('screen'));
const screenClock = screenRun.elapsedMs, assignments = structuredClone(screenRun.assignments);
editPausedSimulationMarker(screenRun, 'player', 2, { x: 60, y: 69 });
assert.equal(screenRun.actions[0].execution.phase, 'approach'); assert.equal(screenRun.actions[0].execution.setAtMs, undefined);
assert.equal(screenRun.screenCoverageLocks.has('screen'), false); assert.equal(screenRun.actions[0].execution.paths.size, 0);
assert.deepEqual(screenRun.assignments, assignments); assert.equal(screenRun.elapsedMs, screenClock);
step(screenRun); assert.ok(screenRun.screenCoverageLocks.has('screen'), 'coverage rebuilds from corrected geometry');

// Editing after release changes neither release evidence nor current flight.
const shotRun = createSimulationRun({ ...source(), arrows: [] }, settings);
until(shotRun, () => shotRun.ballState.kind === 'shot-in-flight');
const shot = structuredClone(shotRun.ballState), shotDraft = structuredClone(shotRun.source);
shotDraft.players[0] = { ...shotDraft.players[0], x: 44, ratings: { threePoint: 1, midrange: 1, finishing: 1 }, badges: ['slasher'] };
assert.equal(rebasePausedSimulation(shotRun, shotDraft), true);
assert.deepEqual(shotRun.ballState, shot); assert.equal(shotRun.frame.shotQuality, shot.quality);
editPausedSimulationMarker(shotRun, 'ball', 'ball', { x: 45, y: 45 });
for (const key of ['start', 'shooterId', 'setupAtMs', 'releaseAtMs', 'resultAtMs', 'quality']) assert.deepEqual(shotRun.ballState[key], shot[key]);
step(shotRun); assert.equal(shotRun.shotQualityAtRelease, shot.quality);

// Every failure path retains even frame, cache and action identities; a valid
// next step still agrees with a run that never received the rejected edit.
for (const fail of [
  r => editPausedSimulationMarker(r, 'player', 1, { x: NaN, y: 50 }),
  r => editPausedSimulationMarker(r, 'player', 99, { x: 40, y: 50 }),
  r => rebasePausedSimulation(r, { ...r.source, players: r.source.players.map(p => ({ ...p, ratings: { threePoint: 99 } })) }),
  r => rebasePausedSimulation(r, { ...r.source, defenders: r.source.defenders.map(p => ({ ...p, badges: ['not-a-badge'] })) }),
  r => rebasePausedSimulation(r, { ...r.source, extra: () => {} }),
]) {
  const actual = paused(), control = paused(), before = structuredClone(actual), frame = actual.frame, actions = actual.actions;
  assert.throws(() => fail(actual)); assert.deepEqual(actual, before);
  assert.strictEqual(actual.frame, frame); assert.strictEqual(actual.actions, actions);
  step(actual); step(control); assert.deepEqual(actual, control);
}
const invalidState = paused(); invalidState.velocities.get('player:2').x = NaN;
const invalidBefore = structuredClone(invalidState);
assert.throws(() => editPausedSimulationMarker(invalidState, 'player', 1, { x: 30, y: 60 }), /invalid simulation state/);
assert.deepEqual(invalidState, invalidBefore, 'candidate validation failure commits nothing');
const locked = paused(); Object.defineProperty(locked, 'players', { writable: false });
const lockedBefore = structuredClone(locked);
assert.throws(() => editPausedSimulationMarker(locked, 'player', 1, { x: 30, y: 60 }), /cannot accept edits/);
assert.deepEqual(locked, lockedBefore);
const incompatible = paused(), incompatibleBefore = structuredClone(incompatible);
assert.equal(rebasePausedSimulation(incompatible, { ...incompatible.source, arrows: [] }), false);
assert.deepEqual(incompatible, incompatibleBefore);

// All starter plays can pause, change attributes and resume in both modes.
for (const play of STARTER_PLAYS) for (const offenseMode of ['scripted', 'adaptive']) {
  const trial = createSimulationRun(play, { ...settings, offenseMode });
  until(trial, () => trial.elapsedMs >= 450);
  const next = structuredClone(trial.source); next.players[0].ratings = { threePoint: 5, midrange: 4, finishing: 3 };
  assert.equal(rebasePausedSimulation(trial, next), true); step(trial);
  assert.ok(trial.players.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
}
console.log('Paused transactions passed: attribute-only updates, simultaneous/unrelated routes, undo/redo/resume, pending catches, screen invalidation, release evidence, snapshot isolation, atomic failures and all 24 starters in both modes.');
