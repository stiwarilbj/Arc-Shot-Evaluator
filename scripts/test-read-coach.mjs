import assert from 'node:assert/strict';
import { createPlaybookSimulationHost } from '../frontend/src/features/playbook/playbookSimulationHost.ts';
import { parseSimulationCommand, parseSimulationResponse } from '../frontend/src/features/playbook/playbookSimulationProtocol.ts';
import { createReadCoachChoiceRun, createSimulationRun, advanceSimulationState, assertReadCoachSnapshot, getAuthoritativeSimulationFrame, getSimulationFrame } from '../frontend/src/features/playbook/simulation.ts';
import { captureSimulationSession, captureSimulationSessionPrefix, restoreSimulationSession, seekSimulationSession } from '../frontend/src/features/playbook/simulationSession.ts';
import { READY_SETUP } from '../frontend/src/features/playbook/data.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { validatePlaybookDocument, validateReadCoachLesson } from '../frontend/src/features/playbook/documentValidation.ts';
import { normalizePlaybookPrecision } from '../frontend/src/features/playbook/documentPrecision.ts';
import { flattenPlaybookPath } from '../frontend/src/features/playbook/playbookBranches.ts';
import { validateHostedLibrary, upgradeHostedLibrary, verifyHostedLibrary } from '../frontend/src/features/playbook/hostedLibrary.ts';

const clone = structuredClone;
const source = clone(READY_SETUP);
source.defenders = []; // Exercise deterministic generated defenders in a frozen lesson
source.arrows = [];
source.players[0].x = 45.1234567; // Force a meaningful save-time coordinate normalization
const settings = { ...clone(DEFAULT_SIMULATION_SETTINGS), defenseScheme: 'man-to-man', defenseStrategy: 'help', offenseOffBall: 'off', offenseMode: 'scripted', automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };

function runToCapture() {
  const run = createSimulationRun(source, settings, undefined, { recordSession: true, seed: 704 });
  advanceSimulationState(run, 50);
  seekSimulationSession(run, run.elapsedMs);
  const session = captureSimulationSession(run);
  const frame = getAuthoritativeSimulationFrame(run);
  assert.equal(session.positionMs, run.elapsedMs);
  assert.equal(run.accumulatorMs, 0);
  assert.equal(frame.ballPhase, 'held');
  return { run, session, frame };
}

const first = runToCapture();
const handler = first.frame.ballHandlerId;
assert.ok(handler);
const receiver = first.frame.players.find(player => player.id !== handler).id;
const movement = { id: 'choice-move', kind: 'movement', sequence: 1, timing: 1.2, actor_id: handler,
  start: { x: first.frame.players.find(player => player.id === handler).x, y: first.frame.players.find(player => player.id === handler).y }, end: { x: 49, y: 53 } };
const pass = { id: 'choice-pass', kind: 'pass', sequence: 1, timing: 1.2, actor_id: handler, recipient_id: receiver,
  start: { x: first.frame.ball.x, y: first.frame.ball.y }, end: { x: first.frame.players.find(player => player.id === receiver).x, y: first.frame.players.find(player => player.id === receiver).y } };
const checkpoint = {
  id: 'read-test', question: 'Which read is available?', explanation: 'The handler can attack or move the ball',
  session: first.session,
  snapshot: { players: clone(first.frame.players), defenders: clone(first.frame.defenders), ball: clone(first.frame.ball), ballHandlerId: handler, atMs: first.session.positionMs },
  choices: [{ id: 'attack', label: 'Attack the gap', arrows: [movement] }, { id: 'move-ball', label: 'Move the ball', arrows: [pass] }],
  correctChoiceId: 'move-ball',
};
const lesson = { version: 1, checkpoints: [checkpoint] };
validateReadCoachLesson(lesson);
const document = { ...clone(source), readCoach: lesson };
validatePlaybookDocument(document);

// A real save rounds visible court coordinates to four decimal places while
// keeping the compact replay journal at full precision. Reloaded lessons must
// accept that documented storage difference without weakening identity or
// possession validation.
const savedDocument = JSON.parse(JSON.stringify(normalizePlaybookPrecision(document)));
const savedCheckpoint = savedDocument.readCoach.checkpoints[0];
assert.ok(Math.abs(savedCheckpoint.snapshot.players[0].x - checkpoint.snapshot.players[0].x) > 1e-5,
  'fixture exercises save-time coordinate rounding beyond the former comparison tolerance');
