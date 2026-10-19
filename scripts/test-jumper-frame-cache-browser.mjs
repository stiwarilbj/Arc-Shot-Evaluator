import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require('../frontend/node_modules/@playwright/test');
const server = await createServer({ root: fileURLToPath(new URL('../frontend', import.meta.url)),
  configFile: false, server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.route(`${origin}/cache-test`, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(`${origin}/cache-test`);
  const result = await page.evaluate(async () => {
    const { FrameCache } = await import('/src/features/jumper/frameCache.ts');
    const cache = await FrameCache.open(new Blob(['source']), { model: 'verified' });
    const other = await FrameCache.open(new Blob(['other source']), { model: 'verified' });
    if (!cache || !other) throw Error('IndexedDB unavailable');
    const shapes = { feats0: [1,32,256,256], feats1: [1,64,128,128], feats2: [1,256,64,64], pos2: [1,256,64,64] };
    const valid = Object.fromEntries(Object.entries(shapes).map(([key,dims]) => [key,{ dims, data:new Float32Array(dims.reduce((a,b)=>a*b,1)) }]));
    const size = 512 + Object.values(valid).reduce((sum,item)=>sum+item.data.byteLength,0);
    await cache.put('features:1', valid, size);
    await other.put('features:0', valid, size);
    // Verify both object stores, since stale meta could still consume admission budget.
    const keys = async store => {
      const opening = indexedDB.open('arc-jumper-frame-cache-v1');
      const db = await new Promise((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)});
      try { return await new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAllKeys();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)}); }
      finally { db.close(); }
    };
    const retained = { meta: await keys('meta'), values: await keys('values') };
    for (const kind of ['shape','nan','infinity','layout']) {
      const bad = structuredClone(valid);
      if (kind === 'shape') bad.feats0.dims = [1,1,1,1];
      if (kind === 'nan') bad.feats0.data[0] = NaN;
      if (kind === 'infinity') bad.feats0.data[0] = Infinity;
      if (kind === 'layout') bad.feats0.data = new Float64Array(bad.feats0.data.length);
      await cache.put('features:0', bad, size * 2);
      if (await cache.getFeatures('features:0') !== undefined) throw Error(`Accepted ${kind}`);
      if (await cache.get('features:0') !== undefined) throw Error(`Retained ${kind}`);
      for (const store of ['meta','values']) {
        if (JSON.stringify(await keys(store)) !== JSON.stringify(retained[store])) throw Error(`Wrong ${store} deletion`);
      }
    }
    if (!await cache.getFeatures('features:1') || !await other.getFeatures('features:0')) throw Error('Neighbor or scope removed');
    await cache.put('features:0', valid, size);
    if (!await cache.getFeatures('features:0')) throw Error('Cannot cache recomputed features');
    await cache.remove('missing');
    cache.close();
    await cache.remove('features:0'); // Closed storage must not interrupt inference.
    other.close();
    return true;
  });
  assert.equal(result, true);
  console.log('Real IndexedDB: invalid features removed from both stores; neighbors/scopes retained, replacements accepted, storage failure tolerated');
} finally { await browser?.close(); await server.close(); }
