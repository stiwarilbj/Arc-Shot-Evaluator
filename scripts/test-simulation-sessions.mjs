import assert from 'node:assert/strict';
import { createSimulationRun, advanceSimulationState, setSimulationRunSettings, rebasePausedSimulation, editPausedSimulationMarker, getSimulationFrame } from '../frontend/src/features/playbook/simulation.ts';
import { captureSimulationSession, restoreSimulationSession, seekSimulationSession, getSimulationSessionInfo, MAX_SIMULATION_CHECKPOINTS, MAX_SIMULATION_CHECKPOINT_BYTES } from '../frontend/src/features/playbook/simulationSession.ts';
import { SIMULATION_ENGINE_VERSION } from '../frontend/src/features/playbook/simulationVersion.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';

import { courtSvgToPoint, NBA_COURT_GEOMETRY } from '../frontend/src/features/playbook/courtGeometry.ts';
const HOOP_POINT = courtSvgToPoint(NBA_COURT_GEOMETRY.basket.center);

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'off', offenseMode: 'scripted' };
const create = (source, overrides = {}, seed = 713) => createSimulationRun(source, { ...settings, ...overrides }, HOOP_POINT, { recordSession: true, seed });
const clock = run => run.elapsedMs + run.accumulatorMs;
const state = run => structuredClone(run);
const save = run => ({ at: clock(run), state: state(run), frame: getSimulationFrame(run) });
const source = { version: 1, id: 'session-test', name: 'Recorded catch', defenders_visible: true,
  players: [{ id: 1, x: 30, y: 70 }, { id: 2, x: 50, y: 70 }, { id: 3, x: 85, y: 60 }],
  defenders: [{ id: 1, x: 10, y: 10 }, { id: 2, x: 90, y: 10 }], ball: { x: 30, y: 70 }, arrows: [
    { id: 'pass', kind: 'pass', actor_id: 1, recipient_id: 2, sequence: 1, timing: 1, start: { x: 30, y: 70 }, end: { x: 50, y: 70 } },
    { id: 'drive', kind: 'movement', actor_id: 2, sequence: 2, timing: 1, start: { x: 50, y: 70 }, end: { x: 52, y: 60 } },
  ] };

function assertRestored(run, snapshot, label = '') {
  const frame = seekSimulationSession(run, snapshot.at);
  assert.deepEqual(state(run), snapshot.state, `${label}: exact executable state, including accumulator, aliases, planner, responsibilities and paths`);
  assert.deepEqual(frame, snapshot.frame, `${label}: identical display interpolation`);
  for (const action of run.actions) assert.strictEqual(run.actionGraph.get(`${action.arrow.id}:${action.sequence}`), action);
  if (['pass-in-flight', 'handoff-pending'].includes(run.ballState.kind)) assert.strictEqual(run.ballState.transfer, run.actionGraph.get(run.ballState.transfer.actionKey).transfer);
}

// Automatic defense is resolved once from a recorded seed, never from today's
// Math.random or current controls. Unrecorded Counter Lab runs keep no history.
const originalRandom = Math.random;
Math.random = () => .05;
const automatic = create(STARTER_PLAYS[0], { defenseScheme: 'auto' });
const initial = state(automatic), initialRecord = captureSimulationSession(automatic);
assert.equal(initialRecord.engineVersion, SIMULATION_ENGINE_VERSION);
assert.deepEqual(initialRecord.initialDrawing, STARTER_PLAYS[0]);
assert.deepEqual(createSimulationRun(STARTER_PLAYS[0], initialRecord.initialSettings, HOOP_POINT, { seed: initialRecord.seed }), automatic);
Math.random = () => .99;
assert.deepEqual(state(restoreSimulationSession(initialRecord)), initial);
Math.random = originalRandom;
assert.equal(getSimulationSessionInfo(createSimulationRun(source, settings)), null);
assert.equal(getSimulationSessionInfo(automatic).resolvedDefenseScheme, initial.activeDefenseScheme);
assert.throws(() => createSimulationRun(source, settings, HOOP_POINT, { seed: NaN }), /seed/);
assert.throws(() => createSimulationRun(source, settings, HOOP_POINT, { seed: -1 }), /seed/);

