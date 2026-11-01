import assert from 'node:assert/strict';
import { WorkerJob, WorkerInterruptedError } from '../frontend/src/features/jumper/workerJob.ts';
import { installWorkerControl } from '../frontend/src/features/jumper/workerControl.ts';
const keys = ['performance', 'document', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const set = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
let now = 0, next = 0;
const timers = new Map();
const document = new EventTarget(); document.hidden = false;
try {
  set('performance', { now: () => now }); set('document', document);
  for (const [key, repeat] of [['setTimeout', false], ['setInterval', true]]) {
    set(key, (fn, delay) => { const id = ++next; timers.set(id, { fn, delay, repeat, at: now + delay }); return id; });
  }
  set('clearInterval', id => timers.delete(id)); set('clearTimeout', id => timers.delete(id));
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, t] = entry; now = t.at;
      if (t.repeat) t.at += t.delay; else timers.delete(id);
      t.fn();
    }
    now = end;
  }
  function fixture() {
    const sent = [], errors = [], abort = new AbortController();
    const worker = { postMessage: value => sent.push(value), terminate() { this.terminated++; }, terminated: 0 };
    const job = new WorkerJob(worker, String(next++), abort.signal, error => errors.push(error));
    job.start({ kind: 'process', id: job.id });
    return { sent, errors, abort, worker, job };
  }
  const good = fixture();
  for (let i = 0; i < 40; i++) { advance(10000); assert(good.job.receive({ id: good.job.id, kind: 'job-pong' })); }
  assert(good.job.active, 'Live long-running work has no arbitrary whole-job deadline');
  assert(good.job.finish('completed')); assert.equal(good.worker.terminated, 1);
  assert(good.job.receive({ id: good.job.id, kind: 'done' }));
  assert.equal(timers.size, 0);

  const cancelled = fixture(); cancelled.abort.abort();
  assert.equal(cancelled.sent.at(-1).kind, 'job-cancel');
  assert.equal(cancelled.job.reason, undefined, 'Intent is not a completed cancellation handshake');
  assert(cancelled.job.receive({ id: cancelled.job.id, kind: 'done' }));
  cancelled.job.receive({ id: cancelled.job.id, kind: 'job-cancelled' });
  assert.equal(cancelled.job.reason, 'cancelled'); assert.equal(cancelled.errors[0].name, 'AbortError');
  advance(3000); assert.equal(cancelled.errors.length, 1);

  const missingAck = fixture(); missingAck.abort.abort(); advance(2000);
  assert.equal(missingAck.job.reason, 'interrupted'); assert(missingAck.errors[0] instanceof WorkerInterruptedError);
  assert.equal(missingAck.worker.terminated, 1);
  missingAck.job.receive({ id: missingAck.job.id, kind: 'job-cancelled' });
  assert.equal(missingAck.job.reason, 'interrupted');

  const crash = fixture(); crash.abort.abort(); crash.worker.onerror();
  assert.equal(crash.job.reason, 'interrupted'); assert.equal(crash.errors.length, 1);
  const closed = fixture(); advance(130000);
  assert.equal(closed.job.reason, 'interrupted'); assert.equal(closed.errors.length, 1);
  const foreign = fixture(); advance(110000);
  foreign.job.receive({ id: 'old-job', kind: 'job-pong' }); advance(20000);
  assert.equal(foreign.job.reason, 'interrupted', 'Stale replies cannot keep another job alive');

  const hidden = fixture(); document.hidden = true; advance(300000);
  assert(hidden.job.active); document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  advance(110000); assert(hidden.job.active); hidden.job.finish('failed');
  assert.equal(timers.size, 0);

  const controller = new AbortController(); controller.abort();
  let rejected;
  const unopened = new WorkerJob({ terminate() {}, postMessage() { assert.fail('Cancelled startup must not launch'); } },
    'unopened', controller.signal, error => rejected = error);
  unopened.start({}); assert.equal(unopened.reason, 'cancelled'); assert.equal(rejected.name, 'AbortError');
  assert.equal(timers.size, 0);
  let deadlineError;
  const deadline = new WorkerJob({ terminate() {}, postMessage() {} }, 'deadline',
    new AbortController().signal, error => deadlineError = error, 1000);
  deadline.start({}); advance(1000);
  assert.equal(deadline.reason, 'interrupted'); assert.match(deadlineError.message, /timed out/);
  assert.equal(timers.size, 0);

  const scope = new EventTarget(), replies = []; scope.postMessage = value => replies.push(value);
  installWorkerControl(scope); let normal = 0;
  scope.addEventListener('message', () => normal++);
  for (const kind of ['job-ping', 'job-cancel', 'process']) scope.dispatchEvent(new MessageEvent('message', { data: { id: 'job', kind } }));
  assert.equal(normal, 1); assert.deepEqual(replies, [{ id: 'job', kind: 'job-pong' }, { id: 'job', kind: 'job-cancelled' }]);
} finally {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
console.log('Worker recovery: completed/cancelled/failed/interrupted, missing acknowledgment, silent closure, stale replies, hidden tabs and cleanup passed');
