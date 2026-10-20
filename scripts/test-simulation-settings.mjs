import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSimulationRun, prepareSimulationRun, setSimulationRunSettings, advanceSimulationState, getSimulationFrame, observeCounterLabRun } from '../frontend/src/features/playbook/simulation.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';

// Auto scheme selection deliberately samples randomness; hold that input fixed
// when comparing defaults/prepared runs and the pre-change deterministic traces.
const originalRandom = Math.random;
Math.random = () => 0.375;
const source = STARTER_PLAYS[0];
const originalSource = structuredClone(source);
const settings = () => structuredClone(DEFAULT_SIMULATION_SETTINGS);
const prepare = prepareSimulationRun(source);
const run = createSimulationRun(source, settings());
advanceSimulationState(run, 50);
const before = structuredClone(run);
const originalFrame = run.frame, originalSettings = run.settings;
const invalid = [undefined, null, false, 0, 'help', [], () => {}, {},
  ...['offenseOffBall', 'defenseStrategy', 'offBallIntensity', 'automaticActions'].map(key => { const input = settings(); delete input[key]; return input; }),
];
for (const key of ['offenseOffBall', 'defenseStrategy', 'defenseScheme', 'offenseMode']) {
  for (const value of ['', 'unknown', 'toString', 'constructor', false, 1, null, [], {}]) invalid.push({ ...settings(), [key]: value });
}
for (const value of [undefined, null, NaN, Infinity, -Infinity, '70', true, {}, new Number(70)]) invalid.push({ ...settings(), offBallIntensity: value });
for (const value of [undefined, null, false, 1, 'true', [], () => {}]) invalid.push({ ...settings(), automaticActions: value });
for (const flag of Object.keys(DEFAULT_SIMULATION_SETTINGS.automaticActions)) {
  for (const value of [undefined, null, 0, 1, 'false', [], {}]) {
    invalid.push({ ...settings(), automaticActions: { ...settings().automaticActions, [flag]: value } });
    invalid.push({ ...settings(), offenseMode: 'scripted', automaticActions: { ...settings().automaticActions, [flag]: value } });
  }
}
invalid.push({ ...settings(), offenseMode: 'scripted', offenseOffBall: 'invalid' });
for (const input of invalid) {
  assert.throws(() => createSimulationRun(source, input), TypeError);
  assert.throws(() => prepare(input), TypeError);
  assert.throws(() => setSimulationRunSettings(run, input), TypeError);
  if (input !== undefined) assert.throws(() => advanceSimulationState(run, 50, input), TypeError);
  assert.deepEqual(run, before, 'Rejected settings must not change attributes, assignments, routes, clocks or frames');
  assert.strictEqual(run.frame, originalFrame);
  assert.strictEqual(run.settings, originalSettings);
}
assert.deepEqual(source, originalSource);

// Defaults remain supported; repeated values retain the fast no-allocation path.
const optional = settings(); delete optional.defenseScheme; delete optional.offenseMode;
const defaulted = createSimulationRun(source, optional);
assert.equal(defaulted.settings.defenseScheme, 'auto');
assert.equal(defaulted.settings.offenseMode, 'adaptive');
assert.deepEqual(defaulted, createSimulationRun(source, settings()));
const frame = defaulted.frame, normalized = defaulted.settings;
setSimulationRunSettings(defaulted, { ...optional, offenseMode: 'adaptive', defenseScheme: 'zone-3-2' });
assert.strictEqual(defaulted.frame, frame);
assert.strictEqual(defaulted.settings, normalized, 'A valid scheme stays fixed for the life of the run');
assert.throws(() => setSimulationRunSettings(defaulted, { ...optional, defenseScheme: 'zone-99' }), /defenseScheme/, 'Even ignored scheme updates must be valid');

const mutable = settings();
const live = createSimulationRun(source, mutable);
mutable.automaticActions.screen = 'false';
assert.throws(() => setSimulationRunSettings(live, mutable), /automaticActions.screen/);
mutable.automaticActions.screen = false;
mutable.defenseStrategy = 'switch';
setSimulationRunSettings(live, mutable);
assert.equal(live.settings.defenseStrategy, 'switch');
assert.equal(live.settings.automaticActions.screen, false);
mutable.automaticActions.screen = true;
assert.equal(live.settings.automaticActions.screen, false, 'Run settings remain isolated from caller mutations');
const scripted = createSimulationRun(source, { ...settings(), offenseMode: 'scripted' });
assert.equal(scripted.settings.offenseOffBall, 'off');
assert.deepEqual(scripted.settings.automaticActions, { screen: false, handoff: false, pickRoll: false, offBallScreen: false });

// Ball-state snapshots include every display/diagnostic sample.
// Historical pre-validation hashes remain in the fixture for before/after audits.
const baselineFile = JSON.parse(readFileSync(new URL('../tests/fixtures/simulation-settings-baseline.json', import.meta.url)));
assert.equal(Math.random(), baselineFile.randomSample);
const baseline = baselineFile.cases;
for (const fixture of baseline) {
  const play = STARTER_PLAYS[fixture.playIndex];
  const input = structuredClone(fixture.settings);
  const current = createSimulationRun(play, input);
  assert.deepEqual(prepareSimulationRun(play)(input), current);
  const hash = createHash('sha256');
  hash.update(JSON.stringify(getSimulationFrame(current)));
  let steps = 0;
  while (current.elapsedMs < current.durationMs) {
    advanceSimulationState(current, 50);
    hash.update(JSON.stringify([current.elapsedMs, current.durationMs, getSimulationFrame(current), observeCounterLabRun(current)]));
    assert.ok(++steps <= fixture.ballStateSteps);
  }
  assert.equal(hash.digest('hex'), fixture.ballStateSha256, `Exact ball-state-engine replay/diagnostic equality: ${JSON.stringify(input)}`);
  assert.equal(steps, fixture.ballStateSteps);
  assert.deepEqual(input, fixture.settings);
}
Math.random = originalRandom;
console.log(`Simulation settings passed: ${invalid.length} malformed inputs across direct/prepared/update/advance boundaries; unchanged state on failure, defaults, mutable caller inputs, scripted overrides and ${baseline.length} exact ball-state-engine deterministic trials across all ${STARTER_PLAYS.length} starters`);