// Record fractional call boundaries, several same-time edits, a settings change,
// a pending catch, and the eventual released shot. Saved records are isolated.
const run = create(source), snapshots = [save(run)];
let sawCatch = false, sawShot = false;
for (let n = 0; n < 500 && run.elapsedMs < run.durationMs; n++) {
  advanceSimulationState(run, [8.125, 16.4, 37, 50][n % 4]);
  if (n === 0) {
    assert.equal(run.ballState.kind, 'held'); // not enough accumulated time yet
  }
  if (n === 2) {
    assert.equal(run.ballState.kind, 'pass-in-flight');
    editPausedSimulationMarker(run, 'player', 2, { x: 52, y: 72 });
    const draft = structuredClone(run.source);
    draft.players[2].ratings = { threePoint: 5, midrange: 2, finishing: 1 };
    draft.players[2].badges = ['deep-range'];
    assert.equal(rebasePausedSimulation(run, draft), true);
    setSimulationRunSettings(run, { ...run.settings, defenseStrategy: 'contain' });
  }
  sawCatch ||= run.actions[0].transfer?.outcome.kind === 'caught';
  sawShot ||= run.ballState.kind === 'shot-in-flight';
  snapshots.push(save(run));
}
assert.ok(sawCatch && sawShot, 'the real catch and shot transitions are exercised');
const history = captureSimulationSession(run), end = snapshots.at(-1);
const events = history.events.filter(event => event.kind !== 'advance');
assert.deepEqual(events.map(event => event.kind), ['edit', 'edit', 'settings']);
assert.equal(new Set(events.map(event => event.atMs)).size, 1, 'simultaneous events retain their recorded order');
assert.ok(events[0].accumulatorMs > 0, 'edits retain the actual fractional simulation clock');
assert.equal(history.initialDrawing.players[1].x, 50, 'initial drawing predates edits');
for (const index of [snapshots.length - 1, 2, 3, 4, 12, 28, 44, 1, 70, snapshots.length - 1]) if (snapshots[index]) assertRestored(run, snapshots[index], `catch/shot sample ${index}`);
const recovered = restoreSimulationSession(JSON.parse(JSON.stringify(history)));
assert.deepEqual(state(recovered), end.state, 'JSON record recovery matches exact uninterrupted execution');
for (const snapshot of snapshots.filter((_, index) => index % 7 === 0)) assertRestored(recovered, snapshot, 'recovered catch timeline');
history.initialDrawing.players[0].x = 99;
history.events[0].deltaMs = 1;
assert.equal(captureSimulationSession(run).initialDrawing.players[0].x, 30, 'external records cannot mutate session evidence');

// Forward playback after rewind applies the historical settings and edits only
// when reached, even with a new display cadence. It rejoins original call
// boundaries exactly rather than accumulating fractional rounding differences.
for (const hz of [30, 60, 120]) {
  assertRestored(run, snapshots[1]);
  assert.equal(run.settings.defenseStrategy, 'off');
  for (let n = 0; n < 1000 && clock(run) < end.at - 1e-7; n++) advanceSimulationState(run, Math.min(1000 / hz, end.at - clock(run)));
  assert.deepEqual(state(run), end.state, `${hz} Hz replay rejoins the exact completed run`);
}
assert.equal(getSimulationSessionInfo(run).eventCount, 3, 'playback does not duplicate historical events');

// Independent partial seeks equal a direct prefix of the recorded calls.
const beforeCatch = snapshots.findLast(snapshot => snapshot.state.actions[0].transfer?.outcome.kind === 'pending');
const catchAt = end.state.actions[0].transfer.outcome.atMs;
for (const time of [17.125, 143.77, beforeCatch.at - .001, beforeCatch.at + .001, catchAt - .001, catchAt, catchAt + .001]) {
  const direct = createSimulationRun(source, settings);
  for (const event of captureSimulationSession(run).events) {
    if (event.atMs > time + 1e-7) break;
    if (event.kind === 'advance') {
      advanceSimulationState(direct, event.endMs > time ? time - event.atMs : event.deltaMs);
      if (event.endMs > time) break;
    } else if (event.kind === 'settings') setSimulationRunSettings(direct, event.settings);
    else if (event.relocation) editPausedSimulationMarker(direct, event.relocation.type, event.relocation.id, event.relocation.point, event.drawing);
    else rebasePausedSimulation(direct, event.drawing);
  }
  seekSimulationSession(run, time);
  assert.deepEqual(state(run), state(direct), `partial seek at ${time}`);
}

