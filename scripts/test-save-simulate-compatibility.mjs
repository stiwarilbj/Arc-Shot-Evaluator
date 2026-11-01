import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { installBrowserLocks } from './helpers/browser-locks.mjs';
import { SAVE_SIMULATE_PLAYS } from './fixtures/save-simulate-plays.mjs';
import { normalizePlaybookPrecision } from '../frontend/src/features/playbook/documentPrecision.ts';
import { flattenPlaybookPath } from '../frontend/src/features/playbook/playbookBranches.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { bindAuthoredActions, createSimulationRun, getSimulationFrame, advanceSimulationRun, observeCounterLabRun, SIMULATION_STEP_MS } from '../frontend/src/features/playbook/simulation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundledPython = fileURLToPath(new URL(process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python', import.meta.url));
const python = process.env.ARC_TEST_PYTHON || (existsSync(bundledPython) ? bundledPython : 'python3');

function startLocalPersistence() {
  const child = spawn(python, ['-u', fileURLToPath(new URL('./helpers/playbook-persistence-bridge.py', import.meta.url))], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, stderr = '', failure;
  const pending = new Map();
  const fail = error => { failure = error; for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.on('error', error => fail(new Error(`Cannot start compatibility backend with ${python}. Install backend/test dependencies or set ARC_TEST_PYTHON. ${error.message}`)));
  const exited = new Promise(resolve => {
    child.once('error', resolve);
    child.once('exit', (code, signal) => {
      fail(new Error(`Compatibility backend exited (${signal ?? code}). ${stderr}`)); resolve();
    });
  });
  child.stdin.on('error', error => fail(error));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const result = JSON.parse(line), entry = pending.get(result.id);
      assert.ok(entry, 'backend response matches an outstanding request');
      pending.delete(result.id);
      if (result.error) entry.reject(new Error(result.error)); else entry.resolve(result);
    } catch (error) { fail(error); }
  });
  return {
    async fetch(path, options = {}) {
      assert.ok(path.startsWith('/api/playbooks'), 'only the isolated playbook routes are reachable');
      if (failure) throw failure;
      const id = ++sequence;
      let timer;
      const result = await new Promise((resolve, reject) => {
        const done = callback => value => { clearTimeout(timer); callback(value); };
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        timer = setTimeout(() => { pending.delete(id); reject(new Error('Compatibility backend request exceeded 20 seconds')); }, 20000);
        child.stdin.write(JSON.stringify({ id, path, method: options.method ?? 'GET', headers: options.headers, ...(options.body ? { body: JSON.parse(options.body) } : {}) }) + '\n');
      });
      return new Response(result.text, { status: result.status, headers: result.headers });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); lines.close(); }
    },
  };
}

async function compilePersistence(target) {
  const output = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify(target) }, build: { write: false, lib: { entry: fileURLToPath(new URL('../frontend/src/features/playbook/api.ts', import.meta.url)), formats: ['es'], fileName: 'api' }, minify: false } });
  const code = (Array.isArray(output) ? output[0] : output).output[0].code;
  let client = 0;
  return () => import(`data:text/javascript;base64,${Buffer.from(code + `\n// compatibility ${target} client ${++client}`).toString('base64')}`);
}

