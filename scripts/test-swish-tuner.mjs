import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import * as p from "../frontend/src/features/games/swishPhysics.ts";
import * as sessions from "../frontend/src/features/games/swishSession.ts";
import { neuralTrajectory, predictShot, validateModel } from "../frontend/src/features/games/swishPrediction.ts";

const model = JSON.parse(readFileSync(new URL("../frontend/src/features/games/swish-model.json", import.meta.url), "utf8"));
assert.ok(validateModel(model));
for (const invalid of [null, [], {}, { ...model, engine: "old" }, { ...model, validation: { samples: 12000, p99Meters: 0.03, maxMeters: 0.04 } },
  { ...model, validation: null }, { ...model, layers: [{ weights: [[NaN]], bias: [0] }] },
  { ...model, layers: [null, ...model.layers.slice(1)] },
  { ...model, layers: [{ ...model.layers[0], weights: [null, ...model.layers[0].weights.slice(1)] }, ...model.layers.slice(1)] }]) assert.equal(validateModel(invalid), false);
const badWeights = structuredClone(model); badWeights.layers[0].weights[0][0] = Infinity;
assert.equal(validateModel(badWeights), false);

const control = { angle: 60, power: 30, spin: 2 }, setup = p.ROUND_SETUPS[0];
assert.equal(p.simulateShot(control, setup).outcome, "Swish");
assert.deepEqual(p.simulateShot(control, setup), p.simulateShot(control, setup));
assert.equal(p.simulateShot({ angle: 35, power: 0, spin: 0 }, setup).outcome, "Short");
assert.notDeepEqual(p.freeTrajectory({ ...control, spin: 0 }, [0, 1]), p.freeTrajectory({ ...control, spin: 5 }, [0, 1]));
for (const value of [NaN, Infinity, -Infinity]) {
  assert.throws(() => p.simulateShot({ ...control, angle: value }, setup));
  assert.throws(() => p.simulateShot(control, { ...setup, height: value }));
}
assert.ok(p.segmentDistance({ x: -1, y: 0, t: 0 }, { x: 1, y: 0, t: 1 }, 0, 0) === 0, "Swept contact, even with endpoints outside");
assert.equal(p.segmentSeparation({ x: -1, y: 0, t: 0 }, { x: 1, y: 0, t: 1 }, { x: 0, y: -1, t: 0 }, { x: 0, y: 1, t: 0 }), 0);
assert.ok(p.segmentSeparation({ x: -0.12, y: 1.12, t: 0 }, { x: -0.11, y: 1.12, t: 1 }, { x: 0, y: 0, t: 0 }, { x: 0, y: 1, t: 0 }) > p.BALL_RADIUS, "Clearing a backboard corner is not a rectangular bounding-box collision");
assert.equal(p.sampleFlight(p.simulateShot(control, setup).points, 0).x, 0);
const outcomes = new Set();
for (let power = 0; power <= 100; power += 0.25) {
  const flight = p.simulateShot({ angle: 55, power, spin: 2 }, setup);
  outcomes.add(flight.outcome);
  assert.ok(flight.points.every(point => Number.isFinite(point.x + point.y + point.t)));
  if (flight.outcome === "Swish") {
    const last = flight.points.at(-1), previous = flight.points.at(-2);
    assert.ok(last.y < setup.height - p.BALL_RADIUS - p.RIM_TUBE);
    assert.ok(last.y < previous.y, "Only descending clearance scores");
  }
}
for (const outcome of ["Front rim", "Back rim", "Swish", "Short", "Long", "Backboard"]) assert.ok(outcomes.has(outcome), outcome);

