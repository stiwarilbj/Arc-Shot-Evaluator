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
const fixture =
  process.env.JUMPER_FIXTURE ||
  new URL("../tests/fixtures/jumper/research-shot.mp4", import.meta.url)
    .pathname;
// Explicit browser fallback: Browser plugin unavailable in this environment.
(async () => {
  const target = process.env.JUMPER_TARGET || "hosted";
  const b = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: process.env.JUMPER_HEADED !== "1",
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
    const localRequests = [];
    p.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        localRequests.push(request.url());
    });
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
    await expect(p).toHaveTitle("ARC · Online Shot Analysis");
    console.log("Page identity", p.url(), await p.title());
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
    const img = p.getByAltText(
      "Selected video frame; click to add a mask point",
    );
    await img.waitFor();
    const bounds = await img.boundingBox();
    const point = (process.env.JUMPER_POINT || ".485,.64")
      .split(",")
      .map(Number);
    await img.click({
      position: { x: bounds.width * point[0], y: bounds.height * point[1] },
    });
    // Processing requires only the clicked shooter, never a name or manual roster.
    await p.getByRole("button", { name: "Process clip", exact: true }).click();
    if (process.env.JUMPER_TEST_CANCEL) {
      await expect(p.locator(".jumper-progress")).toContainText(
        /Tracking|Finding players/,
        { timeout: 180000 },
      );
      await p.getByRole("button", { name: "Cancel processing" }).click();
      await expect(p.locator(".jumper-progress")).toContainText("cancelled");
      await expect(
        p.getByRole("button", { name: "Process clip", exact: true }),
      ).toBeEnabled();
      await expect(
        p.getByRole("heading", { name: "Your finished clip", exact: true }),
      ).toHaveCount(0);
      await p
        .getByRole("button", { name: "Process clip", exact: true })
        .click();
      console.log(
        "Real tracking cancelled and restarted with selections preserved",
      );
    }

    async function waitForResult() {
      for (let i = 0; i < 900; i++) {
        await p.waitForTimeout(1000);
        if (!(await p.locator(".jumper-progress").count())) {
          await p.screenshot({
            path: path.join(artifacts, target + "-interrupted.png"),
            fullPage: true,
          });
          throw Error(
            `Editor progress disappeared at ${p.url()}: ${(await p.locator("body").innerText()).slice(0, 1200)}`,
          );
        }
        const status = await p.locator(".jumper-progress").innerText();
        if (i % 20 === 0) console.log(status);
        const errors = await p
          .locator(".jumper-editor-controls [role=alert]")
          .allTextContents();
        if (errors.length) throw Error(errors.join("\n"));
        if (status.includes("Ready for review")) break;
        if (i === 899) throw Error("processing deadline");
      }
      // Native progress can reach "Ready" just before the job commits its result.
      await p
        .getByRole("heading", { name: "Your finished clip", exact: true })
        .waitFor();
      await expect(
        p.getByRole("button", {
          name: /^(Process clip|Apply corrections & process)$/,
        }),
      ).toBeEnabled();
    }
    await waitForResult();
    if (fixture.includes("research-")) {
      // The technical fixture contains painted wall players. Remove those
      // false detections using real correction controls, preserving track IDs.
      await p.locator(".jumper-corrections summary").click();
      const names = await p
        .getByRole("button", { name: /Remove track/ })
        .evaluateAll((buttons) =>
          buttons.map((b) => b.getAttribute("aria-label")),
        );
      for (const name of names)
        if (name !== "Remove track 1")
          await p.getByRole("button", { name, exact: true }).click();
      await p
        .getByLabel("Find other people automatically", { exact: false })
        .uncheck();
      await expect(
        p.getByRole("button", { name: "Save to My Clips", exact: true }),
      ).toHaveCount(0);
      await p
        .getByRole("button", {
          name: "Apply corrections & process",
          exact: true,
        })
        .click();
      await waitForResult();
      console.log(
        "False detections removed; approval invalidated and corrected tracking completed",
      );
    }
    console.log(
      "warnings",
      await p.locator(".jumper-editor-main [role=alert]").allTextContents(),
    );
    if (process.env.JUMPER_EXPECT_WARNING) {
      await expect(
        p.getByRole("button", { name: "Save to My Clips", exact: true }),
      ).toBeDisabled();
      if (!(await p.locator(".jumper-editor-main [role=alert]").count()))
        throw Error("Expected tracking warning");
      const timeline = p.getByRole("region", { name: "Mask-quality timeline" });
      await expect(timeline).toBeVisible();
      const marker = timeline
        .getByRole("button", { name: /flagged frames?/ })
        .first();
      await marker.press("Enter");
      await expect(p.locator(".jumper-corrections")).toHaveAttribute(
        "open",
        "",
      );
      await expect(p.getByLabel("Inspection view")).toHaveValue("source");
      await p.waitForTimeout(250); // Let the newly selected source frame finish decoding before capture.
      await expect(img).toBeVisible();
      await timeline.screenshot({
        path: path.join(artifacts, target + "-warning-timeline.png"),
      });
      console.log(
        "REAL WARNING TIMELINE: selected frame",
        await p.getByLabel("Correction frame", { exact: true }).inputValue(),
      );
      expect(pageErrors).toHaveLength(0);
      if (target === "hosted") expect(localRequests).toHaveLength(0);
      console.log("UNCERTAIN FOOTAGE CORRECTLY BLOCKED");
      return;
    }
    await p.getByPlaceholder("e.g. Stephen Curry").fill("Practice Shooter");
    await p.getByLabel("I reviewed the full motion:", { exact: false }).check();
    await p.getByLabel("Use in my guessing game", { exact: false }).check();
    const download = p.waitForEvent("download");
    await p.getByRole("link", { name: "Download", exact: true }).click();
    const file = await download;
    await file.saveAs(path.join(artifacts, target + "-full.mp4"));
    let releaseFailedSave;
    // Storage failure must preserve the finished downloadable result.
    if (target === "hosted")
      await p.evaluate(() => {
        window.originalClipPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === "clips")
            throw new DOMException(
              "Test quota exhaustion",
              "QuotaExceededError",
            );
          return window.originalClipPut.apply(this, args);
        };
      });
    else {
      let rejectSave = true;
      await p.route("**/api/jumper-lab/media", async (route) => {
        if (route.request().method() === "POST" && rejectSave) {
          rejectSave = false;
          await new Promise((resolve) => {
            releaseFailedSave = resolve;
          });
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Test unavailable storage" }),
          });
        }
        return route.continue();
      });
    }
    await p
      .getByRole("button", { name: "Save to My Clips", exact: true })
      .click();
    if (target === "local") {
      await expect.poll(() => typeof releaseFailedSave).toBe("function");
      await expect(
        p.getByRole("button", { name: "Clear this frame’s points" }),
      ).toBeDisabled();
      await expect(p.getByLabel("Correction frame")).toBeDisabled();
      releaseFailedSave();
    }
    await expect(
      p.locator(".jumper-editor-controls [role=alert]"),
    ).toContainText("still downloadable");
    await expect(
      p.getByRole("link", { name: "Download", exact: true }),
    ).toBeVisible();
    if (target === "hosted")
      await p.evaluate(() => {
        IDBObjectStore.prototype.put = window.originalClipPut;
      });
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
    const maskedSource = await p
      .locator('video[aria-label="Mystery jumpshot"]')
      .getAttribute("src");
    await p.getByRole("button", { name: "Lock answer" }).click();
    await p.getByText("Correct. You recognized the release.").waitFor();
    expect(
      await p.locator('video[aria-label="Player reveal"]').getAttribute("src"),
    ).toBe(maskedSource);
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
    if (target === "hosted") expect(localRequests).toHaveLength(0);
    console.log("FLOW PASS", target);
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
