import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  chromium,
  expect,
} = require("../frontend/node_modules/@playwright/test");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal"],
});
try {
  for (const scenario of [
    "gpu",
    "cancel",
    "storage",
    "unsupported",
    "worker-post",
    "worker-message",
    "worker-invalid",
    "worker-variants",
  ]) {
    const p = await browser.newPage();
    const errors = [],
      models = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("request", (r) => {
      if (/onnx|wasm|huggingface/.test(r.url())) models.push(r.url());
    });
    await p.addInitScript((s) => {
      window.workerCount = 0;
      window.terminatedWorkers = 0;
      const Original = Worker;
      window.Worker = class extends Original {
        constructor(...args) {
          super(...args);
          window.workerCount++;
        }
      };
      if (s === "gpu") navigator.gpu.requestAdapter = async () => null;
      if (s === "cancel")
        navigator.gpu.requestAdapter = () =>
          new Promise((resolve) => (window.finishAdapter = () => resolve({})));
      if (s === "storage")
        indexedDB.open = () => {
          throw new DOMException("Storage unavailable", "SecurityError");
        };
      if (s === "unsupported") delete globalThis.VideoEncoder;
      if (s.startsWith("worker-")) {
        navigator.gpu.requestAdapter = async () => ({});
        window.Worker = class {
          constructor() {
            window.workerCount++;
          }
          terminate() {
            window.terminatedWorkers++;
          }
          postMessage(value) {
            if (s === "worker-post")
              throw new DOMException("Cannot clone", "DataCloneError");
            setTimeout(() => {
              if (s === "worker-message") this.onmessageerror?.({});
              else if (s === "worker-variants") {
                const quiz = new Blob(["masked"], { type: "video/mp4" });
                const original = new Blob(["original"], { type: "video/mp4" });
                this.onmessage?.({
                  data: {
                    kind: "done",
                    id: value.id,
                    result: {
                      highlight: original,
                      quiz,
                      reveal: original,
                      duration: 0.3,
                      warnings: [],
                      objects: value.request.objects,
                    },
                  },
                });
              } else
                this.onmessage?.({
                  data: { id: value.id, kind: "unexpected" },
                });
            }, 0);
          }
        };
      }
    }, scenario);
    await p.goto(
      process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/",
    );
    await p.getByRole("button", { name: /Others/ }).click();
    await p.getByRole("menuitem").click();
    if (scenario === "storage") {
      await expect(
        p.getByRole("button", { name: "Retry library" }),
      ).toBeVisible();
      await expect(
        p.getByRole("button", { name: "Retry history" }),
      ).toBeVisible();
    } else {
      await p.getByRole("button", { name: "Create", exact: true }).click();
      await p.locator(".jumper-upload input").waitFor();
      if (scenario === "unsupported") {
        await expect(p.locator(".jumper-upload input")).toBeDisabled();
      } else {
        await p
          .locator(".jumper-upload input")
          .setInputFiles(
            new URL(
              "../tests/fixtures/jumper/research-short.mp4",
              import.meta.url,
            ).pathname,
          );
        await p.getByPlaceholder("e.g. Stephen Curry").fill("Test");
        const frame = p.getByAltText(
          "Selected video frame; click to aim a mask point",
        );
        await frame.waitFor();
        await frame.focus();
        await frame.press("ArrowRight");
        await frame.press("Enter");
        await p
          .getByRole("button", { name: "Process clip", exact: true })
          .click();
        if (scenario === "gpu")
          await expect(p.locator(".jumper-editor [role=alert]")).toContainText(
            "WebGPU is unavailable",
          );
        else if (scenario.startsWith("worker-")) {
          await expect(
            p.locator(".jumper-editor-controls [role=alert]"),
          ).toContainText(
            scenario === "worker-post"
              ? "Could not send the video"
              : scenario === "worker-message"
                ? "response could not be read"
                : scenario === "worker-variants"
                  ? "invalid videos"
                  : "invalid response",
          );
        } else {
          await p.getByRole("button", { name: "Cancel processing" }).click();
          await p.evaluate(() => window.finishAdapter());
          await expect(p.locator(".jumper-progress")).toContainText(
            "cancelled",
          );
        }
        await expect(
          p.getByRole("button", { name: "Process clip", exact: true }),
        ).toBeEnabled();
        if (scenario.startsWith("worker-")) {
          expect(await p.evaluate(() => window.workerCount)).toBeGreaterThan(0);
          expect(
            await p.evaluate(
              () => window.workerCount === window.terminatedWorkers,
            ),
          ).toBe(true);
        } else expect(await p.evaluate(() => window.workerCount)).toBe(0);
      }
    }
    expect(errors).toHaveLength(0);
    expect(models).toHaveLength(0);
    console.log("PASS", scenario);
    await p.close();
  }
} finally {
  await browser.close();
}
