import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Browser plugin not available · Delay real browser image operations to expose races
// Worker fixtures keep this loading-only test independent of model downloads
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
const errors = [], warnings = [], uploads = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (e) => { if (["error", "warning"].includes(e.type())) warnings.push(e.text()); });
page.on("request", (r) => { if (r.method() !== "GET") uploads.push(r.url()); });
await page.addInitScript(() => {
  const probe = window.imageLoading = { next: null, held: null, release: null, images: [], fetches: [], workers: 0 };
  function hold(stage, value, details = {}) {
    if (probe.next !== stage) return Promise.resolve(value);
    probe.next = null;
    probe.held = { stage, ...details };
    return new Promise((resolve) => { probe.release = () => resolve(value); });
  }
  const nativeFetch = window.fetch;
  window.fetch = async (url, options) => {
    if (!String(url).includes("freeze-floor/") || !/\.jpg$/.test(String(url)))
      return nativeFetch(url, options);
    const entry = { url: String(url), aborted: options?.signal?.aborted ?? false };
    probe.fetches.push(entry);
    options?.signal?.addEventListener("abort", () => { entry.aborted = true; }, { once: true });
    const response = await nativeFetch(url, options);
    return hold("download", response);
  };
  const read = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function () {
    return hold("header", await read.call(this));
  };
  const bitmaps = new WeakMap(), canvases = new WeakMap();
  const decode = window.createImageBitmap;
  window.createImageBitmap = async (...args) => {
    const bitmap = await decode(...args);
    const entry = { closes: 0, draws: 0, encodes: 0 };
    probe.images.push(entry);
    bitmaps.set(bitmap, entry);
    return hold("decode", bitmap, { entry });
  };
  const close = ImageBitmap.prototype.close;
  ImageBitmap.prototype.close = function () {
    const entry = bitmaps.get(this);
    if (entry) entry.closes++;
    return close.call(this);
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
    const entry = bitmaps.get(image);
    if (entry) { entry.draws++; canvases.set(this.canvas, entry); }
    return draw.call(this, image, ...args);
  };
  const encode = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
    const entry = canvases.get(this);
    if (entry) entry.encodes++;
    return encode.call(this, async (blob) => {
      callback(await hold("conversion", blob, { entry, canvas: this }));
    }, ...args);
  };
  const NativeWorker = window.Worker;
  window.Worker = function (url, options) {
    if (!String(url).includes("inference.worker")) return new NativeWorker(url, options);
    probe.workers++;
    return { terminate() {}, postMessage(request) {
      request.image.close();
      queueMicrotask(() => this.onmessage({ data: {
        type: "result", imageId: request.imageId, jobId: request.jobId, revision: request.revision,
        anchors: [], contacts: [], provider: "wasm", warnings: [],
      } }));
    } };
  };
});
const url = process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/Arc-Shot-Evaluator/#freeze-floor";
const garden = "Madison Square Garden · Floor alignment", game = "Knicks at the Garden · Wide view";
const name = () => page.getByLabel("Project name", { exact: true });
async function choose(which) {
  if (!(await page.locator(".ff-chooser").isVisible()))
    await page.getByRole("button", { name: "Choose photo", exact: true }).click();
  await page.locator(".ff-samples").getByRole("button", { name: new RegExp(which) }).click();
}
async function arm(stage) {
  await page.evaluate((stage) => {
    window.imageLoading.next = stage;
    window.imageLoading.held = window.imageLoading.release = null;
  }, stage);
}
async function held(stage) {
  await expect.poll(() => page.evaluate(() => window.imageLoading.held?.stage)).toBe(stage);
}
async function release() { await page.evaluate(() => window.imageLoading.release()); }
const input = () => page.getByLabel("Upload basketball image", { exact: true });
const photo = readFileSync(new URL("../frontend/public/freeze-floor/garden.jpg", import.meta.url));
async function upload(title) { await input().setInputFiles({ name: title + ".jpg", mimeType: "image/jpeg", buffer: photo }); }
try {
  await page.goto(url);
  await expect(page).toHaveTitle(/Freeze Floor/);
  assert.match(page.url(), /#freeze-floor$/);
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");

  await arm("download");
  await choose("Knicks at the Garden");
  await held("download");
  await choose("Madison Square Garden");
  await expect(name()).toHaveValue(garden);
  await expect(page.locator(".ff-progress")).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.imageLoading.fetches.at(-2).aborted), true);
  const before = await page.evaluate(() => window.imageLoading.images.length);
  await release();
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await expect(name()).toHaveValue(garden);
  assert.equal(await page.evaluate(() => window.imageLoading.images.length), before,
    "an obsolete download cannot start decoding");

  await arm("header");
  await upload("Old header");
  await held("header");
  await choose("Knicks at the Garden");
  await expect(name()).toHaveValue(game);
  await expect(page.locator(".ff-progress")).toHaveCount(0);
  const headerBefore = await page.evaluate(() => window.imageLoading.images.length);
  await release();
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await expect(name()).toHaveValue(game);
  assert.equal(await page.evaluate(() => window.imageLoading.images.length), headerBefore);

  for (const stage of ["decode", "conversion"]) {
    await arm(stage);
    await upload("Obsolete " + stage);
    await held(stage);
    if (stage === "conversion")
      assert.equal(await page.evaluate(() => window.imageLoading.held.entry.closes), 1,
        "bitmap is released before waiting for JPEG conversion");
    await choose("Madison Square Garden");
    await expect(name()).toHaveValue(garden);
    await expect(page.locator(".ff-progress")).toHaveCount(0);
    await release();
    await expect.poll(() => page.evaluate(() => window.imageLoading.held.entry.closes)).toBe(1);
    await expect(name()).toHaveValue(garden);
    const entry = await page.evaluate(() => window.imageLoading.held.entry);
    assert.equal(entry.draws, stage === "decode" ? 0 : 1);
    assert.equal(entry.encodes, stage === "decode" ? 0 : 1);
    if (stage === "conversion")
      await expect.poll(() => page.evaluate(() => [window.imageLoading.held.canvas.width, window.imageLoading.held.canvas.height])).toEqual([0, 0]);
  }
  assert.equal(await page.evaluate(() => window.imageLoading.workers), 0,
    "obsolete uploads never launch inference");

  await arm("decode");
  await upload("Old upload");
  await held("decode");
  await page.evaluate(() => {
    window.oldImageLoading = { release: window.imageLoading.release, entry: window.imageLoading.held.entry };
  });
  await arm("header");
  await upload("Latest upload");
  await held("header");
  await page.evaluate(() => window.oldImageLoading.release());
  await expect.poll(() => page.evaluate(() => window.oldImageLoading.entry.closes)).toBe(1);
  assert.equal(await page.evaluate(() => window.oldImageLoading.entry.draws), 0);
  await expect(page.locator(".ff-progress")).toContainText("Checking image dimensions");
  await expect(name()).toHaveValue(garden);
  await release();
  await expect(name()).toHaveValue("Latest upload");
  await expect(page.locator(".ff-progress")).toHaveCount(0);
  await expect(name()).toHaveValue("Latest upload");
  assert.equal(await page.evaluate(() => window.imageLoading.workers), 1);

  await arm("download");
  await choose("Knicks at the Garden");
  await held("download");
  await page.evaluate(() => { window.location.hash = "#games/box-score-error-hunt"; });
  await expect.poll(() => page.evaluate(() => window.imageLoading.fetches.at(-1).aborted)).toBe(true);
  await release();
  await page.evaluate(() => { window.location.hash = "#freeze-floor"; });
  await expect(name()).toHaveValue("Latest upload");
  await expect(page.locator(".ff-progress,.ff-error,vite-error-overlay")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/freeze-floor-loading-desktop.png" });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: "/tmp/freeze-floor-loading-mobile.png" });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(uploads, []);
  console.log("Freeze Floor photo switching passed: aborted sample requests, stale headers, late bitmap cleanup, skipped obsolete conversion/inference, latest upload retained, workspace cancellation, desktop/mobile, no errors or uploads");
} finally { await browser.close(); }
