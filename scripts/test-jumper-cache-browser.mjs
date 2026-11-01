// Real WebGPU pipeline with test-only computation counters injected into the
// Vite-served worker. Nothing is added to production messages or the UI.
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const root =
  process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/";
const artifacts = process.env.JUMPER_ARTIFACTS || "/tmp/jumper-cache-browser";
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--use-angle=metal",
  ],
});
try {
  const page = await browser.newPage();
  await page.route(
    "**/src/features/jumper/masking.worker.ts",
    async (route) => {
      const response = await route.fetch();
      let source = await response.text();
      assert(source.includes("const result = await vision.run"));
      assert(source.includes("const boxes = await detector.detect"));
      source = source
        .replace(
          "const result = await vision.run",
          'postMessage({kind:"test-computation",calculation:"vision"}); const result = await vision.run',
        )
        .replace(
          "const boxes = await detector.detect",
          'postMessage({kind:"test-computation",calculation:"detection"}); const boxes = await detector.detect',
        );
      await route.fulfill({ response, body: source });
    },
  );
  await page.goto(root);
  const bytes = Array.from(
    await readFile(
      process.env.JUMPER_FIXTURE || "/tmp/jumper-regression-short.mp4",
    ),
  );
  const results = [];
  for (const [name, corrected] of [
    ["cold", false],
    ["warm", false],
    ["corrected-warm", true],
    ["corrected-cold", true],
  ]) {
    if (name === "corrected-cold")
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const r = indexedDB.deleteDatabase("arc-jumper-frame-cache-v1");
            r.onsuccess = resolve;
            r.onerror = reject;
          }),
      );
    const value = await page.evaluate(
      async ({ bytes, name, corrected }) => {
        const file = new File([new Uint8Array(bytes)], "private.mp4", {
          type: "video/mp4",
        });
        const request = {
          start: 0,
          end: 0.3,
          target_id: 1,
          presentation: "silhouette",
          auto_detect_others: true,
          objects: [
            {
              id: 1,
              prompts: [
                { frame: 0, points: [[0.485, 0.482]], labels: [1] },
                ...(corrected
                  ? [{ frame: 3, points: [[0.45, 0.482]], labels: [0] }]
                  : []),
              ],
            },
          ],
        };
        const worker = new Worker(
          new URL("src/features/jumper/masking.worker.ts", location.href),
          { type: "module" },
        );
        const counts = { vision: 0, detection: 0 };
        const started = performance.now();
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("Worker deadline")),
              180000,
            );
            worker.onerror = (e) => {
              clearTimeout(timer);
              reject(Error(e.message));
            };
            worker.onmessage = async ({ data }) => {
              if (data.kind === "test-computation") {
                counts[data.calculation]++;
                return;
              }
              if (data.kind === "error") {
                clearTimeout(timer);
                reject(Error(data.error));
              }
              if (data.kind === "done") {
                clearTimeout(timer);
                resolve({
                  name,
                  counts,
                  seconds: (performance.now() - started) / 1000,
                  warnings: data.result.warnings,
                  bytes: Array.from(
                    new Uint8Array(await data.result.quiz.arrayBuffer()),
                  ),
                });
              }
            };
            worker.postMessage({ kind: "process", id: name, file, request });
          });
        } finally {
          worker.terminate();
        }
      },
      { bytes, name, corrected },
    );
    await writeFile(`${artifacts}/${name}.mp4`, new Uint8Array(value.bytes));
    delete value.bytes;
    results.push(value);
    console.log(value);
  }
  assert(results[0].counts.vision > 0);
  for (const result of results.slice(1, 3)) {
    assert.equal(result.counts.vision, 0, "Vision recomputed");
    assert.equal(result.counts.detection, 0, "Detection recomputed");
  }
  assert(results[3].counts.vision > 0);
  assert.deepEqual(results[0].warnings, results[1].warnings);
  assert.deepEqual(results[2].warnings, results[3].warnings);
  console.log(
    "PASS real WebGPU cold/warm/corrected encoder and detection reuse; exported outputs ready for independent parity checks",
  );
  await page.evaluate(async () => {
    const { FrameCache, FRAME_CACHE_BYTES } = await import(
      new URL("src/features/jumper/frameCache.ts", location.href).href
    );
    const source = new Blob(["cache contract"]);
    const settings = { trim: [0, 1], model: "v1", fps: 30 };
    const a = await FrameCache.open(source, settings);
    const b = await FrameCache.open(source, settings);
    if (!a || !b) throw Error("Cache did not open");
    await a.put("contract", { numbers: new Float32Array([1, 2, 3]) }, 12);
    const first = await b.get("contract");
    first.numbers[0] = 99;
    if ((await a.get("contract")).numbers[0] !== 1)
      throw Error("Cache aliased mutable data");
    b.close();
    const changed = await FrameCache.open(source, { ...settings, model: "v2" });
    if (await changed.get("contract")) throw Error("Model invalidation failed");
    changed.close();
    const other = await FrameCache.open(
      new Blob(["different content"]),
      settings,
    );
    if (await other.get("contract")) throw Error("Source invalidation failed");
    other.close();
    const trim = await FrameCache.open(source, { ...settings, trim: [0.1, 1] });
    if (await trim.get("contract")) throw Error("Trim invalidation failed");
    trim.close();
    if (await a.canPut("oversized", FRAME_CACHE_BYTES + 1))
      throw Error("Oversized admission");
    a.close();
    const open = indexedDB.open;
    indexedDB.open = () => {
      throw new DOMException("Denied", "SecurityError");
    };
    try {
      if (await FrameCache.open(source, settings))
        throw Error("Denied storage not ignored");
    } finally {
      indexedDB.open = open;
    }
  });
  console.log(
    "PASS browser IDB persistence, independent snapshots, model/source/trim invalidation, oversized admission and denied-storage fallback",
  );
} finally {
  await browser.close();
}