assert.ok(Math.abs(savedCheckpoint.snapshot.players[0].x - checkpoint.snapshot.players[0].x) <= 5.1e-5,
  'rounded snapshot remains within the four-decimal storage precision');
assertReadCoachSnapshot(restoreSimulationSession(savedCheckpoint.session), savedCheckpoint.snapshot);
validatePlaybookDocument(savedDocument);

// Captured inputs are independent and restore to the exact held court
const sessionCopy = clone(checkpoint.session);
sessionCopy.initialDrawing.players[0].x = 99;
assert.notEqual(checkpoint.session.initialDrawing.players[0].x, 99);
const restored = restoreSimulationSession(checkpoint.session);
assertReadCoachSnapshot(restored, checkpoint.snapshot);
const restoredFrame = getAuthoritativeSimulationFrame(restored);
assert.deepEqual(restoredFrame.players.map(({ id, x, y }) => ({ id, x, y })), checkpoint.snapshot.players.map(({ id, x, y }) => ({ id, x, y })));
assert.deepEqual(restoredFrame.defenders.map(({ id, x, y }) => ({ id, x, y })), checkpoint.snapshot.defenders.map(({ id, x, y }) => ({ id, x, y })));

// Every answer starts from the same live possession and defensive assignments
const attackRun = createReadCoachChoiceRun(checkpoint.session, checkpoint.choices[0], checkpoint.snapshot);
const passRun = createReadCoachChoiceRun(checkpoint.session, checkpoint.choices[1], checkpoint.snapshot);
for (const trial of [attackRun, passRun]) {
  const frame = getAuthoritativeSimulationFrame(trial);
  assert.deepEqual(frame.players.map(({ id, x, y }) => ({ id, x, y })), checkpoint.snapshot.players.map(({ id, x, y }) => ({ id, x, y })));
  assert.deepEqual(frame.defenders.map(({ id, x, y }) => ({ id, x, y })), checkpoint.snapshot.defenders.map(({ id, x, y }) => ({ id, x, y })));
  assert.deepEqual(frame.ball, checkpoint.snapshot.ball);
  assert.equal(frame.ballHandlerId, checkpoint.snapshot.ballHandlerId);
  assert.equal(trial.settings.offenseMode, 'scripted');
  assert.equal(trial.settings.offenseOffBall, 'off');
  assert.deepEqual(trial.settings.automaticActions, { screen: false, handoff: false, pickRoll: false, offBallScreen: false });
  assert.equal(trial.source.arrows.length, 1);
  assert.equal(trial.source.readCoach, undefined);
}
attackRun.players[0].x += 1;
assert.notEqual(attackRun.players[0].x, passRun.players[0].x, 'choice runs own independent mutable state');

// Seeking inside a recorded advance keeps the exact fractional accumulator and
// does not serialize any future simulation events into the checkpoint.
const partial = createSimulationRun(source, settings, undefined, { recordSession: true, seed: 705 });
advanceSimulationState(partial, 50);
seekSimulationSession(partial, 17.125);
const partialRecord = captureSimulationSessionPrefix(partial);
assert.equal(partialRecord.positionMs, 17.125);
assert.equal(partialRecord.events.length, 1);
assert.equal(partialRecord.events[0].endMs, 17.125);
const partialRestore = restoreSimulationSession(partialRecord);
assert.equal(partialRestore.elapsedMs + partialRestore.accumulatorMs, 17.125);
assert.deepEqual(getAuthoritativeSimulationFrame(partialRestore), getAuthoritativeSimulationFrame(partial));

// The worker captures an acknowledged fixed-step state, rejects an invalid
// ball phase recoverably, and practice playback stops exactly at the capture
const host = createPlaybookSimulationHost();
const message = (body, sessionId, revision, requestId) => ({ ...body, sessionId, revision, requestId });
let response = host(message({ type: 'start', drawing: source, settings, seed: 704 }, 'author', 1, 1));
parseSimulationResponse(response); assert.equal(response.type, 'state');
response = host(message({ type: 'frame', deltaMs: 50 }, 'author', 1, 2));
parseSimulationResponse(response);
const acknowledgedTime = response.view.session.positionMs;
response = host(message({ type: 'capture' }, 'author', 2, 3));
parseSimulationResponse(response); assert.equal(response.type, 'capture');
assert.ok(response.capture.session.positionMs <= acknowledgedTime + 1e-6);
assert.ok(acknowledgedTime - response.capture.session.positionMs < 1000 / 60 + 1e-5, 'capture snaps by less than one fixed simulation step');
assert.equal(response.capture.frame.ballPhase, 'held');
assertReadCoachSnapshot(restoreSimulationSession(response.capture.session), {
  players: response.capture.frame.players, defenders: response.capture.frame.defenders,
  ball: response.capture.frame.ball, ballHandlerId: response.capture.frame.ballHandlerId, atMs: response.capture.session.positionMs,
});
const workerCheckpoint = { ...checkpoint, session: response.capture.session,
  snapshot: { players: response.capture.frame.players, defenders: response.capture.frame.defenders, ball: response.capture.frame.ball,
    ballHandlerId: response.capture.frame.ballHandlerId, atMs: response.capture.session.positionMs } };
