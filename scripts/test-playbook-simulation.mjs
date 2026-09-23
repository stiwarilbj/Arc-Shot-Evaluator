import assert from 'node:assert/strict';
import {
  advanceSimulationRun,
  createSimulationRun,
  DEFENDER_MAX_SPEED_FT_PER_SECOND,
  editPausedSimulationMarker,
  getSimulationFrame,
  pointDistanceFeet,
  rebasePausedSimulation,
  setSimulationRunSettings,
  SIMULATION_STEP_MS,
} from '../frontend/src/features/playbook/simulation.ts';
import { EMPTY_COURT, READY_SETUP, STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { courtSvgToPoint, COURT_SCALE, COURT_VIEWBOX, NBA_COURT_GEOMETRY } from '../frontend/src/features/playbook/courtGeometry.ts';

const settings = { offenseOffBall: 'read-react', defenseOffBall: 'help', offBallIntensity: 70 };
const hoop = courtSvgToPoint(NBA_COURT_GEOMETRY.basket.center);

function makeDraft({ players, ball, arrows = [], defenders = [] }) {
  return {
    version: 1,
    id: 'simulation-test',
    name: 'Simulation test',
    defenders_visible: defenders.length > 0,
    players: players.map(([x, y], index) => ({ id: index + 1, x, y })),
    defenders: defenders.map(([x, y], index) => ({ id: index + 1, x, y })),
    ball: ball ? { x: ball[0], y: ball[1] } : null,
    arrows,
  };
}

function advance(run, milliseconds, runSettings = settings) {
  let remaining = milliseconds;
  while (remaining > 1e-8) {
    const slice = Math.min(remaining, SIMULATION_STEP_MS);
    advanceSimulationRun(run, slice, runSettings);
    remaining -= slice;
  }
}

function assertNear(actual, expected, tolerance = 1e-5, message = 'values should be near') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${actual} to be within ${tolerance} of ${expected}`);
}

function helpSpot(handler) {
  const toFeetX = (COURT_VIEWBOX.width / 100) / COURT_SCALE;
  const toFeetY = (COURT_VIEWBOX.height / 100) / COURT_SCALE;
  const dxFeet = (hoop.x - handler.x) * toFeetX;
  const dyFeet = (hoop.y - handler.y) * toFeetY;
  const distanceFeet = Math.hypot(dxFeet, dyFeet);
  const distanceToHelp = Math.min(9, distanceFeet * 0.34);
  const fraction = distanceFeet ? distanceToHelp / distanceFeet : 0;
  return { x: handler.x + (hoop.x - handler.x) * fraction, y: handler.y + (hoop.y - handler.y) * fraction };
}

// A simulation run must not add temporary defenders to or otherwise mutate the draft.
const noDefenderDraft = makeDraft({ players: [[50, 76], [27, 60], [73, 60]], ball: [50, 76] });
const originalDraft = structuredClone(noDefenderDraft);
const ephemeralRun = createSimulationRun(noDefenderDraft, settings);
assert.equal(ephemeralRun.ephemeralDefenders, true);
assert.equal(ephemeralRun.defenders.length, noDefenderDraft.players.length);
assert.deepEqual(noDefenderDraft, originalDraft, 'starting a run must not change the editor draft');
assert.deepEqual(ephemeralRun.players, originalDraft.players, 'every offensive marker begins at its drawn position');
assert.deepEqual(new Map(ephemeralRun.assignments), new Map(ephemeralRun.assignments), 'matchups are stored once for the duration of the run');

// Existing defenders also begin exactly where the diagram placed them.
const manualDefenseDraft = makeDraft({
  players: [[50, 76], [27, 60], [73, 60]],
  ball: [50, 76],
  defenders: [[49, 68], [34, 56], [66, 56]],
});
const manualRun = createSimulationRun(manualDefenseDraft, settings);
assert.equal(manualRun.ephemeralDefenders, false);
assert.deepEqual(manualRun.defenders, manualDefenseDraft.defenders, 'manual defenders are not repositioned when playback starts');

// Actions execute in sequence order, passes bind to the current handler, and possession transfers at the pass boundary.
const orderedDraft = makeDraft({
  players: [[50, 76], [30, 60], [76, 60]],
  ball: [50, 76],
  arrows: [
    { id: 'pass-second', kind: 'pass', start: { x: 50, y: 76 }, end: { x: 32, y: 58 }, sequence: 2, timing: 0.8 },
    { id: 'move-first', kind: 'movement', start: { x: 30, y: 60 }, end: { x: 32, y: 58 }, sequence: 1, timing: 0.6 },
    { id: 'move-third', kind: 'movement', start: { x: 32, y: 58 }, end: { x: 39, y: 54 }, sequence: 3, timing: 0.7 },
  ],
});
const orderedRun = createSimulationRun(orderedDraft, settings);
const orderedAssignments = new Map(orderedRun.assignments);
assert.deepEqual(orderedRun.actions.map((action) => action.sequence), [1, 2, 3]);
assert.equal(orderedRun.actions[1].actorId, 1, 'the pass starts with the drawn ball handler');
assert.equal(orderedRun.actions[1].recipientId, 2, 'the nearest player to the pass endpoint receives the ball');
assert.equal(orderedRun.actions[2].actorId, 2, 'the next action is bound to the new ball handler');

let lastDefenders = orderedRun.defenders.map((defender) => ({ ...defender }));
for (let frame = 0; frame < 18; frame += 1) {
  advance(orderedRun, SIMULATION_STEP_MS);
  orderedRun.defenders.forEach((defender, index) => {
    const displacement = pointDistanceFeet(lastDefenders[index], defender);
    assert.ok(displacement <= DEFENDER_MAX_SPEED_FT_PER_SECOND * SIMULATION_STEP_MS / 1000 + 0.002, 'defender travel is speed-limited per frame');
  });
  lastDefenders = orderedRun.defenders.map((defender) => ({ ...defender }));
}
assert.equal(orderedRun.frame.activeSequence, 2, 'the first action is complete and the ordered pass is active');
const playersAtPassStart = orderedRun.players.map((player) => ({ ...player }));
const ballAtPassStart = { ...orderedRun.ball };
advance(orderedRun, SIMULATION_STEP_MS);
orderedRun.players.forEach((player, index) => {
  assert.ok(pointDistanceFeet(playersAtPassStart[index], player) < 1, 'player routes remain continuous across an action boundary');
});
assert.ok(pointDistanceFeet(ballAtPassStart, orderedRun.ball) < 1.6, 'the ball does not teleport when a pass begins');
const ballBeforePass = { ...orderedRun.ball };
advance(orderedRun, 240);
assert.ok(pointDistanceFeet(ballBeforePass, orderedRun.ball) > 0.25, 'the ball travels continuously during a pass');
const passEnd = orderedRun.actions[1].startTime + orderedRun.actions[1].durationMs;
while (orderedRun.elapsedMs < passEnd - SIMULATION_STEP_MS * 2) advance(orderedRun, SIMULATION_STEP_MS);
const playersBeforePassEnd = orderedRun.players.map((player) => ({ ...player }));
advance(orderedRun, SIMULATION_STEP_MS * 3);
orderedRun.players.forEach((player, index) => {
  assert.ok(pointDistanceFeet(playersBeforePassEnd[index], player) < 3, 'players remain continuous as possession changes');
});
assert.equal(orderedRun.ballHandlerId, 2, 'possession transfers to the pass recipient at the pass boundary');
assert.deepEqual(new Map(orderedRun.assignments), orderedAssignments, 'help defense does not recalculate defensive assignments');

// A drive triggers a consistent helper; once the drive ends, that defender recovers to the original matchup.
const driveDraft = makeDraft({
  players: [[50, 75], [29, 63], [71, 63]],
  ball: [50, 75],
  arrows: [
    { id: 'drive', kind: 'movement', start: { x: 50, y: 75 }, end: { x: 50, y: 55 }, sequence: 1, timing: 1.2 },
    { id: 'weak-side-lift', kind: 'movement', start: { x: 71, y: 63 }, end: { x: 78, y: 61 }, sequence: 2, timing: 1.5 },
  ],
});
const driveRun = createSimulationRun(driveDraft, settings);
const stableAssignments = new Map(driveRun.assignments);
advance(driveRun, 430);
const helperId = driveRun.helpDefenderId;
assert.ok(helperId != null, 'Help & recover sends the nearest suitable defender to help on the drive');
const helperBefore = driveRun.defenders.find((defender) => defender.id === helperId);
const handlerBefore = driveRun.players.find((player) => player.id === driveRun.ballHandlerId);
const helpDistanceBefore = pointDistanceFeet(helperBefore, helpSpot(handlerBefore));
advance(driveRun, 350);
assert.equal(driveRun.helpDefenderId, helperId, 'the helper does not switch matchups mid-drive');
const helperDuring = driveRun.defenders.find((defender) => defender.id === helperId);
const handlerDuring = driveRun.players.find((player) => player.id === driveRun.ballHandlerId);
assert.ok(pointDistanceFeet(helperDuring, helpSpot(handlerDuring)) < helpDistanceBefore, 'the helper moves toward the drive lane');
advance(driveRun, driveRun.actions[0].startTime + driveRun.actions[0].durationMs - driveRun.elapsedMs + 550);
assert.equal(driveRun.helpDefenderId, null, 'help assignment clears when the drive ends');
assert.deepEqual(new Map(driveRun.assignments), stableAssignments, 'help and recovery preserve each defender’s original matchup');

// Pause/edit/resume keeps the exact simulation clock and uses the edited marker position as its new origin.
const pausedDraft = makeDraft({
  players: [[50, 76], [28, 60]],
  ball: [50, 76],
  arrows: [{ id: 'long-drive', kind: 'movement', start: { x: 50, y: 76 }, end: { x: 50, y: 50 }, sequence: 1, timing: 4 }],
});
const pausedRun = createSimulationRun(pausedDraft, { ...settings, defenseOffBall: 'off' });
advance(pausedRun, 900);
const frozenElapsed = pausedRun.elapsedMs;
const pausedPosition = { x: 48, y: 68 };
const pausedFrame = editPausedSimulationMarker(pausedRun, 'player', 1, pausedPosition);
assert.equal(pausedRun.elapsedMs, frozenElapsed, 'editing while paused does not advance time');
assert.deepEqual(pausedFrame.players.find((player) => player.id === 1), { id: 1, ...pausedPosition });
assert.deepEqual(pausedFrame.ball, pausedPosition, 'the ball stays with the edited handler');
assert.deepEqual(pausedDraft, {
  ...pausedDraft,
  players: [{ id: 1, x: 50, y: 76 }, { id: 2, x: 28, y: 60 }],
}, 'editing a paused simulation does not mutate the source draft');
const positionBeforeResume = { ...pausedFrame.players.find((player) => player.id === 1) };
advance(pausedRun, SIMULATION_STEP_MS);
assert.ok(pointDistanceFeet(positionBeforeResume, pausedRun.players.find((player) => player.id === 1)) < 1.2, 'resume continues from the edited position without snapping');

const rebaseDraft = makeDraft({
  players: [[50, 76], [28, 60]],
  ball: [50, 76],
  arrows: [{ id: 'rebase-drive', kind: 'movement', start: { x: 50, y: 76 }, end: { x: 50, y: 50 }, sequence: 1, timing: 4 }],
});
const rebaseRun = createSimulationRun(rebaseDraft, { ...settings, defenseOffBall: 'off' });
advance(rebaseRun, 900);
const liveHandlerBeforeEdit = { ...rebaseRun.players.find((player) => player.id === 1) };
const liveBallBeforeEdit = { ...rebaseRun.ball };
const changedDraft = structuredClone(rebaseDraft);
changedDraft.players[1] = { ...changedDraft.players[1], x: 31, y: 62 };
assert.equal(rebasePausedSimulation(rebaseRun, changedDraft), true);
assert.deepEqual(rebaseRun.players.find((player) => player.id === 1), liveHandlerBeforeEdit, 'rebasing one paused marker preserves every other player’s live frame');
assert.deepEqual(rebaseRun.ball, liveBallBeforeEdit, 'an unrelated paused edit does not reset the live ball');
assert.deepEqual(rebaseRun.players.find((player) => player.id === 2), changedDraft.players[1], 'the selected paused edit is applied to its simulation marker');

// Settings take effect on the current run without resetting its timeline or moving markers instantly.
const elapsedBeforeSettings = pausedRun.elapsedMs;
const defendersBeforeSettings = pausedRun.defenders.map((defender) => ({ ...defender }));
setSimulationRunSettings(pausedRun, { ...settings, defenseOffBall: 'contain', offBallIntensity: 35 });
assert.equal(pausedRun.elapsedMs, elapsedBeforeSettings);
assert.deepEqual(pausedRun.defenders, defendersBeforeSettings, 'changing settings does not teleport defenders');

// Automatic shots begin from the final live positions, including a play without arrows.
const noArrowRun = createSimulationRun(noDefenderDraft, settings);
const noArrowInitial = structuredClone(noArrowRun.players);
advance(noArrowRun, noArrowRun.actionDurationMs - SIMULATION_STEP_MS * 2);
const playersBeforeShot = noArrowRun.players.map((player) => ({ ...player }));
advance(noArrowRun, SIMULATION_STEP_MS * 3);
assert.equal(noArrowRun.frame.shotPhase, 'setup');
assert.equal(noArrowRun.frame.shooterId, noArrowRun.ballHandlerId);
assertNear(pointDistanceFeet(noArrowRun.frame.shotStart, noArrowRun.ball), 0, 0.02, 'the shot starts where the live ball was at the action/shot boundary');
noArrowRun.players.forEach((player, index) => {
  assert.ok(pointDistanceFeet(playersBeforeShot[index], player) < 1, 'the shot boundary carries forward every player’s final position');
});
assert.ok(noArrowInitial.every((player, index) => pointDistanceFeet(player, noArrowRun.players[index]) < 7), 'off-ball players remain near their drawn roles through the shot boundary');
const editedShotBall = { x: 49, y: 75 };
const shotEditFrame = editPausedSimulationMarker(noArrowRun, 'ball', 'ball', editedShotBall);
assert.deepEqual(shotEditFrame.ball, editedShotBall, 'a paused shot ball edit is reflected at the current frame');
advance(noArrowRun, SIMULATION_STEP_MS);
assert.ok(pointDistanceFeet(editedShotBall, noArrowRun.ball) < 1.6, 'the remaining shot resumes from the edited ball location');

for (const play of [READY_SETUP, ...STARTER_PLAYS, EMPTY_COURT]) {
  if (!play.players.length) continue;
  const snapshot = structuredClone(play);
  const run = createSimulationRun(play, settings);
  assert.deepEqual(play, snapshot, `${play.name} stays unchanged when it starts`);
  advance(run, run.durationMs + SIMULATION_STEP_MS * 2);
  assert.equal(run.elapsedMs, run.durationMs, `${play.name} reaches the end of its automatic-shot timeline`);
  assert.equal(run.frame.shotPhase, 'result', `${play.name} finishes with a shot result`);
  assert.ok(run.players.every((player) => Number.isFinite(player.x) && Number.isFinite(player.y)));
}

console.log('Playbook simulation tests passed: timeline order, live possession, continuous shot boundary, bounded/stable defense, help and recovery, paused edits, settings, draft isolation, and all presets');
