import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { VIDEO_SAMPLES } from "../frontend/src/features/freezeFloor/videoSamples.ts";

// Browser plugin not available · Real image/video decoding and IndexedDB
// A worker fixture isolates edit protection from inference and model downloads
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page = await context.newPage();
const errors = [], consoleIssues = [], uploads = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (e) => { if (["error", "warning"].includes(e.type())) consoleIssues.push(e.text()); });
page.on("request", (r) => { if (r.method() !== "GET") uploads.push(r.url()); });
await context.addInitScript(() => {
  window.inferenceStarts = 0;
  const NativeWorker = window.Worker;
  window.Worker = function (url, options) {
    if (!String(url).includes("inference.worker")) return new NativeWorker(url, options);
    window.inferenceStarts++;
    let stopped = false;
    return {
      terminate() { stopped = true; },
      postMessage(r) {
        r.image.close();
        queueMicrotask(() => { if (!stopped) this.onmessage({ data: {
          type: "result", imageId: r.imageId, jobId: r.jobId, revision: r.revision,
          anchors: [], contacts: [], provider: "wasm", warnings: [],
        } }); });
      },
    };
  };
});
const url = process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/Arc-Shot-Evaluator/#freeze-floor";
const garden = "Madison Square Garden · Floor alignment", knicks = "Knicks at the Garden · Wide view";
const name = () => page.getByLabel("Project name", { exact: true });
const dialog = () => page.getByRole("dialog", { name: "Keep your corrections?" });
async function inspector() {
  if (!(await name().isVisible())) await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
}
async function choose() {
  if (!(await page.locator("#ff-chooser").isVisible()))
    await page.getByRole("button", { name: "Choose photo", exact: true }).click();
}
async function sample(label) {
  await choose();
  await page.locator("#ff-chooser .ff-samples").getByRole("button", { name: new RegExp(label) }).click();
}
async function openSaved(title) {
  await choose();
  await page.locator(".ff-library").getByRole("button", { name: title, exact: true }).click();
}
async function records(target = page) {
  return target.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readonly");
        const r = tx.objectStore("projects").getAll();
        tx.oncomplete = () => resolve(r.result.map((s) => ({ project: s.project, revision: s.revision })));
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
}
async function save() {
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
}
try {
  await page.goto(url);
  await expect(page).toHaveTitle(/Freeze Floor/);
  assert.match(page.url(), /#freeze-floor$/);
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await sample("Knicks at the Garden");
  await expect(dialog()).toHaveCount(0);
  await inspector();
  await expect(name()).toHaveValue(knicks);
  await sample("Madison Square Garden");
  await expect(name()).toHaveValue(garden);
  await expect(dialog()).toHaveCount(0);

  await page.getByLabel("Player 1 contact status").selectOption("grounded");
  await page.getByRole("checkbox", { name: "Paint", exact: true }).check();
  const beforeImage = await page.locator(".ff-photo>svg image").getAttribute("href");
  await sample("Knicks at the Garden");
  await expect(dialog()).toBeVisible();
  await expect(dialog().getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.screenshot({ path: "/tmp/freeze-floor-unsaved-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(dialog()).toHaveCount(0);
  await expect(name()).toHaveValue(garden);
  await expect(page.getByLabel("Player 1 contact status")).toHaveValue("grounded");
  await expect(page.getByRole("checkbox", { name: "Paint", exact: true })).toBeChecked();
  assert.equal(await page.locator(".ff-photo>svg image").getAttribute("href"), beforeImage);
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await sample("Knicks at the Garden");
  await expect(dialog()).toHaveCount(0);
  await expect(name()).toHaveValue(knicks);

  await name().fill("Discarded draft");
  await sample("Madison Square Garden");
  await dialog().getByRole("button", { name: "Discard", exact: true }).click();
  await expect(name()).toHaveValue(garden);
  assert.deepEqual(await records(), [], "Discard does not write a project");

  await name().fill("Protected corrections");
  await page.getByLabel("Player 1 contact status").selectOption("hidden");
  await sample("Knicks at the Garden");
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await expect(name()).toHaveValue(knicks);
  let saved = (await records())[0];
  assert.equal(saved.project.name, "Protected corrections");
  assert.equal(saved.project.contacts[0].status, "hidden");
  await openSaved("Protected corrections");
  await expect(name()).toHaveValue("Protected corrections");
  await expect(page.getByLabel("Player 1 contact status")).toHaveValue("hidden");
  await page.reload();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await openSaved("Protected corrections");
  await inspector();
  await expect(name()).toHaveValue("Protected corrections");

  // Reopening the same card after Save must use the newly committed record
  await page.getByRole("checkbox", { name: "Paint", exact: true }).check();
  await openSaved("Protected corrections");
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Paint", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();

  // Storage failure keeps the modal and all edits instead of opening its target
  await name().fill("Storage failure draft");
  await sample("Knicks at the Garden");
  await page.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB);
    window.restoreStorage = () => { indexedDB.open = original; };
    indexedDB.open = () => { throw new DOMException("Test storage unavailable", "SecurityError"); };
  });
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog().getByRole("alert")).toContainText("storage unavailable");
  await expect(name()).toHaveValue("Storage failure draft");
  await page.evaluate(() => window.restoreStorage());
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(name()).toHaveValue("Storage failure draft");

  // A revision conflict is also a failed Save, never implicit permission to leave
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator(".ff-status")).toContainText("Alignment ready");
  await other.getByRole("button", { name: "Choose photo", exact: true }).click();
  await other.locator(".ff-library").getByRole("button", { name: "Protected corrections", exact: true }).click();
  await other.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await other.getByLabel("Project name").fill("Other tab saved");
  await other.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(other.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await sample("Knicks at the Garden");
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog().getByRole("alert")).toContainText("changed in another tab");
  await expect(name()).toHaveValue("Storage failure draft");
  await dialog().getByRole("button", { name: "Discard", exact: true }).click();
  await expect(name()).toHaveValue(knicks);
  await other.close();

  // Cancel a queued replacement while its save is still committing
  await name().fill("In-flight protected");
  await sample("Madison Square Garden");
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    window.createImageBitmap = async (...args) => {
      window.createImageBitmap = original;
      await new Promise((resolve) => { window.finishSave = resolve; });
      return original(...args);
    };
  });
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.finishSave)).toBe("function");
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => window.finishSave());
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await expect(name()).toHaveValue("In-flight protected");

  // Uploaded photographs are not decoded or sent to inference before consent
  await page.getByRole("checkbox", { name: "Paint", exact: true }).check();
  const starts = await page.evaluate(() => window.inferenceStarts);
  await page.getByLabel("Upload basketball image", { exact: true }).setInputFiles({
    name: "Replacement upload.jpg", mimeType: "image/jpeg",
    buffer: readFileSync(new URL("../frontend/public/freeze-floor/garden.jpg", import.meta.url)),
  });
  await expect(dialog()).toBeVisible();
  assert.equal(await page.evaluate(() => window.inferenceStarts), starts);
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(name()).toHaveValue("In-flight protected");

  // Video browsing keeps corrections; replacing the actual still asks first
  await page.getByLabel("Upload basketball video").setInputFiles(
    new URL(`../frontend/public/freeze-floor/videos/${VIDEO_SAMPLES[0].file}`, import.meta.url).pathname);
  await expect(dialog()).toHaveCount(0);
  await page.getByRole("button", { name: "Use this frame", exact: true }).click();
  await expect(dialog()).toBeVisible();
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(name()).toHaveValue("In-flight protected");
  await page.getByRole("button", { name: "Use this frame", exact: true }).click();
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(name()).not.toHaveValue("In-flight protected");
  await expect(page.locator(".ff-progress")).toHaveCount(0);
  await page.getByRole("button", { name: "Close video picker" }).click();

  await name().fill("Mobile protected draft");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.setViewportSize({ width: 360, height: 800 });
  await sample("Madison Square Garden");
  await expect(dialog()).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await dialog().evaluate((d) => d.scrollWidth > d.clientWidth), false);
  await expect(dialog().getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog().getByRole("button", { name: "Discard", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog().getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.screenshot({ path: "/tmp/freeze-floor-unsaved-mobile.png" });
  // Browser navigation cancels the queued request while preserving the draft
  await page.evaluate(() => { location.hash = "#games/box-score-error-hunt"; });
  await expect(dialog()).toHaveCount(0);
  await page.evaluate(() => { location.hash = "#freeze-floor"; });
  await expect(name()).toHaveValue("Mobile protected draft");
  await expect(dialog()).toHaveCount(0);
  await sample("Madison Square Garden");
  await expect(dialog()).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(dialog()).toHaveCount(0);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(name()).toHaveValue("Mobile protected draft");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(uploads, []);
  console.log("Freeze Floor unsaved corrections passed: clean samples, undo baseline, Save/Discard/Cancel, fresh same-project open, reload, storage/conflict failures, cancelled saves, upload/video protection, keyboard, mobile, both themes and workspace navigation");
} finally { await browser.close(); }
