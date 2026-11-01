import assert from 'node:assert/strict';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { baitPayoffActionSignature } from '../frontend/src/features/playbook/baitPayoff.ts';
import { resolvePlaybookPath, createBranchFromAction } from '../frontend/src/features/playbook/playbookBranches.ts';
import { validatePlaybookDocument } from '../frontend/src/features/playbook/documentValidation.ts';
import { normalizePlaybookPrecision } from '../frontend/src/features/playbook/documentPrecision.ts';
import { upgradeHostedLibrary, validateHostedLibrary, verifyHostedLibrary } from '../frontend/src/features/playbook/hostedLibrary.ts';
import { bindAuthoredActions } from '../frontend/src/features/playbook/simulation.ts';
import { authoredRoleCueTemplates, buildRoleCues } from '../frontend/src/features/playbook/roleRehearsal.ts';
import { createSimulationRun, advanceSimulationState, getAuthoritativeSimulationFrame } from '../frontend/src/features/playbook/simulation.ts';
import { captureSimulationSession, captureSimulationSessionPrefix, seekSimulationSession } from '../frontend/src/features/playbook/simulationSession.ts';
import { READY_SETUP } from '../frontend/src/features/playbook/data.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { SIMULATION_ENGINE_VERSION } from '../frontend/src/features/playbook/simulationVersion.ts';
import { prepareRoleSwitch, roleAssignmentsForPath, roleSwitchSourceKey } from '../frontend/src/features/playbook/roleSwitchboard.ts';

const clone = structuredClone;
const swapId = (id, first, second) => id === first ? second : id === second ? first : id;

