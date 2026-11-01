// Exercise the real worker's admission path with simulated limited hardware.
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
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
  const modelRequests = [];
  page.on("request", (r) => {
    if (/\.onnx|\.pt(?:\?|$)|huggingface|fbaipublicfiles/.test(r.url()))
      modelRequests.push(r.url());
  });
  await page.route(
    "**/src/features/jumper/masking.worker.ts",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body:
          'Object.defineProperty(navigator,"deviceMemory",{value:0.5});\n' +
          (await response.text()),
      });
    },
  );
  await page.goto(
    process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/",
  );
  const bytes = Array.from(
    await readFile(
      new URL("../tests/fixtures/jumper/research-short.mp4", import.meta.url),
    ),
  );
  const result = await page.evaluate(async (bytes) => {
    const worker = new Worker(
      new URL("src/features/jumper/masking.worker.ts", location.href),
      { type: "module" },
    );
    const stages = [];
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Preflight timed out")),
          20000,
        );
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(Error(e.message));
        };
        worker.onmessage = ({ data }) => {
          if (data.kind === "progress")
            stages.push(data.stage ?? data.progress?.stage);
          if (data.kind === "error") {
            clearTimeout(timer);
            resolve({ error: data.error, stages });
          }
          if (data.kind === "done") {
            clearTimeout(timer);
            reject(Error("Oversized workload accepted"));
          }
        };
        worker.postMessage({
          kind: "process",
          id: "limited-memory",
          file: new File([new Uint8Array(bytes)], "private.mp4", {
            type: "video/mp4",
          }),
          request: {
            start: 0,
            end: 0.3,
            target_id: 1,
            auto_detect_others: true,
            presentation: "silhouette",
            objects: [
              {
                id: 1,
                prompts: [{ frame: 0, points: [[0.485, 0.482]], labels: [1] }],
              },
            ],
          },
        });
      });
    } finally {
      worker.terminate();
    }
  }, bytes);
  assert.match(result.error, /working memory/);
  assert.match(result.error, /shorter segment/);
  assert.equal(modelRequests.length, 0, JSON.stringify(modelRequests));
  console.log(JSON.stringify({ result, modelRequests: modelRequests.length }));
} finally {
  await browser.close();
}
