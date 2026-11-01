import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { coordinateMovement, createMovementBuffers } from '../frontend/src/features/playbook/coordinatedMovement.ts';
import { createSimulationRun, advanceSimulationState, observeCounterLabRun, getSimulationFrame, setSimulationRunSettings, editPausedSimulationMarker, pointDistanceFeet } from '../frontend/src/features/playbook/simulation.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { courtFeetToSvg, courtSvgToPoint } from '../frontend/src/features/playbook/courtGeometry.ts';
import { decodeReplayForPlayback } from '../frontend/src/features/playbook/counterLabReplayValidation.ts';
import { packReplay } from '../frontend/src/features/playbook/counterLabReplayArchive.ts';
import { clearCongestionState, CONGESTION_YIELD_MS, CONGESTION_STALL_MS } from '../frontend/src/features/playbook/congestionPlanning.ts';

const dt = 1 / 60, bounds = { left: 0, right: 50, top: 0, bottom: 47 };
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function swept(a, b, A, B) {
  const x = a.x - b.x, y = a.y - b.y, dx = A.x - B.x - x, dy = A.y - B.y - y;
  const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / Math.max(1e-12, dx * dx + dy * dy)));
  return Math.hypot(x + t * dx, y + t * dy);
}
function project(p, a, b) {
  const x = b.x - a.x, y = b.y - a.y, length = Math.hypot(x, y);
  const progress = length ? Math.max(0, Math.min(length, ((p.x - a.x) * x + (p.y - a.y) * y) / length)) : 0;
  return { progress, length, closest: { x: a.x + x * progress / (length || 1), y: a.y + y * progress / (length || 1) } };
}
function trial(starts, goals, options = {}) {
  const scratch = createMovementBuffers(), frames = [], statuses = new Set();
  let points = structuredClone(starts), velocities = starts.map(() => ({ x: 0, y: 0 })), minimum = Infinity, maxYield = 0;
  const keys = starts.map((_, n) => `player:${n + 1}`), steps = options.steps ?? 600;
  for (let step = 0; step < steps; step++) {
    const intents = points.map((point, n) => {
      const goal = goals[n], route = project(point, starts[n], goal), remaining = gap(point, goal);
      const speed = Math.min(8, Math.sqrt(56 * remaining));
      return { key: keys[n], point, previousVelocity: velocities[n], speed: 8, acceleration: 28,
        velocity: remaining < .08 || options.frozen?.includes(n) ? { x: 0, y: 0 } : { x: (goal.x - point.x) / remaining * speed, y: (goal.y - point.y) / remaining * speed },
        priority: options.frozen?.includes(n) ? 100 : remaining < .8 ? 8 : 3, frozen: options.frozen?.includes(n), target: goal,
        corridor: { point: route.closest, radius: 3 },
        ...(options.planning === false ? {} : { navigation: { id: keys[n], goal, points: [starts[n], goal], progress: route.progress, remaining: route.length - route.progress } }),
      };
    });
    const input = structuredClone(intents);
    const active = options.reverse ? [...intents].reverse() : intents;
    const resolved = coordinateMovement(active, dt, options.bounds ?? bounds, undefined, scratch);
    assert.deepEqual(intents, input, 'planning never mutates route geometry or caller intentions');
    const byKey = new Map(active.map((i, n) => [i.key, resolved[n]]));
    const next = keys.map(key => byKey.get(key));
    next.forEach((r, n) => {
      assert.ok(Number.isFinite(r.point.x) && Number.isFinite(r.point.y));
      assert.ok(gap(r.point, points[n]) <= 8 * dt + 1e-7, 'bounded travel without teleporting');
      assert.ok(Math.hypot(r.velocity.x, r.velocity.y) <= 8 + 1e-7, 'speed bound');
      assert.ok(gap(r.point, project(r.point, starts[n], goals[n]).closest) <= 3 + 1e-6, 'authored route deviation remains at most three feet');
      const box = options.bounds ?? bounds;
      assert.ok(r.point.x >= box.left - 1e-6 && r.point.x <= box.right + 1e-6 && r.point.y >= box.top - 1e-6 && r.point.y <= box.bottom + 1e-6);
      if (options.frozen?.includes(n)) assert.deepEqual(r.point, starts[n], 'a set screen is never moved to manufacture a passage');
      for (let other = n + 1; other < next.length; other++) {
        const separation = swept(points[n], points[other], r.point, next[other].point);
        if (gap(points[n], points[other]) >= 2.0001) assert.ok(separation >= 1.999, 'full swept segments preserve body clearance');
        minimum = Math.min(minimum, gap(r.point, next[other].point));
      }
    });
    for (const decision of scratch.congestion.decisions.values()) {
      statuses.add(decision.status); assert.ok(decision.blockers.length && decision.reason && decision.sinceMs <= scratch.congestion.elapsedMs);
    }
    for (const passage of scratch.congestion.passages.values()) {
      assert.ok(passage.untilMs - scratch.congestion.elapsedMs <= CONGESTION_YIELD_MS + 1e-6, 'individual passage leases are bounded');
      maxYield = Math.max(maxYield, passage.untilMs - scratch.congestion.elapsedMs);
    }
    assert.ok(scratch.congestion.passages.size <= starts.length * (starts.length - 1) / 2);
    assert.ok(scratch.congestion.destinations.length <= starts.length);
    points = next.map(r => r.point); velocities = next.map(r => r.velocity);
    if (options.frames) frames.push(points);
  }
  return { points, gaps: points.map((p, n) => gap(p, goals[n])), statuses: [...statuses], minimum, maxYield, frames, scratch };
}
const fixtures = [
  ['head-on passage', [{ x: 15, y: 20 }, { x: 30, y: 20 }], [{ x: 30, y: 20 }, { x: 15, y: 20 }]],
  ['crossing cuts', [{ x: 15, y: 20 }, { x: 25, y: 10 }], [{ x: 35, y: 20 }, { x: 25, y: 30 }]],
  ['crowded paint', [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 25, y: 15 }, { x: 25, y: 25 }], [{ x: 30, y: 20 }, { x: 20, y: 20 }, { x: 25, y: 25 }, { x: 25, y: 15 }]],
  ['baseline congestion', [{ x: 15, y: 1.4 }, { x: 25, y: 1.4 }, { x: 35, y: 1.4 }], [{ x: 35, y: 1.4 }, { x: 25, y: 1.4 }, { x: 15, y: 1.4 }], { frozen: [1] }],
];
const planningAudit = [];
for (const [name, starts, goals, options] of fixtures) {
  const result = trial(starts, goals, options);
  assert.ok(result.gaps.every(d => d < .6), `${name}: legal detours/yields retain every authored destination`);
  const before = trial(starts, goals, { ...options, planning: false });
  planningAudit.push({ name, before: before.gaps.map(d => Number(d.toFixed(4))), after: result.gaps.map(d => Number(d.toFixed(4))) });
  const again = trial(starts, goals, { ...options, reverse: true });
  assert.deepEqual(again.points, result.points, `${name}: symmetric priorities are independent of incoming array order`);
}
assert.ok(planningAudit.some(test => test.before.some(gap => gap > 2) && test.after.every(gap => gap < .6)), 'planning resolves a reproducible deadlock left by immediate avoidance');
if (process.env.ARC_CONGESTION_AUDIT_FILE) writeFileSync(process.env.ARC_CONGESTION_AUDIT_FILE, JSON.stringify(planningAudit, null, 2) + '\n');
const shared = trial([{ x: 15, y: 20 }, { x: 30, y: 20 }], [{ x: 24, y: 20 }, { x: 24, y: 20 }]);
assert.equal(shared.gaps.filter(d => d < .6).length, 1, 'only the reserved destination owner can arrive');
assert.ok(shared.statuses.includes('blocked'), 'the impossible second arrival reports obstruction');
const wall = trial([{ x: 15, y: 1.5 }, { x: 25, y: 1.5 }], [{ x: 35, y: 1.5 }, { x: 25, y: 1.5 }], { frozen: [1], bounds: { ...bounds, bottom: 3 } });
assert.ok(wall.statuses.includes('blocked') && wall.gaps[0] > 2, 'a closed lane never invents clearance');
assert.ok(wall.scratch.congestion.elapsedMs >= CONGESTION_STALL_MS);
const overlap = trial([{ x: 25, y: 20 }, { x: 25, y: 20 }], [{ x: 15, y: 20 }, { x: 35, y: 20 }]);
assert.ok(overlap.gaps.every(d => d < .6), 'exact symmetric starts resolve gradually and deterministically');
const solo = trial([{ x: 10, y: 10 }], [{ x: 30, y: 10 }]);
assert.deepEqual(solo.points, trial([{ x: 10, y: 10 }], [{ x: 30, y: 10 }], { planning: false }).points, 'uncongested movement remains unchanged');
// Projecting to the route endpoint is not arrival while still three feet
// laterally displaced. An immovable body at that goal must age the stall.
const endpointBuffers = createMovementBuffers();
let endpoint = { x: 30, y: 23 }, endpointVelocity = { x: 0, y: 0 };
for (let n = 0; n < 180; n++) {
  const goal = { x: 30, y: 20 };
  const intents = [{ key: 'player:1', point: endpoint, velocity: { x: 0, y: -5 }, previousVelocity: endpointVelocity,
    speed: 5, acceleration: 28, priority: 8, corridor: { point: goal, radius: 3 }, target: goal,
    navigation: { id: 'end', goal, points: [{ x: 20, y: 20 }, goal], progress: 10, remaining: 0 } },
    { key: 'player:2', point: goal, velocity: { x: 0, y: 0 }, previousVelocity: { x: 0, y: 0 }, speed: 0, acceleration: 28, priority: 100, frozen: true }];
  const result = coordinateMovement(intents, dt, bounds, undefined, endpointBuffers);
  endpoint = result[0].point; endpointVelocity = result[0].velocity;
}
assert.equal(endpointBuffers.congestion.decisions.get('player:1')?.status, 'blocked', 'endpoint projection cannot conceal a persistent lateral obstruction');
const snapshot = structuredClone(shared.scratch.congestion);
coordinateMovement([], 0, bounds, undefined, shared.scratch);
assert.deepEqual(shared.scratch.congestion, snapshot, 'zero time cannot age or change reservations');
clearCongestionState(shared.scratch.congestion);
assert.equal(shared.scratch.congestion.agents.size + shared.scratch.congestion.passages.size + shared.scratch.congestion.destinations.length + shared.scratch.congestion.decisions.size, 0);
assert.notStrictEqual(solo.scratch.congestion, overlap.scratch.congestion, 'runs own isolated reservation state');
console.log('Congestion planning passed: crossings, paint, baseline, shared destinations, closed lanes, symmetric starts, clearance, deterministic priorities, bounded leases and isolated state.');