function frozenLessons() {
  const frozenDrawing = clone(READY_SETUP);
  delete frozenDrawing.branches;
  delete frozenDrawing.readCoach;
  delete frozenDrawing.roleCues;
  delete frozenDrawing.spacingGates;
  delete frozenDrawing.flipbooks;
  delete frozenDrawing.baitPayoffs;
  const settings = { ...clone(DEFAULT_SIMULATION_SETTINGS), defenseScheme: 'man-to-man', offenseOffBall: 'off', offenseMode: 'scripted',
    automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };

  const readRun = createSimulationRun(frozenDrawing, settings, undefined, { recordSession: true, seed: 9801 });
  advanceSimulationState(readRun, 50, settings);
  seekSimulationSession(readRun, readRun.elapsedMs);
  const readSession = captureSimulationSessionPrefix(readRun);
  const readFrame = getAuthoritativeSimulationFrame(readRun);
  const handlerId = readFrame.ballHandlerId;
  const receiverId = readFrame.players.find(player => player.id !== handlerId).id;
  const handler = readFrame.players.find(player => player.id === handlerId);
  const receiver = readFrame.players.find(player => player.id === receiverId);
  const checkpoint = {
    id: 'frozen-role-switch-read', question: 'Where does the help go?', explanation: 'The opening was captured before the personnel exchange',
    session: readSession,
    snapshot: { players: clone(readFrame.players), defenders: clone(readFrame.defenders), ball: clone(readFrame.ball), ballHandlerId: handlerId, atMs: readSession.positionMs },
    choices: [
      { id: 'frozen-attack', label: 'Attack the gap', arrows: [{ id: 'frozen-attack-move', kind: 'movement', sequence: 1, timing: 1,
        actor_id: handlerId, start: { x: handler.x, y: handler.y }, end: { x: 50, y: 50 } }] },
      { id: 'frozen-read-pass', label: 'Move the ball', arrows: [{ id: 'frozen-read-pass-arrow', kind: 'pass', sequence: 1, timing: 1,
        actor_id: handlerId, recipient_id: receiverId, start: { ...readFrame.ball }, end: { x: receiver.x, y: receiver.y } }] },
    ],
    correctChoiceId: 'frozen-read-pass',
  };

  const flipRun = createSimulationRun(frozenDrawing, settings, undefined, { recordSession: true, seed: 9802 });
  const opening = getAuthoritativeSimulationFrame(flipRun);
  let steps = 0;
  while (flipRun.elapsedMs < flipRun.durationMs && steps++ < 2000) advanceSimulationState(flipRun, 50, settings);
  assert.ok(steps < 2000, 'the frozen walkthrough fixture records to its actual end');
  seekSimulationSession(flipRun, flipRun.elapsedMs + flipRun.accumulatorMs);
  const finish = getAuthoritativeSimulationFrame(flipRun);
  const recording = captureSimulationSession(flipRun);
  const panel = (id, atMs, caption, frame) => ({ id, atMs, caption, focusPlayerIds: [], routeIds: [], snapshot: {
    atMs, players: frame.players.map(({ id: playerId, x, y }) => ({ id: playerId, x, y })),
    defenders: frame.defenders.map(({ id: defenderId, x, y }) => ({ id: defenderId, x, y })),
    ball: frame.ball ? { ...frame.ball } : null, ballHandlerId: frame.ballHandlerId ?? null, ballPhase: frame.ballPhase ?? 'held',
    shotPhase: frame.shotPhase, routes: [],
  } });
  assert.ok(recording.positionMs > 0);
  assert.equal(recording.engineVersion, SIMULATION_ENGINE_VERSION);
  return {
    readCoach: { version: 1, checkpoints: [checkpoint] },
    flipbooks: { version: 1, stories: [{ id: 'frozen-role-switch-story', playName: frozenDrawing.name, endingId: null, endingLabel: 'Main', recording,
      panels: [panel('frozen-opening', 0, 'Opening before the swap', opening), panel('frozen-finish', recording.positionMs, 'Captured finish', finish)] }] },
  };
}
const bound = play => bindAuthoredActions(play).map(action => ({
  id: action.arrow.id, sequence: action.sequence, kind: action.arrow.kind,
  actorId: action.actorId, recipientId: action.recipientId, partnerId: action.partnerId ?? null,
}));
const actionShape = (arrow, remapWaits = false) => ({
  id: arrow.id, kind: arrow.kind, sequence: arrow.sequence, path: arrow.path,
  start: arrow.start, end: arrow.end, control: arrow.control, exit_target: arrow.exit_target,
  timing: arrow.timing,
  timingPlan: arrow.timingPlan ? {
    startAtMs: arrow.timingPlan.startAtMs, syncId: arrow.timingPlan.syncId,
    waits: arrow.timingPlan.waits?.map(wait => ({
      id: wait.id, actionId: wait.actionId, event: wait.event,
      playerId: wait.playerId == null ? undefined : remapWaits ? swapId(wait.playerId, 1, 2) : wait.playerId,
      routePhase: wait.routePhase, routeSegment: wait.routeSegment, progress: wait.progress,
    })),
  } : undefined,
});

function assertPathMapped(beforeFamily, afterFamily, pathId, first, second) {
  const before = resolvePlaybookPath(beforeFamily, pathId).play;
  const after = resolvePlaybookPath(afterFamily, pathId).play;
  const original = bound(before), reassigned = bound(after);
  assert.deepEqual(reassigned.map(item => item.id), original.map(item => item.id), 'action identities and order stay stable');
  assert.deepEqual(reassigned.map(item => [item.actorId, item.recipientId, item.partnerId]),
    original.map(item => [swapId(item.actorId, first, second), swapId(item.recipientId, first, second), swapId(item.partnerId, first, second)]),
    `${pathId ?? 'Main'}: every engine-resolved participant follows the exchanged responsibility`);
  const originalArrows = new Map(before.arrows.map(arrow => [arrow.id, arrow]));
  for (const arrow of after.arrows) assert.deepEqual(actionShape(arrow), actionShape(originalArrows.get(arrow.id), true), `${pathId ?? 'Main'}/${arrow.id}: geometry, timing and dependency identities are preserved`);
}

