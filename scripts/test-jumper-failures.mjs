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
  for (const scenario of ["gpu", "cancel", "storage", "unsupported"]) {
    const p = await browser.newPage();
    const errors = [],
      models = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("request", (r) => {
      if (/onnx|wasm|huggingface/.test(r.url())) models.push(r.url());
    });
    await p.addInitScript((s) => {
      window.workerCount = 0;
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
          "Selected video frame; click to add a mask point",
        );
        await frame.waitFor();
        await frame.focus();
        await frame.press("Enter");
        await p
          .getByRole("button", { name: "Process clip", exact: true })
          .click();
        if (scenario === "gpu")
          await expect(p.locator(".jumper-editor [role=alert]")).toContainText(
            "WebGPU is unavailable",
          );
        else {
          await p.getByRole("button", { name: "Cancel processing" }).click();
          await p.evaluate(() => window.finishAdapter());
          await expect(p.locator(".jumper-progress")).toContainText(
            "cancelled",
          );
        }
        await expect(
          p.getByRole("button", { name: "Process clip", exact: true }),
        ).toBeEnabled();
        expect(await p.evaluate(() => window.workerCount)).toBe(0);
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
