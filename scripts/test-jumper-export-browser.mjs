// Real SAM/WebGPU masks; inject encoder faults only into the development worker.
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const root =
  process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/";
const artifacts = process.env.JUMPER_ARTIFACTS || "/tmp/jumper-export-browser";
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
let mode = "normal";
try {
  const page = await browser.newPage();
  await page.route(
    "**/src/features/jumper/masking.worker.ts",
    async (route) => {
      const response = await route.fetch();
      let source = await response.text();
      assert(source.includes("async function finishOutputs() {"));
      assert(source.includes("const owners = new Uint8Array(width * height),"));
      source =
        `let __failed=false; const __mode=${JSON.stringify(mode)};\n` +
        source
          .replace(
            "async function finishOutputs() {",
            'async function finishOutputs() { postMessage({kind:"test",event:"finish"}); if(__mode==="persistent" || (["finalize","manual","cancel"].includes(__mode) && !__failed)){__failed=true;throw Error("injected finalization failure");}',
          )
          .replace(
            "await validateFinishedVideo(",
            'if (__mode === "invalidPersistent" || (__mode === "invalid" && !__failed)) { __failed = true; blobs[i] = new Blob(["corrupt encoded output"]); } await validateFinishedVideo(',
          )
          .replace(
            "const owners = new Uint8Array(width * height),",
            'postMessage({kind:"test",event:"tracking"}); const owners = new Uint8Array(width * height),',
          )
          .replace(
            "await output.source.add(frame / 30, 1 / 30);",
            '{ if(__mode==="midstream" && !__failed && frame===3){__failed=true;throw Error("injected encoding failure");} await output.source.add(frame / 30, 1 / 30); }',
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
  for (mode of [
    "normal",
    "finalize",
    "midstream",
    "invalid",
    "invalidPersistent",
    "persistent",
    "manual",
    "cancel",
  ]) {
    const value = await page.evaluate(
      async ({ bytes, mode }) => {
        const worker = new Worker(
          new URL("src/features/jumper/masking.worker.ts", location.href),
          { type: "module" },
        );
        const events = [],
          stages = [];
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("Worker timed out")),
              180000,
            );
            worker.onerror = (e) => {
              clearTimeout(timer);
              reject(Error(e.message));
            };
            worker.onmessage = async ({ data }) => {
              if (data.kind === "test") events.push(data.event);
              if (data.kind === "progress") {
                stages.push(data.stage);
                if (
                  mode === "cancel" &&
                  data.stage === "Retrying export from completed masks"
                ) {
                  clearTimeout(timer);
                  worker.terminate();
                  resolve({ mode, events, stages, cancelled: true });
                  return;
                }
              }
              if (data.kind === "error") {
                clearTimeout(timer);
                resolve({ mode, events, stages, error: data.error });
              }
              if (data.kind === "done") {
                clearTimeout(timer);
                resolve({
                  mode,
                  events,
                  stages,
                  warnings: data.result.warnings,
                  ...(mode === "manual"
                    ? {
                        variants: await Promise.all(
                          [data.result.highlight, data.result.reveal].map(
                            async (blob) => [
                              ...new Uint8Array(await blob.arrayBuffer()),
                            ],
                          ),
                        ),
                      }
                    : {}),
                  bytes: Array.from(
                    new Uint8Array(await data.result.quiz.arrayBuffer()),
                  ),
                });
              }
            };
            worker.postMessage({
              kind: "process",
              id: mode,
              file: new File([new Uint8Array(bytes)], "private.mp4", {
                type: "video/mp4",
              }),
              request: {
                start: 0,
                end: 0.3,
                target_id: 1,
                presentation: mode === "manual" ? undefined : "silhouette",
                auto_detect_others: true,
                objects: [
                  {
                    id: 1,
                    prompts: [
                      { frame: 0, points: [[0.485, 0.482]], labels: [1] },
                    ],
                  },
                ],
              },
            });
          });
        } finally {
          worker.terminate();
        }
      },
      { bytes, mode },
    );
    assert.equal(
      value.events.filter((x) => x === "tracking").length,
      9,
      "segmentation repeated or dropped frames",
    );
    if (mode === "persistent" || mode === "invalidPersistent") {
      assert.match(
        value.error,
        mode === "persistent"
          ? /injected finalization/
          : /codec|decode|format/i,
      );
      assert.equal(
        value.events.filter((x) => x === "finish").length,
        2,
        "unbounded encoding retries",
      );
    } else if (mode === "cancel") assert(value.cancelled);
    else {
      assert(!value.error, value.error);
      await writeFile(`${artifacts}/${mode}.mp4`, new Uint8Array(value.bytes));
      delete value.bytes;
      if (value.variants) {
        for (const [i, variant] of value.variants.entries())
          await writeFile(
            `${artifacts}/manual-${i}.mp4`,
            new Uint8Array(variant),
          );
        delete value.variants;
      }
      if (mode !== "normal")
        assert(value.stages.includes("Retrying export from completed masks"));
    }
    console.log(
      JSON.stringify({
        ...value,
        stages: [
          ...new Set(
            value.stages.filter((stage) => !stage.startsWith("Downloading")),
          ),
        ],
      }),
    );
    results.push(value);
  }
  assert.deepEqual(results[0].warnings, results[1].warnings);
  assert.deepEqual(results[0].warnings, results[2].warnings);
  console.log(
    "PASS real WebGPU normal/finalize/midstream/invalid-file exports, identical tracking counts, bounded repeated failure and worker cancellation",
  );
} finally {
  await browser.close();
}
