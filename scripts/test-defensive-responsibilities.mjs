import assert from 'node:assert/strict';
import { coordinateDefensiveDuties, createDefensiveTeamState, defensiveDutySnapshot } from '../frontend/src/features/playbook/defensiveResponsibilities.ts';
import { createSimulationRun, prepareSimulationRun, advanceSimulationState, setSimulationRunSettings, getSimulationFrame, observeCounterLabRun, rebasePausedSimulation, pointDistanceFeet } from '../frontend/src/features/playbook/simulation.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { runCounterLabTrial } from '../frontend/src/features/playbook/counterLabEngine.ts';
import { packReplay } from '../frontend/src/features/playbook/counterLabReplayArchive.ts';
import { decodeReplayForPlayback } from '../frontend/src/features/playbook/counterLabReplayValidation.ts';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const roster = [[50, 60], [25, 50], [75, 50], [50, 20]].map(([x, y], i) => ({ id: i + 1, x, y }));
function context(overrides = {}) {
  return { atMs: 100, strategy: 'help', zone: false, players: structuredClone(roster),
    defenders: [{ id: 1, x: 50, y: 56 }, { id: 2, x: 40, y: 45 }, { id: 3, x: 67, y: 42 }, { id: 4, x: 50, y: 15 }],
    assignments: new Map([[1, 1], [2, 2], [3, 3], [4, 4]]), zoneAssignments: new Map(), chasers: new Map(),
    primary: { defenderId: 1, playerId: 1 }, screens: [], drive: true, helperCandidates: [2], rimCandidates: [4, 3, 2, 1],
    distance, anchor: id => roster[id - 1], threat: () => 3, ...overrides };
}
function uniqueDuties(state, c) {
  const duties = [...state.duties.values()];
  assert.equal(new Set(duties.map(d => d.defenderId)).size, duties.length);
  for (const role of ['primary', 'helper', 'rim-protector']) assert.ok(duties.filter(d => d.role === role).length <= 1);
  for (const duty of duties) {
    assert.ok(c.defenders.some(d => d.id === duty.defenderId));
    assert.ok(duty.playerId == null || c.players.some(p => p.id === duty.playerId));
    assert.ok(duty.reason && duty.releaseOn && duty.sinceMs <= c.atMs);
  }
}

// A real x-out: one replacement owns the exposed player, the helper inherits
// that replacement's former player, and recovery does not snap back to originals.
const team = createDefensiveTeamState(), c = context();
coordinateDefensiveDuties(team, c); uniqueDuties(team, c);
assert.equal(team.helper.defenderId, 2);
assert.equal(team.rotations[0].replacementId, 3, 'the free wing rotates rather than stealing the rim protector');
assert.equal(c.assignments.get(3), 2); assert.equal(c.assignments.get(2), 3);
assert.equal(team.duties.get(3).role, 'recovery'); assert.equal(team.duties.get(4).role, 'rim-protector');
assert.equal(team.rotations[0].exposedPlayerId, 3, 'the plan records the unavoidable weak-side exposure');
const first = defensiveDutySnapshot(team), started = team.duties.get(2).sinceMs;
coordinateDefensiveDuties(team, { ...c, atMs: 180 });
assert.equal(team.rotations.length, 1); assert.equal(team.duties.get(2).sinceMs, started);
coordinateDefensiveDuties(team, { ...c, atMs: 200, drive: false });
coordinateDefensiveDuties(team, { ...c, atMs: 419.999, drive: false });
assert.equal(team.helper.defenderId, 2, 'threat hysteresis retains the commitment just below 220ms');
coordinateDefensiveDuties(team, { ...c, atMs: 420, drive: false });
assert.equal(team.helper, null); assert.equal(team.duties.get(2).role, 'recovery');
assert.equal(c.assignments.get(3), 2); assert.equal(c.assignments.get(2), 3);
assert.equal(first.find(d => d.defenderId === 2).role, 'helper', 'snapshots never alias mutable team duties');

