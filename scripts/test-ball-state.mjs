import assert from 'node:assert/strict';
import { ballController, placedBall, transitionBall, caughtAt, copyTransfer } from '../frontend/src/features/playbook/ballState.ts';
import { createSimulationRun, prepareSimulationRun, advanceSimulationState, getSimulationFrame, observeCounterLabRun, editPausedSimulationMarker, pointDistanceFeet, rebasePausedSimulation } from '../frontend/src/features/playbook/simulation.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { replayFrame } from '../frontend/src/features/playbook/counterLabReplay.ts';
import { diagnoseOpenings, runCounterLabTrial } from '../frontend/src/features/playbook/counterLabEngine.ts';
import { packReplay } from '../frontend/src/features/playbook/counterLabReplayArchive.ts';
import { decodeReplayForPlayback } from '../frontend/src/features/playbook/counterLabReplayValidation.ts';

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'off', offenseMode: 'scripted' };
const point = { x: 30, y: 70 }, next = { x: 50, y: 70 };
const record = (kind = 'pass') => ({ actionKey: 'pass:1', kind, giverId: 1, receiverId: 2, release: null, arrival: null, outcome: { kind: 'pending' } });
const play = (kind = 'pass') => ({ version: 1, id: 'ball-state-test', name: 'Possession', defenders_visible: false,
  players: [{ id: 1, ...point }, { id: 2, ...next }, { id: 3, x: 85, y: 60 }], defenders: [], ball: { ...point }, arrows: [
    { id: 'pass', kind, actor_id: 1, recipient_id: 2, sequence: 1, timing: 1, start: { ...point }, end: { ...next } },
    { id: 'drive', kind: 'movement', actor_id: 2, sequence: 2, timing: 1, start: { ...next }, end: { x: 52, y: 60 } },
  ] });
const step = (run) => advanceSimulationState(run, 1000 / 60);
function until(run, condition, limit = 3000) {
  for (let n = 0; n < limit && !condition(); n++) { assert.ok(run.elapsedMs < run.durationMs); step(run); }
  assert.ok(condition(), JSON.stringify(run.ballState));
}
function consistent(run) {
  assert.equal(run.ballHandlerId, ballController(run.ballState));
  assert.deepEqual(run.frame.ball, run.ballState.position);
  assert.equal(run.frame.ballHandlerId, run.ballHandlerId);
  assert.equal(run.frame.ballPhase, run.ballState.kind);
  assert.equal(observeCounterLabRun(run).ballHandlerId, run.ballHandlerId);
  assert.deepEqual(getSimulationFrame(run).ballPhase, run.ballState.kind);
  if (run.ball) assert.ok(Number.isFinite(run.ball.x) && Number.isFinite(run.ball.y));
}

// Legal transitions, exactly-once outcomes, invalid events and historical evidence.
const held = placedBall(point, 1), transfer = record();
const flight = transitionBall(held, { kind: 'transfer', record: transfer, atMs: 10 });
assert.equal(ballController(flight), null);
assert.deepEqual(transfer.release, { atMs: 10, position: point });
for (const event of [
  { kind: 'transfer', record: record(), atMs: 20 },
  { kind: 'shot', shooterId: 1, atMs: 20, durationMs: 1500, quality: 70 },
  { kind: 'recover', playerId: 1, position: point },
  { kind: 'catch', receiverId: 3, atMs: 20, position: next },
  { kind: 'catch', receiverId: 2, atMs: 9, position: next },
  { kind: 'fail', atMs: NaN, reason: 'invalid' },
]) {
  const before = structuredClone(flight);
  assert.throws(() => transitionBall(flight, event), /Illegal ball transition/);
  assert.deepEqual(flight, before, 'Rejected transitions change no evidence or state');
}
const caught = transitionBall(flight, { kind: 'catch', receiverId: 2, atMs: 100, position: next });
assert.equal(ballController(caught), 2);
assert.equal(caughtAt(transfer), 100);
assert.throws(() => transitionBall(caught, { kind: 'catch', receiverId: 2, atMs: 101, position: next }));
const evidence = copyTransfer(transfer); evidence.release.position.x = 0;
assert.equal(transfer.release.position.x, point.x);
const handoff = transitionBall(held, { kind: 'transfer', record: record('handoff'), atMs: 10 });
assert.equal(ballController(handoff), 1);
assert.equal(handoff.transfer.release, null);
const interrupted = transitionBall(handoff, { kind: 'interrupt', atMs: 20, reason: 'cancelled', giverPosition: point });
assert.equal(ballController(interrupted), 1);
assert.equal(handoff.transfer.outcome.kind, 'interrupted');
const failed = transitionBall(transitionBall(held, { kind: 'transfer', record: record(), atMs: 10 }), { kind: 'fail', atMs: 20, reason: 'catch timed out' });
assert.equal(failed.kind, 'loose'); assert.equal(ballController(failed), null);
const recovered = transitionBall(failed, { kind: 'recover', playerId: 3, position: point });
assert.equal(ballController(recovered), 3);
let shot = transitionBall(caught, { kind: 'shot', shooterId: 2, atMs: 100, durationMs: 1500, quality: 70 });
assert.equal(ballController(shot), 2);
assert.throws(() => transitionBall(shot, { kind: 'release-shot', atMs: 369 }));
shot = transitionBall(shot, { kind: 'release-shot', atMs: 370 });
assert.equal(ballController(shot), null);
assert.throws(() => transitionBall(shot, { kind: 'finish-shot', atMs: 1359 }));
shot = transitionBall(shot, { kind: 'finish-shot', atMs: 1360 });
assert.equal(shot.kind, 'shot-result'); assert.equal(ballController(shot), null);