let seed = 918273;
const random = () => { let value; [seed, value] = p.randomStep(seed); return value; };
const errors = [], t = performance.now();
for (let i = 0; i < 12000; i++) {
  const c = { angle: 35 + random() * 40, power: random() * 100, spin: random() * 5 };
  const time = random() * 4;
  const actual = p.freeTrajectory(c, [time])[0], estimated = neuralTrajectory(model, c, [time])[0];
  errors.push(Math.hypot(actual.x - estimated.x, actual.y - estimated.y));
}
errors.sort((a, b) => a - b);
assert.ok(errors[Math.floor(errors.length * 0.99)] <= 0.02, `Independent p99 ${errors[Math.floor(errors.length * 0.99)]}`);
assert.ok(errors.at(-1) <= 0.05, `Independent worst case ${errors.at(-1)}`);
for (const angle of [35, 40, 55, 70, 75]) for (const power of [0, 10, 30, 70, 100]) for (const spin of [0, 0.1, 2, 4.9, 5]) {
  const times = [0, 0.01, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
  const c = { angle, power, spin }, actual = p.freeTrajectory(c, times), estimated = neuralTrajectory(model, c, times);
  estimated.forEach((v, i) => assert.ok(Math.hypot(v.x - actual[i].x, v.y - actual[i].y) <= 0.05, `Edge error ${JSON.stringify(c)} at ${v.t}`));
}
const launch = neuralTrajectory(model, control, [0])[0];
assert.deepEqual(launch, { t: 0, x: 0, y: p.RELEASE_HEIGHT });
const fallback = predictShot(control, null);
assert.deepEqual(fallback.center, p.freeTrajectory(control, fallback.center.map(v => v.t)));
assert.equal(predictShot(control, model).error, 0.05);
assert.ok(predictShot(control, model).spread.length === 8);
for (const c of [{ angle: 35, power: 0, spin: 0 }, { angle: 75, power: 100, spin: 5 }, control]) {
  for (let i = 0; i < 200; i++) {
    const result = p.varyControls(c, seed); seed = result.seed;
    for (const k of ["angle", "power", "spin"]) assert.ok(Math.abs(result.controls[k] - c[k]) <= p.SPREAD[k] + 1e-10);
    assert.ok(p.validControls(result.controls));
  }
}
console.log(`Independent 12,000-sample model check: p99 ${(errors[Math.floor(errors.length * 0.99)] * 100).toFixed(2)} cm, max ${(errors.at(-1) * 100).toFixed(2)} cm; ${Math.round(performance.now() - t)} ms`);

for (const s of p.ROUND_SETUPS) {
  const solution = p.solutionFor(s);
  for (let i = 0; i < 200; i++) {
    const varied = p.varyControls(solution, seed); seed = varied.seed;
    assert.equal(p.simulateShot(varied.controls, s).outcome, "Swish", `Catalog must have forgiving solutions: ${JSON.stringify(s)}`);
  }
}
let s = sessions.createSwishSession(12345);
assert.ok(sessions.validateSwishSession(s));
assert.equal(sessions.nextSwishRound(s), s);
for (let round = 1; round <= 36; round++) {
  const before = s.totalScore, currentSetup = s.setupIndex;
  s = { ...s, controls: { angle: 35, power: 0, spin: 0 } };
  s = sessions.shoot(s).session;
  assert.equal(s.makes, 0);
  s = { ...s, controls: p.solutionFor(p.ROUND_SETUPS[s.setupIndex]) };
  const solution = s.controls;
  for (let n = 0; n < 3; n++) {
    const before = structuredClone(s), shot = sessions.shoot(s);
    assert.deepEqual(s, before, "Shooting never mutates input session");
    s = shot.session;
    assert.equal(s.makes, n + 1);
    assert.equal(s.attempts, n + 2);
    assert.ok(sessions.validateSwishSession(s));
  }
  assert.equal(s.totalScore, before + 75);
  assert.equal(s.completed, round);
  assert.equal(sessions.shoot(s).session, s, "Completed round locks scoring");
  s = sessions.nextSwishRound(s);
  assert.equal(s.round, round + 1);
  assert.equal(s.makes, 0);
  assert.equal(s.attempts, 0);
  assert.notEqual(s.setupIndex, currentSetup);
  assert.deepEqual(s.controls, solution);
}
assert.equal(sessions.roundScore(3), 100);
assert.equal(sessions.roundScore(7), 43);
const fake = { value: null, getItem() { return this.value; }, setItem(_k, value) { this.value = value; } };
assert.equal(sessions.saveSwishSession(s, () => fake), true);
assert.deepEqual(sessions.loadSwishSession(() => fake).session, s);
fake.value = '{"version":999}';
assert.equal(sessions.loadSwishSession(() => fake).session.round, 1);
fake.value = JSON.stringify({ ...s, controls: { ...s.controls, angle: null } });
assert.equal(sessions.loadSwishSession(() => fake).session.round, 1);
fake.value = "{";
assert.equal(sessions.loadSwishSession(() => fake).session.round, 1);
const blocked = () => { throw new Error("Storage blocked"); };
assert.equal(sessions.loadSwishSession(blocked).storageAvailable, false);
assert.equal(sessions.saveSwishSession(s, blocked), false);
const pending = sessions.shoot({ ...sessions.createSwishSession(123), controls: control }).session;
fake.value = JSON.stringify(pending);
const restored = sessions.loadSwishSession(() => fake).session;
assert.equal(restored.attempts, 1);
assert.equal(restored.makes, pending.makes, "Reload settles the result exactly once");
const missControls = { angle: 35, power: 0, spin: 0 };
const missOutcome = p.simulateShot(missControls, setup).outcome;
assert.notEqual(missOutcome, "Swish");
const secondSetupMiss = p.simulateShot(missControls, p.ROUND_SETUPS[1]).outcome;
const impossibleSavedRound = { ...sessions.createSwishSession(9), round: 2, setupIndex: 1, recent: [0, 1], completed: 1, attempts: 2, makes: 2, totalScore: 100,
  lastShot: { controls: missControls, outcome: secondSetupMiss } };
assert.equal(sessions.validateSwishSession(impossibleSavedRound), false, "A final miss needs an attempt beyond the total makes");
const possibleSavedRound = { ...impossibleSavedRound, attempts: 3 };
assert.equal(sessions.validateSwishSession(possibleSavedRound), true, "Earlier attempts can account for makes before a miss");

// Saved history must remain consistent with the score and setup-unlock rules
const unplayedRound = (round, setupIndex, recent) => ({
  ...sessions.createSwishSession(77), round, completed: round - 1, totalScore: round - 1,
  setupIndex, recent,
});
assert.equal(sessions.validateSwishSession(unplayedRound(3, 2, [0, 1, 2])), true, "The first setup tier remains available through round three");
assert.equal(sessions.validateSwishSession(unplayedRound(4, 6, [1, 2, 6])), true, "The middle setup tier opens after round three");
assert.equal(sessions.validateSwishSession(unplayedRound(7, 11, [5, 6, 11])), true, "The full setup catalog opens after round six");
assert.equal(sessions.validateSwishSession({ ...unplayedRound(2, 1, [0, 1]), totalScore: 0 }), true, "A completed round can legitimately score zero after more than 600 attempts");
const impossibleHistory = [
  { ...s, totalScore: s.completed * 100 + 1 },
  { ...sessions.createSwishSession(3), setupIndex: 1, recent: [1] },
  unplayedRound(2, 3, [0, 3]),
  unplayedRound(3, 3, [0, 1, 3]),
  unplayedRound(4, 7, [0, 1, 7]),
  { ...s, recent: [s.setupIndex] },
  { ...s, recent: [0, s.setupIndex, s.setupIndex] },
];
for (const invalid of impossibleHistory) assert.equal(sessions.validateSwishSession(invalid), false, `Reject impossible saved state: ${JSON.stringify({ round: invalid.round, setupIndex: invalid.setupIndex, completed: invalid.completed, totalScore: invalid.totalScore, recent: invalid.recent })}`);
for (const invalid of impossibleHistory) {
  fake.value = JSON.stringify(invalid);
  assert.equal(sessions.loadSwishSession(() => fake).session.round, 1, "Impossible persisted progress safely starts a fresh session");
}
for (const broken of [null, {}, { ...s, makes: 4 }, { ...s, seed: -1 }, { ...s, recent: [] }, { ...s, completed: 999 }, { ...s, lastShot: { controls: control, outcome: "Swish" } }]) assert.equal(sessions.validateSwishSession(broken), false);
console.log("Swish Tuner: deterministic physics, swept contacts, descending swishes, spread bounds, catalog solutions, 36 rounds, scoring, locking, storage and model fallback passed");