// A kick to the former helper's new matchup immediately overrides help. There
// is exactly one primary and no unrelated defender independently chooses it.
const kick = context({ atMs: 500, assignments: c.assignments, primary: { defenderId: 2, playerId: 3 }, drive: false });
coordinateDefensiveDuties(team, kick); uniqueDuties(team, kick);
assert.equal(team.duties.get(2).role, 'primary'); assert.equal(team.duties.get(3).playerId, 2);
assert.equal(team.recoveries.has(2), false, 'priority takeover clears superseded recovery');

// Screens preempt help/recovery and release by explicit action identity. The
// next screen may reserve the same defender without inheriting the prior duty.
const screenTeam = createDefensiveTeamState(), screenC = context();
coordinateDefensiveDuties(screenTeam, screenC);
coordinateDefensiveDuties(screenTeam, { ...screenC, atMs: 150, screens: [{ defenderId: 2, playerId: 3, actionId: 'first' }], drive: false });
assert.equal(screenTeam.helper, null); assert.equal(screenTeam.duties.get(2).role, 'screen');
coordinateDefensiveDuties(screenTeam, { ...screenC, atMs: 300, screens: [{ defenderId: 3, playerId: 2, actionId: 'second' }], drive: false });
assert.equal(screenTeam.duties.get(3).actionId, 'second');
assert.ok([...screenTeam.duties.values()].every(d => d.actionId !== 'first'));

// Zone rotations exchange areas, not the persistent man matchup map. Chasers
// cannot be reassigned; free closeout claims remain distinct and stable.
const zoneTeam = createDefensiveTeamState();
const zoneC = context({ zone: true, zoneAssignments: new Map([[1, 0], [2, 1], [3, 2], [4, 3]]),
  anchor: id => roster[zoneC.zoneAssignments.get(id)] });
const originalMan = new Map(zoneC.assignments);
coordinateDefensiveDuties(zoneTeam, zoneC);
assert.equal(zoneC.zoneAssignments.get(3), 1); assert.equal(zoneC.zoneAssignments.get(2), 2);
assert.deepEqual(zoneC.assignments, originalMan);
const zoneClaims = [...zoneTeam.duties.values()].filter(d => d.role !== 'helper' && d.playerId != null).map(d => d.playerId);
assert.equal(new Set(zoneClaims).size, zoneClaims.length);
const withChaser = createDefensiveTeamState(), chaserC = context({ chasers: new Map([[3, 3]]) });
coordinateDefensiveDuties(withChaser, chaserC);
assert.notEqual(withChaser.rotations[0].replacementId, 3); assert.equal(withChaser.duties.get(3).playerId, 3);

const partial = createDefensiveTeamState(), partialC = context({ defenders: context().defenders.slice(0, 2) });
coordinateDefensiveDuties(partial, partialC);
assert.equal(partial.rotations[0].replacementId, null); assert.equal(partial.rotations[0].exposedPlayerId, 2);
assert.equal(partial.duties.size, 2, 'partial rosters never invent a replacement');
coordinateDefensiveDuties(partial, { ...partialC, atMs: 500, defenders: partialC.defenders.slice(0, 1), drive: false });
assert.equal(partial.helper, null); assert.equal(partial.duties.size, 1);
coordinateDefensiveDuties(partial, { ...partialC, strategy: 'off' });
assert.equal(partial.duties.size, 0); assert.equal(partial.helper, null);

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'help', offenseMode: 'scripted' };
const draft = (players, arrows = [], defenders) => ({ version: 1, id: 'responsibility-fixture', name: 'Responsibilities', defenders_visible: true,
  players: players.map(([x, y], i) => ({ id: i + 1, x, y })), defenders: (defenders ?? players.map(([x, y]) => [x, y - 5])).map(([x, y], i) => ({ id: i + 1, x, y })),
  ball: { x: players[0][0], y: players[0][1] }, arrows });
