import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const {
  chromium,
  expect,
} = require("../frontend/node_modules/@playwright/test");
const artifacts =
  process.env.JUMPER_ARTIFACTS || path.join(tmpdir(), "arc-jumper-browser");
mkdirSync(artifacts, { recursive: true });
const fixture = new URL(
  "../tests/fixtures/jumper/research-shot.mp4",
  import.meta.url,
).pathname;
// Explicit browser fallback: Browser plugin unavailable in this environment.
(async () => {
  const target = process.env.JUMPER_TARGET || "hosted";
  const b = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--use-angle=metal",
    ],
  });
  try {
    const p = await b.newPage({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    p.setDefaultTimeout(30000);
    const pageErrors = [];
    p.on("pageerror", (e) => {
      pageErrors.push(e.message);
      console.log("PAGEERROR", e.message);
    });
    await p.goto(
      process.env.JUMPER_URL ||
        (target === "local"
          ? "http://127.0.0.1:5173"
          : "http://127.0.0.1:5175/Arc-Shot-Evaluator/"),
    );
    async function open() {
      await p.getByRole("button", { name: /Others/ }).click();
      await p.getByRole("menuitem").click();
    }
    await open();
    await p.getByRole("button", { name: "Create", exact: true }).click();
    await p.locator(".jumper-upload input").waitFor();
    await p.locator(".jumper-upload input").setInputFiles(fixture);
    if (process.env.JUMPER_TRIM_START) {
      await p.getByLabel("Start (s)").fill(process.env.JUMPER_TRIM_START);
      await p.getByLabel("End (s)").fill(process.env.JUMPER_TRIM_END);
    }
    await p.getByPlaceholder("e.g. Stephen Curry").fill("Practice Shooter");
    await p.getByRole("button", { name: "Find people in first frame" }).click();
    await p
      .getByRole("button", { name: "Process clip", exact: true })
      .waitFor();
    await expect(
      p.getByRole("button", { name: "Process clip", exact: true }),
    ).toBeEnabled({ timeout: 90000 });
    console.log(target, "detected");
    // This fixture has one real player. The detector also proposes painted
    // wall silhouettes; explicitly reject those as a user must in review.
    const removeNames = await p
      .getByRole("button", { name: /Remove track/ })
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      );
    for (const name of removeNames)
      if (name !== "Remove track 1")
        await p.getByRole("button", { name, exact: true }).click();
    await p.getByRole("button", { name: "Process clip", exact: true }).click();
    let last = "";
    for (let i = 0; i < 900; i++) {
      await p.waitForTimeout(1000);
      const status = await p.locator(".jumper-progress").innerText();
      if (i % 20 === 0) console.log(status);
      const errors = await p
        .locator(".jumper-editor-controls [role=alert]")
        .allTextContents();
      if (errors.length) throw Error(errors.join("\n"));
      if (status.includes("Ready for review")) break;
      if (i === 899) throw Error("processing deadline");
    }
    console.log(
      "warnings",
      await p.locator(".jumper-editor-main [role=alert]").allTextContents(),
    );
    await p.getByLabel("I reviewed the full motion:", { exact: false }).check();
    await p.getByLabel("Use in my guessing game", { exact: false }).check();
    const download = p.waitForEvent("download");
    await p.getByRole("link", { name: "Download", exact: true }).click();
    const file = await download;
    await file.saveAs(path.join(artifacts, target + "-full.mp4"));
    await p
      .getByRole("button", { name: "Save to My Clips", exact: true })
      .click();
    await p
      .getByRole("button", { name: "Saved to My Clips", exact: true })
      .waitFor();
    console.log("saved");
    const modelRequests = [];
    p.on("request", (r) => {
      if (/onnx|wasm|huggingface/.test(r.url())) modelRequests.push(r.url());
    });
    await p.reload();
    await open();
    await p.getByLabel("Player name", { exact: true }).fill("Practice Shooter");
    await expect(p.getByRole("button", { name: "Lock answer" })).toBeEnabled();
    const attempts = () =>
      p.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("arc-jumper-v1");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const database = open.result;
              const tx = database.transaction("attempts");
              const read = tx.objectStore("attempts").getAll();
              tx.oncomplete = () => {
                database.close();
                resolve(read.result);
              };
              tx.onerror = () => reject(tx.error);
            };
          }),
      );
    expect(await attempts()).toHaveLength(0);
    await p
      .locator('video[aria-label="Mystery jumpshot"]')
      .dispatchEvent("error");
    await expect(p.getByRole("button", { name: "Lock answer" })).toBeDisabled();
    expect(await attempts()).toHaveLength(0);
    await p.getByRole("button", { name: "Retry playback" }).click();
    await expect(p.getByRole("button", { name: "Lock answer" })).toBeEnabled();
    await p.getByRole("button", { name: "Lock answer" }).click();
    await p.getByText("Correct. You recognized the release.").waitFor();
    expect(await attempts()).toHaveLength(1);
    await p.reload();
    await open();
    await p.getByText("Correct. You recognized the release.").waitFor();
    expect(await attempts()).toHaveLength(1);
    console.log("guess reload once, inferenceRequests", modelRequests.length);
    expect(modelRequests).toHaveLength(0);
    await p.getByRole("button", { name: "My Clips", exact: true }).click();
    await p.getByRole("button", { name: "Open clip" }).first().click();
    await p.locator(".jumper-library-player video").waitFor();
    await p.waitForFunction(
      () =>
        document.querySelector(".jumper-library-player video")?.readyState >= 2,
    );
    await p.screenshot({
      path: path.join(artifacts, target + "-library.png"),
      fullPage: true,
    });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.waitForTimeout(300);
    await p.screenshot({
      path: path.join(artifacts, target + "-mobile.png"),
      fullPage: true,
    });
    console.log(
      "overflow",
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    );
    expect(pageErrors).toHaveLength(0);
    console.log("FLOW PASS", target);
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
