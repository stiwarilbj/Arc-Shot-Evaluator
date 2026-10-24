import assert from 'node:assert/strict';
import { READY_SETUP } from '../frontend/src/features/playbook/data.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { createSimulationRun, advanceSimulationState, getAuthoritativeSimulationFrame } from '../frontend/src/features/playbook/simulation.ts';
import { captureSimulationSession, restoreSimulationSession, seekSimulationSession } from '../frontend/src/features/playbook/simulationSession.ts';
import { createPlaybookSimulationHost } from '../frontend/src/features/playbook/playbookSimulationHost.ts';
import { parseSimulationResponse } from '../frontend/src/features/playbook/playbookSimulationProtocol.ts';
import { flattenPlaybookPath } from '../frontend/src/features/playbook/playbookBranches.ts';
import { validatePlaybookDocument } from '../frontend/src/features/playbook/documentValidation.ts';
import { normalizePlaybookPrecision } from '../frontend/src/features/playbook/documentPrecision.ts';
import { upgradeHostedLibrary, validateHostedLibrary, verifyHostedLibrary } from '../frontend/src/features/playbook/hostedLibrary.ts';
import { SIMULATION_ENGINE_VERSION } from '../frontend/src/features/playbook/simulationVersion.ts';

const clone = structuredClone;
const source = clone(READY_SETUP);
delete source.branches; delete source.readCoach; delete source.roleCues; delete source.spacingGates; delete source.flipbooks;
const executable = flattenPlaybookPath(source, null);
const settings = { ...clone(DEFAULT_SIMULATION_SETTINGS), defenseScheme: 'man-to-man', offenseOffBall: 'off', offenseMode: 'scripted',
  automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };
const run = createSimulationRun(executable, settings, undefined, { recordSession: true, seed: 107 });
const openingFrame = getAuthoritativeSimulationFrame(run);
let steps = 0;
while (run.elapsedMs < run.durationMs && steps++ < 2000) advanceSimulationState(run, 50, settings);
assert.ok(steps < 2000, 'the deterministic recording reaches its actual simulation end');
seekSimulationSession(run, run.elapsedMs + run.accumulatorMs);
const endingFrame = getAuthoritativeSimulationFrame(run);
const recording = captureSimulationSession(run);
assert.equal(recording.positionMs, run.durationMs);
assert.equal(recording.engineVersion, SIMULATION_ENGINE_VERSION);

const generatedRoute = { id: 'auto-handoff-1:1:actor', actionId: 'auto-handoff-1', sequence: 1, kind: 'handoff', playerId: 1,
  scope: 'on-ball', importance: 'main', start: { x: 50, y: 70 }, end: { x: 55, y: 65 } };
const snapshot = (frame, atMs, routes = []) => ({ atMs, players: frame.players.map(({ id, x, y }) => ({ id, x, y })),
  defenders: frame.defenders.map(({ id, x, y }) => ({ id, x, y })), ball: frame.ball ? { ...frame.ball } : null,
  ballHandlerId: frame.ballHandlerId ?? null, ballPhase: frame.ballPhase ?? 'held', shotPhase: frame.shotPhase, routes });
const panel = (id, atMs, caption, frame, routes = []) => ({ id, atMs, caption, focusPlayerIds: routes.length ? [1] : [], routeIds: routes.map((route) => route.id), snapshot: snapshot(frame, atMs, routes) });
const opening = panel('opening', 0, 'Opening', openingFrame, [generatedRoute]);
opening.chalkTalk = { version: 1, steps: [
  { id: 'reveal-defender', label: 'Defender position', marks: [{ id: 'defender-circle', kind: 'circle', points: [{ x: 34, y: 41 }, { x: 41, y: 41 }] }] },
  { id: 'reveal-space', label: 'Available space', marks: [{ id: 'space-label', kind: 'text', points: [{ x: 60, y: 36 }], text: 'Read the lane' }] },
] };
const story = { id: 'flipbook-test', playName: 'Frozen test name', endingId: null, endingLabel: 'Main', recording,
  panels: [opening, panel('finish', recording.positionMs, 'Finish', endingFrame)] };
const document = { ...clone(source), flipbooks: { version: 1, stories: [story] } };
validatePlaybookDocument(document);

const frozen = clone(document);
frozen.name = 'Renamed play';
assert.equal(frozen.flipbooks.stories[0].playName, 'Frozen test name', 'the walkthrough title remains frozen after renaming its play');
assert.equal(flattenPlaybookPath(frozen, null).flipbooks, undefined, 'executable paths omit the frozen lesson');
const normalized = normalizePlaybookPrecision(document);
validatePlaybookDocument(normalized);
assert.deepEqual(normalized.flipbooks.stories[0].recording.events, recording.events, 'replay inputs keep their exact precision');
assert.deepEqual(normalized.flipbooks.stories[0].panels[0].chalkTalk, opening.chalkTalk, 'saved annotations retain exact geometry and reveal ordering');

