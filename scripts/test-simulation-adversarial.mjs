import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateAuditCase, executeAuditCase, verifySnapshot, validateAuditCase, reduceAuditFailure, readableTrace, STEP_MS, LAYOUTS } from './lib/simulation-adversarial.mjs';
import { saveAuditFailure } from './audit-playbook-simulation.mjs';
import { createSimulationRun, advanceSimulationState, inspectSimulationExecution, watchSimulationExecution, getSimulationFrame,
  editPausedSimulationMarker, rebasePausedSimulation, setSimulationRunSettings } from '../frontend/src/features/playbook/simulation.ts';
import { createPlaybookSimulationHost } from '../frontend/src/features/playbook/playbookSimulationHost.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';

const directory = new URL('../tests/fixtures/simulation-adversarial/', import.meta.url);
const corpus = [];
for (const file of (await readdir(directory)).filter(name => name.endsWith('.case.json')).sort()) {
  const test = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
  const result = executeAuditCase(test);
  assert.ok(result.ok, `${file}: ${JSON.stringify(result.failure)}\n${readableTrace(test, result)}`);
  corpus.push({ test, result });
}
assert.ok(corpus.length >= 2, 'normal regression command replays the checked-in corpus');
assert.ok(corpus.some(c => c.result.counts.caught > 0), 'fixtures exercise confirmed catches, not only failed transfers');
assert.ok(corpus.some(c => c.result.counts.conflicts > 0), 'conflict outcomes remain valid audit results');
assert.ok(corpus.some(c => c.result.counts.restores > 0), 'fixtures exercise executable checkpoint restoration');
const ownership = corpus.find(c => c.test.drawing.id === 'audit-20261685');
assert.ok(ownership, 'the audit-discovered ownership failure remains an ordinary fixture');
assert.equal(ownership.result.final.actions.find(a => a.key === 'auto-offball-5:5').execution.phase, 'conflict');
assert.equal(ownership.result.final.actions.find(a => a.key === 'action-6:4').execution.phase, 'approach');
assert.ok(Math.abs(ownership.result.final.actions.find(a => a.key === 'auto-offball-5:5').execution.completedAtMs - 4000) < 1e-6,
  'ownership is settled at the authored start boundary, before the next movement update');