// Only declared storage defaults are equivalent. Keep every executable field,
// roster order, attribute and participant ID; ignore generated identity/time.
function drawing(document) {
  const point = value => value ? { x: value.x, y: value.y } : null;
  const marker = (value, offense) => ({ id: value.id, ...point(value), badges: value.badges ?? [], ...(offense ? { ratings: { threePoint: 3, midrange: 3, finishing: 3, ...value.ratings } } : {}) });
  const arrow = (value, index) => ({
    id: value.id, kind: value.kind, sequence: value.sequence ?? index + 1, path: value.path ?? 'straight', timing: value.timing ?? 1.2,
    start: point(value.start), end: point(value.end), control: point(value.control), exit_target: point(value.exit_target),
    ...Object.fromEntries(['actor_id', 'recipient_id', 'screener_id', 'handler_id', 'cutter_id'].map(key => [key, value[key] ?? null])),
  });
  return {
    version: document.version, name: document.name, defenders_visible: document.defenders_visible,
    players: document.players.map(value => marker(value, true)), defenders: document.defenders.map(value => marker(value, false)), ball: point(document.ball),
    arrows: document.arrows.map(arrow),
    ...(document.branches ? { branches: document.branches.map(branch => ({
      id: branch.id, label: branch.label, fork: branch.fork, continuation: branch.continuation.map(arrow),
    })) } : {}),
  };
}
function bindings(document) {
  return bindAuthoredActions(document).map(action => ({
    id: action.arrow.id, sequence: action.sequence, kind: action.arrow.kind,
    actorId: action.actorId, recipientId: action.recipientId, partnerId: action.partnerId ?? null,
    plannedStart: action.plannedStart, recipientStart: action.recipientStart, partnerStart: action.partnerStart ? { x: action.partnerStart.x, y: action.partnerStart.y } : null, controlOffset: action.controlOffset,
    startTime: action.startTime, durationMs: action.durationMs, onBall: action.onBall,
  }));
}
// Route endpoints can carry copied marker attributes. Their effective defaults
// are checked above; replay geometry compares coordinates, not JSON decoration.
const replayPoint = value => value == null ? value : { x: value.x, y: value.y };
const replayRoute = route => ({ ...route,
  ...Object.fromEntries(['start', 'end', 'control', 'via'].filter(key => key in route).map(key => [key, replayPoint(route[key])])),
  ...(route.points ? { points: route.points.map(replayPoint) } : {}),
});
function simulate(document, settings) {
  const run = createSimulationRun(document, settings), samples = [];
  let first;
  const record = frame => {
    const positions = roster => roster.map(({ id, x, y }) => {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `${document.name}: finite replay position`);
      return { id, x, y };
    });
    const display = { ...frame, players: positions(frame.players), defenders: positions(frame.defenders),
      routes: frame.routes.map(replayRoute), ball: replayPoint(frame.ball), shotStart: replayPoint(frame.shotStart), shotTarget: replayPoint(frame.shotTarget),
      adaptiveReadRoute: frame.adaptiveReadRoute ? replayRoute(frame.adaptiveReadRoute) : null,
    };
    const observed = observeCounterLabRun(run);
    const observation = { ...observed, activeRoutes: observed.activeRoutes.map(replayRoute) };
    first ??= { display, observation };
    samples.push(createHash('sha256').update(JSON.stringify({ display, observation })).digest('hex'));
  };
  record(getSimulationFrame(run));
  while (run.elapsedMs < run.durationMs - 1e-6) {
    assert.ok(samples.length < 3601, `${document.name}: simulation completes within 120 seconds`);
    record(advanceSimulationRun(run, SIMULATION_STEP_MS));
  }
  const frame = getSimulationFrame(run);
  return { samples, first, final: { elapsedMs: run.elapsedMs, durationMs: run.durationMs, ballHandlerId: run.ballHandlerId, execution: frame.execution, shotPhase: frame.shotPhase, shotResult: frame.shotResult, shotQuality: frame.shotQuality } };
}
function compareTrials(actual, expected, label) {
  assert.deepEqual(actual.first, expected.first, `${label}: initial frame`);
  const mismatch = actual.samples.findIndex((sample, index) => sample !== expected.samples[index]);
  assert.equal(mismatch, -1, `${label}: first differing fixed-step replay/diagnostic sample ${mismatch}`);
  assert.equal(actual.samples.length, expected.samples.length, `${label}: retained sample count`);
  assert.deepEqual(actual.final, expected.final, `${label}: deterministic possession, action outcomes and shot quality`);
}

