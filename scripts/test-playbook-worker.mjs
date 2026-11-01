import assert from 'node:assert/strict';
import { createPlaybookSimulationHost } from '../frontend/src/features/playbook/playbookSimulationHost.ts';
import { createPlaybookSimulationClient, MAX_PENDING_ADVANCE_MS } from '../frontend/src/features/playbook/playbookSimulationClient.ts';
import { parseSimulationCommand, parseSimulationResponse } from '../frontend/src/features/playbook/playbookSimulationProtocol.ts';
import { createSimulationRun, advanceSimulationState, getSimulationFrame, setSimulationRunSettings, editPausedSimulationMarker, rebasePausedSimulation } from '../frontend/src/features/playbook/simulation.ts';
import { getSimulationSessionInfo, seekSimulationSession } from '../frontend/src/features/playbook/simulationSession.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';

const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'auto' };
const drawing = STARTER_PLAYS[0];
const clone = structuredClone;
function harness() {
  const host = createPlaybookSimulationHost(); let revision = 0, requestId = 0;
  return body => {
    if (body.type !== 'frame') revision++;
    const command = { ...body, sessionId: 'worker-parity', revision, requestId: ++requestId };
    const response = clone(host(clone(command)));
    parseSimulationResponse(response);
    assert.equal(response.type, 'state', response.message);
    return response.view;
  };
}
let frames = 0;
// The exact same fixed-step engine runs on the other side of the message
// boundary: full display snapshots AND checkpoint/session bookkeeping match.
for (const source of STARTER_PLAYS) for (const offenseMode of ['scripted', 'adaptive']) {
  const config = { ...settings, offenseMode };
  const send = harness(), run = createSimulationRun(source, config, undefined, { recordSession: true, seed: 715 });
  const compare = view => {
    assert.deepEqual(view.frame, getSimulationFrame(run));
    assert.deepEqual(view.session, getSimulationSessionInfo(run));
    assert.deepEqual(view.settings, run.settings); assert.equal(view.durationMs, run.durationMs); frames++;
  };
  compare(send({ type: 'start', drawing: source, settings: config, seed: 715 }));
  for (let n = 0; n < 400 && run.elapsedMs < run.durationMs; n++) {
    const deltaMs = [1000 / 120, 1000 / 60, 1000 / 30, 50][n % 4];
    advanceSimulationState(run, deltaMs);
    compare(send({ type: 'frame', deltaMs }));
    if (n === 15) {
      compare(send({ type: 'playback', playing: false }));
      compare(send({ type: 'frame', deltaMs: 50 })); // no execution while paused
      const next = { ...config, offBallIntensity: 24 };
      setSimulationRunSettings(run, next); compare(send({ type: 'settings', settings: next }));
      const edit = clone(source); edit.players[0].ratings = { threePoint: 5, midrange: 2, finishing: 3 };
      rebasePausedSimulation(run, edit); compare(send({ type: 'edit', drawing: edit }));
      const point = { x: 45, y: 70 }; edit.players[0] = { ...edit.players[0], ...point };
      editPausedSimulationMarker(run, 'player', edit.players[0].id, point, edit);
      compare(send({ type: 'edit', drawing: edit, relocation: { type: 'player', id: edit.players[0].id, point } }));
      compare(send({ type: 'playback', playing: true }));
    }
  }
  const end = getSimulationSessionInfo(run).positionMs;
  for (const timeMs of [0, end * .43, end, 0]) { seekSimulationSession(run, timeMs); compare(send({ type: 'seek', timeMs })); }
  compare(send({ type: 'playback', playing: true }));
  for (let n = 0; n < 20; n++) { advanceSimulationState(run, 1000 / 60); compare(send({ type: 'frame', deltaMs: 1000 / 60 })); }
}

// Runtime boundaries, including cross-session and stale commands, cannot
// mutate a healthy run. Accepted execution failures pause rather than corrupt it.
const host = createPlaybookSimulationHost();
const start = { type: 'start', drawing, settings, seed: 1, sessionId: 'validation', revision: 1, requestId: 1 };
const initial = clone(host(start)); parseSimulationResponse(initial);
for (const invalid of [null, {}, { ...start, type: 'unknown' }, { ...start, revision: NaN },
  { ...start, settings: { ...settings, offBallIntensity: Infinity } }, { ...start, drawing: { ...drawing, players: null } },
  { ...start, type: 'frame', deltaMs: NaN }, { ...start, type: 'frame', deltaMs: 51 },
  { ...start, type: 'playback', playing: 'false' }, { ...start, type: 'seek', timeMs: -1 },
  { ...start, type: 'edit', relocation: { type: 'player', id: 1, point: { x: NaN, y: 1 } } },
]) assert.throws(() => parseSimulationCommand(invalid));
for (const command of [{ ...start, type: 'frame', deltaMs: 25, sessionId: 'old', requestId: 2 },
  { ...start, type: 'frame', deltaMs: 25, revision: 0, requestId: 3 },
  { ...start, type: 'playback', playing: false, requestId: 4 }]) assert.equal(host(command).type, 'error');
