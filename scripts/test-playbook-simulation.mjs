import assert from 'node:assert/strict';
import {
  advanceSimulationRun,
  chooseDefenseScheme,
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
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { courtSvgToPoint, COURT_SCALE, COURT_VIEWBOX, NBA_COURT_GEOMETRY } from '../frontend/src/features/playbook/courtGeometry.ts';

const settings = { offenseOffBall: 'read-react', defenseScheme: 'man-to-man', defenseStrategy: 'help', offBallIntensity: 70, automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };
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

function advanceUntil(run, predicate, maxMilliseconds = 6000, runSettings = run.settings) {
  let elapsed = 0;
  while (!predicate() && elapsed < maxMilliseconds && run.elapsedMs < run.durationMs) {
    advance(run, SIMULATION_STEP_MS, runSettings);
    elapsed += SIMULATION_STEP_MS;
  }
  assert.ok(predicate(), `simulation reaches the expected state within ${maxMilliseconds}ms`);
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

function goalSideAlignment(defender, player) {
  const toFeetX = (COURT_VIEWBOX.width / 100) / COURT_SCALE;
  const toFeetY = (COURT_VIEWBOX.height / 100) / COURT_SCALE;
  const towardHoop = { x: (hoop.x - player.x) * toFeetX, y: (hoop.y - player.y) * toFeetY };
  const towardDefender = { x: (defender.x - player.x) * toFeetX, y: (defender.y - player.y) * toFeetY };
  const denominator = Math.hypot(towardHoop.x, towardHoop.y) * Math.hypot(towardDefender.x, towardDefender.y);
  return denominator > 0 ? (towardHoop.x * towardDefender.x + towardHoop.y * towardDefender.y) / denominator : 0;
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

// Active defenders anticipate drives, slide with lateral movement, and stay goal-side of off-ball cutters.
const containmentDraft = makeDraft({
  players: [[50, 75], [29, 62], [71, 62]],
  ball: [50, 75],
  defenders: [[50, 69], [34, 59], [66, 59]],
  arrows: [{ id: 'containment-drive', kind: 'movement', start: { x: 50, y: 75 }, end: { x: 50, y: 52 }, sequence: 1, timing: 2.4 }],
});
const containmentRun = createSimulationRun(containmentDraft, { ...settings, defenseStrategy: 'contain' });
const containmentGuardId = [...containmentRun.assignments].find(([, playerId]) => playerId === 1)?.[0];
let previousContainmentDefenders = containmentRun.defenders.map((defender) => ({ ...defender }));
for (let frame = 0; frame < 27; frame += 1) {
  advanceSimulationRun(containmentRun, SIMULATION_STEP_MS + 0.001);
  containmentRun.defenders.forEach((defender, index) => {
    assert.ok(pointDistanceFeet(previousContainmentDefenders[index], defender) <= DEFENDER_MAX_SPEED_FT_PER_SECOND * SIMULATION_STEP_MS / 1000 + 0.002, 'predictive positioning respects the per-frame speed limit');
  });
  previousContainmentDefenders = containmentRun.defenders.map((defender) => ({ ...defender }));
}
const containmentHandler = containmentRun.players.find((player) => player.id === 1);
const containmentGuard = containmentRun.defenders.find((defender) => defender.id === containmentGuardId);
assert.ok(goalSideAlignment(containmentGuard, containmentHandler) > 0.8, 'the on-ball defender stays goal-side during a straight drive');
assert.ok(pointDistanceFeet(containmentGuard, containmentHandler) < 7, 'anticipation keeps the on-ball gap compact during a drive');
assert.equal(containmentRun.ballHandlerId, 1, 'defensive containment does not change possession');

const lateralDriveDraft = makeDraft({
  players: [[50, 75], [29, 62], [71, 62]],
  ball: [50, 75],
  defenders: [[50, 69], [34, 59], [66, 59]],
  arrows: [{ id: 'lateral-drive', kind: 'movement', start: { x: 50, y: 75 }, end: { x: 66, y: 68 }, sequence: 1, timing: 2.4 }],
});
const lateralDriveRun = createSimulationRun(lateralDriveDraft, { ...settings, defenseStrategy: 'contain' });
const lateralGuardId = [...lateralDriveRun.assignments].find(([, playerId]) => playerId === 1)?.[0];
const lateralGuardStart = lateralDriveRun.defenders.find((defender) => defender.id === lateralGuardId);
advance(lateralDriveRun, 900);
const lateralHandler = lateralDriveRun.players.find((player) => player.id === 1);
const lateralGuard = lateralDriveRun.defenders.find((defender) => defender.id === lateralGuardId);
assert.ok(goalSideAlignment(lateralGuard, lateralHandler) > 0.65, 'the on-ball defender keeps a goal-side angle on a lateral drive');
assert.ok(Math.abs(lateralGuard.x - lateralGuardStart.x) > 1, 'the defender slides laterally to cut off the changed route');

const cutterDraft = makeDraft({
  players: [[50, 76], [27, 66], [72, 62]],
  ball: [50, 76],
  defenders: [[50, 70], [50, 58], [70, 58]],
  arrows: [{ id: 'basket-cut', kind: 'movement', start: { x: 27, y: 66 }, end: { x: 43, y: 51 }, sequence: 1, timing: 1.8 }],
});
const cutterRun = createSimulationRun(cutterDraft, { ...settings, defenseStrategy: 'contain' });
const cutterDefenderId = [...cutterRun.assignments].find(([, playerId]) => playerId === 2)?.[0];
advance(cutterRun, 900);
const cutter = cutterRun.players.find((player) => player.id === 2);
const cutCoverDefender = cutterRun.defenders.find((defender) => defender.id === cutterDefenderId);
assert.ok(goalSideAlignment(cutCoverDefender, cutter) > 0.65, 'the off-ball defender moves goal-side as the cutter attacks the basket');
assert.ok(pointDistanceFeet(cutCoverDefender, cutter) < 7, 'the off-ball defender closes space on the cut without snapping into place');

const frontQualityDraft = makeDraft({
  players: [[50, 75], [29, 62], [71, 62]],
  ball: [50, 75],
  defenders: [[50, 68], [34, 59], [66, 59]],
});
const trailingQualityDraft = makeDraft({
  players: [[50, 75], [29, 62], [71, 62]],
  ball: [50, 75],
  defenders: [[50, 82], [34, 59], [66, 59]],
});
const frontQuality = createSimulationRun(frontQualityDraft, { ...settings, defenseStrategy: 'contain' }).frame.defensiveQuality;
const trailingQuality = createSimulationRun(trailingQualityDraft, { ...settings, defenseStrategy: 'contain' }).frame.defensiveQuality;
assert.ok(frontQuality > trailingQuality + 10, 'defensive quality rewards goal-side positioning over a similarly close trailing defender');

// Defender spacing follows the guarded player's expected shot at that court location.
for (const [skill, point, defenderPoint] of [
  ['threePoint', [50, 75], [50, 68]],
  ['midrange', [50, 45], [50, 38]],
  ['finishing', [50, 26], [50, 19]],
]) {
  const makeThreatRun = (rating) => {
    const draft = makeDraft({ players: [point, [25, 60], [75, 60]], ball: point, defenders: [defenderPoint, [31, 56], [69, 56]] });
    draft.players[0].ratings = { threePoint: 3, midrange: 3, finishing: 3, [skill]: rating };
    const run = createSimulationRun(draft, { ...settings, defenseStrategy: 'contain' });
    advance(run, 950);
    const defender = run.defenders.find((item) => run.assignments.get(item.id) === 1);
    return pointDistanceFeet(defender, run.players[0]);
  };
  const lowGap = makeThreatRun(1);
  const highGap = makeThreatRun(5);
  assert.ok(lowGap > highGap + 2.5, `${skill} rating changes how much space the defender gives`);
}

// A strong open shooter becomes the adaptive pass target; a rating-1 handler avoids an automatic drive.
const shooterChoiceDraft = makeDraft({ players: [[50, 75], [23, 69], [77, 69]], ball: [50, 75], defenders: [[50, 65], [23, 60], [77, 60]] });
shooterChoiceDraft.players[0].ratings = { threePoint: 3, midrange: 3, finishing: 1 };
shooterChoiceDraft.players[1].ratings = { threePoint: 1, midrange: 3, finishing: 3 };
shooterChoiceDraft.players[2].ratings = { threePoint: 5, midrange: 3, finishing: 3 };
const shooterChoiceRun = createSimulationRun(shooterChoiceDraft, { ...settings, offenseOffBall: 'off', defenseStrategy: 'off' });
advance(shooterChoiceRun, shooterChoiceRun.plannedActionDurationMs);
assert.ok(shooterChoiceRun.actions.some((action) => action.adaptiveReadLabel && action.recipientId === 3), 'adaptive reads pass to the higher-rated open shooter');

// Rating 1 remains a possible last-resort shot, but its quality is capped below a make.
const shotQualityAtRating = (rating, point) => {
  const draft = makeDraft({ players: [point], ball: point });
  draft.players[0].ratings = { threePoint: 3, midrange: 3, finishing: 3, ...rating };
  const run = createSimulationRun(draft, { ...settings, defenseStrategy: 'off' });
  advance(run, run.actionDurationMs);
  return run.frame.shotQuality;
};
const lowThreeQuality = shotQualityAtRating({ threePoint: 1 }, [50, 75]);
const highThreeQuality = shotQualityAtRating({ threePoint: 5 }, [50, 75]);
assert.ok(lowThreeQuality <= 40 && highThreeQuality > lowThreeQuality, 'shooting rating changes shot quality and makes rating 1 a poor last-resort attempt');
const lowFinishQuality = shotQualityAtRating({ finishing: 1 }, [50, 26]);
const highFinishQuality = shotQualityAtRating({ finishing: 5 }, [50, 26]);
assert.ok(lowFinishQuality <= 40 && highFinishQuality > lowFinishQuality, 'finishing rating changes quality near the basket');
const lowMidrangeQuality = shotQualityAtRating({ midrange: 1 }, [50, 45]);
const highMidrangeQuality = shotQualityAtRating({ midrange: 5 }, [50, 45]);
assert.ok(lowMidrangeQuality <= 40 && highMidrangeQuality > lowMidrangeQuality, 'midrange rating changes quality inside the three-point line');

// Free players move toward a strong shooting role and away from a zone rated 1, while Hold positions keeps them still.
const skillSpacingDraft = (threePoint, midrange = 3) => {
  const draft = makeDraft({
    players: [[50, 76], [26, 62], [74, 62], [40, 48], [60, 48]],
    ball: [50, 76],
    defenders: [[5, 5], [95, 5], [5, 95], [95, 95], [50, 95]],
  });
  draft.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
  draft.players[1].ratings = { threePoint, midrange, finishing: 1 };
  return draft;
};
const spacingSettings = { ...settings, defenseStrategy: 'off' };
const baselineSpacingRun = createSimulationRun(skillSpacingDraft(3), spacingSettings);
const strongShooterSpacingRun = createSimulationRun(skillSpacingDraft(5), spacingSettings);
const weakThreeSpacingRun = createSimulationRun(skillSpacingDraft(1, 5), spacingSettings);
advance(baselineSpacingRun, 300);
advance(strongShooterSpacingRun, 300);
advance(weakThreeSpacingRun, 300);
assert.ok(pointDistanceFeet(baselineSpacingRun.players[1], strongShooterSpacingRun.players[1]) > 0.6, 'a high three-point rating changes a free player’s spot');
assert.ok(pointDistanceFeet(weakThreeSpacingRun.players[1], hoop) < pointDistanceFeet(baselineSpacingRun.players[1], hoop), 'a player rated 1 from three shifts toward their better midrange area');
const holdSpacingRun = createSimulationRun(skillSpacingDraft(5), { ...settings, offenseOffBall: 'off' });
advance(holdSpacingRun, 300);
assert.deepEqual(holdSpacingRun.players[1], skillSpacingDraft(5).players[1], 'the off-ball setting can still keep free players in place');

// A clear, high-value three can interrupt a drawn sequence; weak ratings keep ordinary looks in the play.
const earlyShotDraft = makeDraft({
  players: [[50, 63], [18, 68], [82, 68], [34, 54], [66, 54]],
  ball: [50, 63],
  defenders: [[5, 5], [95, 5], [5, 95], [95, 95], [50, 95]],
  arrows: [{ id: 'authored-lift', kind: 'movement', actor_id: 4, start: { x: 34, y: 54 }, end: { x: 35, y: 53 }, sequence: 1, timing: 3 }],
});
earlyShotDraft.players[0].ratings = { threePoint: 5, midrange: 3, finishing: 3 };
const earlyShotSnapshot = structuredClone(earlyShotDraft);
const earlyShotRun = createSimulationRun(earlyShotDraft, { ...settings, defenseStrategy: 'off' });
advance(earlyShotRun, 600);
assert.equal(earlyShotRun.earlyReadInterrupted, true, 'a high-value early shot can end the remaining authored route');
assert.equal(earlyShotRun.adaptiveReadLabel, 'Early shot');
assert.ok(earlyShotRun.frame.shotQuality >= 72 && earlyShotRun.frame.shotPhase !== 'idle');
assert.ok(earlyShotRun.actionDurationMs < earlyShotRun.plannedActionDurationMs, 'the early shot shortens only the simulation timeline');
assert.deepEqual(earlyShotDraft, earlyShotSnapshot, 'an early shot leaves the saved diagram unchanged');
const poorEarlyShotDraft = structuredClone(earlyShotDraft);
poorEarlyShotDraft.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
const poorEarlyShotRun = createSimulationRun(poorEarlyShotDraft, { ...settings, defenseStrategy: 'off' });
advance(poorEarlyShotRun, 600);
assert.equal(poorEarlyShotRun.earlyReadInterrupted, false, 'a rating-1 shot does not interrupt the authored sequence');

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

const helpThreatDraft = makeDraft({
  players: [[50, 75], [25, 61], [75, 61]],
  ball: [50, 75],
  arrows: [{ id: 'help-threat-drive', kind: 'movement', start: { x: 50, y: 75 }, end: { x: 50, y: 54 }, sequence: 1, timing: 1.2 }],
  defenders: [[50, 68], [32, 59], [68, 59]],
});
helpThreatDraft.players[1].ratings = { threePoint: 1, midrange: 3, finishing: 3 };
helpThreatDraft.players[2].ratings = { threePoint: 5, midrange: 3, finishing: 3 };
const helpThreatRun = createSimulationRun(helpThreatDraft, settings);
advance(helpThreatRun, 430);
assert.equal(helpThreatRun.helpDefenderId, [...helpThreatRun.assignments].find(([, playerId]) => playerId === 2)?.[0], 'defense chooses to help from the lower-rated perimeter shooter');

const makeFinishThreatRun = (rating) => {
  const draft = structuredClone(driveDraft);
  draft.players[0].ratings = { threePoint: 3, midrange: 3, finishing: rating };
  const run = createSimulationRun(draft, settings);
  advance(run, 550);
  return run;
};
const lowFinisherRun = makeFinishThreatRun(1);
const highFinisherRun = makeFinishThreatRun(5);
const lowFinisherHelper = lowFinisherRun.defenders.find((defender) => defender.id === lowFinisherRun.helpDefenderId);
const highFinisherHelper = highFinisherRun.defenders.find((defender) => defender.id === highFinisherRun.helpDefenderId);
assert.ok(pointDistanceFeet(highFinisherHelper, hoop) < pointDistanceFeet(lowFinisherHelper, hoop) - 0.5, 'a high-finishing handler draws help defenders deeper toward the basket');

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

// A play without arrows can use live reads before releasing its shot.
const noArrowRun = createSimulationRun(noDefenderDraft, settings);
advance(noArrowRun, noArrowRun.plannedActionDurationMs - noArrowRun.elapsedMs);
assert.equal(noArrowRun.frame.shotPhase, 'idle', 'a useful pass can extend a play before the shot');
assert.equal(noArrowRun.adaptiveReadResolved, true);
advanceUntil(noArrowRun, () => noArrowRun.frame.shotPhase === 'setup');
const playersBeforeShot = noArrowRun.players.map((player) => ({ ...player }));
assertNear(pointDistanceFeet(noArrowRun.frame.shotStart, noArrowRun.ball), 0, 1.5, 'the live ball moves continuously away from the shot start');
advance(noArrowRun, SIMULATION_STEP_MS * 3);
assert.equal(noArrowRun.frame.shotPhase, 'setup');
assert.equal(noArrowRun.frame.shooterId, noArrowRun.ballHandlerId);
noArrowRun.players.forEach((player, index) => {
  assert.ok(pointDistanceFeet(playersBeforeShot[index], player) < 1, 'the shot boundary carries forward every player’s final position');
});
assert.ok(noArrowRun.players.every((player) => player.x >= 0 && player.x <= 100 && player.y >= 0 && player.y <= 100), 'rating-aware spacing and live reads keep players inside the court');
const editedShotBall = { x: 49, y: 75 };
const shotEditFrame = editPausedSimulationMarker(noArrowRun, 'ball', 'ball', editedShotBall);
assert.deepEqual(shotEditFrame.ball, editedShotBall, 'a paused shot ball edit is reflected at the current frame');
advance(noArrowRun, SIMULATION_STEP_MS);
assert.ok(pointDistanceFeet(editedShotBall, noArrowRun.ball) < 1.6, 'the remaining shot resumes from the edited ball location');

assert.deepEqual(STARTER_PLAYS.map((play) => play.name), [
  'Pick and roll', 'Give and go', 'Drive and kick', 'Horns', 'Flex', 'Pick and pop',
  'Inverted pick and roll', 'Spain pick and roll', 'Floppy', '5-out motion', 'Horns twist',
  'UCLA cut', 'Princeton backdoor', 'Pistol', 'Chicago', 'Elevator',
  '1-4 high', '4-out 1-in', '3-out 2-in', 'Shuffle', 'Triangle', 'Zipper', 'Box', 'High-low',
], 'the starter library includes all twenty-four plays');
const spainStarter = STARTER_PLAYS.find((play) => play.name === 'Spain pick and roll');
assert.deepEqual(spainStarter.arrows.filter((item) => ['screen', 'pick-roll', 'pick-pop', 'off-ball-screen'].includes(item.kind)).map((item) => item.sequence), [1, 2], 'the Spain back screen follows the initial ball screen');
for (const play of [READY_SETUP, ...STARTER_PLAYS, EMPTY_COURT]) {
  if (!play.players.length) continue;
  const snapshot = structuredClone(play);
  const run = createSimulationRun(play, settings);
  assert.deepEqual(play, snapshot, `${play.name} stays unchanged when it starts`);
  advance(run, run.durationMs + 4000);
  assert.equal(run.elapsedMs, run.durationMs, `${play.name} reaches the end of its automatic-shot timeline`);
  assert.equal(run.frame.shotPhase, 'result', `${play.name} finishes with a shot result`);
  assert.equal(run.adaptiveReadResolved, true, `${play.name} resolves its read from live defender positions`);
  assert.ok(run.adaptiveReadLabel && run.adaptiveReadReason, `${play.name} explains its selected read or fallback`);
  assert.ok(run.adaptiveActionsTaken <= 3, `${play.name} stays within the three live-action limit`);
  if (run.adaptiveContinuationStartedAtMs != null) {
    assert.ok(run.actionDurationMs - run.adaptiveContinuationStartedAtMs <= 4000 + SIMULATION_STEP_MS, `${play.name} keeps live actions inside the four-second window`);
  }
  assert.ok(run.players.every((player) => Number.isFinite(player.x) && Number.isFinite(player.y)));
}

// Adaptive reads inspect the completed action state, preserve the authored
// diagram, and add a temporary route before the shot.
const openRollReadDraft = makeDraft({
  players: [[50, 76], [56, 68], [25, 33]],
  ball: [50, 76],
  defenders: [[8, 8], [91, 8], [8, 91]],
  arrows: [{ id: 'read-roll-screen', kind: 'pick-roll', screener_id: 2, handler_id: 1, start: { x: 56, y: 68 }, end: { x: 53, y: 66 }, sequence: 1, timing: 1.2 }],
});
const openRollSnapshot = structuredClone(openRollReadDraft);
const openRollRun = createSimulationRun(openRollReadDraft, { ...settings, defenseStrategy: 'off' });
advance(openRollRun, openRollRun.plannedActionDurationMs);
assert.equal(openRollRun.adaptiveReadResolved, true, 'the read is evaluated after the drawn and automatic actions end');
assert.equal(openRollRun.actions.at(-1).arrow.kind, 'pass', 'an open roller receives the adaptive continuation');
assert.equal(openRollRun.actions.at(-1).recipientId, 2, 'the open roll recipient is identified from the screen action');
assert.match(openRollRun.adaptiveReadLabel, /roller/i);
assert.match(openRollRun.adaptiveReadReason, /clear passing lane/i);
assert.equal(openRollRun.frame.shotPhase, 'idle', 'a read continuation delays the shot until its route finishes');
assert.equal(openRollRun.frame.adaptiveReadRoute.kind, 'pass', 'the live frame exposes the temporary pass route');
const initialOpenRollReadLabel = openRollRun.adaptiveReadLabel;
const initialOpenRollReadRoute = structuredClone(openRollRun.adaptiveReadRoute);
assert.deepEqual(openRollReadDraft, openRollSnapshot, 'adaptive actions never enter the saved diagram');
advance(openRollRun, openRollRun.actions.at(-1).durationMs + SIMULATION_STEP_MS);
assert.equal(openRollRun.ballHandlerId, 2, 'an adaptive pass transfers possession at its completion boundary');
assert.equal(openRollRun.frame.shotPhase, 'idle', 'the offense reevaluates its next option after the catch');
advanceUntil(openRollRun, () => openRollRun.frame.shotPhase === 'setup');
assert.equal(openRollRun.frame.shotPhase, 'setup', 'the shot starts after the adaptive pass arrives');

// A pass chosen for a high-rated open shooter is re-evaluated after the defense closes out.
const earlyCloseoutDraft = makeDraft({
  players: [[50, 75], [50, 63], [18, 63], [82, 63], [30, 50]],
  ball: [50, 75],
  defenders: [[90, 63], [5, 5], [95, 5], [5, 95], [95, 95]],
  arrows: [{ id: 'closeout-lift', kind: 'movement', actor_id: 4, start: { x: 82, y: 63 }, end: { x: 83, y: 62 }, sequence: 1, timing: 3 }],
});
earlyCloseoutDraft.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
earlyCloseoutDraft.players[1].ratings = { threePoint: 5, midrange: 3, finishing: 3 };
const closeoutSettings = { ...settings, offenseOffBall: 'off', defenseStrategy: 'contain' };
const closeoutRun = createSimulationRun(earlyCloseoutDraft, closeoutSettings);
const initialShooterGap = Math.min(...closeoutRun.defenders.map((defender) => pointDistanceFeet(defender, closeoutRun.players[1])));
advance(closeoutRun, 600);
assert.match(closeoutRun.adaptiveReadLabel ?? '', /early read/i);
assert.equal(closeoutRun.actions.at(-1).arrow.kind, 'pass', 'the first read sends the ball to the high-rated shooter');
assert.equal(closeoutRun.actions.at(-1).recipientId, 2);
advanceUntil(closeoutRun, () => closeoutRun.ballHandlerId === 2);
assert.ok(Math.min(...closeoutRun.defenders.map((defender) => pointDistanceFeet(defender, closeoutRun.players[1]))) < initialShooterGap, 'the defender closes toward the receiver during the pass');
advanceUntil(closeoutRun, () => closeoutRun.frame.shotPhase === 'setup');
assert.notEqual(closeoutRun.adaptiveReadLabel, 'Early shot', 'a shot that lost its clear advantage is re-evaluated after the catch');
assert.ok(closeoutRun.frame.shotQuality < 72, 'the closeout lowers the live shot quality below the early-shot gate');

const openLaneReadDraft = makeDraft({
  players: [[50, 70], [24, 55]],
  ball: [50, 70],
  defenders: [[8, 8], [24, 55]],
});
const openLaneRun = createSimulationRun(openLaneReadDraft, { ...settings, defenseStrategy: 'off' });
advance(openLaneRun, openLaneRun.plannedActionDurationMs);
assert.equal(openLaneRun.actions.at(-1).arrow.kind, 'movement', 'a clear lane triggers a drive when no special receiver is available');
assert.equal(openLaneRun.actions.at(-1).actorId, 1, 'the current handler owns the adaptive drive');
assert.match(openLaneRun.adaptiveReadLabel, /open lane/i);
const adaptiveDrive = openLaneRun.actions.at(-1);
let previousAdaptiveHandler = { ...openLaneRun.players.find((player) => player.id === 1) };
while (openLaneRun.elapsedMs < openLaneRun.actionDurationMs - 0.001) {
  advance(openLaneRun, SIMULATION_STEP_MS);
  const currentHandler = openLaneRun.players.find((player) => player.id === 1);
  assert.ok(pointDistanceFeet(previousAdaptiveHandler, currentHandler) <= 19 * SIMULATION_STEP_MS / 1000 + 0.002, 'the adaptive drive obeys the existing offensive speed limit');
  previousAdaptiveHandler = { ...currentHandler };
}
assert.ok(pointDistanceFeet(previousAdaptiveHandler, adaptiveDrive.arrow.end) < pointDistanceFeet(openLaneReadDraft.players[0], adaptiveDrive.arrow.end), 'the handler advances along the drive before taking the newly opened shot');

const perimeterPassDraft = makeDraft({
  players: [[50, 76], [25, 59], [81, 56]],
  ball: [50, 76],
  defenders: [[50, 56], [81, 57], [9, 9]],
});
const perimeterPassRun = createSimulationRun(perimeterPassDraft, { ...settings, defenseStrategy: 'off' });
advance(perimeterPassRun, perimeterPassRun.plannedActionDurationMs);
assert.equal(perimeterPassRun.actions.at(-1).arrow.kind, 'pass', 'a clear perimeter teammate is the next read when the drive lane is covered');
assert.equal(perimeterPassRun.actions.at(-1).recipientId, 2, 'the read chooses the open passing lane over the guarded wing');
assert.match(perimeterPassRun.adaptiveReadLabel, /kick/i);

const spacedReadDraft = makeDraft({
  players: [[70, 75], [25, 25], [25.5, 25], [10, 55]],
  ball: [70, 75],
  defenders: [[69, 68], [8, 8], [90, 90]],
});
const spacedReadRun = createSimulationRun(spacedReadDraft, { ...settings, defenseStrategy: 'off' });
advance(spacedReadRun, spacedReadRun.plannedActionDurationMs);
assert.equal(spacedReadRun.actions.at(-1)?.recipientId, 4, 'a receiver crowded by a teammate is skipped in favor of a spaced perimeter option');
assert.match(spacedReadRun.adaptiveReadReason, /good floor spacing/i);

const coveredReadDraft = makeDraft({
  players: [[50, 76], [25, 70]],
  ball: [50, 76],
  defenders: [[50, 57], [25, 70]],
});
const coveredReadRun = createSimulationRun(coveredReadDraft, { ...settings, defenseStrategy: 'off' });
advance(coveredReadRun, coveredReadRun.plannedActionDurationMs);
assert.equal(coveredReadRun.actions.length, 0, 'the read engine does not force a continuation through covered routes');
assert.equal(coveredReadRun.adaptiveReadRoute, null, 'a shot fallback does not show a false route');
assert.equal(coveredReadRun.adaptiveReadLabel, 'No safe continuation');
assert.match(coveredReadRun.adaptiveReadReason, /takes the shot/i);

const repeatReadRun = createSimulationRun(structuredClone(openRollReadDraft), { ...settings, defenseStrategy: 'off' });
advance(repeatReadRun, repeatReadRun.plannedActionDurationMs);
assert.equal(repeatReadRun.adaptiveReadLabel, initialOpenRollReadLabel, 'identical live reads resolve deterministically');
assert.deepEqual(repeatReadRun.adaptiveReadRoute, initialOpenRollReadRoute, 'identical runs select the same temporary route');



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

// Pick and pop records both participants and its pop route, retains possession,
// and sends a switching defense through the named screen matchup.
const pickPopDraft = makeDraft({
  players: [[50, 76], [60, 68], [27, 57]],
  ball: [50, 76],
  defenders: [[50, 70], [61, 63], [28, 52]],
  arrows: [{ id: 'pick-pop', kind: 'pick-pop', screener_id: 2, handler_id: 1, start: { x: 60, y: 68 }, end: { x: 55, y: 69 }, exit_target: { x: 70, y: 57 }, sequence: 1, timing: 1.5 }],
});
const pickPopRun = createSimulationRun(pickPopDraft, { ...settings, defenseStrategy: 'switch' });
const pickPopAction = pickPopRun.actions[0];
const pickPopAssignments = new Map(pickPopRun.initialAssignments);
assert.equal(pickPopAction.actorId, 2);
assert.equal(pickPopAction.partnerId, 1);
let lastPickPopScreener = { ...pickPopRun.players.find((player) => player.id === 2) };
for (let frame = 0; frame < 42; frame += 1) {
  advance(pickPopRun, SIMULATION_STEP_MS);
  const screener = pickPopRun.players.find((player) => player.id === 2);
  assert.ok(pointDistanceFeet(lastPickPopScreener, screener) <= 19 * SIMULATION_STEP_MS / 1000 + 0.002, 'the pop route stays within the offensive movement limit');
  lastPickPopScreener = { ...screener };
}
assert.ok(pointDistanceFeet(lastPickPopScreener, pickPopDraft.arrows[0].exit_target) < pointDistanceFeet(pickPopDraft.players[1], pickPopDraft.arrows[0].exit_target), 'the screener moves through the screen spot toward the pop destination');
assert.equal(pickPopRun.ballHandlerId, 1, 'pick and pop keeps possession with the current handler');
assert.equal(pickPopRun.assignments.get([...pickPopAssignments].find(([, playerId]) => playerId === 1)[0]), 2, 'switching applies to the pick-and-pop screen participants');

// A pin-down uses its cutter destination while a backdoor cut follows the
// selected player's authored route; neither action transfers possession.
const pinDownDraft = makeDraft({
  players: [[50, 76], [38, 62], [27, 55]],
  ball: [50, 76],
  arrows: [{ id: 'pin-down', kind: 'pin-down', screener_id: 2, cutter_id: 3, start: { x: 38, y: 62 }, end: { x: 34, y: 58 }, exit_target: { x: 30, y: 49 }, sequence: 1, timing: 1.4 }],
});
const pinDownRun = createSimulationRun(pinDownDraft, settings);
assert.equal(pinDownRun.actions[0].actorId, 2);
assert.equal(pinDownRun.actions[0].recipientId, 3);
advance(pinDownRun, 700);
assert.ok(pointDistanceFeet(pinDownRun.players.find((player) => player.id === 3), pinDownDraft.arrows[0].end) < pointDistanceFeet(pinDownDraft.players[2], pinDownDraft.arrows[0].end), 'the pin-down cutter runs to the screen before turning');
advance(pinDownRun, 600);
assert.ok(pointDistanceFeet(pinDownRun.players.find((player) => player.id === 3), pinDownDraft.arrows[0].exit_target) < pointDistanceFeet(pinDownDraft.players[2], pinDownDraft.arrows[0].exit_target), 'the pin-down cutter continues to the authored destination');
assert.equal(pinDownRun.ballHandlerId, 1);
const pinDownSwitchRun = createSimulationRun(pinDownDraft, { ...settings, defenseStrategy: 'switch' });
const pinDownAssignments = new Map(pinDownSwitchRun.initialAssignments);
advance(pinDownSwitchRun, SIMULATION_STEP_MS);
const pinDownCutterDefender = pinDownSwitchRun.defenders.find((defender) => pinDownAssignments.get(defender.id) === 3);
assert.equal(pinDownSwitchRun.assignments.get(pinDownCutterDefender.id), 2, 'Switch screens exchanges matchups for a pin-down action');
const pinDownCoverage = (defenseStrategy) => {
  const run = createSimulationRun(pinDownDraft, { ...settings, defenseStrategy });
  advance(run, 650);
  const defenderId = [...run.assignments].find(([, playerId]) => playerId === 3)?.[0];
  return run.defenders.find((defender) => defender.id === defenderId);
};
assert.ok(pointDistanceFeet(pinDownCoverage('fight-over'), pinDownCoverage('help')) > 0.2, 'a pin-down uses the selected screen coverage');
const backdoorTarget = { x: 49, y: 22 };
const backdoorDraft = makeDraft({
  players: [[50, 76], [35, 55]],
  ball: [50, 76],
  arrows: [{ id: 'backdoor', kind: 'backdoor-cut', actor_id: 2, start: { x: 35, y: 55 }, end: backdoorTarget, sequence: 1, timing: 1.2 }],
});
const backdoorRun = createSimulationRun(backdoorDraft, settings);
assert.equal(backdoorRun.actions[0].actorId, 2);
advance(backdoorRun, 700);
assert.ok(pointDistanceFeet(backdoorRun.players.find((player) => player.id === 2), backdoorTarget) < pointDistanceFeet(backdoorDraft.players[1], backdoorTarget), 'the backdoor cutter follows the selected basket route');
assert.equal(backdoorRun.ballHandlerId, 1);

// Equal move numbers begin together. The first drawn route wins for a player,
// while a simultaneous screen still applies defense and coverage to that cutter.
const sharedOrderDraft = makeDraft({
  players: [[50, 76], [37, 64], [26, 59], [75, 42]],
  ball: [50, 76],
  defenders: [[50, 71], [37, 60], [26, 55], [75, 38]],
  arrows: [
    { id: 'cutter-route', kind: 'movement', start: { x: 26, y: 59 }, end: { x: 42, y: 46 }, sequence: 1, timing: 1.5 },
    { id: 'screen-for-route', kind: 'off-ball-screen', start: { x: 37, y: 64 }, end: { x: 32, y: 60 }, screener_id: 2, cutter_id: 3, sequence: 1, timing: 1.5 },
    { id: 'losing-route', kind: 'movement', start: { x: 26, y: 59 }, end: { x: 10, y: 48 }, sequence: 1, timing: 1.5 },
  ],
});
const sharedOrderRun = createSimulationRun(sharedOrderDraft, { ...settings, defenseStrategy: 'switch' });
assert.ok(sharedOrderRun.actions.every((action) => action.startTime === 0), 'all actions with the same sequence share a start time');
const sharedBaseline = new Map(sharedOrderRun.initialAssignments);
advance(sharedOrderRun, SIMULATION_STEP_MS);
assert.equal(sharedOrderRun.assignments.get([...sharedBaseline].find(([, playerId]) => playerId === 3)[0]), 2, 'the screen switches coverage even while its cutter follows a separate drawn route');
advance(sharedOrderRun, 450);
const routeCutter = sharedOrderRun.players.find((player) => player.id === 3);
assert.ok(routeCutter.x > sharedOrderDraft.players[2].x, 'diagram order gives the first conflicting route control of the player');
assert.ok(routeCutter.y < sharedOrderDraft.players[2].y, 'the first route continues toward its own destination');

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

// Defensive schemes select once per run, retain stable zone roles, and preserve motion limits.
assert.equal(DEFAULT_SIMULATION_SETTINGS.defenseScheme, 'auto', 'new Playbook sessions use Auto defense schemes by default');
const schemeNames = ['man-to-man', 'pack-line', 'zone-2-3', 'zone-3-2', 'zone-1-3-1', 'zone-2-1-2', 'zone-1-2-2', 'matchup-1-1-3', 'box-and-one', 'triangle-and-two'];
const autoPicks = schemeNames.map((_, index) => chooseDefenseScheme('auto', 5, 5, () => index / schemeNames.length).scheme);
assert.deepEqual(autoPicks, schemeNames, 'Auto gives every eligible scheme the same random interval');
assert.equal(chooseDefenseScheme('auto', 4, 5, () => 0.2).scheme, 'man-to-man', 'Auto with fewer than five defenders considers only man schemes');
assert.equal(chooseDefenseScheme('auto', 4, 5, () => 0.8).scheme, 'pack-line', 'both man schemes remain reachable in Auto with fewer than five defenders');
const invalidScheme = chooseDefenseScheme('zone-2-3', 4, 5);
assert.equal(invalidScheme.scheme, 'man-to-man');
assert.match(invalidScheme.notice, /needs five defenders/);
assert.equal(chooseDefenseScheme('triangle-and-two', 5, 1).scheme, 'man-to-man', 'triangle-and-two requires two offensive threats to mark');

const schemeDraft = makeDraft({
  players: [[50, 76], [22, 68], [78, 68], [34, 56], [66, 56]],
  ball: [50, 76],
  defenders: [[48, 72], [28, 64], [72, 64], [39, 59], [61, 59]],
});
const schemeSettings = { ...settings, offenseOffBall: 'off', defenseStrategy: 'contain' };
const zoneSchemes = ['zone-2-3', 'zone-3-2', 'zone-1-3-1', 'zone-2-1-2', 'zone-1-2-2', 'matchup-1-1-3', 'box-and-one', 'triangle-and-two'];
const zoneRuns = zoneSchemes.map((defenseScheme) => {
  const run = createSimulationRun(schemeDraft, { ...schemeSettings, defenseScheme });
  assert.equal(run.activeDefenseScheme, defenseScheme, `${defenseScheme} is selected for the run`);
  assert.equal(run.defenseSchemeWasAutomatic, false, 'manual scheme choice is shown as a fixed selection');
  assert.equal(run.frame.activeDefenseScheme, defenseScheme, 'the active scheme is exposed in playback frames');
  assert.equal(run.zoneAssignments.size + run.zoneChaserAssignments.size, 5, `${defenseScheme} gives every defender a zone or chaser role`);
  assert.deepEqual(run.assignments, run.initialAssignments, 'zone setup preserves the original matchup map');
  let previous = run.defenders.map((defender) => ({ ...defender }));
  let moved = 0;
  for (let frame = 0; frame < 21; frame += 1) {
    advance(run, SIMULATION_STEP_MS);
    run.defenders.forEach((defender, index) => {
      const distance = pointDistanceFeet(previous[index], defender);
      assert.ok(distance <= DEFENDER_MAX_SPEED_FT_PER_SECOND * SIMULATION_STEP_MS / 1000 + 0.002, `${defenseScheme} respects the defender speed limit`);
      moved += distance;
    });
    previous = run.defenders.map((defender) => ({ ...defender }));
  }
  assert.ok(moved > 0.1, `${defenseScheme} defenders slide toward their ball-side and area responsibilities`);
  return run;
});
const zone2Positions = zoneRuns[0].defenders;
zoneRuns.slice(1, 6).forEach((run) => {
  const separation = run.defenders.reduce((total, defender, index) => total + pointDistanceFeet(defender, zone2Positions[index]), 0);
  assert.ok(separation > 0.5, `${run.activeDefenseScheme} has a distinct formation from the 2–3 zone`);
});

const ratedSchemeDraft = structuredClone(schemeDraft);
for (const player of ratedSchemeDraft.players) player.ratings = { threePoint: 3, midrange: 3, finishing: 3 };
ratedSchemeDraft.players.find((player) => player.id === 2).ratings = { threePoint: 5, midrange: 5, finishing: 5 };
ratedSchemeDraft.players.find((player) => player.id === 4).ratings = { threePoint: 5, midrange: 5, finishing: 5 };
const boxRun = createSimulationRun(ratedSchemeDraft, { ...schemeSettings, defenseScheme: 'box-and-one' });
assert.deepEqual([...boxRun.zoneChaserAssignments.values()], [2], 'Box-and-one assigns its chaser to the highest-rated threat, with player ID as the tie break');
assert.equal(boxRun.zoneAssignments.size, 4, 'four Box-and-one defenders retain zone slots');
const triangleRun = createSimulationRun(ratedSchemeDraft, { ...schemeSettings, defenseScheme: 'triangle-and-two' });
assert.deepEqual([...triangleRun.zoneChaserAssignments.values()], [2, 4], 'Triangle-and-two assigns its chasers to the two highest-rated threats in ID order');
assert.equal(triangleRun.zoneAssignments.size, 3, 'three Triangle-and-two defenders retain triangle slots');

const shortZoneRun = createSimulationRun({ ...schemeDraft, defenders: schemeDraft.defenders.slice(0, 4) }, { ...schemeSettings, defenseScheme: 'zone-3-2' });
assert.equal(shortZoneRun.activeDefenseScheme, 'man-to-man', 'manual five-defender schemes fall back when defenders are missing');
assert.match(shortZoneRun.frame.defenseSchemeNotice ?? '', /needs five defenders/);
const autoShortRun = createSimulationRun({ ...schemeDraft, defenders: schemeDraft.defenders.slice(0, 4) }, { ...schemeSettings, defenseScheme: 'auto' });
assert.ok(['man-to-man', 'pack-line'].includes(autoShortRun.activeDefenseScheme), 'Auto excludes formations that cannot fill their five roles');

const fixedAutoRun = createSimulationRun(schemeDraft, { ...schemeSettings, defenseScheme: 'auto' });
const firstAutoPick = fixedAutoRun.activeDefenseScheme;
assert.equal(fixedAutoRun.defenseSchemeWasAutomatic, true, 'playback identifies a randomized scheme selection');
setSimulationRunSettings(fixedAutoRun, { ...schemeSettings, defenseScheme: 'zone-3-2' });
advance(fixedAutoRun, SIMULATION_STEP_MS * 3);
assert.equal(fixedAutoRun.activeDefenseScheme, firstAutoPick, 'Auto selects once and keeps the same scheme through the possession');
assert.equal(fixedAutoRun.frame.activeDefenseScheme, firstAutoPick, 'the displayed scheme remains the original Auto selection for the whole run');

const zoneScreenRun = createSimulationRun({ ...schemeDraft, arrows: [{ id: 'zone-screen', kind: 'screen', screener_id: 2, start: { x: 22, y: 68 }, end: { x: 45, y: 70 }, sequence: 1, timing: 1.2 }] }, { ...schemeSettings, defenseScheme: 'zone-2-3', defenseStrategy: 'switch' });
const zoneAssignmentsBeforeScreen = new Map(zoneScreenRun.assignments);
advance(zoneScreenRun, SIMULATION_STEP_MS * 4);
assert.deepEqual(zoneScreenRun.assignments, zoneAssignmentsBeforeScreen, 'zone switching handles a screen temporarily without converting the zone into permanent matchups');
assert.equal(zoneScreenRun.frame.activeDefenseScheme, 'zone-2-3', 'the chosen scheme remains fixed while its screen coverage adapts');

const immutableSchemeRun = createSimulationRun(schemeDraft, { ...schemeSettings, defenseScheme: 'zone-2-3' });
setSimulationRunSettings(immutableSchemeRun, { ...schemeSettings, defenseScheme: 'zone-3-2', defenseStrategy: 'fight-over' });
assert.equal(immutableSchemeRun.activeDefenseScheme, 'zone-2-3', 'changing the selected scheme during playback only affects the next run');
const nextSchemeRun = createSimulationRun(schemeDraft, { ...schemeSettings, defenseScheme: 'zone-3-2' });
assert.equal(nextSchemeRun.activeDefenseScheme, 'zone-3-2', 'the next run uses the newly selected scheme');
const holdZoneRun = createSimulationRun(schemeDraft, { ...schemeSettings, defenseScheme: 'zone-2-3', defenseStrategy: 'off' });
const holdZonePositions = holdZoneRun.defenders.map((defender) => ({ ...defender }));
advance(holdZoneRun, 300);
assert.deepEqual(holdZoneRun.defenders, holdZonePositions, 'Hold positions freezes defenders even when a zone scheme is selected');

// Auto controls are independent. Contextual events are added only when enabled and only to the simulation timeline.
const autoSettings = (overrides) => ({ ...settings, automaticActions: { ...settings.automaticActions, ...overrides } });
const autoHandoffDraft = makeDraft({
  players: [[50, 70], [59, 70], [18, 31]],
  ball: [50, 70],
  defenders: [[50, 64], [89, 89], [10, 90]],
});
autoHandoffDraft.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
const handoffOffRun = createSimulationRun(autoHandoffDraft, autoSettings({ screen: false, handoff: false, pickRoll: false, offBallScreen: false }));
assert.equal(handoffOffRun.actions.some((action) => action.automatic), false, 'disabled controls do not create automatic actions');
const handoffRun = createSimulationRun(autoHandoffDraft, autoSettings({ handoff: true }));
assert.ok(handoffRun.actions.some((action) => action.automatic && action.arrow.kind === 'handoff'), 'a pressured handler with an open nearby receiver triggers an automatic handoff');
assert.equal(handoffRun.source.arrows.length, 0, 'automatic actions never enter the source diagram');
const ratingHandoffDraft = makeDraft({
  players: [[50, 70], [58, 70], [42, 70], [18, 31]],
  ball: [50, 70],
  defenders: [[50, 61], [89, 89], [10, 90], [30, 15]],
});
ratingHandoffDraft.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
ratingHandoffDraft.players[1].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
ratingHandoffDraft.players[2].ratings = { threePoint: 5, midrange: 3, finishing: 3 };
const ratingHandoffRun = createSimulationRun(ratingHandoffDraft, autoSettings({ handoff: true }));
assert.equal(ratingHandoffRun.actions.find((action) => action.automatic && action.arrow.kind === 'handoff')?.recipientId, 3, 'automatic handoffs choose the stronger open shooter');
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
autoOffBallDraft.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
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
autoPickRollDraft.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
const autoPickRollRun = createSimulationRun(autoPickRollDraft, autoSettings({ screen: false, handoff: false, pickRoll: true, offBallScreen: false }));
const autoPickRoll = autoPickRollRun.actions.find((action) => action.automatic);
assert.equal(autoPickRoll?.arrow.kind, 'pick-roll', 'an open roll lane and on-ball pressure trigger a pick and roll');
assert.equal(autoPickRoll?.actorId, 2, 'the automatic screener is the player nearest the handler');
assert.equal(autoPickRoll?.partnerId, 1, 'the handler runs the pick and roll while keeping the ball');
assert.ok(autoPickRollRun.frame.activeActionLabel == null, 'temporary action labels appear when the action starts');
advance(autoPickRollRun, autoPickRoll.startTime + SIMULATION_STEP_MS);
assert.match(autoPickRollRun.frame.activeActionLabel ?? '', /Auto pick and roll/);
assert.equal(autoPickRollRun.ballHandlerId, 1, 'a pick and roll keeps possession with the handler');
const ratingPickRollDraft = makeDraft({
  players: [[50, 70], [40, 70], [60, 70], [17, 35]],
  ball: [50, 70],
  defenders: [[50, 62], [90, 90], [10, 90], [30, 15]],
});
ratingPickRollDraft.players[0].ratings = { threePoint: 1, midrange: 1, finishing: 1 };
ratingPickRollDraft.players[1].ratings = { threePoint: 5, midrange: 3, finishing: 2 };
ratingPickRollDraft.players[2].ratings = { threePoint: 1, midrange: 3, finishing: 5 };
const ratingPickRollRun = createSimulationRun(ratingPickRollDraft, autoSettings({ screen: false, handoff: false, pickRoll: true, offBallScreen: false }));
assert.equal(ratingPickRollRun.actions.find((action) => action.automatic && action.arrow.kind === 'pick-roll')?.actorId, 3, 'automatic rolls use the available player with the strongest finishing rating');
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

console.log('Playbook simulation tests passed: timeline order, live possession, continuous shot boundary, adaptive read selection and spacing, bounded/stable defense, help and recovery, screen coverage, switching, paused edits, settings, draft isolation, and all 24 starters');