// Real catch and the dependent drive share exactly the same step boundary.
const source = play(), sourceCopy = structuredClone(source), run = createSimulationRun(source, settings);
step(run); consistent(run);
assert.equal(run.ballState.kind, 'pass-in-flight');
assert.equal(run.actions[1].execution?.startedAtMs ?? null, null);
assert.strictEqual(run.ballState.transfer, run.actions[0].transfer);
const release = structuredClone(run.actions[0].transfer.release);
until(run, () => caughtAt(run.actions[0].transfer) != null);
consistent(run);
assert.equal(run.ballHandlerId, 2);
assert.equal(run.actions[1].execution.startedAtMs, caughtAt(run.actions[0].transfer));
assert.ok(run.actions[0].transfer.arrival.atMs <= caughtAt(run.actions[0].transfer));
assert.deepEqual(run.actions[0].transfer.release, release);
assert.deepEqual(source, sourceCopy, 'Ball execution does not alter saved version-1 plays');
const snapshot = getSimulationFrame(run);
snapshot.execution[0].transfer.release.position.x = 0;
assert.deepEqual(run.actions[0].transfer.release, release, 'Frames never alias live transfer evidence');
assert.throws(() => { run.ballHandlerId = 3; }, TypeError, 'Compatibility accessors cannot create a second possession authority');
until(run, () => run.ballState.kind === 'shot-in-flight'); consistent(run);
assert.equal(run.ballHandlerId, null);
until(run, () => run.ballState.kind === 'shot-result'); consistent(run);
assert.equal(run.frame.shotPhase, 'result');

// A receiver's authored receiving route can move while a pass is airborne.
const moving = play(); moving.arrows[1].sequence = 1;
const movingRun = createSimulationRun(moving, settings);
until(movingRun, () => caughtAt(movingRun.actions[0].transfer) != null);
assert.ok(pointDistanceFeet(movingRun.ball, movingRun.players[1]) < 1e-6);
assert.equal(movingRun.actions[0].transfer.outcome.kind, 'caught');

// Removing a receiver after release produces a failed transfer and a loose ball.
const missing = createSimulationRun(play(), settings); step(missing);
missing.players = missing.players.filter(p => p.id !== 2);
step(missing); consistent(missing);
assert.equal(missing.ballState.kind, 'loose');
assert.equal(missing.actions[0].transfer.outcome.kind, 'failed');
assert.equal(missing.actions[1].execution.phase, 'obstructed');
assert.equal(missing.actions[1].execution.startedAtMs, null);
editPausedSimulationMarker(missing, 'player', 1, { x: 5, y: 90 });
editPausedSimulationMarker(missing, 'player', 3, { ...missing.ball });
until(missing, () => missing.ballHandlerId != null);
assert.equal(missing.ballHandlerId, 3);
assert.equal(missing.actions[0].transfer.outcome.kind, 'failed', 'Recovery cannot rewrite a failed pass as a catch');

// Interrupted handoff retains the giver; losing the giver cannot invent a catch.
const interruptedRun = createSimulationRun(play('handoff'), settings); step(interruptedRun);
interruptedRun.actions[0].execution.phase = 'interrupted';
step(interruptedRun); consistent(interruptedRun);
assert.equal(interruptedRun.ballState.kind, 'held'); assert.equal(interruptedRun.ballHandlerId, 1);
assert.equal(interruptedRun.actions[0].transfer.outcome.kind, 'interrupted');
const missingGiver = createSimulationRun(play('handoff'), settings); step(missingGiver);
missingGiver.players = missingGiver.players.filter(p => p.id !== 1); step(missingGiver);
assert.equal(missingGiver.ballState.kind, 'loose'); assert.equal(missingGiver.ballHandlerId, null);
assert.equal(caughtAt(missingGiver.actions[0].transfer), undefined);