const driveKick = draft([[50, 75], [29, 63], [71, 63], [80, 45]], [
  { id: 'drive', kind: 'movement', actor_id: 1, sequence: 1, timing: 1.2, start: { x: 50, y: 75 }, end: { x: 50, y: 55 } },
  { id: 'kick', kind: 'pass', actor_id: 1, recipient_id: 2, sequence: 2, timing: .8, start: { x: 50, y: 55 }, end: { x: 29, y: 63 } },
  { id: 'reverse', kind: 'pass', actor_id: 2, recipient_id: 3, sequence: 3, timing: .8, start: { x: 29, y: 63 }, end: { x: 71, y: 63 } },
]);
function inspect(run) {
  const snapshots = [], primaryPlayers = new Set();
  while (run.elapsedMs < run.durationMs) {
    const before = new Map(run.defenders.map(d => [d.id, { ...d }])), atMs = run.elapsedMs;
    advanceSimulationState(run, 1000 / 60);
    uniqueDuties(run.defense, { ...context(), players: run.players, defenders: run.defenders, atMs: run.elapsedMs });
    for (const d of run.defenders) {
      assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y));
      assert.ok(pointDistanceFeet(d, before.get(d.id)) <= 15 * (run.elapsedMs - atMs) / 1000 + .002, 'rotation never teleports defenders');
    }
    const frame = getSimulationFrame(run), observed = observeCounterLabRun(run);
    assert.deepEqual(frame.defensiveResponsibilities, observed.defensiveResponsibilities);
    const primary = frame.defensiveResponsibilities.find(d => d.role === 'primary');
    if (primary) primaryPlayers.add(primary.playerId);
    snapshots.push({ positions: run.defenders.map(({id,x,y}) => ({id,x,y})), duties: frame.defensiveResponsibilities, atMs: run.elapsedMs });
    assert.ok(snapshots.length < 4000);
  }
  return { snapshots, primaryPlayers };
}
for (const defenseStrategy of ['help', 'trap-rotate']) {
  const run = createSimulationRun(driveKick, { ...settings, defenseStrategy }), source = structuredClone(driveKick);
  const result = inspect(run);
  assert.ok(run.defense.rotations.length > 0, `${defenseStrategy}: actual driving motion commits a rotation`);
  assert.ok(result.primaryPlayers.has(1) && result.primaryPlayers.has(2) && result.primaryPlayers.has(3), 'kick and reversal transfer primary responsibility');
  assert.equal(run.actions[1].transfer.outcome.kind, 'caught'); assert.equal(run.actions[2].transfer.outcome.kind, 'caught');
  assert.deepEqual(inspect(createSimulationRun(driveKick, { ...settings, defenseStrategy })), result, 'team decisions are deterministic');
  assert.deepEqual(driveKick, source);
}
const screens = draft([[50, 76], [37, 64], [26, 59]], [
  { id: 'first', kind: 'screen', screener_id: 2, start: { x: 37, y: 64 }, end: { x: 43, y: 69 }, sequence: 1, timing: .7 },
  { id: 'second', kind: 'screen', screener_id: 3, start: { x: 26, y: 59 }, end: { x: 42, y: 67 }, sequence: 2, timing: .7 },
]);
for (const defenseStrategy of ['switch', 'hedge', 'drop']) {
  const run = createSimulationRun(screens, { ...settings, defenseStrategy });
  const { snapshots } = inspect(run);
  for (const actionId of ['first', 'second']) assert.ok(snapshots.some(frame => frame.duties.some(d => d.actionId === actionId)), `${actionId}: screen participants own a recorded duty`);
  assert.ok([...run.screenCoverageLocks.keys()].length === 0, 'finished screen locks are released');
  if (defenseStrategy === 'switch') assert.equal(run.switchedActions.size, 2, 'consecutive actual screen interactions each switch once');
  assert.equal(run.settings.defenseStrategy, defenseStrategy);
}
// The zone's nearest ball slot must not override a screen's reserved owner;
// that used to send two defenders toward the same screened player.
for (const defenseStrategy of ['contain', 'switch', 'hedge']) {
  const run = createSimulationRun(STARTER_PLAYS[0], { ...settings, defenseScheme: 'zone-3-2', defenseStrategy });
  const { snapshots } = inspect(run);
  for (const frame of snapshots) {
    const claims = frame.duties.filter(d => d.role !== 'helper' && d.playerId != null).map(d => d.playerId);
    assert.equal(new Set(claims).size, claims.length, 'locked screen owners and zone pressure coordinate their claims');
  }
}
for (const defenseScheme of ['man-to-man', 'zone-3-2']) {
  const run = createSimulationRun(STARTER_PLAYS[0], { ...settings, defenseScheme, defenseStrategy: 'trap-rotate' });
  let committed = 0;
  while (run.elapsedMs < run.durationMs) {
    advanceSimulationState(run, 1000 / 60);
    const primary = [...run.defense.duties.values()].find(d => d.role === 'primary');
    const screen = run.actions.find(a => ['set', 'use', 'release'].includes(a.execution?.phase)
      && run.screenCoverageLocks.get(a.arrow.id)?.screenedId === primary?.playerId);
    if (screen) {
      committed++;
      assert.equal(run.defense.helper, null, 'the locked screen trap must not recruit a third drive helper');
      assert.ok([...run.defense.duties.values()].some(d => d.role === 'screen' && d.actionId === screen.arrow.id));
    }
  }
  assert.ok(committed > 0, 'the fixture must execute a screen trap');
}
for (const count of [0, 1, 2]) {
  const play = { ...driveKick, defenders: driveKick.defenders.slice(0, count) };
  const run = createSimulationRun(play, settings); inspect(run);
  assert.ok(run.defense.duties.size <= run.defenders.length);
}
const changing = createSimulationRun(driveKick, settings);
while (!changing.defense.helper) advanceSimulationState(changing, 1000 / 60);
const pausedDuties = structuredClone(changing.defense), pausedAssignments = new Map(changing.assignments);
assert.equal(rebasePausedSimulation(changing, structuredClone(changing.source)), true);
assert.deepEqual(changing.defense, pausedDuties, 'rebasing a paused drawing never rewinds responsibility clocks or creates a rotation');
assert.deepEqual(changing.assignments, pausedAssignments);
const positions = structuredClone(changing.defenders);
setSimulationRunSettings(changing, { ...settings, defenseStrategy: 'off' });
assert.equal(changing.defense.helper, null); assert.equal(changing.defense.duties.size, 0); assert.deepEqual(changing.defenders, positions);

