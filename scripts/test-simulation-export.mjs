import assert from 'node:assert/strict';
import { READY_SETUP } from '../frontend/src/features/playbook/data.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { advanceSimulationState, createSimulationRun, getSimulationFrame, setSimulationRunSettings } from '../frontend/src/features/playbook/simulation.ts';
import { captureSimulationSession, restoreSimulationSession } from '../frontend/src/features/playbook/simulationSession.ts';
import { advanceExportRunTo, frameSvg, createImageZip, isExportFrame } from '../frontend/src/features/playbook/simulationExport.ts';

const settings = { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: 'scripted', offenseOffBall: 'off', automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };
const run = createSimulationRun(READY_SETUP, settings, undefined, { seed: 41 });
advanceSimulationState(run, 100, settings);
const frame = structuredClone(getSimulationFrame(run));
frame.routes = [{ id: 'route-one', actionId: 'action-one', sequence: 1, kind: 'drive', playerId: frame.players[0].id, scope: 'on-ball', importance: 'main', start: { x: 50, y: 70 }, end: { x: 54, y: 62 } }];
frame.spacingGateResults = [{ gateId: 'gate-one', status: 'met', checkedAtMs: 100 }];
const sample = { atMs: 100, frame };
assert.equal(isExportFrame(sample), true, 'valid full court frames pass worker-boundary validation');
assert.equal(isExportFrame({ ...sample, atMs: Number.NaN }), false, 'non-finite timestamps are rejected');
assert.equal(isExportFrame({ ...sample, frame: { ...frame, players: [{ id: 1, x: Number.NaN, y: 2 }] } }), false, 'non-finite marker coordinates are rejected');

const gate = { id: 'gate-one', playerId: frame.players[0].id, area: { shape: 'circle', center: { x: 50, y: 70 }, radiusFeet: 3 }, rule: 'inside', trigger: { actionId: 'action-one', event: 'start' }, beforeSeconds: 0, afterSeconds: 0, scope: 'shared' };
const mark = { id: 'mark-one', kind: 'callout', points: [{ x: 50, y: 70 }], number: 1, text: 'Look <left>', startMs: 0, endMs: 250 };
const offSvg = frameSvg(sample, 'off', { spacingGates: [gate], showSpacingGates: true, marks: [mark], notes: 'Read the corner', atMs: 100, frameLabel: 'Original & <Repair>' });
assert.ok(!offSvg.includes('class="route '), 'Arrows Off removes route overlays');
assert.ok(offSvg.includes('export-spacing-gate') && offSvg.includes('✓ Met'), 'enabled gate geometry and results are exported');
assert.ok(offSvg.includes('Look &lt;left&gt;') && offSvg.includes('Original &amp; &lt;Repair&gt;') && offSvg.includes('Read the corner'), 'marks, labels, and notes are safely rendered');
assert.ok(offSvg.includes('class="player'), 'player positions remain visible when arrows are off');
const hiddenGates = frameSvg(sample, 'off', { spacingGates: [gate], showSpacingGates: false });
assert.ok(!hiddenGates.includes('<g class="export-spacing-gate'), 'hidden spacing gates do not leak into exported frames');
const compareSvg = frameSvg({ ...sample, comparison: frame, replayEnded: true, comparisonEnded: true }, 'all', { frameLabel: 'Repair', comparisonLabel: 'Original' });
assert.ok(compareSvg.includes(`width="${2000}"`) && compareSvg.includes('Replay ended') && compareSvg.includes('Original'), 'comparison output uses two full court widths and end labels');
assert.ok(compareSvg.includes('class="route '), 'visible arrows are restored for the selected setting');
const focusSvg = frameSvg(sample, 'all', { focus: { playerIds: [frame.players[0].id], defenderIds: [frame.defenders[0].id], actionIds: ['action-one'] } });
assert.ok(focusSvg.includes('class="player handler focus"') && focusSvg.includes('class="defender focus"') && focusSvg.includes('class="route  focus"'), 'selected-player, defender, and action focus survive export rendering');

const recordedRun = createSimulationRun(READY_SETUP, settings, undefined, { recordSession: true, seed: 712 });
advanceSimulationState(recordedRun, 50, settings);
const changedSettings = { ...settings, defenseStrategy: 'switch' };
setSimulationRunSettings(recordedRun, changedSettings);
const expectedFirst = structuredClone(getSimulationFrame(recordedRun));
advanceSimulationState(recordedRun, 50, changedSettings);
const expectedLast = structuredClone(getSimulationFrame(recordedRun));
const record = captureSimulationSession(recordedRun);
const restored = restoreSimulationSession(record);
assert.deepEqual(advanceExportRunTo(restored, 50, record.positionMs, record.hoop), expectedFirst, 'export seeking replays the recorded pre-edit settings');
assert.deepEqual(advanceExportRunTo(restored, 100, record.positionMs, record.hoop), expectedLast, 'export advancement reapplies recorded settings and reaches the recorded frame exactly');

const zip = await createImageZip([{ name: 'arcade/frame-0001.png', blob: new Blob(['image-bytes']) }], 'Frame 1 · 0.000 s', undefined, 'arcade/index.txt');
const zipBytes = new Uint8Array(await zip.arrayBuffer());
assert.equal(zip.type, 'application/zip');
assert.deepEqual([...zipBytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'image-folder export is a ZIP archive');
const zipText = new TextDecoder().decode(zipBytes);
assert.ok(zipText.includes('arcade/frame-0001.png') && zipText.includes('arcade/index.txt') && zipText.includes('Frame 1 · 0.000 s'), 'ZIP includes the named folder, sequential frame, and timestamp index');

console.log('Simulation export passed: worker-boundary frame checks, arrow/gate/focus rendering, deterministic session seeking, comparison layout, and indexed image ZIP');
