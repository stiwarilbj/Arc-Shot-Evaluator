import assert from 'node:assert/strict';
import { advanceSimulationState, advanceSimulationRun, createSimulationRun, getSimulationFrame } from '../frontend/src/features/playbook/simulation.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man' };
const create = () => createSimulationRun(STARTER_PLAYS[0], structuredClone(settings));
const changedSettings = { ...settings, defenseStrategy: 'switch', offBallIntensity: 13 };
const invalid = [NaN, Infinity, -Infinity, undefined, null, '16', false, {}, new Number(16)];
for (const advance of [advanceSimulationState, advanceSimulationRun]) {
  const run = create(), control = create();
  // Preserve both real movement and a nonzero fractional accumulator on rejection.
  advance(run, 40);
  advance(control, 40);
  for (const delta of invalid) {
    const displayed = getSimulationFrame(run);
    const before = structuredClone(run);
    const frame = run.frame, previousFrame = run.previousFrame, normalized = run.settings;
    assert.throws(() => advance(run, delta, changedSettings), {
      name: 'TypeError', message: 'Simulation elapsed time must be finite',
    });
    assert.deepEqual(run, before, `${advance.name}: invalid time must not mutate any run state`);
    assert.strictEqual(run.frame, frame);
    assert.strictEqual(run.previousFrame, previousFrame);
    assert.strictEqual(run.settings, normalized);
    assert.deepEqual(getSimulationFrame(run), displayed);
    // A rejected call must not poison the very next ordinary advancement.
    advance(run, 16);
    advance(control, 16);
    assert.deepEqual(run, control);
    assert.deepEqual(getSimulationFrame(run), getSimulationFrame(control));
  }
  for (const delta of [0, -0, -0.125, -Number.MAX_VALUE]) {
    const before = structuredClone(run);
    advance(run, delta, changedSettings);
    assert.deepEqual(run, before, 'Finite nonpositive deltas retain their no-op semantics');
  }
  for (const delta of [Number.MIN_VALUE, Number.EPSILON, 0.001, 1 / 120]) {
    const tiny = create();
    advance(tiny, delta);
    assert.equal(tiny.accumulatorMs, delta);
    assert.equal(tiny.elapsedMs, 0);
    assert.deepEqual(tiny.frame, create().frame);
  }
  const fractional = create(), combined = create();
  for (let i = 0; i < 320; i++) advance(fractional, 0.125);
  advance(combined, 40);
  assert.ok(fractional.elapsedMs > 0, 'Small accumulated deltas eventually execute a fixed step');
  assert.deepEqual(fractional, combined, 'Fractional deltas preserve exact binary accumulation');
  for (const delta of [50, 5000, Number.MAX_VALUE]) {
    const capped = create(), reference = create();
    advance(capped, delta);
    advance(reference, 50);
    assert.deepEqual(capped, reference, 'Positive delta cap remains 50 ms');
  }
  const finished = create();
  while (finished.elapsedMs < finished.durationMs) advance(finished, 50);
  const before = structuredClone(finished);
  for (const delta of [NaN, Infinity, -Infinity]) {
    assert.throws(() => advance(finished, delta, changedSettings), TypeError);
    assert.deepEqual(finished, before);
  }
  advance(finished, 50, changedSettings);
  assert.deepEqual(finished, before, 'Completed runs still ignore finite advancement');
}
console.log('Simulation advancement passed: both entry points reject nonfinite/non-number times without mutation, resume identically, and preserve fractional, nonpositive, capped and completed-run behavior.');