const previous = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'), locks: Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks') };
const restore = (object, key, descriptor) => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key];
const local = startLocalPersistence();
const branchSource = structuredClone(SAVE_SIMULATE_PLAYS[1]);
const branchFork = branchSource.document.arrows.find(arrow => arrow.id === 'slip-feed');
branchSource.document = { ...branchSource.document, name: `${branchSource.document.name} branches`, branches: [{
  id: 'ending-compat', label: 'Slip', fork: { actionIds: [branchFork.id], sequence: branchFork.sequence },
  continuation: branchSource.document.arrows.filter(arrow => arrow.sequence >= branchFork.sequence),
}] };
const compatibilityFixtures = [...SAVE_SIMULATE_PLAYS, branchSource];
try {
  installBrowserLocks();
  const roundTrips = new Map();
  for (const target of ['github-pages', 'local']) {
    const newClient = await compilePersistence(target);
    let stored = '[]';
    const window = new EventTarget();
    window.localStorage = {
      getItem(key) { assert.equal(key, 'arc-playbooks-v1'); return stored; },
      setItem(key, value) { assert.equal(key, 'arc-playbooks-v1'); stored = value; },
    };
    globalThis.window = window;
    globalThis.fetch = target === 'local' ? local.fetch : () => { throw new Error('Hosted persistence must not make API requests'); };
    const api = await newClient(), savedPlays = [];
    assert.deepEqual(await api.fetchPlaybooks(), [], `${target}: isolated library starts empty`);
    for (const fixture of compatibilityFixtures) {
      const source = structuredClone(fixture.document), before = structuredClone(source);
      const expected = drawing(normalizePlaybookPrecision(source));
      let saved = await api.createPlaybook(source);
      assert.notEqual(saved.id, source.id, `${target}: fresh saved identity`);
      for (let cycle = 0; cycle < 3; cycle++) {
        // A fresh module has no parsed-library cache or pending-read state.
        const reader = await newClient();
        const reopened = (await reader.fetchPlaybooks()).find(play => play.id === saved.id);
        assert.ok(reopened, `${target}: saved identity survives reload`);
        assert.deepEqual(drawing(reopened), expected, `${target}/${source.name}: save/reload cycle ${cycle}`);
        for (const [path, value] of fixture.precision ?? []) {
          assert.equal(path.split('.').reduce((node, key) => node[key], reopened), value, `${target}: supported precision ${path}`);
        }
        const bound = bindings(reopened);
        assert.deepEqual(bound.map(action => action.id), fixture.order, `${target}: stable action order and simultaneous ties`);
        assert.deepEqual(bound.map(action => action.actorId), fixture.actors, `${target}: explicit and legacy actor binding`);
        assert.deepEqual(bound, bindings(normalizePlaybookPrecision(source)), `${target}: every participant, planned point and action phase timing`);
        if (cycle < 2) saved = await api.updatePlaybook(reopened); else savedPlays.push(reopened);
      }
      assert.deepEqual(source, before, `${target}: persistence never mutates the caller's draft`);
    }
    roundTrips.set(target, savedPlays);
    console.log(`${target}: ${savedPlays.length} real API round trips, fresh-client reloads and repeated updates preserve drawing, precision and bindings`);
  }
  let comparisons = 0;
    for (const [index, fixture] of compatibilityFixtures.entries()) {
    const hosted = roundTrips.get('github-pages')[index], downloaded = roundTrips.get('local')[index];
    assert.deepEqual(drawing(hosted), drawing(downloaded), `${fixture.document.name}: cross-target persisted content`);
    assert.deepEqual(bindings(hosted), bindings(downloaded), `${fixture.document.name}: cross-target participant bindings`);
    for (const defenseStrategy of ['switch', 'drop']) for (const offenseMode of ['scripted', 'adaptive']) {
      const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy, offenseMode };
      const baseline = simulate(normalizePlaybookPrecision(fixture.document), settings);
      const label = `${fixture.document.name}/${defenseStrategy}/${offenseMode}`;
      if (fixture.document.name === 'handoff-possession' && offenseMode === 'scripted') {
        const handoff = baseline.final.execution.find(action => action.actionId === 'handoff');
        assert.equal(handoff?.phase, 'completed');
        assert.equal(handoff.transfer.receiverId, 8, 'the handoff targets the recorded recipient');
        assert.equal(handoff.transfer.outcome.kind, 'caught', 'the handoff fixture genuinely confirms a catch');
        assert.equal(baseline.final.shotPhase, 'result');
        assert.equal(baseline.final.ballHandlerId, null, 'a released shot no longer has a controller');
      }
      const first = simulate(hosted, settings);
      compareTrials(first, baseline, `${label}: hosted vs normalized source`);
      compareTrials(simulate(downloaded, settings), first, `${label}: local vs hosted`);
      compareTrials(simulate(hosted, settings), first, `${label}: deterministic rerun`);
      comparisons++;
    }
  }
  const hostedFamily = roundTrips.get('github-pages').at(-1);
  const hostedEnding = flattenPlaybookPath(hostedFamily, 'ending-compat', 'Slip');
  for (const target of ['github-pages', 'local']) {
    const family = roundTrips.get(target).at(-1);
    const ending = flattenPlaybookPath(family, 'ending-compat', 'Slip');
    assert.deepEqual(drawing(ending), drawing(hostedEnding), `${target}: selected ending resolves identically after family reload`);
    assert.deepEqual(bindings(ending), bindings(hostedEnding), `${target}: selected ending participant bindings survive persistence`);
    const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'switch', offenseMode: 'scripted' };
    compareTrials(simulate(ending, settings), simulate(hostedEnding, settings), `${target}: selected branch vs hosted flattened ending`);
  }
  console.log(`Save-and-simulate compatibility passed: ${comparisons} scenarios, exact fixed-step replay/diagnostic samples, execution outcomes, possession and quality; curves, slips, handoffs, simultaneous actions, precision, legacy and partial/empty rosters`);
} finally {
  await local.close();
  restore(globalThis, 'window', previous.window); restore(globalThis, 'fetch', previous.fetch); restore(globalThis.navigator, 'locks', previous.locks);
}