// Repeatedly moved receiving targets exercise the bounded, genuinely missed catch.
const timeout = createSimulationRun(play(), settings);
until(timeout, () => timeout.elapsedMs >= 500);
let retries = 0;
while (timeout.actions[0].transfer.outcome.kind === 'pending') {
  assert.ok(++retries < 500, 'Transfer timeout remains bounded');
  editPausedSimulationMarker(timeout, 'ball', 'ball', { x: 5, y: 5 });
  step(timeout); consistent(timeout);
}
assert.equal(timeout.actions[0].transfer.outcome.kind, 'failed');
assert.match(timeout.actions[0].transfer.outcome.reason, /complete the catch/);
assert.equal(timeout.ballState.kind, 'loose'); assert.equal(timeout.ballHandlerId, null);
assert.equal(timeout.actions[1].execution.startedAtMs, null);

// A paused in-flight relocation never grants possession to a nearby marker.
const paused = createSimulationRun(play(), settings); step(paused);
const pausedRelease = structuredClone(paused.actions[0].transfer.release);
editPausedSimulationMarker(paused, 'ball', 'ball', paused.players[2]);
assert.equal(paused.ballState.kind, 'pass-in-flight'); assert.equal(paused.ballHandlerId, null);
assert.deepEqual(paused.actions[0].transfer.release, pausedRelease);
const rebased = structuredClone(paused.source); rebased.ball = { ...point };
assert.equal(rebasePausedSimulation(paused, rebased), true);
assert.equal(paused.ballHandlerId, null);
const factory = prepareSimulationRun(play()), a = factory(settings), b = factory(settings);
step(a); assert.equal(b.ballState.kind, 'held');
step(b); assert.notStrictEqual(a.actions[0].transfer, b.actions[0].transfer);

// Neutral transit is not a failed opening, and interpolation cannot blend flight/loose states.
const baseFrame = { elapsedMs: 0, sequence: null, action: null, ballHandlerId: 1, ballPhase: 'held', assignments: [],
  opportunities: [{ kind: 'shot', playerId: 1, quality: 70, score: 1, receiverGap: 5, laneGap: 5 }], blockedPass: null,
  involvedPlayerIds: [], activeRoutes: [], players: [{ id: 1, ...point }], defenders: [], ball: point, shotPhase: 'idle' };
const airborne = { ...baseFrame, elapsedMs: 100, ballHandlerId: null, ballPhase: 'pass-in-flight', opportunities: [] };
assert.equal(diagnoseOpenings([baseFrame, airborne, { ...airborne, elapsedMs: 1000 }]).firstLostOpeningMs, null);
const loose = { ...airborne, elapsedMs: 200, ballPhase: 'loose', ball: next };
assert.deepEqual(replayFrame([airborne, loose], 150).ball, point);
assert.deepEqual(decodeReplayForPlayback(packReplay([baseFrame, airborne, loose])), [baseFrame, airborne, loose]);
assert.throws(() => decodeReplayForPlayback(packReplay([{ ...airborne, ballHandlerId: 1 }])));
const trial = runCounterLabTrial(play(), { id: 'off', label: 'Off', strategy: 'off', scheme: 'man-to-man' }, 'scripted');
assert.deepEqual(decodeReplayForPlayback(packReplay(trial.trace)), trial.trace, 'Real transfer evidence survives worker archive decoding');
const caughtFrame = trial.trace.find(frame => frame.execution?.some(action => action.transfer?.outcome.kind === 'caught'));
assert.ok(caughtFrame);
for (const corrupt of [
  transfer => { transfer.release.position.x = NaN; },
  transfer => { transfer.arrival = null; },
  transfer => { transfer.outcome.atMs = -1; },
  transfer => { transfer.release.atMs = transfer.outcome.atMs + 1; },
  transfer => { transfer.receiverId = 99; },
]) {
  const bad = structuredClone(caughtFrame);
  corrupt(bad.execution.find(action => action.transfer?.outcome.kind === 'caught').transfer);
  assert.throws(() => decodeReplayForPlayback(packReplay([bad])), /damaged or incompatible/);
}
console.log('Ball-state regressions passed: legal transitions, controller invariants, real catches and simultaneous starts, moving receivers, handoff interruption, timeout, loose recovery, shot release, paused edits, isolated evidence and replay transitions.');