validateReadCoachLesson({ version: 1, checkpoints: [workerCheckpoint] });

const practiceHost = createPlaybookSimulationHost();
response = practiceHost(message({ type: 'read-opening', checkpoint: workerCheckpoint }, 'practice', 1, 1));
parseSimulationResponse(response); assert.equal(response.type, 'state');
for (let request = 2; request < 200 && response.view.playing; request++) {
  response = practiceHost(message({ type: 'frame', deltaMs: 50 }, 'practice', 1, request));
  parseSimulationResponse(response);
}
assert.equal(response.view.playing, false, 'opening stops at the checkpoint');
assert.equal(response.view.session.positionMs, workerCheckpoint.session.positionMs);
assertReadCoachSnapshot(restoreSimulationSession(workerCheckpoint.session), workerCheckpoint.snapshot);

const choiceHost = createPlaybookSimulationHost();
response = choiceHost(message({ type: 'read-choice', checkpoint: workerCheckpoint, choiceId: 'attack' }, 'choice', 1, 1));
parseSimulationResponse(response); assert.equal(response.type, 'state');
assert.deepEqual(response.view.frame.players.map(({ id, x, y }) => ({ id, x, y })), workerCheckpoint.snapshot.players.map(({ id, x, y }) => ({ id, x, y })));
assert.deepEqual(response.view.frame.ball, workerCheckpoint.snapshot.ball);
const corrupted = clone(workerCheckpoint); corrupted.snapshot.players[0].x += 2;
validateReadCoachLesson({ version: 1, checkpoints: [corrupted] });
const badHost = createPlaybookSimulationHost();
response = badHost(message({ type: 'read-opening', checkpoint: corrupted }, 'bad-practice', 1, 1));
assert.equal(response.type, 'error');
response = badHost(message({ type: 'read-opening', checkpoint: workerCheckpoint }, 'bad-practice', 2, 2));
assert.equal(response.type, 'state', 'a failed snapshot check leaves the worker available for a retry');

// Counter Lab gets only the selected executable path, never lesson metadata
assert.equal(flattenPlaybookPath(document, null).readCoach, undefined);

// Old hosted envelopes with Read Coach content are upgraded to the lesson-aware
// storage envelope and checksummed migration chain
const saved = { ...clone(document), id: 'play-read-coach-test', revision: 'a'.repeat(32), created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
const legacy = validateHostedLibrary({ version: 1, plays: [saved], creations: [] });
const upgraded = await upgradeHostedLibrary(legacy);
assert.equal(upgraded.version, 5);
assert.equal(upgraded.plays[0].readCoach.checkpoints[0].id, 'read-test');
await verifyHostedLibrary(upgraded);

for (const mutate of [value => { value.session.positionMs += 10; }, value => { value.snapshot.ballHandlerId = 999; }]) {
  const invalid = clone(checkpoint); mutate(invalid);
  assert.throws(() => validateReadCoachLesson({ version: 1, checkpoints: [invalid] }));
}
const staleEngine = clone(checkpoint); staleEngine.session.engineVersion += 1;
const staleResponse = host(message({ type: 'read-opening', checkpoint: staleEngine }, 'stale', 1, 4));
assert.equal(staleResponse.type, 'error');
assert.throws(() => parseSimulationCommand(message({ type: 'read-choice', checkpoint: staleEngine, choiceId: 'attack' }, 'stale', 1, 1)));

console.log('Read Coach passed: exact held-state capture/restoration, independent scripted choices, stop-at-checkpoint opening, stale snapshot rejection, generated-defense snapshots, executable-path flattening and lesson-aware storage migration');