// Every supplied starter remains eligible for every distinct two-player swap
for (const starter of STARTER_PLAYS) {
  for (const first of starter.players) for (const second of starter.players) {
    if (first.id >= second.id) continue;
    const source = clone(starter);
    const original = clone(source);
    const preview = prepareRoleSwitch(source, first.id, second.id);
    assert.deepEqual(preview.validationErrors, [], `${starter.name}, Players ${first.id} and ${second.id}: valid across all endings`);
    assert.deepEqual(source, original, `${starter.name}: preparing a preview never mutates the source`);
    const playerById = new Map(preview.after.players.map(player => [player.id, player]));
    assert.deepEqual([playerById.get(first.id).x, playerById.get(first.id).y], [second.x, second.y]);
    assert.deepEqual([playerById.get(second.id).x, playerById.get(second.id).y], [first.x, first.y]);
    for (const beforePlayer of source.players) {
      const afterPlayer = playerById.get(beforePlayer.id);
      assert.deepEqual({ ratings: afterPlayer.ratings, badges: afterPlayer.badges }, { ratings: beforePlayer.ratings, badges: beforePlayer.badges }, 'player skills stay with the same identity');
    }
    assertPathMapped(source, preview.after, null, first.id, second.id);
    for (const branch of source.branches ?? []) assertPathMapped(source, preview.after, branch.id, first.id, second.id);
    validatePlaybookDocument(preview.after);
    assert.equal(roleSwitchSourceKey(source), roleSwitchSourceKey(original));
  }
}