// A genuine edit branches the future; a failed edit or equivalent settings do
// not. New playback and JSON recovery must agree after an interior-call branch.
seekSimulationSession(run, 143.77);
const beforeBranch = captureSimulationSession(run), branchState = state(run);
assert.throws(() => editPausedSimulationMarker(run, 'player', 999, { x: 30, y: 30 }));
assert.deepEqual(captureSimulationSession(run), beforeBranch);
assert.deepEqual(state(run), branchState);
setSimulationRunSettings(run, structuredClone(run.settings));
assert.deepEqual(captureSimulationSession(run), beforeBranch);
setSimulationRunSettings(run, { ...run.settings, defenseStrategy: 'switch' });
assert.ok(getSimulationSessionInfo(run).recordedUntilMs < end.at);
const branchSource = structuredClone(run.source); branchSource.players[0].badges = ['deep-range'];
rebasePausedSimulation(run, branchSource);
for (let n = 0; n < 30; n++) advanceSimulationState(run, 16.1);
const branched = state(run), branchRecord = captureSimulationSession(run);
assert.deepEqual(state(restoreSimulationSession(JSON.parse(JSON.stringify(branchRecord)))), branched);
seekSimulationSession(run, 0); seekSimulationSession(run, branchRecord.positionMs);
assert.deepEqual(state(run), branched);
assert.ok(!captureSimulationSession(run).events.some(event => event.kind === 'settings' && event.settings.defenseStrategy === 'contain' && event.atMs > 143.77));

// Invalid recovery never changes the live state or history. Engine versions,
// event times, resolved defense, payloads, and seed must all agree.
const validRecord = captureSimulationSession(run), validState = state(run);
for (const time of [NaN, Infinity, -1, getSimulationSessionInfo(run).recordedUntilMs + 1]) {
  assert.throws(() => seekSimulationSession(run, time));
  assert.deepEqual(state(run), validState); assert.deepEqual(captureSimulationSession(run), validRecord);
}
for (const mutate of [r => r.engineVersion++, r => r.seed = -1, r => r.positionMs = NaN,
  r => r.resolvedDefenseScheme = 'impossible', r => r.events[0].atMs = 20,
  r => r.events[0].deltaMs = Infinity, r => r.events[0].endMs += 2,
  r => r.events[0].kind = 'unknown', r => r.initialDrawing.players[0].x = NaN]) {
  const bad = structuredClone(validRecord); mutate(bad); assert.throws(() => restoreSimulationSession(bad));
}
for (const time of [NaN, Infinity, -Infinity]) assert.throws(() => advanceSimulationState(run, time));
assert.deepEqual(state(run), validState); assert.deepEqual(captureSimulationSession(run), validRecord);
assert.throws(() => advanceSimulationState(run, 16, run.settings, { x: 1, y: 2 }), /hoop/);
assert.deepEqual(state(run), validState);
// Recovery can replace corrupt live positions from a healthy checkpoint.
run.players[0].x = NaN;
seekSimulationSession(run, validRecord.positionMs);
assert.deepEqual(state(run), validState);