// Long generated pause/edit/resume streams also cross the real worker command
// boundary. Checkpoint restoration has its own engine/session regressions.
for (let i = 0; i < LAYOUTS.length; i++) {
  const test = generateAuditCase(61020 + i, { index: i, commands: 72 });
  const run = createSimulationRun(test.drawing, test.settings, undefined, { seed: test.seed });
  const host = createPlaybookSimulationHost(); let revision = 0, requestId = 0, paused = false;
  const send = command => {
    if (command.type !== 'frame') revision++;
    const response = host({ ...command, sessionId: `adversarial-${i}`, revision, requestId: ++requestId });
    assert.equal(response.type, 'state', response.message);
    assert.deepEqual(response.view.frame, getSimulationFrame(run), `worker frame: ${command.type}, seed ${test.seed}`);
    if (paused) assert.equal(response.view.playing, false, 'real host ignores advances while paused');
  };
  send({ type: 'start', drawing: test.drawing, settings: test.settings, seed: test.seed });
  const advance = deltaMs => { if (!paused) advanceSimulationState(run, deltaMs); send({ type: 'frame', deltaMs: Math.max(0, deltaMs) }); };
  for (const c of test.commands) {
    if (c.kind === 'checkpoint' || c.kind === 'restore') continue;
    if (c.kind === 'pause' || c.kind === 'resume') { paused = c.kind === 'pause'; send({ type: 'playback', playing: !paused }); }
    else if (c.kind === 'advance') { for (let n = 0; n < c.steps; n++) advance(c.deltaMs); }
    else if (c.kind === 'finish') { let n = 0; while (run.elapsedMs < run.durationMs && n++ < c.maxSteps) advance(STEP_MS); assert.ok(run.elapsedMs >= run.durationMs); }
    else if (c.kind === 'settings') { setSimulationRunSettings(run, c.settings); send({ type: 'settings', settings: c.settings }); }
    else {
      const drawing = structuredClone(run.source);
      if (c.kind === 'edit') {
        const roster = c.team === 'player' ? drawing.players : drawing.defenders;
        Object.assign(roster.find(p => p.id === c.id), c.point);
        editPausedSimulationMarker(run, c.team, c.id, c.point, drawing);
        send({ type: 'edit', drawing, relocation: { type: c.team, id: c.id, point: c.point } });
      } else {
        const player = drawing.players.find(p => p.id === c.id);
        player.ratings = { threePoint: c.rating, midrange: c.rating, finishing: c.rating }; player.badges = [c.badge];
        assert.equal(rebasePausedSimulation(run, drawing), true); send({ type: 'edit', drawing });
      }
    }
  }
}
for (let i = 0; i < LAYOUTS.length; i++) {
  const test = generateAuditCase(20261020 + i, { index: i, commands: 16 });
  assert.deepEqual(test, generateAuditCase(test.seed, { index: i, commands: 16 }), 'seeds reproduce complete inputs');
  const a = executeAuditCase(test), b = executeAuditCase(test);
  assert.ok(a.ok, JSON.stringify(a.failure)); assert.ok(b.ok, JSON.stringify(b.failure));
  assert.deepEqual(a.final, b.final, 'identical command streams produce identical execution');
  assert.deepEqual(a.counts, b.counts);
}
const fixture = structuredClone(corpus.find(c => c.result.counts.caught).test);
const snapshot = corpus.find(c => c.result.counts.caught > 0).result.final;
function rejects(change, code) {
  const damaged = structuredClone(snapshot); change(damaged);
  assert.throws(() => verifySnapshot(damaged), error => error.code === code, `the verifier detects ${code}`);
}
rejects(s => { s.markers[0].x = NaN; }, 'finite-position');
rejects(s => { s.controllerId = 999; }, 'possession');
rejects(s => { s.elapsedMs = Infinity; }, 'clock');
rejects(s => { s.markers[0].velocity.x = 100; }, 'speed');
rejects(s => { s.actions.find(a => a.execution).execution.phase = ['use', 'release']; }, 'action-phase');
rejects(s => { const a = s.actions.find(a => a.transfer?.outcome.kind === 'caught'); a.transfer.outcome = { kind: 'pending' }; }, 'completed-catch');
rejects(s => { const a = s.actions.find(a => a.execution?.phase === 'completed'); a.execution.startedAtMs = null; }, 'completion');

// Observe hidden internal slices at fractional action boundaries; disposing or
// mutating detached snapshots must leave a normal run completely unchanged.
const source = structuredClone(fixture.drawing); source.arrows = [source.arrows[0]]; source.arrows[0].timing = .51;
const settings = { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: 'scripted', defenseScheme: 'man-to-man', defenseStrategy: 'off' };
const watched = createSimulationRun(source, settings), normal = createSimulationRun(source, settings);
let observed = 0, fractional = false;
const stop = watchSimulationExecution(watched, s => {
  observed++; fractional ||= Math.abs(s.elapsedMs / STEP_MS - Math.round(s.elapsedMs / STEP_MS)) > 1e-5;
  s.markers[0].x = -999; s.actions[0].target.x = -999;
  if (s.actions[0].transfer?.release) s.actions[0].transfer.release.position.x = -999;
});
assert.throws(() => watchSimulationExecution(watched, () => {}), /already/);
for (let n = 0; n < 50; n++) { advanceSimulationState(watched, 50); advanceSimulationState(normal, 50); }
assert.ok(observed > 50 && fractional, 'every fixed slice and intermediate boundary is observed');
assert.deepEqual(inspectSimulationExecution(watched), inspectSimulationExecution(normal), 'diagnostics never alias execution');
assert.ok(watched.elapsedMs < watched.durationMs, 'observer disposal is tested before execution ends');
stop(); stop(); const beforeStop = observed; advanceSimulationState(watched, 50); assert.equal(observed, beforeStop);