const source = {
  version: 1, id: 'role-switch-fixture', name: 'Role switch fixture', defenders_visible: true,
  players: [
    { id: 1, x: 50, y: 78, ratings: { threePoint: 5, midrange: 4, finishing: 3 }, badges: ['playmaker'] },
    { id: 2, x: 27, y: 57, ratings: { threePoint: 2, midrange: 3, finishing: 5 }, badges: ['slasher', 'cutter'] },
    { id: 3, x: 73, y: 57, ratings: { threePoint: 4, midrange: 4, finishing: 4 }, badges: ['catch-and-shoot'] },
    { id: 4, x: 24, y: 30, ratings: { threePoint: 3, midrange: 3, finishing: 2 }, badges: ['screen-setter'] },
    { id: 5, x: 60, y: 68, ratings: { threePoint: 3, midrange: 4, finishing: 4 }, badges: ['roll-threat'] },
  ],
  defenders: [{ id: 11, x: 48, y: 66 }, { id: 12, x: 34, y: 56 }], ball: { x: 50, y: 78 },
  arrows: [
    { id: 'pass-one', kind: 'pass', sequence: 1, start: { x: 50, y: 78 }, end: { x: 27, y: 57 }, timing: 1, timingPlan: { startAtMs: 0 } },
    { id: 'handoff-two', kind: 'handoff', sequence: 2, start: { x: 27, y: 57 }, end: { x: 73, y: 57 }, timing: 1.1, timingPlan: { startAtMs: 1100 } },
    { id: 'pickroll-three', kind: 'pick-roll', sequence: 3, screener_id: 5, handler_id: 3, start: { x: 60, y: 68 }, end: { x: 66, y: 58 }, timing: 1.3, timingPlan: { startAtMs: 2200, syncId: 'screen-pair' } },
    { id: 'weak-side', kind: 'movement', sequence: 3, actor_id: 4, start: { x: 24, y: 30 }, end: { x: 18, y: 39 }, timing: 0.8, timingPlan: { startAtMs: 2200, syncId: 'screen-pair' } },
    { id: 'offscreen-four', kind: 'off-ball-screen', sequence: 4, screener_id: 4, cutter_id: 2, start: { x: 24, y: 30 }, end: { x: 35, y: 48 }, timing: 1.2, timingPlan: { startAtMs: 3300 } },
    { id: 'cut-five', kind: 'backdoor-cut', sequence: 5, actor_id: 2, path: 'curve', start: { x: 27, y: 57 }, control: { x: 33, y: 42 }, end: { x: 47, y: 34 }, timing: 1.5, timingPlan: { startAtMs: 4400 } },
    { id: 'pass-main', kind: 'pass', sequence: 6, actor_id: 1, recipient_id: 3, start: { x: 50, y: 78 }, end: { x: 73, y: 57 }, timing: 0.9,
      timingPlan: { startAtMs: 5500, waits: [{ id: 'wait-for-cut', actionId: 'cut-five', event: 'route-point', playerId: 2, routePhase: 'main', routeSegment: 0, progress: 0.45 }] } },
  ],
  roleCues: { version: 1, cues: [{ playerId: 2, actionId: 'offscreen-four', phase: 'screen-use', scope: 'shared', text: 'Clear the lane after the screen', signature: '0123abcd' }] },
  spacingGates: { version: 1, gates: [{ id: 'corner-gate', playerId: 2, area: { shape: 'circle', center: { x: 27, y: 57 }, radiusFeet: 3 }, rule: 'outside',
    trigger: { actionId: 'offscreen-four', event: 'route-point', routePlayerId: 2, routePhase: 'main', routeSegment: 0, progress: 0.5 }, beforeSeconds: 0, afterSeconds: 0, instruction: 'Clear the lane', scope: 'shared' }] },
  ...frozenLessons(),
};
source.roleCues.cues[0].signature = authoredRoleCueTemplates(source).find(cue => cue.playerId === 2 && cue.actionId === 'offscreen-four' && cue.phase === 'screen-use').signature;
const reactionLink = {
  id: 'screen-reaction', baitActionId: 'offscreen-four', payoffActionId: 'handoff-two', title: 'Pull the helper',
  explanation: 'The cutter draws attention before the handoff', scope: 'shared',
  baitSignature: baitPayoffActionSignature(source.arrows[4], source), payoffSignature: baitPayoffActionSignature(source.arrows[1], source),
  reaction: { defenderId: 11, direction: 'enter', area: { shape: 'circle', center: { x: 40, y: 50 }, radiusFeet: 3 },
    checkpoint: { actionId: 'offscreen-four', event: 'route-point', routePlayerId: 2, routePhase: 'main', routeSegment: 0, progress: 0.5 } },
};
source.baitPayoffs = { version: 1, connections: [reactionLink] };
source.branches = [createBranchFromAction(source, 'cut-five', 1)];
source.branches[0].id = 'ending-switch';
source.branches[0].label = 'Switch read';
const endingPass = source.branches[0].continuation.find(arrow => arrow.id === 'pass-main');
endingPass.id = 'ending-pass'; endingPass.actor_id = 2; endingPass.recipient_id = 4;
endingPass.timingPlan.waits[0].id = 'ending-wait-for-cut';
source.roleCues.cues.push({ playerId: 4, actionId: 'ending-pass', phase: 'pass', scope: 'ending', branchId: 'ending-switch', text: 'Find the cutter', signature: '89abcdef' });
validatePlaybookDocument(source);