assert.equal(host({ ...start, type: 'frame', deltaMs: 25, requestId: 5 }).view.playing, true);
for (const corrupt of [v => v.frame.players[0].x = NaN, v => v.session.positionMs = Infinity,
  v => v.frame.routes = [{ id: 'bad' }], v => v.frame.shotPhase = 'broken',
  v => v.frame.ballHandlerId = 999, v => v.settings.automaticActions.screen = 'yes',
  v => v.session.engineVersion = -1, v => v.frame.execution = [{}]]) {
  const message = clone(initial); corrupt(message.view); assert.throws(() => parseSimulationResponse(message));
}

class FakeWorker extends EventTarget {
  pending = []; sent = []; dead = false; execute = createPlaybookSimulationHost();
  postMessage(command) { this.sent.push(clone(command)); this.pending.push(clone(command)); }
  terminate() { this.dead = true; }
  respond() { assert.equal(this.pending.length, 1, 'at most one outstanding message'); const response = clone(this.execute(this.pending.shift())); this.emit(response); return response; }
  emit(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
function clientHarness(timeoutMs = 2000) {
  const worker = new FakeWorker(), views = [], failures = [];
  const client = createPlaybookSimulationClient({ sessionId: 'client-test', createWorker: () => worker, onState: view => views.push(view), onFailure: m => failures.push(m), timeoutMs });
  client.start(drawing, settings, 1);
  return { worker, client, views, failures };
}
const flushMicrotasks = () => new Promise(resolve => queueMicrotask(resolve));

{
  const { worker, client, views, failures } = clientHarness();
  client.playback(false); client.playback(true); client.playback(false);
  worker.respond(); assert.equal(views.length, 0, 'start cannot overwrite the newer pause');
  assert.equal(worker.pending.length, 1); assert.equal(worker.pending[0].playing, false);
  worker.respond(); assert.equal(views.at(-1).playing, false);
  client.playback(true); worker.respond();
  client.advance(16); for (let n = 0; n < 1000; n++) client.advance(16);
  assert.equal(worker.pending.length, 1, 'no frame backlog');
  let elapsed = 0;
  while (worker.pending.length) { const c = worker.pending[0]; elapsed += c.deltaMs; worker.respond(); }
  assert.equal(elapsed, 16 + MAX_PENDING_ADVANCE_MS, 'bounded catch-up after a delayed frame');
  client.advance(16); const stale = clone(worker.execute(worker.pending.shift()));
  const edit = clone(drawing); edit.players[0].x = 40;
  client.edit(edit, { type: 'player', id: edit.players[0].id, point: { x: 40, y: edit.players[0].y } });
  for (let n = 0; n < 100; n++) {
    const next = clone(edit); next.players[0].x = 40 + n / 100;
    client.edit(next, { type: 'player', id: next.players[0].id, point: { x: next.players[0].x, y: next.players[0].y } });
  }
  const previous = views.at(-1);
  worker.emit({ ...stale, sessionId: 'previous-session' }); assert.equal(worker.pending.length, 0);
  worker.emit(stale); assert.strictEqual(views.at(-1), previous, 'old revision never replaces a paused edit');
  assert.equal(worker.pending.length, 1); assert.equal(worker.pending[0].drawing.players[0].x, 40.99);
  worker.respond(); assert.equal(views.at(-1).frame.players[0].x, 40.99);
  const accepted = views.at(-1); worker.emit(stale); assert.strictEqual(views.at(-1), accepted);
  client.dispose(); worker.emit(stale); assert.strictEqual(views.at(-1), accepted); assert.equal(worker.dead, true); assert.deepEqual(failures, []);
}

for (const hz of [30, 60, 120]) {
  const { worker, client, views } = clientHarness(); worker.respond();
  const direct = createSimulationRun(drawing, settings, undefined, { recordSession: true, seed: 1 });
  for (let n = 0; n < hz; n++) { client.advance(1000 / hz); worker.respond(); advanceSimulationState(direct, 1000 / hz); }
  assert.deepEqual(views.at(-1).frame, getSimulationFrame(direct));
  client.dispose();
}

for (const event of ['error', 'messageerror', 'timeout', 'malformed', 'overflow', 'post-failure']) {
  const { worker, client, views, failures } = clientHarness(event === 'timeout' ? 15 : 2000); worker.respond();
  const last = clone(views.at(-1));
  if (event === 'post-failure') { worker.postMessage = () => { throw new Error('terminated'); }; client.advance(16); }
  else if (event === 'timeout') { client.advance(16); await new Promise(resolve => setTimeout(resolve, 30)); }
  else if (event === 'malformed') { client.advance(16); const raw = worker.execute(worker.pending.shift()); raw.view.frame.players[0].x = NaN; worker.emit(raw); }
  else if (event === 'overflow') { client.advance(16); for (let n = 0; n < 40; n++) { client.seek(0); client.playback(true); } }
  else worker.dispatchEvent(new Event(event));
  await flushMicrotasks();
  assert.equal(failures.length, 1, event); assert.match(failures[0], /intact/); assert.equal(worker.dead, true);
  assert.deepEqual(views.at(-1), last, `${event}: preserve last valid frame`);
  client.advance(16); client.playback(true); await flushMicrotasks(); assert.equal(failures.length, 1);
}
console.log(`Playbook worker: ${frames} exact engine snapshots across 24 starters/both modes; protocol, stale messages, bounded queues, 30/60/120 Hz, pause/edit/seek and failure recovery passed.`);