// The prepared path owns separate plans, and worker archives keep and validate
// responsibility evidence without exposing mutable run objects.
const factory = prepareSimulationRun(driveKick), a = factory(settings), b = factory(settings);
advanceSimulationState(a, 50); assert.notStrictEqual(a.defense.duties, b.defense.duties);
const trial = runCounterLabTrial(driveKick, { id: 'help', label: 'Help', scheme: 'man-to-man', strategy: 'help' }, 'scripted');
assert.deepEqual(decodeReplayForPlayback(packReplay(trial.trace)), trial.trace);
const sample = trial.trace.find(frame => frame.defensiveResponsibilities.length > 1);
for (const corrupt of [
  duties => { duties[0].defenderId = 99; }, duties => { duties[1].defenderId = duties[0].defenderId; },
  duties => { duties[0].role = 'random'; }, duties => { duties[0].playerId = 99; },
  duties => { duties[0].sinceMs = Infinity; }, duties => { duties[0].zoneSlot = 5; },
  duties => { duties[0].releaseOn = ''; }, duties => { duties[0].relatedDefenderId = duties[0].defenderId; },
]) { const bad = structuredClone(sample); corrupt(bad.defensiveResponsibilities); assert.throws(() => decodeReplayForPlayback(packReplay([bad]))); }
console.log('Defensive responsibility tests passed: explicit rotations, release boundaries, recovery ownership, screens, traps/reversals, zone/chaser exclusions, partial rosters, bounded movement, deterministic trials and worker evidence.');