// Exercise the actual authored-route binding, fixed-step scheduler, replay
// recording and obstruction reporting used by both workspaces.
const at = (x, y) => courtSvgToPoint(courtFeetToSvg({ x, y }));
const fixture = (starts, goals) => ({ version: 1, id: 'congestion', name: 'Congestion',
  players: starts.map(([x,y], n) => ({ id: n + 1, ...at(x,y) })),
  defenders: [{ id: 1, ...at(45,45) }], defenders_visible: true, ball: null,
  arrows: goals.map(([x,y], n) => ({ id: `cut-${n}`, kind: 'movement', actor_id: n + 1,
    start: at(...starts[n]), end: at(x,y), sequence: 1, timing: 4, path: 'straight' })),
});
const settings = { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: 'scripted', defenseScheme: 'man-to-man', defenseStrategy: 'off' };
function execute(play, hz = 60) {
  const before = structuredClone(play), run = createSimulationRun(play, settings), frames = [], states = new Set();
  let steps = 0;
  while (run.elapsedMs < run.durationMs) {
    advanceSimulationState(run, 1000 / hz);
    const observation = observeCounterLabRun(run);
    frames.push({ ...observation, ...observation.frame });
    for (const action of run.frame.execution ?? []) if (action.congestion) states.add(action.congestion.status);
    assert.ok(++steps < 2000, 'the existing action wait bound still ends the possession');
  }
  assert.deepEqual(play, before, 'planning never rewrites the drawing');
  assert.deepEqual(decodeReplayForPlayback(packReplay(frames)), frames, 'worker archives preserve congestion evidence at every sample');
  return { run, states, frames };
}
for (const play of [fixture([[20,25],[30,25]], [[30,25],[20,25]]), fixture([[20,25],[25,20]], [[30,25],[25,30]])]) {
  const { run, states } = execute(play);
  assert.ok(states.has('detouring'));
  assert.ok(run.actions.every(action => action.execution.phase === 'completed'), 'feasible crossing actions complete');
  assert.ok(run.players.every((player,n) => pointDistanceFeet(player, play.arrows[n].end) <= .6));
  for (const hz of [30, 120]) assert.deepEqual(getSimulationFrame(execute(play, hz).run), getSimulationFrame(run), 'render cadence cannot change planning or final execution');
}
const crowded = execute(fixture([[20,25],[30,25],[25,20],[25,30]], [[30,25],[20,25],[25,30],[25,20]]));
assert.ok(crowded.states.has('yielding') && crowded.states.has('blocked'));
assert.ok(crowded.run.actions.every(a => a.execution.phase === 'completed'), 'feasible multiway traffic must not introduce unnecessary obstruction');
assert.ok(crowded.run.players.every((p,n) => pointDistanceFeet(p, crowded.run.source.arrows[n].end) < .6));
assert.ok(crowded.run.actions.every(a => a.execution.waitMs <= 1200 + 1e-6));
const curvedCrossing = fixture([[20,25],[25,25]], [[30,25],[25,35]]);
curvedCrossing.arrows[0].path = 'curve'; curvedCrossing.arrows[0].control = at(25,35);
const curveResult = execute(curvedCrossing);
assert.ok(curveResult.states.has('detouring'), 'curved authored traffic participates in passage planning');
assert.ok(curveResult.run.actions.every(a => a.execution.phase === 'completed'), 'bounded planning preserves curved destinations and completion');
assert.ok(curveResult.frames.some(frame => frame.players[0].y > at(25,29).y), 'actual playback retains its curve rather than becoming a chord');
const destinationPlay = fixture([[20,25],[30,25]], [[25,25],[25,25]]);
const destination = execute(destinationPlay);
assert.equal(destination.run.actions.filter(a => a.execution.phase === 'completed').length, 1);
assert.equal(destination.run.actions.filter(a => a.execution.phase === 'obstructed').length, 1);
assert.match(destination.run.actions.find(a => a.execution.phase === 'obstructed').execution.notice, /reserved player traffic/);
const active = createSimulationRun(destinationPlay, settings);
while (!active.frame.execution.some(a => a.congestion)) advanceSimulationState(active, 1000 / 60);
const sample = observeCounterLabRun(active), display = getSimulationFrame(active);
const recordedBefore = structuredClone(sample), displayBefore = structuredClone(display);
const activeDiagnostic = active.frame.execution.find(a => a.congestion);
activeDiagnostic.congestion.blockers.push('mutated');
assert.deepEqual(sample, recordedBefore, 'compact recordings own nested congestion evidence');
assert.deepEqual(display, displayBefore, 'display snapshots own nested congestion evidence');
activeDiagnostic.congestion.blockers.pop();
const planningBefore = structuredClone(active.movementBuffers.solver.congestion);
setSimulationRunSettings(active, { ...settings });
assert.deepEqual(active.movementBuffers.solver.congestion, planningBefore, 'unchanged settings preserve current reservations');
setSimulationRunSettings(active, { ...settings, offBallIntensity: 30 });
assert.equal(active.movementBuffers.solver.congestion.decisions.size, 0, 'changed settings release old plans');
assert.ok(active.frame.execution.every(a => !a.congestion), 'changed settings clear active traffic diagnostics');
advanceSimulationState(active, 1000 / 60);
editPausedSimulationMarker(active, 'player', 1, at(15,25));
assert.equal(active.movementBuffers.solver.congestion.passages.size, 0, 'a paused edit releases passage ownership');
assert.ok(active.frame.execution.every(a => !a.congestion), 'a paused edit cannot display stale traffic evidence');
console.log('Authored congestion integration passed: completion, bounded obstruction, destination ownership, 30/60/120Hz equality, replay validation, snapshot isolation and plan invalidation.');