// Prove the audit catches a plausible fault and shrinks the same evidence, not
// an invalid document or a different exception. Inject into snapshots only.
const corrupt = snapshot => {
  const caught = snapshot.actions.find(a => a.transfer?.outcome.kind === 'caught' && a.execution.phase === 'completed');
  if (caught) caught.transfer.outcome = { kind: 'pending' };
};
const execute = test => executeAuditCase(test, { mutateSnapshot: corrupt });
const broken = execute(fixture); assert.equal(broken.ok, false); assert.equal(broken.failure.code, 'completed-catch');
const reduced = reduceAuditFailure(fixture, { execute, maxRuns: 250 });
validateAuditCase(reduced.test);
assert.equal(reduced.result.failure.code, broken.failure.code); assert.equal(reduced.result.failure.subject, broken.failure.subject);
assert.ok(reduced.test.commands.length < fixture.commands.length);
assert.ok(reduced.test.drawing.arrows.length < fixture.drawing.arrows.length);
assert.equal(executeAuditCase(reduced.test).ok, true, 'the verifier fault never mutates engine state');
assert.equal(execute(reduced.test).ok, false, 'reduced example deterministically reproduces the injected failure');
assert.ok(readableTrace(reduced.test, reduced.result, reduced).includes('completed-catch'));
const budgeted = reduceAuditFailure(fixture, { execute, maxRuns: 1 });
assert.equal(budgeted.budgetExhausted, true); assert.equal(budgeted.minimality, 'budget-limited');
assert.throws(() => reduceAuditFailure(fixture), /passing/);

const temporary = await mkdtemp(join(tmpdir(), 'arc-adversarial-'));
try {
  const path = await saveAuditFailure(temporary, reduced.test, fixture, reduced);
  const restored = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(restored, reduced.test); assert.equal(execute(restored).failure.code, 'completed-catch');
  assert.match(await readFile(path.replace('.case.json', '.trace.txt'), 'utf8'), /seed.*Failure:/s);
  assert.deepEqual(JSON.parse(await readFile(path.replace('.case.json', '.original.json'), 'utf8')), fixture);
  assert.ok((await readdir(temporary)).every(name => !name.endsWith('.tmp')), 'published artifacts have no partial writes');
  const cli = fileURLToPath(new URL('./audit-playbook-simulation.mjs', import.meta.url));
  const invoke = args => spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { encoding: 'utf8', timeout: 15000 });
  const report = join(temporary, 'report.json');
  const passing = invoke(['--cases', '1', '--commands', '1', '--seed', '19', '--start-index', '7', '--report', report]);
  assert.equal(passing.status, 0, passing.stderr);
  const summary = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(summary.checked, 1); assert.equal(summary.options.startIndex, 7);
  assert.deepEqual(summary.layouts, { transfers: 1 });
  assert.equal(invoke(['--cases', '0']).status, 1, 'invalid CLI ranges fail before running');
  const short = { ...fixture, commands: [{ kind: 'finish', maxSteps: 1 }] };
  const shortPath = join(temporary, 'short.json'); await writeFile(shortPath, JSON.stringify(short));
  const failedDirectory = join(temporary, 'failure');
  const failed = invoke(['--fixture', shortPath, '--output', failedDirectory, '--shrink-runs', '1']);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /Saved regression:/);
  const saved = (await readdir(failedDirectory)).find(name => name.endsWith('.case.json'));
  assert.ok(saved, 'CLI failure produces an ordinary regression automatically');
  const reproduction = JSON.parse(await readFile(join(failedDirectory, saved), 'utf8'));
  assert.equal(executeAuditCase(reproduction).failure.code, 'liveness');
} finally { await rm(temporary, { recursive: true, force: true }); }
for (const edit of [
  t => { t.drawing.players[0].x = Infinity; },
  t => { t.commands = [{ kind: 'edit', team: 'player', id: 1, point: { x: 40, y: 40 } }]; },
  t => { t.commands = [{ kind: 'restore' }]; },
  t => { t.commands = [{ kind: 'advance', steps: 1, deltaMs: NaN }]; },
  t => { t.settings.defenseStrategy = 'invalid'; },
]) { const test = structuredClone(fixture); edit(test); assert.throws(() => validateAuditCase(test)); }
console.log('Adversarial audit regressions passed: corpus, seeded drawings, deterministic commands, slice diagnostics, invariants, real catches, snapshot isolation, reducer, bounded reduction and saved failure artifacts.');