// Actual switches, delayed screen phases and responsibility transitions are
// sampled on either side of every change in all 24 starters and both modes.
let compared = 0, switchCases = 0, delayCases = 0;
for (const play of STARTER_PLAYS) for (const offenseMode of ['scripted', 'adaptive']) {
  const trial = create(play, { offenseMode, defenseStrategy: 'switch' });
  const samples = [save(trial)];
  let signature = '', previous = samples[0];
  for (let n = 0; n < 2500 && trial.elapsedMs < trial.durationMs; n++) {
    advanceSimulationState(trial, [16.25, 33.3, 50][n % 3]);
    const current = save(trial);
    const next = JSON.stringify([trial.ballState.kind, [...trial.switchedActions], trial.actions.map(action => [action.execution?.phase, action.startTime, action.durationMs]), [...trial.defense.duties.values()].map(duty => [duty.defenderId, duty.role])]);
    if (next !== signature && samples.length < 42) { samples.push(previous, current); signature = next; }
    previous = current;
  }
  assert.equal(trial.elapsedMs, trial.durationMs, `${play.name}: completed`);
  switchCases += trial.switchedActions.size > 0;
  delayCases += trial.actions.some(action => (action.execution?.waitMs ?? 0) > 0);
  const final = save(trial); samples.push(final);
  for (const snapshot of samples.reverse()) { assertRestored(trial, snapshot, `${play.name}/${offenseMode}`); compared++; }
  assert.deepEqual(state(restoreSimulationSession(JSON.parse(JSON.stringify(captureSimulationSession(trial))))), state(trial));
}
assert.ok(switchCases > 0 && delayCases > 0, 'fixtures genuinely exercise screen switches and delayed action execution');

// A long authored run evicts old checkpoints while retaining exact recovery
// from the original start. Replay cursor snapshots share the same budgets.
const longPlay = structuredClone(source);
longPlay.arrows = Array.from({ length: 16 }, (_, index) => ({ id: `long-${index}`, kind: 'movement', actor_id: 1, sequence: index + 1, timing: 4,
  start: { x: index % 2 ? 40 : 30, y: 70 }, end: { x: index % 2 ? 30 : 40, y: 70 } }));
const long = create(longPlay); const longStart = save(long);
for (let n = 0; n < 800 && long.elapsedMs < long.durationMs; n++) advanceSimulationState(long, 50);
const longEnd = save(long);
assert.ok(getSimulationSessionInfo(long).checkpointCount <= MAX_SIMULATION_CHECKPOINTS);
assert.ok(getSimulationSessionInfo(long).checkpointCount > 10);
for (const time of [0, 15.77, 17391.123, longEnd.at]) {
  seekSimulationSession(long, time);
  assert.ok(getSimulationSessionInfo(long).checkpointBytes <= MAX_SIMULATION_CHECKPOINT_BYTES);
  assert.ok(getSimulationSessionInfo(long).checkpointCount <= MAX_SIMULATION_CHECKPOINTS);
}
assertRestored(long, longStart); assertRestored(long, longEnd);
// Partial/empty rosters, generated defenders, explicit defender/ball edits and
// settings requests for a different scheme retain the original resolved shape.
for (const play of [source, { ...structuredClone(source), defenders: [] }, { ...structuredClone(source), players: [], defenders: [], ball: null, arrows: [] }]) {
  const small = create(play, { defenseScheme: 'auto' });
  advanceSimulationState(small, 50);
  if (small.defenders.length) editPausedSimulationMarker(small, 'defender', small.defenders[0].id, { x: 20, y: 20 });
  if (small.ball) editPausedSimulationMarker(small, 'ball', 'ball', { x: small.ball.x + 1, y: small.ball.y });
  setSimulationRunSettings(small, { ...small.settings, defenseScheme: 'zone-2-3' });
  advanceSimulationState(small, 50);
  const last = save(small), smallRecord = captureSimulationSession(small);
  assert.deepEqual(state(restoreSimulationSession(JSON.parse(JSON.stringify(smallRecord)))), last.state);
  seekSimulationSession(small, 0); assertRestored(small, last);
  assert.equal(small.activeDefenseScheme, smallRecord.resolvedDefenseScheme);
}
console.log(`Simulation sessions passed: ${compared} exact starter/mode restores, ${switchCases} switching trials, ${delayCases} delayed trials; seed/defense capture, fractional calls, catches, edits, historical settings, 30/60/120 Hz replay, branching, JSON recovery, invalid records, partial/empty rosters and bounded executable checkpoints.`);
