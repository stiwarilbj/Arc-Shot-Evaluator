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

const settings = { offenseOffBall: 'read-react', defenseStrategy: 'help', offBallIntensity: 70, automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };
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

function advance(run, milliseconds, runSettings = run.settings) {
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
const pausedRun = createSimulationRun(pausedDraft, { ...settings, defenseStrategy: 'off' });
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
const rebaseRun = createSimulationRun(rebaseDraft, { ...settings, defenseStrategy: 'off' });
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
setSimulationRunSettings(pausedRun, { ...settings, defenseStrategy: 'contain', offBallIntensity: 35 });
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



// Manual off-ball screens bind to their chosen screener and cutter, move both without transferring possession, and stay out of the saved draft.
const offBallDraft = makeDraft({
  players: [[50, 76], [37, 64], [26, 59]],
  ball: [50, 76],
  arrows: [{ id: 'manual-offball', kind: 'off-ball-screen', screener_id: 2, cutter_id: 3, start: { x: 37, y: 64 }, end: { x: 31, y: 58 }, sequence: 1, timing: 1.2 }],
});
const offBallSnapshot = structuredClone(offBallDraft);
const offBallRun = createSimulationRun(offBallDraft, settings);
const manualOffBall = offBallRun.actions[0];
assert.equal(manualOffBall.actorId, 2);
assert.equal(manualOffBall.recipientId, 3);
advance(offBallRun, 650);
assert.ok(pointDistanceFeet(offBallRun.players.find((player) => player.id === 2), offBallSnapshot.players[1]) > 0.3, 'the selected screener moves to the screen spot');
assert.ok(pointDistanceFeet(offBallRun.players.find((player) => player.id === 3), offBallSnapshot.players[2]) > 0.3, 'the selected cutter runs around the screen');
assert.equal(offBallRun.ballHandlerId, 1, 'an off-ball screen keeps possession with the handler');
assert.deepEqual(offBallDraft, offBallSnapshot, 'simulation actions do not mutate the saved draft');

// Screen coverages use the live screen location and keep distinct assignments except for Switch screens.
const coverageDraft = makeDraft({
  players: [[50, 76], [37, 64], [26, 59]],
  ball: [50, 76],
  defenders: [[50, 73], [37, 61], [26, 56]],
  arrows: [{ id: 'coverage-screen', kind: 'screen', screener_id: 2, start: { x: 37, y: 64 }, end: { x: 43, y: 69 }, sequence: 1, timing: 1.2 }],
});
const switchRun = createSimulationRun(coverageDraft, { ...settings, defenseStrategy: 'switch' });
const switchBaseline = new Map(switchRun.initialAssignments);
advance(switchRun, SIMULATION_STEP_MS);
const handlerDefender = switchRun.defenders.find((defender) => switchBaseline.get(defender.id) === 1);
const screenerDefender = switchRun.defenders.find((defender) => switchBaseline.get(defender.id) === 2);
assert.equal(switchRun.assignments.get(handlerDefender.id), 2, 'Switch screens exchanges the handler and screener matchups at screen start');
assert.equal(switchRun.assignments.get(screenerDefender.id), 1, 'both defenders receive the new matchup');

const runCoverage = (defenseStrategy) => {
  const run = createSimulationRun(coverageDraft, { ...settings, defenseStrategy });
  const before = run.defenders.map((defender) => ({ ...defender }));
  advance(run, 650);
  return { run, before, byAssignment: (playerId) => {
    const defenderId = [...run.assignments].find(([, assigned]) => assigned === playerId)?.[0];
    return run.defenders.find((defender) => defender.id === defenderId);
  } };
};
const overRun = runCoverage('fight-over');
const underRun = runCoverage('go-under');
assert.ok(pointDistanceFeet(overRun.byAssignment(1), underRun.byAssignment(1)) > 0.4, 'fight-over and go-under send the screened defender around different sides of the screen');
const dropRun = runCoverage('drop');
const hedgeRun = runCoverage('hedge');
assert.ok(pointDistanceFeet(dropRun.byAssignment(2), hedgeRun.byAssignment(2)) > 0.2, 'drop and hedge produce distinct screener-defender reactions');
const helpCoverageRun = runCoverage('help');
const denyRun = runCoverage('deny-lanes');
const paintRun = runCoverage('protect-paint');
assert.ok(pointDistanceFeet(helpCoverageRun.byAssignment(3), denyRun.byAssignment(3)) > 0.2, 'denial changes the weak-side defender position toward the passing lane');
assert.ok(pointDistanceFeet(helpCoverageRun.byAssignment(3), paintRun.byAssignment(3)) > 0.2, 'paint protection sinks weak-side defenders toward the basket');

const offBallSwitchRun = createSimulationRun(offBallDraft, { ...settings, defenseStrategy: 'switch' });
const offBallBaseline = new Map(offBallSwitchRun.initialAssignments);
advance(offBallSwitchRun, SIMULATION_STEP_MS);
const cutterDefender = offBallSwitchRun.defenders.find((defender) => offBallBaseline.get(defender.id) === 3);
assert.equal(offBallSwitchRun.assignments.get(cutterDefender.id), 2, 'Switch screens exchanges matchups on a drawn off-ball screen');

const missingDefenderDraft = { ...coverageDraft, defenders: coverageDraft.defenders.slice(0, 1) };
const missingDefenderRun = createSimulationRun(missingDefenderDraft, { ...settings, defenseStrategy: 'switch' });
const missingBaseline = new Map(missingDefenderRun.assignments);
advance(missingDefenderRun, SIMULATION_STEP_MS);
assert.equal(missingDefenderRun.defenders.length, 1);
assert.deepEqual(missingDefenderRun.assignments, missingBaseline, 'a screen does not create a partial switch when one matchup defender is missing');

// Handoffs switch at their boundary; leaving Switch restores original matchups without moving defenders instantly.
const switchingHandoffDraft = makeDraft({
  players: [[50, 70], [59, 70], [20, 36]],
  ball: [50, 70],
  defenders: [[50, 67], [59, 67], [20, 33]],
  arrows: [{ id: 'switch-handoff', kind: 'handoff', start: { x: 50, y: 70 }, end: { x: 59, y: 70 }, sequence: 1, timing: 1 }],
});
const handoffSwitchRun = createSimulationRun(switchingHandoffDraft, { ...settings, defenseStrategy: 'switch' });
const handoffBaseline = new Map(handoffSwitchRun.initialAssignments);
advance(handoffSwitchRun, SIMULATION_STEP_MS);
const handoffHandlerDefender = handoffSwitchRun.defenders.find((defender) => handoffBaseline.get(defender.id) === 1);
assert.equal(handoffSwitchRun.assignments.get(handoffHandlerDefender.id), 2, 'Switch screens also exchanges matchups when a handoff starts');
const switchedPositions = handoffSwitchRun.defenders.map((defender) => ({ ...defender }));
setSimulationRunSettings(handoffSwitchRun, { ...settings, defenseStrategy: 'help' });
assert.deepEqual(handoffSwitchRun.assignments, handoffBaseline, 'leaving Switch screens restores original matchups');
assert.deepEqual(handoffSwitchRun.defenders, switchedPositions, 'restoring matchups changes targets without teleporting defenders');

// A live change to Switch waits until the next screen boundary, while the current action continues smoothly.
const twoScreenDraft = makeDraft({
  players: [[50, 76], [37, 64], [26, 59]],
  ball: [50, 76],
  defenders: [[50, 73], [37, 61], [26, 56]],
  arrows: [
    { id: 'first-screen', kind: 'screen', screener_id: 2, start: { x: 37, y: 64 }, end: { x: 43, y: 69 }, sequence: 1, timing: 0.7 },
    { id: 'second-screen', kind: 'screen', screener_id: 3, start: { x: 26, y: 59 }, end: { x: 42, y: 67 }, sequence: 2, timing: 0.7 },
  ],
});
const liveSwitchRun = createSimulationRun(twoScreenDraft, settings);
advance(liveSwitchRun, SIMULATION_STEP_MS * 3);
const baselineAssignments = new Map(liveSwitchRun.initialAssignments);
const livePositionsBeforeToggle = liveSwitchRun.defenders.map((defender) => ({ ...defender }));
setSimulationRunSettings(liveSwitchRun, { ...settings, defenseStrategy: 'switch' });
assert.deepEqual(liveSwitchRun.assignments, baselineAssignments, 'enabling Switch screens mid-action does not swap the active matchup');
assert.deepEqual(liveSwitchRun.defenders, livePositionsBeforeToggle, 'changing strategy mid-action preserves defender positions');
const secondScreenStart = liveSwitchRun.actions.find((action) => action.arrow.id === 'second-screen').startTime;
advance(liveSwitchRun, secondScreenStart - liveSwitchRun.elapsedMs + SIMULATION_STEP_MS);
const defenderOnScreener = liveSwitchRun.defenders.find((defender) => baselineAssignments.get(defender.id) === 3);
assert.equal(liveSwitchRun.assignments.get(defenderOnScreener.id), 1, 'the next screen uses the newly selected switching strategy');

// Auto controls are independent. Contextual events are added only when enabled and only to the simulation timeline.
const autoSettings = (overrides) => ({ ...settings, automaticActions: { ...settings.automaticActions, ...overrides } });
const autoHandoffDraft = makeDraft({
  players: [[50, 70], [59, 70], [18, 31]],
  ball: [50, 70],
  defenders: [[50, 64], [89, 89], [10, 90]],
});
const handoffOffRun = createSimulationRun(autoHandoffDraft, autoSettings({ screen: false, handoff: false, pickRoll: false, offBallScreen: false }));
assert.equal(handoffOffRun.actions.some((action) => action.automatic), false, 'disabled controls do not create automatic actions');
const handoffRun = createSimulationRun(autoHandoffDraft, autoSettings({ handoff: true }));
assert.ok(handoffRun.actions.some((action) => action.automatic && action.arrow.kind === 'handoff'), 'a pressured handler with an open nearby receiver triggers an automatic handoff');
assert.equal(handoffRun.source.arrows.length, 0, 'automatic actions never enter the source diagram');
const handoffEnd = handoffRun.actions.find((action) => action.arrow.kind === 'handoff' && action.automatic).startTime + handoffRun.actions.find((action) => action.arrow.kind === 'handoff' && action.automatic).durationMs;
advance(handoffRun, handoffEnd + SIMULATION_STEP_MS);
assert.notEqual(handoffRun.ballHandlerId, 1, 'automatic handoffs transfer possession at the end of their action');
const autoHandoffSwitchRun = createSimulationRun(autoHandoffDraft, { ...autoSettings({ handoff: true }), defenseStrategy: 'switch' });
const autoHandoffAction = autoHandoffSwitchRun.actions.find((action) => action.automatic && action.arrow.kind === 'handoff');
const autoHandoffBaseline = new Map(autoHandoffSwitchRun.initialAssignments);
advance(autoHandoffSwitchRun, autoHandoffAction.startTime + SIMULATION_STEP_MS);
const autoHandlerDefender = autoHandoffSwitchRun.defenders.find((defender) => autoHandoffBaseline.get(defender.id) === autoHandoffAction.actorId);
assert.equal(autoHandoffSwitchRun.assignments.get(autoHandlerDefender.id), autoHandoffAction.recipientId, 'Switch screens applies to an automatic handoff');

const autoOffBallDraft = makeDraft({
  players: [[50, 76], [45, 58], [28, 58]],
  ball: [50, 76],
  defenders: [[28, 53], [90, 90], [10, 90]],
});
const autoOffBallRun = createSimulationRun(autoOffBallDraft, autoSettings({ screen: false, handoff: false, pickRoll: false, offBallScreen: true }));
assert.ok(autoOffBallRun.actions.some((action) => action.automatic && action.arrow.kind === 'off-ball-screen'), 'a guarded cutter and free screener trigger an automatic off-ball screen');
const autoOffBallSwitchRun = createSimulationRun(autoOffBallDraft, { ...autoSettings({ screen: false, handoff: false, pickRoll: false, offBallScreen: true }), defenseStrategy: 'switch' });
const autoOffBallAction = autoOffBallSwitchRun.actions.find((action) => action.automatic && action.arrow.kind === 'off-ball-screen');
const autoOffBallBaseline = new Map(autoOffBallSwitchRun.initialAssignments);
advance(autoOffBallSwitchRun, autoOffBallAction.startTime + SIMULATION_STEP_MS);
const autoCutterDefender = autoOffBallSwitchRun.defenders.find((defender) => autoOffBallBaseline.get(defender.id) === autoOffBallAction.recipientId);
assert.equal(autoOffBallSwitchRun.assignments.get(autoCutterDefender.id), autoOffBallAction.actorId, 'Switch screens also exchanges matchups on an automatic off-ball screen');

const autoPickRollDraft = makeDraft({
  players: [[50, 70], [40, 70], [17, 35]],
  ball: [50, 70],
  defenders: [[50, 62], [90, 90], [10, 90]],
});
const autoPickRollRun = createSimulationRun(autoPickRollDraft, autoSettings({ screen: false, handoff: false, pickRoll: true, offBallScreen: false }));
const autoPickRoll = autoPickRollRun.actions.find((action) => action.automatic);
assert.equal(autoPickRoll?.arrow.kind, 'pick-roll', 'an open roll lane and on-ball pressure trigger a pick and roll');
assert.equal(autoPickRoll?.actorId, 2, 'the automatic screener is the player nearest the handler');
assert.equal(autoPickRoll?.partnerId, 1, 'the handler runs the pick and roll while keeping the ball');
assert.ok(autoPickRollRun.frame.activeActionLabel == null, 'temporary action labels appear when the action starts');
advance(autoPickRollRun, autoPickRoll.startTime + SIMULATION_STEP_MS);
assert.match(autoPickRollRun.frame.activeActionLabel ?? '', /Auto pick and roll/);
assert.equal(autoPickRollRun.ballHandlerId, 1, 'a pick and roll keeps possession with the handler');
const autoPickRollSwitchRun = createSimulationRun(autoPickRollDraft, { ...autoSettings({ screen: false, handoff: false, pickRoll: true, offBallScreen: false }), defenseStrategy: 'switch' });
const autoPickRollAction = autoPickRollSwitchRun.actions.find((action) => action.automatic && action.arrow.kind === 'pick-roll');
const autoPickRollBaseline = new Map(autoPickRollSwitchRun.initialAssignments);
advance(autoPickRollSwitchRun, autoPickRollAction.startTime + SIMULATION_STEP_MS);
const autoScreenerDefender = autoPickRollSwitchRun.defenders.find((defender) => autoPickRollBaseline.get(defender.id) === autoPickRollAction.actorId);
assert.equal(autoPickRollSwitchRun.assignments.get(autoScreenerDefender.id), autoPickRollAction.partnerId, 'Switch screens applies to an automatic pick and roll');

const autoScreenRun = createSimulationRun(autoPickRollDraft, autoSettings({ screen: true, handoff: false, pickRoll: false, offBallScreen: false }));
assert.ok(autoScreenRun.actions.some((action) => action.automatic && action.arrow.kind === 'screen'), 'screen toggle creates a screen when the lane does not warrant a roll');
const autoScreenSwitchRun = createSimulationRun(autoPickRollDraft, { ...autoSettings({ screen: true, handoff: false, pickRoll: false, offBallScreen: false }), defenseStrategy: 'switch' });
const autoScreenAction = autoScreenSwitchRun.actions.find((action) => action.automatic && action.arrow.kind === 'screen');
const autoScreenBaseline = new Map(autoScreenSwitchRun.initialAssignments);
advance(autoScreenSwitchRun, autoScreenAction.startTime + SIMULATION_STEP_MS);
const autoScreenScreenerDefender = autoScreenSwitchRun.defenders.find((defender) => autoScreenBaseline.get(defender.id) === autoScreenAction.actorId);
assert.equal(autoScreenSwitchRun.assignments.get(autoScreenScreenerDefender.id), autoScreenAction.partnerId, 'Switch screens applies to an automatic on-ball screen');

const concurrentScreenDraft = makeDraft({
  players: [[50, 76], [75, 76], [28, 58], [20, 53]],
  ball: [50, 76],
  defenders: [[50, 69], [97, 90], [28, 51], [90, 10]],
  arrows: [{ id: 'drawn-screen-first', kind: 'screen', screener_id: 2, start: { x: 75, y: 76 }, end: { x: 57, y: 73 }, sequence: 1, timing: 4 }],
});
const concurrentRun = createSimulationRun(concurrentScreenDraft, { ...autoSettings({ screen: false, handoff: false, pickRoll: false, offBallScreen: true }), defenseStrategy: 'fight-over' });
const concurrentAutoScreen = concurrentRun.actions.find((action) => action.automatic && action.arrow.kind === 'off-ball-screen');
assert.ok(concurrentAutoScreen, 'an automatic off-ball screen can accompany a drawn screen when their players are free');
assert.equal(concurrentAutoScreen.startTime, 0, 'the free automatic screen runs alongside the drawn screen');
assert.ok(![concurrentAutoScreen.actorId, concurrentAutoScreen.recipientId].includes(concurrentRun.actions[0].actorId), 'the automatic action uses different players from the drawn screen');
const concurrentStarts = new Map(concurrentRun.actions.map((action) => [action.arrow.id, action.startTime]));
advance(concurrentRun, 650);
assert.ok(concurrentRun.actions.filter((action) => concurrentStarts.get(action.arrow.id) === 0).length >= 2, 'both independent screens remain active in the simulation timeline');

const manualPriorityDraft = makeDraft({
  players: [[50, 76], [37, 64], [26, 59], [78, 40]],
  ball: [50, 76],
  defenders: [[50, 67], [25, 54], [90, 90], [10, 90]],
  arrows: [{ id: 'authored-move', kind: 'movement', start: { x: 50, y: 76 }, end: { x: 50, y: 70 }, sequence: 1, timing: 1.5 }],
});
const manualPriorityRun = createSimulationRun(manualPriorityDraft, autoSettings({ handoff: true }));
const authoredAction = manualPriorityRun.actions.find((action) => action.arrow.id === 'authored-move');
const laterAutoAction = manualPriorityRun.actions.find((action) => action.automatic && action.arrow.kind !== 'off-ball-screen');
if (laterAutoAction) assert.ok(laterAutoAction.startTime >= authoredAction.startTime + authoredAction.durationMs, 'on-ball auto actions happen after authored actions');
assert.deepEqual(manualPriorityRun.source.arrows, manualPriorityDraft.arrows, 'temporary automatic events leave every authored arrow unchanged');

const manualPickRollDraft = makeDraft({
  players: [[50, 70], [40, 70], [20, 36]],
  ball: [50, 70],
  arrows: [{ id: 'manual-pick-roll', kind: 'pick-roll', screener_id: 2, start: { x: 40, y: 70 }, end: { x: 46, y: 70 }, sequence: 1, timing: 1.3 }],
});
const manualPickRollRun = createSimulationRun(manualPickRollDraft, settings);
const manualPickRollAction = manualPickRollRun.actions[0];
assert.equal(manualPickRollAction.actorId, 2, 'a drawn pick and roll binds the named screener');
assert.equal(manualPickRollAction.partnerId, 1, 'a drawn pick and roll binds the current ball handler as its partner');
advance(manualPickRollRun, manualPickRollAction.durationMs + SIMULATION_STEP_MS);
const manualRoller = manualPickRollRun.players.find((player) => player.id === 2);
assert.ok(pointDistanceFeet(manualRoller, hoop) < pointDistanceFeet(manualPickRollAction.arrow.end, hoop) - 3, 'the drawn screener rolls from the screen location toward the basket');

const noOpportunityDraft = makeDraft({
  players: [[50, 70], [20, 35], [80, 35]],
  ball: [50, 70],
  defenders: [[10, 90], [90, 90], [50, 15]],
});
const noOpportunityRun = createSimulationRun(noOpportunityDraft, autoSettings({ screen: true, handoff: true, pickRoll: true, offBallScreen: true }));
assert.equal(noOpportunityRun.actions.some((action) => action.automatic), false, 'the simulator does not invent an action when no matchup opportunity exists');

console.log('Playbook simulation tests passed: timeline order, live possession, continuous shot boundary, bounded/stable defense, help and recovery, screen coverage, switching, paused edits, settings, draft isolation, and all presets');