const before = clone(source);
const preview = prepareRoleSwitch(source, 1, 2);
assert.deepEqual(preview.validationErrors, [], 'complex branch family validates after exchange');
assert.deepEqual(source, before, 'branch preview is side-effect free');
assert.equal(preview.materializedBallLocation, false);
assert.deepEqual(preview.after.ball, source.ball, 'authored ball location is unchanged');
assertPathMapped(source, preview.after, null, 1, 2);
assertPathMapped(source, preview.after, 'ending-switch', 1, 2);
assert.deepEqual(preview.after.roleCues.cues.map(cue => cue.playerId), [1, 4], 'shared and ending-scoped cues exchange player assignments');
assert.equal(preview.after.roleCues.cues[0].text, source.roleCues.cues[0].text, 'cue wording remains intact for review');
assert.equal(preview.after.roleCues.cues[1].signature, source.roleCues.cues[1].signature, 'review signature stays attached to its action');
const afterEnding = resolvePlaybookPath(preview.after, 'ending-switch');
const reassignedCues = buildRoleCues(afterEnding.play, 1, 'ending-switch', afterEnding.sharedIds, [], 0);
assert.equal(reassignedCues.find(cue => cue.actionId === 'offscreen-four' && cue.phase === 'screen-use').reviewWording, true, 'existing My Role wording displays its review reminder after participants change');
assert.equal(preview.after.spacingGates.gates[0].playerId, 1);
assert.equal(preview.after.spacingGates.gates[0].trigger.routePlayerId, 1);
assert.equal(preview.after.baitPayoffs.connections[0].reaction.checkpoint.routePlayerId, 1);
assert.equal(preview.after.baitPayoffs.connections[0].reaction.defenderId, 11, 'defensive assignments are not exchanged');
assert.equal(preview.after.baitPayoffs.connections[0].explanation, source.baitPayoffs.connections[0].explanation);
assert.deepEqual(preview.after.readCoach, source.readCoach, 'frozen Read Coach data is untouched');
assert.deepEqual(preview.after.flipbooks, source.flipbooks, 'frozen Flipbook data is untouched');
assert.equal(preview.frozenLessonCount, 2, 'the preview identifies actual frozen Read Coach and Flipbook content');
assert.ok(preview.references.some(reference => reference.category === 'Timing' && reference.label.includes('Move 6')));
assert.ok(preview.references.some(reference => reference.category === 'Spacing gate'));
assert.ok(preview.references.some(reference => reference.category === 'My Role cue'));
assert.ok(preview.references.some(reference => reference.category === 'Bait & Payoff'));
assert.notEqual(preview.after.baitPayoffs.connections[0].baitSignature, baitPayoffActionSignature(preview.after.arrows.find(arrow => arrow.id === 'offscreen-four'), preview.after), 'Bait & Payoff review signature catches the changed participant');
assert.equal(preview.paths.find(path => path.branchId === 'ending-switch').label, 'Switch read');
assert.deepEqual(roleAssignmentsForPath(resolvePlaybookPath(source, 'ending-switch').play).map(assignment => assignment.playerId), [1, 2, 3, 4, 5]);

const implicitBall = clone(source); implicitBall.ball = null;
const implicitPreview = prepareRoleSwitch(implicitBall, 1, 2);
assert.equal(implicitPreview.materializedBallLocation, true);
assert.deepEqual(implicitPreview.after.ball, { x: before.players[0].x, y: before.players[0].y }, 'an omitted ball is materialized at the same initial possession location');
assert.deepEqual(implicitPreview.validationErrors, []);

assert.throws(() => prepareRoleSwitch(source, 1, 1), /two different/i);
assert.throws(() => prepareRoleSwitch(source, 1, 99), /roster/i);
const normalized = normalizePlaybookPrecision(preview.after);
validatePlaybookDocument(normalized);
assert.deepEqual(normalized.roleCues, preview.after.roleCues, 'save normalization preserves cue assignments and wording');
const hosted = await upgradeHostedLibrary(validateHostedLibrary([normalized]));
assert.deepEqual(hosted.plays[0].spacingGates, normalized.spacingGates);
assert.deepEqual(hosted.plays[0].branches, normalized.branches);
assert.deepEqual(hosted.plays[0].baitPayoffs, normalized.baitPayoffs);
await verifyHostedLibrary(hosted);

console.log(`Role Switchboard passed: ${STARTER_PLAYS.length} starters × every player pair, inferred and explicit bindings, branches, timing waits, sync groups, teaching references, ball position, validation and hosted persistence`);
