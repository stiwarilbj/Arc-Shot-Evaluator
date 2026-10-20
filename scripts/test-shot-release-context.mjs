import assert from 'node:assert/strict';
import { createSimulationRun, advanceSimulationState, evaluateShotContext, getSimulationFrame, rebasePausedSimulation, cloneSimulationExecution, pointDistanceFeet } from '../frontend/src/features/playbook/simulation.ts';
import { seekSimulationSession } from '../frontend/src/features/playbook/simulationSession.ts';
import { validateShotRelease } from '../frontend/src/features/playbook/shotReleaseContext.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { createPlaybookSimulationHost } from '../frontend/src/features/playbook/playbookSimulationHost.ts';
import { parseSimulationResponse } from '../frontend/src/features/playbook/playbookSimulationProtocol.ts';

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseStrategy: 'off', defenseScheme: 'man-to-man', offenseMode: 'scripted' };
const shooter = { id: 1, x: 50, y: 58, badges: ['catch-and-shoot'], ratings: { threePoint: 3, midrange: 3, finishing: 3 } };
const defender = { id: 1, x: 50, y: 50, badges: [] };
const motion = (extra = {}) => ({ atMs: 1000, shooterVelocityFtPerSecond: { x: 0, y: 0 }, defenderVelocities: [], catch: null, recentActions: [], ...extra });
const evaluate = evidence => evaluateShotContext([shooter], [defender], shooter, 70, undefined, evidence);
const still = evaluate(motion());
const dy = evaluate(motion()).defenders[0].directionToShooter.y;
const approaching = evaluate(motion({ defenderVelocities: [{ id: 1, velocityFtPerSecond: { x: 0, y: dy * 15 } }] }));
const retreating = evaluate(motion({ defenderVelocities: [{ id: 1, velocityFtPerSecond: { x: 0, y: -dy * 15 } }] }));
const lateral = evaluate(motion({ defenderVelocities: [{ id: 1, velocityFtPerSecond: { x: 15, y: 0 } }] }));
assert.ok(approaching.quality < retreating.quality, 'Same positions distinguish a closeout from recovery away from the shooter');
assert.equal(still.quality, retreating.quality); assert.equal(still.quality, lateral.quality);
assert.ok(approaching.defenders[0].approachSpeedFtPerSecond > 0 && retreating.defenders[0].approachSpeedFtPerSecond < 0);
const catchEvidence = { atMs: 700, actionId: 'catch-pass', sequence: 2, giverId: 2, kind: 'pass', position: { x: 50, y: 58 }, receiverVelocityFtPerSecond: { x: 12, y: 0 }, nearestDefenderGapFeet: 1.8 };
const settled = evaluate(motion({ catch: catchEvidence }));
const cutting = evaluate(motion({ catch: catchEvidence, shooterVelocityFtPerSecond: { x: 15, y: 0 } }));
assert.ok(settled.quality > cutting.quality, 'Hard cut and settled catch have different release context at identical coordinates');
assert.equal(settled.catch.settled, true); assert.equal(cutting.catch.settled, false);
assert.equal(settled.catch.nearestDefenderGapFeet, 1.8, 'Contested-catch evidence survives even after space opens');
assert.equal(settled.modifiers.find(m => m.key === 'catch-and-shoot').points, 6);
assert.equal(cutting.modifiers.find(m => m.key === 'catch-and-shoot').points, 0);
for (const age of [149.999, 150, 150.001, 1150, 1150.001]) {
  const record = evaluate(motion({ catch: { ...catchEvidence, atMs: 1000 - age } }));
  assert.equal(record.modifiers.find(m => m.key === 'catch-and-shoot').points, age >= 150 && age <= 1150 ? 6 : 0);
}
assert.equal(evaluate(motion({ catch: { ...catchEvidence, atMs: 1001 } })).catch, null, 'Future catches cannot support a release');
const oneDefender = evaluateShotContext([shooter], [], shooter, 70);
assert.equal(oneDefender.defenders.length, 0);
const coincident = evaluateShotContext([shooter], [{ ...defender, x: shooter.x, y: shooter.y }], shooter, 70, undefined, motion());
assert.deepEqual(coincident.defenders[0].directionToShooter, { x: 0, y: 0 });
for (const context of [still, approaching, retreating, lateral, settled, cutting, oneDefender, coincident]) {
  validateShotRelease(context);
  assert.ok(Math.abs(context.modifiers.reduce((sum, m) => sum + m.points, 0) - context.quality) < 1e-10, 'Every scored contribution has recorded evidence');
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.shooter.position) && Object.isFrozen(context.defenders));
}
assert.throws(() => { settled.catch.position.x = 1; }, TypeError);
assert.throws(() => { settled.modifiers[0].points = 100; }, TypeError);
assert.throws(() => { settled.shooter.rating = 5; }, TypeError);
for (const corrupt of [v => v.quality = NaN, v => v.defenders[0].velocityFtPerSecond.x = Infinity,
  v => v.catch.elapsedMs = -1, v => v.shooter.rating = 9, v => v.modifiers[0].points = NaN,
  v => v.defenders.push(v.defenders[0]), v => delete v.modifiers]) {
  const record = structuredClone(settled); corrupt(record); assert.throws(() => validateShotRelease(record));
}

const play = (extra = {}) => ({ version: 1, id: 'release-context', name: 'Release context', defenders_visible: true,
  players: [structuredClone(shooter)], defenders: [structuredClone(defender)], ball: { x: shooter.x, y: shooter.y }, arrows: [], ...extra });
