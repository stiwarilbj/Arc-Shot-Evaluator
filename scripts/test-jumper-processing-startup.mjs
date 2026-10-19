import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';

const root = fileURLToPath(new URL('../frontend', import.meta.url));
const original = Object.fromEntries(['Worker', 'fetch', 'navigator', 'VideoEncoder'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const set = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
try {
  for (const hosted of [true, false]) {
    const server = await createServer({ root, configFile: false, server: { middlewareMode: true },
      define: { 'import.meta.env.VITE_DEPLOY_TARGET': JSON.stringify(hosted ? 'github-pages' : 'local') } });
    try {
      const { processVideo } = await server.ssrLoadModule('/src/features/jumper/processing.ts');
      const { ShooterSelectionCache } = await server.ssrLoadModule('/src/features/jumper/shooterSelection.ts');
      const { buildFrameMap } = await server.ssrLoadModule('/src/features/jumper/sourceFrames.ts');
      const request = { start: 0, end: .1, target_id: 1, auto_detect_others: false,
        objects: [{ id: 1, prompts: [{ frame: 0, box: [.1, .1, .5, .9] }] }],
        frame_map: buildFrameMap([{ timestamp: 0, duration: .1 }], 0, .1) };
      const file = new File(['private'], 'shot.mp4');
      set('navigator', { gpu: { requestAdapter: async () => ({}) } });
      set('VideoEncoder', class {});
      let created, terminated, posted, fetched, onCreate, onFetch, onPost;
      const reset = () => { created = terminated = posted = fetched = 0; onCreate = onFetch = onPost = undefined; };
      set('Worker', class {
        constructor() { created++; onCreate?.(); }
        terminate() { terminated++; }
        postMessage() { posted++; onPost?.(); }
      });
      set('fetch', async (...args) => {
        fetched++;
        return onFetch ? onFetch(...args) : Promise.reject(Error('Unexpected upload'));
      });
      const resolve = ShooterSelectionCache.prototype.resolve;
      try {
        // Fire after preparation resolves but before processVideo's continuation.
        reset();
        const handoff = new AbortController();
        ShooterSelectionCache.prototype.resolve = async (...args) => {
          const result = await resolve.apply(new ShooterSelectionCache(), args);
          queueMicrotask(() => handoff.abort());
          return result;
        };
        await assert.rejects(processVideo(file, request, () => {}, handoff.signal), { name: 'AbortError' });
        assert.equal(created, 0); assert.equal(fetched, 0);
        ShooterSelectionCache.prototype.resolve = resolve;

        reset();
        const controller = new AbortController();
        if (hosted) {
          // Abort before the listener exists: adding it cannot replay the event.
          onCreate = () => controller.abort();
          await assert.rejects(processVideo(file, request, () => {}, controller.signal), { name: 'AbortError' });
          assert.equal(created, 1); assert.equal(terminated, 1); assert.equal(posted, 0);

          // Normal cancellation after registration still cleans up exactly once.
          reset();
          const active = new AbortController();
          const add = active.signal.addEventListener.bind(active.signal);
          active.signal.addEventListener = (...args) => { add(...args); active.abort(); };
          await assert.rejects(processVideo(file, request, () => {}, active.signal), { name: 'AbortError' });
          assert.equal(terminated, 1); assert.equal(posted, 0);

          reset();
          const running = new AbortController();
          onPost = () => running.abort();
          await assert.rejects(processVideo(file, request, () => {}, running.signal), { name: 'AbortError' });
          assert.equal(posted, 1); assert.equal(terminated, 1);
        } else {
          // A progress callback may synchronously cancel before the upload.
          await assert.rejects(processVideo(file, request, () => controller.abort(), controller.signal), { name: 'AbortError' });
          assert.equal(fetched, 0);

          reset();
          // Ordinary uncancelled startup must still start the real API path.
          await assert.rejects(processVideo(file, request, () => {}, new AbortController().signal), /Unexpected upload/);
          assert.equal(fetched, 1);

          reset();
          const polling = new AbortController();
          const id = '12345678-1234-1234-1234-123456789abc';
          const paths = [];
          onFetch = async (path, init) => {
            paths.push([path, init.method]);
            return Response.json(path.endsWith('/jobs') ? { id } :
              { id, status: 'processing', stage: 'Tracking', progress: .1 });
          };
          await assert.rejects(processVideo(file, request, value => {
            if (value.stage === 'Tracking') polling.abort();
          }, polling.signal), { name: 'AbortError' });
          assert.equal(paths.length, 4);
          assert.deepEqual(paths.at(-1), [`/api/jumper-lab/jobs/${id}`, 'DELETE']);
        }
      } finally { ShooterSelectionCache.prototype.resolve = resolve; }
    } finally { await server.close(); }
  }
} finally {
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
console.log('Processing startup: cancelled preparation handoff, missed abort event, active listener cleanup and local upload guards passed');