for (const mutate of [
  (value) => { value.flipbooks.stories.push(clone(value.flipbooks.stories[0])); },
  (value) => { value.flipbooks.stories[0].panels.reverse(); },
  (value) => { value.flipbooks.stories[0].panels[0].snapshot.atMs = 1; },
  (value) => { value.flipbooks.stories[0].playName = ' '; },
  (value) => { value.flipbooks.stories[0].panels[0].routeIds.push('missing-route'); },
  (value) => { value.flipbooks.stories[0].panels[0].snapshot.routes[0].actionId = 'forged-auto-action'; },
  (value) => { value.flipbooks.stories[0].panels[0].chalkTalk.steps[1].marks[0].points[0].x = Number.NaN; },
  (value) => { value.flipbooks.stories[0].panels[0].chalkTalk.steps.push(...Array.from({ length: 8 }, (_, index) => ({ id: `extra-${index}`, label: 'Extra', marks: [] }))); },
]) {
  const invalid = clone(document); mutate(invalid);
  assert.throws(() => validatePlaybookDocument(invalid), undefined, 'malformed or duplicate walkthrough data is rejected');
}

const legacy = validateHostedLibrary([document]);
const hosted = await upgradeHostedLibrary(legacy);
assert.equal(hosted.version, 10, 'Chalk Talk-aware content receives hosted envelope version 10');
assert.equal(hosted.plays[0].flipbooks.stories[0].playName, 'Frozen test name');
assert.deepEqual(hosted.plays[0].flipbooks.stories[0].panels[0].chalkTalk, opening.chalkTalk);
await verifyHostedLibrary(hosted);

const hostMessage = (body, sessionId, revision, requestId) => ({ ...body, sessionId, revision, requestId });
const earlyHost = createPlaybookSimulationHost();
let early = earlyHost(hostMessage({ type: 'start', drawing: executable, settings, seed: 107 }, 'early', 1, 1));
assert.equal(early.type, 'state');
early = earlyHost(hostMessage({ type: 'capture-flipbook' }, 'early', 2, 2));
assert.equal(early.type, 'error', 'a partial simulation cannot be frozen as a complete walkthrough');
early = earlyHost(hostMessage({ type: 'capture-export' }, 'early', 3, 3));
parseSimulationResponse(early);
assert.equal(early.type, 'export-capture', 'a partial simulation can be captured for a disposable full replay export');
assert.equal(early.capture.session.positionMs, 0, 'a current-position export capture retains the acknowledged partial session');

const host = createPlaybookSimulationHost();
let response = host(hostMessage({ type: 'start', drawing: executable, settings, seed: 107 }, 'recording', 1, 1));
parseSimulationResponse(response); assert.equal(response.type, 'state');
let requestId = 2;
while (response.view.playing && requestId < 2000) {
  response = host(hostMessage({ type: 'frame', deltaMs: 50 }, 'recording', 1, requestId++));
  parseSimulationResponse(response);
}
assert.equal(response.view.playing, false);
assert.equal(response.view.session.positionMs, response.view.durationMs);
response = host(hostMessage({ type: 'capture-flipbook' }, 'recording', 2, requestId));
parseSimulationResponse(response); assert.equal(response.type, 'capture');
assert.equal(response.capture.session.positionMs, recording.positionMs, 'the worker freezes the full timeline');

const playbackHost = createPlaybookSimulationHost();
response = playbackHost(hostMessage({ type: 'open-flipbook', session: recording }, 'playback', 1, 1));
parseSimulationResponse(response); assert.equal(response.type, 'state');
const seekTime = Math.min(1234.567, recording.positionMs);
response = playbackHost(hostMessage({ type: 'seek', timeMs: seekTime }, 'playback', 2, 2));
parseSimulationResponse(response); assert.equal(response.type, 'state');
const expectedRun = restoreSimulationSession(recording);
seekSimulationSession(expectedRun, seekTime);
assert.deepEqual(response.view.frame.players.map(({ id, x, y }) => ({ id, x, y })), getAuthoritativeSimulationFrame(expectedRun).players.map(({ id, x, y }) => ({ id, x, y })));
assert.equal(response.view.session.positionMs, seekTime, 'worker seeking restores the exact recorded moment');

console.log('Play Flipbook and Chalk Talk passed: frozen recording, annotation validation and round trip, executable-path exclusion, hosted envelope v10, full and partial export capture, exact worker seek and rejection of early walkthrough capture');