const step = run => advanceSimulationState(run, 1000 / 60);
function until(run, condition) {
  for (let n = 0; n < 2000 && !condition() && run.elapsedMs < run.durationMs; n++) step(run);
  assert.ok(condition(), `Not reached at ${run.elapsedMs}`);
}
const run = createSimulationRun(play(), settings, undefined, { recordSession: true, seed: 1 });
until(run, () => run.ballState.kind === 'shot-setup');
assert.equal(run.frame.shotRelease, null, 'Setup is provisional');
const updated = structuredClone(run.source); updated.players[0].ratings = { threePoint: 5, midrange: 5, finishing: 5 };
assert.equal(rebasePausedSimulation(run, updated), true);
until(run, () => run.ballState.kind === 'shot-in-flight');
const released = run.ballState.releaseContext, releasedCopy = structuredClone(released), quality = run.frame.shotQuality;
assert.equal(released.shooter.rating, 5, 'An attribute edit during setup is evaluated at release');
assert.ok(Math.abs(released.atMs - run.ballState.releaseAtMs) < 1e-6, 'Evaluation occurs at the exact release boundary');
assert.deepEqual(released.shooter.position, run.ballState.start);
assert.deepEqual(released.shooter.velocityFtPerSecond, run.velocities.get(`player:${released.shooter.id}`));
for (const defender of released.defenders) assert.deepEqual(defender.velocityFtPerSecond, run.velocities.get(`defender:${defender.id}`));
assert.equal(run.frame.shotRelease, released); assert.equal(run.shotQualityAtRelease, released.quality);
const changed = structuredClone(run.source); changed.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
changed.players[0].badges = []; changed.defenders[0].badges = ['lockdown']; changed.defenders[0].x = 80;
assert.equal(rebasePausedSimulation(run, changed), true);
assert.deepEqual(run.frame.shotRelease, releasedCopy); assert.equal(run.frame.shotQuality, quality);
const cloned = cloneSimulationExecution(run);
assert.ok(Object.isFrozen(cloned.ballState.releaseContext.shooter.position));
assert.notStrictEqual(cloned.ballState.releaseContext, released);
until(run, () => run.ballState.kind === 'shot-result');
assert.deepEqual(run.frame.shotRelease, releasedCopy); assert.equal(run.frame.shotQuality, quality);
const result = structuredClone(getSimulationFrame(run)), endMs = run.elapsedMs;
seekSimulationSession(run, released.atMs - 1); assert.equal(run.frame.shotRelease, null);
seekSimulationSession(run, endMs); assert.deepEqual(getSimulationFrame(run), result);
assert.ok(Object.isFrozen(run.ballState.releaseContext));

// A completed, contested catch is recorded at the actual receiver position.
const passRun = createSimulationRun(play({ players: [{ id: 2, x: 25, y: 58 }, structuredClone(shooter)],
  defenders: [{ id: 1, x: 53, y: 58 }], ball: { x: 25, y: 58 }, arrows: [
    { id: 'real-pass', kind: 'pass', actor_id: 2, recipient_id: 1, start: { x: 25, y: 58 }, end: { x: 50, y: 58 }, timing: 1, sequence: 1 },
  ] }), settings);
until(passRun, () => passRun.lastCatchEvidence.has(1));
const caught = structuredClone(passRun.lastCatchEvidence.get(1));
assert.equal(caught.actionId, 'real-pass');
assert.equal(caught.atMs, passRun.actions[0].transfer.outcome.atMs);
assert.equal(caught.nearestDefenderGapFeet, Math.min(...passRun.defenders.map(d => pointDistanceFeet(d, passRun.players.find(p => p.id === 1)))));
until(passRun, () => passRun.ballState.kind === 'shot-in-flight');
assert.equal(passRun.frame.shotRelease.catch.atMs, caught.atMs);
assert.deepEqual(passRun.frame.shotRelease.catch.position, caught.position);

const zeroPlay = play({ players: [{ id: 1, x: 50, y: 98, ratings: { threePoint: 1, midrange: 1, finishing: 1 } }],
  defenders: [{ id: 1, x: 50, y: 96 }], ball: { x: 50, y: 98 } });
const zero = createSimulationRun(zeroPlay, settings);
until(zero, () => zero.ballState.kind === 'shot-in-flight');
assert.equal(zero.frame.shotQuality, 0); assert.equal(zero.frame.shotRelease.quality, 0);
const better = structuredClone(zero.source); better.players[0].ratings = { threePoint: 5, midrange: 5, finishing: 5 }; better.defenders[0].x = 1;
rebasePausedSimulation(zero, better);
until(zero, () => zero.ballState.kind === 'shot-result');
assert.equal(getSimulationFrame(zero).shotQuality, 0, 'A legitimate zero never triggers a fallback after release');
assert.equal(zero.frame.shotResult, 'missed');

// Real protocol parsing must accept zero and reject mismatched or corrupt evidence.
const host = createPlaybookSimulationHost(); let requestId = 0;
const command = data => host({ sessionId: 'release', revision: 0, requestId: ++requestId, ...data });
let response = command({ type: 'start', drawing: zeroPlay, settings, seed: 1 });
for (let n = 0; n < 200 && response.view.frame.shotPhase !== 'result'; n++) response = command({ type: 'frame', deltaMs: 50 });
parseSimulationResponse(structuredClone(response));
assert.equal(response.view.frame.shotQuality, 0);
for (const corrupt of [f => f.shotQuality = 1, f => f.shotRelease = null, f => f.shotRelease.shooter.id = 4,
  f => f.shotRelease.defenders[0].approachSpeedFtPerSecond = NaN]) {
  const invalid = structuredClone(response); corrupt(invalid.view.frame); assert.throws(() => parseSimulationResponse(invalid));
}
console.log('Shot release contexts passed: signed closeouts, hard cuts/settled and contested catches, exact boundaries, modifier evidence, immutable release/checkpoints, pre/post-release edits, zero scores and worker validation.');
