import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const nativeBase = process.env.ARC_ANALYZER_NATIVE_URL;
const base = nativeBase || process.env.ARC_ANALYZER_URL || "http://127.0.0.1:5190/Arc-Shot-Evaluator/";
const browser = await chromium.launch({
  channel: process.env.ARC_CHROMIUM_CHANNEL || "chrome",
});
const errors = [];
const uploadFixture = fileURLToPath(new URL("../examples/20.0-26.0.mp4", import.meta.url));

async function openPage(viewport, touch = false) {
  const page = await browser.newPage({ viewport, hasTouch: touch, isMobile: touch });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "See the shot; fix the form" })).toBeVisible();
  return page;
}

async function checkNavigation() {
  for (const width of [320, 390, 768, 861, 1440]) {
    const height = width === 320 ? 640 : width === 390 ? 700 : 780;
    const touch = width < 620;
    const page = await openPage({ width, height }, touch);
    await expect(page.getByRole("navigation", { name: "Try other tools" }).getByRole("link")).toHaveCount(5);
    const uploadLabel = await page.locator(".upload-drop strong").boundingBox();
    expect(uploadLabel.y + uploadLabel.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const label of ["Games", "Others"]) {
      const trigger = page.getByRole("button", { name: label, exact: true });
      const menu = page.getByRole("menu", { name: label, exact: true });
      const activate = touch ? () => trigger.tap() : () => trigger.click();
      await activate();
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await activate();
      await expect(menu).toBeHidden();
      await activate();
      const outside = page.getByText("Analysis depth", { exact: true });
      if (touch) await outside.tap();
      else await outside.click();
      await expect(menu).toBeHidden();
    }
    if (!touch) {
      const trigger = page.getByRole("button", { name: "Others", exact: true });
      const first = page.getByRole("menuitem", { name: "Guess the Jumper" });
      const last = page.getByRole("menuitem", { name: "Freeze Floor" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(first).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(last).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(first).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Space");
      await expect(first).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(trigger).not.toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.focus();
      await page.keyboard.press("ArrowUp");
      await expect(last).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#freeze-floor$/);
      await page.goBack();
      await expect(page.locator(".upload-drop")).toBeVisible();
    }
    await page.close();
  }
}

async function delayResponse(page, url) {
  const request = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route(url, async (route) => {
    request.resolve();
    await release.promise;
    // Cancellation may already have closed the underlying media request.
    await route.continue().catch(() => {});
  });
  return { requested: request.promise, release: release.resolve };
}

async function waitForRequest(delayed) {
  const timer = new AbortController();
  try {
    await Promise.race([
      delayed.requested,
      wait(8000, undefined, { signal: timer.signal }).then(() => { throw new Error("Expected browser request did not start"); }),
    ]);
  } finally {
    timer.abort();
  }
}

async function sampleInfo(card) {
  const source = await card.locator("video").evaluate((video) => video.src);
  const filename = decodeURIComponent(new URL(source).pathname.split("/").at(-1));
  const pose = new URL(`pose-data/${encodeURIComponent(filename)}.json`, source).href;
  return { source, filename, pose };
}

async function stallSamplerSeek(page, source, sendWrongPosition = false) {
  await page.evaluate(({ source, sendWrongPosition }) => {
    const position = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      ...position,
      set(time) {
        if (!this.isConnected && this.src === source) {
          window.delayedAnalyzerSeek = true;
          if (sendWrongPosition) this.dispatchEvent(new Event("seeked"));
          return;
        }
        position.set.call(this, time);
      },
    });
  }, { source, sendWrongPosition });
}

async function checkCancellation(stage) {
  const page = await openPage({ width: 1440, height: 900 });
  const cards = page.locator(".example-card");
  const first = cards.nth(0);
  const second = cards.nth(1);
  const [firstVideo, secondVideo] = await Promise.all([first, second].map(sampleInfo));
  const stopped = stage === "seek" ? null
    : await delayResponse(page, stage === "metadata" ? firstVideo.source : firstVideo.pose);
  if (stage === "seek") await stallSamplerSeek(page, firstVideo.source);
  const waiting = await delayResponse(page, secondVideo.pose);
  try {
    await first.click();
    if (stopped) await waitForRequest(stopped);
    else await page.waitForFunction(() => window.delayedAnalyzerSeek === true);
    const stop = page.getByRole("button", { name: `Stop ${firstVideo.filename}`, exact: true });
    await expect(stop).toBeVisible();
    await second.click();
    await expect(page.locator(".queue-queued")).toContainText(secondVideo.filename);
    await stop.click();
    await expect(page.locator(".queue-processing")).toContainText(secondVideo.filename);
    await waitForRequest(waiting);
    stopped?.release();
    await expect(page.locator(".analysis-session-shell .workspace-tabs")).toHaveCount(0);
    waiting.release();
    await expect(page.locator(".queue-done")).toHaveCount(1);
    await expect(page.locator(".queue-done")).toContainText(secondVideo.filename);
    await expect(page.locator(".header-filename")).toHaveText(secondVideo.filename);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    stopped?.release();
    waiting.release();
    await page.close();
  }
}

async function checkUploads() {
  const page = await openPage({ width: 1440, height: 900 });
  const button = page.getByRole("button", { name: /Choose basketball videos/ });
  const choose = async (file) => {
    await button.focus();
    const picker = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await picker).setFiles(file);
  };
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["invalid media"], "unreadable.mp4", { type: "video/mp4" }));
    return data;
  });
  try {
    await expect(button.locator("input")).toHaveCount(0);
    await button.dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(button).toHaveClass(/is-dragging/);
    await button.locator("strong").dispatchEvent("dragenter", { dataTransfer: transfer });
    await button.dispatchEvent("dragleave", { dataTransfer: transfer });
    await expect(button).toHaveClass(/is-dragging/);
    await button.locator("strong").dispatchEvent("dragleave", { dataTransfer: transfer });
    await expect(button).not.toHaveClass(/is-dragging/);
    await button.dispatchEvent("dragenter", { dataTransfer: transfer });
    await button.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(button).not.toHaveClass(/is-dragging/);
    await expect(page.locator(".queue-error")).toContainText("Try an H.264 MP4 or use the downloaded app");

    await choose(uploadFixture);
    await expect(page.locator(".queue-done")).toContainText("20.0-26.0.mp4");
    await expect.poll(() => page.locator(".analysis-session-shell video").first().evaluate(
      (video) => video.currentSrc.startsWith("blob:") && video.readyState >= 1,
    )).toBe(true);
    await expect(page.getByRole("group", { name: "Video view" })).toHaveCount(0);
    await expect(page.locator(".pose-overlay-canvas")).toHaveCount(0);
    await page.locator(".header-actions button").last().click();
    await choose(uploadFixture);
    await expect(page.locator(".queue-done")).toHaveCount(2);
  } finally {
    await transfer.dispose();
    await page.close();
  }
}

async function checkSeekTimeout() {
  const page = await openPage({ width: 1440, height: 900 });
  try {
    const cards = page.locator(".example-card");
    const [first, second] = await Promise.all([cards.nth(0), cards.nth(1)].map(sampleInfo));
    await stallSamplerSeek(page, first.source, true);
    await cards.nth(0).click();
    await page.waitForFunction(() => window.delayedAnalyzerSeek === true);
    await cards.nth(1).click();
    await expect(page.locator(".queue-queued")).toContainText(second.filename);
    const failed = page.locator(".queue-error");
    await expect(failed).toContainText("couldn’t load a video frame", { timeout: 8000 });
    await expect(failed).toContainText(first.filename);
    await expect(page.locator(".queue-done")).toHaveCount(1, { timeout: 12000 });
    await expect(page.locator(".header-filename")).toHaveText(second.filename);
  } finally {
    await page.close();
  }
}

async function checkAudioOnlyUpload() {
  // One second of silence in a valid mono PCM WAV container.
  const audio = Buffer.alloc(44 + 8000, 128);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(8000, 28);
  audio.writeUInt16LE(1, 32);
  audio.writeUInt16LE(8, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(8000, 40);
  const page = await openPage({ width: 390, height: 700 }, true);
  try {
    await page.locator(".video-upload input").setInputFiles([
      { name: "audio-only.mp4", mimeType: "audio/wav", buffer: audio },
      { name: "valid-basketball.mp4", mimeType: "video/mp4", buffer: await readFile(uploadFixture) },
    ]);
    const failed = page.locator(".queue-error");
    await expect(failed).toContainText("audio-only.mp4");
    await expect(failed).toContainText("doesn’t contain a readable video track");
    await expect(page.locator(".queue-done")).toHaveCount(1);
    await expect(page.locator(".header-filename")).toHaveText("valid-basketball.mp4");
  } finally {
    await page.close();
  }
}

async function checkQueueReload() {
  const page = await openPage({ width: 1440, height: 900 });
  try {
    const cards = page.locator(".example-card");
    const [running, waiting, completed] = await Promise.all([0, 1, 2].map((index) => sampleInfo(cards.nth(index))));
    await cards.nth(2).click();
    await expect(page.locator(".queue-done")).toContainText(completed.filename);
    const key = "arc-analysis-queue-pages-v1";
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) ?? "[]")[0]?.result, key);
    await page.evaluate(({ key, running, waiting }) => {
      const entry = (filename, kind, status, exampleId) => ({
        id: filename, filename, kind, status, exampleId, progress: 0, error: null,
        processingMode: "normal", shotMode: "free_throw",
      });
      const saved = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify([
        ...saved,
        entry("running-upload.mp4", "upload", "processing"),
        entry("waiting-upload.mp4", "upload", "queued"),
        entry("completed-upload.mp4", "upload", "done"),
        entry(running, "example", "processing", "example-1"),
        entry(waiting, "example", "queued", "example-2"),
      ]));
    }, { key, running: running.filename, waiting: waiting.filename });
    await page.reload();
    const failed = page.locator(".queue-error");
    for (const filename of ["running-upload.mp4", "waiting-upload.mp4"]) {
      await expect(failed.filter({ hasText: filename })).toContainText("Add the video again");
    }
    await expect(failed.filter({ hasText: "completed-upload.mp4" })).toContainText("cannot be restored after a page reload");
    await expect(page.locator(".queue-done")).toHaveCount(3, { timeout: 15000 });
    await expect(page.locator(".queue-processing, .queue-queued")).toHaveCount(0);
    await page.reload();
    const saved = page.getByTitle("Open this analysis").filter({ hasText: completed.filename });
    await saved.click();
    await expect(page.locator(".header-filename")).toHaveText(completed.filename);
  } finally {
    await page.close();
  }
}

async function checkNativeReconnect() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  const pendingPoll = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const releasePoll = Promise.withResolvers();
  let polls = 0;
  const status = (id, value, result = null) => ({
    id, status: value, result, filename: id + ".mp4", stage: value,
    frames_done: 0, frames_total: 0, error: null,
  });
  await page.addInitScript(() => {
    const entry = (id, status, options = {}) => ({
      id, status, filename: id + ".mp4", kind: "upload", stage: "Test",
      progress: 0, error: null, processingMode: "normal", shotMode: "free_throw", ...options,
    });
    localStorage.setItem("arc-analysis-queue-v2", JSON.stringify([
      entry("active", "processing", { jobId: "active" }),
      entry("waiting", "queued"),
      entry("interrupted", "processing"),
      entry("broken", "done", { jobId: "broken" }),
      entry("next", "queued", { kind: "example", exampleId: "example-1" }),
    ]));
  });
  await page.route("**/api/examples", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/jobs/active", async (route) => {
    if (route.request().method() === "DELETE") {
      cancelled.resolve();
      return route.fulfill({ json: status("active", "cancelled") });
    }
    polls += 1;
    pendingPoll.resolve();
    await releasePoll.promise;
    await route.fulfill({ json: status("active", "processing") }).catch(() => {});
  });
  await page.route("**/api/jobs/broken", (route) => route.fulfill({ json: status("broken", "done") }));
  await page.route("**/api/examples/example-1/jobs?**", (route) => route.fulfill({ json: { job_id: "next" } }));
  await page.route("**/api/jobs/next", (route) => route.fulfill({ json: status("next", "done") }));
  try {
    await page.goto(base);
    await waitForRequest({ requested: pendingPoll.promise });
    const stop = page.getByRole("button", { name: "Stop active.mp4", exact: true });
    await expect(stop).toBeVisible();
    await expect(page.locator(".queue-queued")).toHaveCount(1);
    await expect(page.locator(".queue-error").filter({ hasText: "waiting.mp4" })).toContainText("Add the video again");
    await expect(page.locator(".queue-error").filter({ hasText: "interrupted.mp4" })).toContainText("Add the video again");
    await expect(page.locator(".queue-error").filter({ hasText: "broken.mp4" })).toContainText("No review result was saved");
    expect(polls).toBe(1);
    await stop.click();
    await waitForRequest({ requested: cancelled.promise });
    await expect(page.locator(".queue-error").filter({ hasText: "next.mp4" })).toContainText("No review result was saved");
    releasePoll.resolve();
    await expect(page.locator(".queue-row").filter({ hasText: "active.mp4" })).toHaveCount(0);
    await expect(page.locator(".queue-processing, .queue-queued")).toHaveCount(0);
  } finally {
    releasePoll.resolve();
    await page.close();
  }
}

async function checkNativeCorrectionOrder() {
  const page = await openPage({ width: 1440, height: 900 });
  const firstSave = Promise.withResolvers();
  const acknowledgeFirst = Promise.withResolvers();
  const sent = [];
  const id = "overlapping-review";
  const shot = {
    id: 1, outcome: "review", confidence: 0.6, confidence_label: "review", release_frame: 30, release_time: 1,
    end_frame: 50, release_speed_ms: null, release_height_m: null, entry_angle_deg: null, arc_peak_m: null,
    form: { elbow: null, knee: null, shoulder: null, hip: null }, flags: [],
    evidence: {
      shooter_id: null, motion_events: { takeoff_frame: null, release_frame: 30 },
      defenders: [{ id: "guard-2", role: "opponent", evidence_frames: [28] }],
    },
  };
  const result = {
    session: { id, filename: "Review.mp4", width: 1280, height: 720, fps: 30, frame_count: 60, duration: 2 },
    summary: { attempts: 1, makes: 0, misses: 0, review: 1, fg_pct: null, best_streak: 0, average_confidence: 60 },
    shot_mode: "jump_shot", shots: [shot], warnings: [],
    artifacts: { original: "", annotated: "", pose: "", shots_jsonl: "", analysis_json: "", thumbnails: [] },
  };
  try {
    await page.addInitScript((id) => {
      localStorage.setItem("arc-analysis-queue-v2", JSON.stringify([{
        id, jobId: id, filename: "Review.mp4", kind: "upload", status: "done", progress: 100,
        processingMode: "normal", shotMode: "jump_shot", error: null,
      }]));
    }, id);
    await page.route(`**/api/jobs/${id}`, (route) => route.fulfill({ json: { id, status: "done", result } }));
    await page.route(`**/api/sessions/${id}/shots/1`, async (route) => {
      const changes = route.request().postDataJSON();
      sent.push(changes);
      if ("shooter_id" in changes) shot.evidence.shooter_id = changes.shooter_id;
      if ("takeoff_frame" in changes) shot.evidence.motion_events.takeoff_frame = changes.takeoff_frame;
      if ("defender_ids" in changes) shot.evidence.defender_ids = changes.defender_ids;
      if (sent.length === 1) {
        firstSave.resolve();
        await acknowledgeFirst.promise;
      }
      await route.fulfill({ json: result });
    });
    await page.reload();
    await page.getByTitle("Open this analysis").click();
    const shooter = page.getByRole("textbox", { name: "Shooter label (optional)" });
    const takeoff = page.getByRole("spinbutton", { name: "Takeoff frame", exact: true });
    const labels = page.getByRole("textbox", { name: "Defender track labels" });
    const save = page.getByRole("button", { name: "Save timing / shooter correction" });
    await expect(labels).toHaveValue("guard-2");
    await shooter.fill("new-shooter");
    await takeoff.fill("20");
    await save.click();
    await waitForRequest({ requested: firstSave.promise });
    await shooter.fill("");
    await takeoff.fill("");
    await save.click();
    acknowledgeFirst.resolve();
    await expect.poll(() => sent).toEqual([
      { shooter_id: "new-shooter", takeoff_frame: 20 },
      { shooter_id: null, takeoff_frame: null },
    ]);
    await page.reload();
    await page.getByTitle("Open this analysis").click();
    await expect(shooter).toHaveValue("");
    await expect(takeoff).toHaveValue("");
    await labels.fill("guard-2, guard-manual");
    await save.click();
    await expect.poll(() => sent.at(-1)).toEqual({ defender_ids: ["guard-2", "guard-manual"] });
    await page.reload();
    await page.getByTitle("Open this analysis").click();
    await expect(labels).toHaveValue("guard-2, guard-manual");

    const addMiss = page.getByRole("button", { name: "Add missed attempt at this frame" });
    const addStarted = Promise.withResolvers();
    const releaseAdd = Promise.withResolvers();
    const occupied = "An attempt already uses this frame · Review that shot or choose another frame";
    let addRequests = 0;
    await page.route(`**/api/sessions/${id}/shots`, async (route) => {
      addRequests += 1;
      addStarted.resolve();
      await releaseAdd.promise;
      await route.fulfill({ status: 409, json: { detail: occupied } });
    });
    try {
      await addMiss.click();
      await waitForRequest({ requested: addStarted.promise });
      await expect(addMiss).toBeDisabled();
      await addMiss.evaluate((button) => button.click());
      releaseAdd.resolve();
      await expect(page.getByRole("alert").filter({ hasText: occupied })).toBeVisible();
      await expect(addMiss).toBeEnabled();
      await expect(page.getByRole("spinbutton", { name: "Release frame" })).toHaveValue("30");
      expect(addRequests).toBe(1);
    } finally {
      releaseAdd.resolve();
    }
  } finally {
    acknowledgeFirst.resolve();
    await page.close();
  }
}

async function checkBackgroundCompletion(width) {
  const page = await openPage({ width, height: 800 }, width < 620);
  const cards = page.locator(".example-card");
  const [first, second] = await Promise.all([0, 1].map((index) => sampleInfo(cards.nth(index))));
  const firstDelay = await delayResponse(page, first.pose);
  const secondDelay = await delayResponse(page, second.pose);
  try {
    await cards.nth(0).click();
    await waitForRequest(firstDelay);
    await cards.nth(1).click();
    firstDelay.release();
    await waitForRequest(secondDelay);
    await expect(page.locator(".header-filename")).toHaveText(first.filename);
    await page.getByRole("button", { name: "Tracking", exact: true }).click();
    const reviewUrl = page.url();
    secondDelay.release();
    await expect(page.locator(".queue-done")).toHaveCount(2);
    await expect(page.locator(".header-filename")).toHaveText(first.filename, { timeout: 1500 });
    await expect(page).toHaveURL(reviewUrl);
    const viewing = page.locator('.queue-item[aria-current="true"]');
    await expect(viewing).toContainText(first.filename);
    await expect(viewing).toContainText("Viewing");
    const queue = page.getByRole("complementary", { name: "Analysis Queue" });
    const headingRight = await queue.getByRole("heading", { name: "Analysis Queue" }).evaluate((heading) => {
      const text = document.createRange();
      text.selectNodeContents(heading);
      return text.getBoundingClientRect().right;
    });
    const count = await queue.getByText("2 saved", { exact: true }).boundingBox();
    expect(headingRight).toBeLessThanOrEqual(count.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByTitle("Open this analysis").filter({ hasText: second.filename }).click();
    await expect(page.locator(".header-filename")).toHaveText(second.filename);
    await expect(viewing).toContainText(second.filename);
  } finally {
    firstDelay.release();
    secondDelay.release();
    await page.close();
  }
}

async function checkClearQueue(width) {
  const page = await openPage({ width, height: width === 320 ? 640 : 900 }, width === 320);
  const cards = page.locator(".example-card");
  const first = await sampleInfo(cards.nth(0));
  const delayed = await delayResponse(page, first.pose);
  try {
    await cards.nth(0).click();
    await waitForRequest(delayed);
    await cards.nth(1).click();
    await expect(page.locator(".queue-queued")).toHaveCount(1);
    const clear = page.getByRole("button", { name: "Clear queue" });
    if (width === 320) await clear.tap();
    else await clear.click();
    await expect(page.locator(".queue-queued")).toHaveCount(0);
    await expect(page.locator(".queue-processing")).toContainText(first.filename);
    await expect(clear).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 320) {
      await page.getByRole("button", { name: `Stop ${first.filename}`, exact: true }).tap();
      await expect(page.locator(".queue-row")).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Analysis views" })).toHaveCount(0);
    } else {
      delayed.release();
      await expect(page.locator(".queue-done")).toHaveCount(1);
      await expect(page.locator(".header-filename")).toHaveText(first.filename);
    }
  } finally {
    delayed.release();
    await page.close();
  }
}

async function checkShotReview(width) {
  const mobile = width < 620;
  const page = await openPage({ width, height: mobile ? 700 : 900 }, mobile);
  try {
    await page.evaluate(() => {
      for (const method of ["getItem", "setItem"]) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (key.startsWith("arc-note-v1:")) throw new DOMException("Notes denied", "SecurityError");
          return original.call(this, key, ...args);
        };
      }
    });
    await page.locator(".example-card").first().click();
    const outcomes = page.getByRole("group", { name: "Correct shot outcome" });
    await expect(outcomes).toBeVisible({ timeout: 15000 });
    const overview = page.getByRole("button", { name: "Overview", exact: true });
    await overview.click();
    const summary = (label) => page.locator(".overview-strip > div").filter({ hasText: label }).locator("strong");
    const observed = summary("Observed FT%");
    await expect(observed).toHaveText("—");
    const dataLink = page.getByRole("link", { name: "Shot data JSON" });
    async function readExport() {
      const href = await dataLink.getAttribute("href");
      return page.evaluate(async (url) => (await fetch(url)).json(), href);
    }
    const original = await readExport();
    const confidence = original.reduce((sum, shot) => sum + (shot.observation_confidence ?? shot.confidence), 0);
    const confidencePercent = Number((confidence / original.length * 100).toFixed(1));
    await expect(summary("Observation confidence")).toHaveText(`${confidencePercent.toFixed(0)}%`);
    await expect(dataLink).toHaveAttribute("download", "shot-data.json");
    await expect(page.getByRole("link", { name: "Source video" })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Annotated MP4" })).toHaveCount(0);
    const note = page.getByRole("textbox", { name: "Shot notes" });
    await expect(page.getByText("Notes can only be kept while this result is open")).toBeVisible();
    await note.fill("Keep the follow-through");
    await outcomes.getByRole("button", { name: "MAKE", exact: true }).click();
    await expect(observed).toHaveText("100%");
    expect((await readExport())[0].outcome).toBe("make");
    const downloadEvent = page.waitForEvent("download");
    await dataLink.click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("shot-data.json");
    expect(JSON.parse(await readFile(await download.path(), "utf8"))[0].outcome).toBe("make");

    const frame = page.getByRole("spinbutton", { name: "Release frame" });
    const saveTiming = page.getByRole("button", { name: "Save timing / shooter correction" });
    const addMiss = page.getByRole("button", { name: "Add missed attempt at this frame" });
    const occupied = page.getByRole("alert").filter({ hasText: "An attempt already uses this frame · Review that shot or choose another frame" });
    await expect(frame).toHaveValue(String(original[0].release_frame));
    const reviewed = await readExport();
    await addMiss.click();
    await expect(occupied).toBeVisible();
    await expect(frame).toHaveValue(String(original[0].release_frame));
    await expect(observed).toHaveText("100%");
    expect(await readExport()).toEqual(reviewed);
    const lastFrame = Number(await frame.getAttribute("max"));
    for (const invalid of ["", "-1", "1.5", String(lastFrame + 1)]) {
      await frame.fill(invalid);
      await saveTiming.click();
      await expect(frame).toHaveAttribute("aria-invalid", "true");
      await expect(frame).toHaveAccessibleDescription(`Enter a whole release frame from 0 to ${lastFrame}`);
      await expect(frame).toHaveValue(invalid);
    }
    await addMiss.click();
    expect(await readExport()).toHaveLength(original.length);
    expect((await readExport())[0].release_frame).toBe(original[0].release_frame);
    await frame.fill(String(lastFrame));
    await saveTiming.click();
    await expect(frame).toHaveAttribute("aria-invalid", "false");
    expect((await readExport())[0]).toMatchObject({ outcome: "make", release_frame: lastFrame, end_frame: lastFrame });
    await addMiss.click();
    await expect(occupied).toBeVisible();
    expect(await readExport()).toHaveLength(reviewed.length);
    await frame.fill("0");
    await addMiss.click();
    await expect(observed).toHaveText("50%");
    expect((await readExport()).at(-1)).toMatchObject({ outcome: "miss", release_frame: 0 });
    const withManualAttempt = await readExport();
    await addMiss.click();
    await expect(occupied).toBeVisible();
    await expect(frame).toHaveValue("0");
    await expect(observed).toHaveText("50%");
    expect(await readExport()).toEqual(withManualAttempt);
    await page.getByRole("button", { name: "Next shot" }).click();
    await expect(note).toHaveValue("");
    await overview.click();
    await outcomes.getByRole("button", { name: "REVIEW", exact: true }).click();
    await expect(observed).toHaveText("100%");
    await outcomes.getByRole("button", { name: "MISS", exact: true }).click();
    await expect(observed).toHaveText("50%");
    const edited = await readExport();
    await page.getByRole("button", { name: "Previous shot" }).click();
    await expect(note).toHaveValue("Keep the follow-through");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    // Simulate a queue saved with the old derived values but with the user's edits intact.
    await page.evaluate(() => {
      const key = "arc-analysis-queue-pages-v1";
      const queue = JSON.parse(localStorage.getItem(key));
      queue[0].result.summary.observed_ft_pct = 0;
      queue[0].result.artifacts.shots_jsonl = "data:application/json,%5B%5D";
      localStorage.setItem(key, JSON.stringify(queue));
    });
    await page.reload();
    await page.getByTitle("Open this analysis").click();
    await overview.click();
    await expect(observed).toHaveText("50%");
    expect(await readExport()).toEqual(edited);
  } finally {
    await page.close();
  }
}

async function checkPlaybackReview(width, height) {
  const page = await openPage({ width, height }, width < 620);
  try {
    if (width < 620) await page.getByRole("button", { name: "Light", exact: true }).tap();
    await page.locator(".example-card").first().click();
    const player = page.getByRole("region", { name: "Video analysis workspace" });
    const video = player.locator("video");
    const position = () => video.evaluate((element) => element.currentTime);
    const paused = () => video.evaluate((element) => element.paused);
    const pose = player.locator("canvas");
    await expect.poll(position).toBeGreaterThan(0);
    const initialPosition = await position();
    const views = player.getByRole("group", { name: "Video view" });
    await expect(views.getByRole("button")).toHaveText(["Pose", "Original"]);
    await expect(pose).toBeVisible();
    await views.getByRole("button", { name: "Original" }).click();
    await expect(pose).toHaveCount(0);
    expect(await position()).toBeCloseTo(initialPosition, 2);
    await views.getByRole("button", { name: "Pose" }).click();
    await expect(pose).toBeVisible();

    const menu = page.getByRole("button", { name: "Others", exact: true });
    const tools = await menu.boundingBox();
    const guide = await page.locator(".guide-trigger").boundingBox();
    expect(tools.x + tools.width <= guide.x || tools.y >= guide.y + guide.height).toBe(true);
    await menu.click();
    await expect(page.getByRole("menuitem", { name: "Freeze Floor" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Overview", exact: true }).click();
    const summary = page.getByRole("region", { name: "Session summary" });
    await expect(summary).toBeVisible();
    expect(await summary.evaluate((strip) => [...strip.children].every((card) =>
      card.scrollWidth <= card.clientWidth && card.getBoundingClientRect().right <= strip.getBoundingClientRect().right,
    ))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width >= 1280) {
      expect(await summary.evaluate((strip) => new Set([...strip.children].map((card) => card.getBoundingClientRect().top)).size)).toBe(1);
      const rail = page.locator(".shot-data-panel");
      await rail.hover();
      await page.mouse.wheel(0, 1600);
      await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(page.getByRole("link", { name: "Shot data JSON", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }

    if (width < 1280) return;
    await player.getByRole("button", { name: "Full screen", exact: true }).click();
    const exit = player.getByRole("button", { name: "Exit full screen" });
    await expect(exit).toBeInViewport();
    expect(await page.evaluate(() => document.fullscreenElement?.classList.contains("video-workspace"))).toBe(true);
    await expect.poll(() => pose.evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    })).toBe(true);
    await player.getByRole("combobox", { name: "Playback speed" }).click();
    await player.getByRole("option", { name: "0.5×", exact: true }).click();
    await expect.poll(() => video.evaluate((element) => element.playbackRate)).toBe(0.5);
    await exit.click();
    await expect(player.getByRole("button", { name: "Full screen", exact: true })).toBeVisible();
    expect(await position()).toBeCloseTo(initialPosition, 2);

    await video.evaluate((element) => { element.currentTime = element.duration * 0.85; });
    await player.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(paused).toBe(false);
    for (const hidden of [true, false]) {
      await page.evaluate((value) => {
        Object.defineProperty(document, "hidden", { configurable: true, value });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
      await expect.poll(paused).toBe(true);
    }
    await page.getByTitle("Open this analysis").click();
    await expect.poll(position).toBeCloseTo(initialPosition, 2);
    expect(await paused()).toBe(true);
    // Exercise the time display at a boundary that the short sample never reaches.
    await video.evaluate((element) => {
      Object.defineProperty(element, "currentTime", { configurable: true, value: 59.999 });
      element.dispatchEvent(new Event("timeupdate"));
    });
    await expect(player.locator(".timecode")).toHaveText(/^01:00\.00 \/ /);
    await video.evaluate((element) => {
      delete element.currentTime;
      element.dispatchEvent(new Event("timeupdate"));
    });
    await page.evaluate(() => { HTMLElement.prototype.requestFullscreen = undefined; });
    await player.getByRole("button", { name: "Full screen", exact: true }).click();
    await expect(player.getByRole("alert")).toHaveText("Full screen is unavailable in this browser");
  } finally {
    await page.close();
  }
}

async function checkReviewSeeks() {
  const page = await openPage({ width: 320, height: 640 }, true);
  const lateMode = await delayResponse(page, (url) => url.searchParams.get("view") === "annotated");
  try {
    await page.locator(".example-card").first().click();
    const key = "arc-analysis-queue-pages-v1";
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) ?? "[]")[0]?.result?.shots.length, key);
    const { leadIn, release } = await page.evaluate((key) => {
      const entries = JSON.parse(localStorage.getItem(key));
      const { result } = entries[0];
      const first = result.shots[0];
      result.shot_mode = "jump_shot";
      result.shots = [first, ...[1, 2, 3].map((offset) => ({ ...first, id: first.id + offset }))];
      result.artifacts.thumbnails = [result.artifacts.thumbnails[0]];
      const alternate = new URL(result.artifacts.original, location.href);
      alternate.searchParams.set("view", "annotated");
      result.artifacts.annotated = alternate.href;
      localStorage.setItem(key, JSON.stringify(entries));
      return {
        leadIn: Math.max(0, first.release_time - 0.7),
        release: first.release_frame / result.session.fps,
      };
    }, key);
    await page.reload();
    await page.getByTitle("Open this analysis").click();
    const player = page.getByRole("region", { name: "Video analysis workspace" });
    const video = player.locator("video");
    const position = () => video.evaluate((element) => element.currentTime);
    const paused = () => video.evaluate((element) => element.paused);
    const cards = page.locator(".shot-option");
    await expect(cards).toHaveCount(4);
    await expect.poll(position).toBeCloseTo(leadIn, 2);
    const scrubToEnd = async () => {
      await video.evaluate((element) => { element.currentTime = element.duration - 0.1; });
      expect(await position()).toBeGreaterThan(release + 0.1);
    };
    await scrubToEnd();
    await cards.first().tap();
    await expect.poll(position).toBeCloseTo(leadIn, 2);

    await page.getByRole("button", { name: "Tracking", exact: true }).tap();
    const releaseButton = page.getByRole("button", { name: /^Release Frame / });
    for (let click = 0; click < 2; click += 1) {
      await scrubToEnd();
      await releaseButton.tap();
      await expect.poll(position).toBeCloseTo(release, 2);
    }

    const views = player.getByRole("group", { name: "Video view" });
    await video.evaluate((element, time) => { element.currentTime = time; }, leadIn);
    await player.getByRole("button", { name: "Play", exact: true }).tap();
    await expect.poll(paused).toBe(false);
    await views.getByRole("button", { name: "Annotated" }).tap();
    await waitForRequest(lateMode);
    expect(await video.evaluate((element) => element.readyState)).toBe(0);
    await player.getByRole("button", { name: "Pause", exact: true }).tap();
    await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    await player.getByRole("button", { name: "Play", exact: true }).tap();
    await expect.poll(paused).toBe(false);
    // Send an evidence seek to the incoming source, then leave it before metadata arrives.
    await releaseButton.tap();
    await views.getByRole("button", { name: "Original" }).tap();
    await expect.poll(paused).toBe(false);
    expect(await position()).toBeGreaterThanOrEqual(release - 0.02);
    await player.getByRole("button", { name: "Pause", exact: true }).tap();

    const next = page.getByRole("button", { name: "Next shot" });
    const previous = page.getByRole("button", { name: "Previous shot" });
    await expect(cards.first().locator("img")).toBeVisible();
    const autoWidth = await cards.first().evaluate((card) => card.getBoundingClientRect().width);
    const manualWidth = await cards.last().evaluate((card) => card.getBoundingClientRect().width);
    expect(manualWidth).toBe(autoWidth);
    for (let index = 1; index < 4; index += 1) await next.tap();
    await expect(cards.last()).toHaveAttribute("aria-current", "true");
    const visibleInStrip = (card) => card.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const strip = element.parentElement.getBoundingClientRect();
      return bounds.left >= strip.left - 1 && bounds.right <= strip.right + 1;
    });
    await expect.poll(() => visibleInStrip(cards.last())).toBe(true);
    await page.setViewportSize({ width: 1700, height: 900 });
    await expect.poll(() => page.locator(".shot-selector-list").evaluate((strip) => strip.scrollLeft)).toBe(0);
    await page.setViewportSize({ width: 320, height: 640 });
    await expect.poll(() => visibleInStrip(cards.last())).toBe(true);
    for (let index = 1; index < 4; index += 1) await previous.tap();
    await expect.poll(() => visibleInStrip(cards.first())).toBe(true);
  } finally {
    lateMode.release();
    await page.close();
  }
}

async function checkCorrectionDetails() {
  const page = await openPage({ width: 390, height: 780 }, true);
  try {
    await page.locator(".example-card").first().click();
    const key = "arc-analysis-queue-pages-v1";
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) ?? "[]")[0]?.result?.shots.length, key);
    const { release, takeoff, fps } = await page.evaluate((key) => {
      const queue = JSON.parse(localStorage.getItem(key));
      const { result } = queue[0];
      result.shot_mode = "jump_shot";
      const shot = result.shots[0];
      const fps = result.session.fps;
      result.shots = [shot, { ...shot, id: shot.id + 1, evidence: { ...shot.evidence } }];
      shot.evidence.shooter_id = "model-player";
      shot.evidence.defenders = [{ id: "guard-2", role: "opponent", evidence_frames: [shot.release_frame] }];
      shot.evidence.player_height_m = 1.95;
      shot.evidence.motion_events = {
        release_frame: shot.release_frame,
        takeoff_frame: shot.release_frame - 10,
        release_after_takeoff_ms: 10 / fps * 1000,
        timing_available: true,
      };
      localStorage.setItem(key, JSON.stringify(queue));
      return { release: shot.release_frame - 3, takeoff: shot.release_frame - 12, fps };
    }, key);
    await page.reload();
    await page.getByTitle("Open this analysis").click();
    const shooter = page.getByRole("textbox", { name: "Shooter label (optional)" });
    const releaseInput = page.getByRole("spinbutton", { name: "Release frame" });
    const takeoffInput = page.getByRole("spinbutton", { name: "Takeoff frame", exact: true });
    const save = page.getByRole("button", { name: "Save timing / shooter correction" });
    const tracking = page.getByRole("button", { name: "Tracking", exact: true });
    const releaseButton = page.getByRole("button", { name: /^Release Frame / });
    const readExport = async () => {
      const href = await page.getByRole("link", { name: "Shot data JSON" }).getAttribute("href");
      return page.evaluate(async (url) => (await (await fetch(url)).json())[0], href);
    };
    await expect(shooter).toHaveValue("model-player");
    const imagePoints = page.getByRole("textbox", { name: "Image points JSON", exact: true });
    const courtPoints = page.getByRole("textbox", { name: "Court points JSON (metres)" });
    const saveCourt = page.getByRole("button", { name: "Save court setup" });
    const imageDraft = "[[4,0],[20,0],[20,30],[4,30]]";
    const courtDraft = "[[0,0],[2,0],[2,3],[0,3]]";
    await imagePoints.fill(imageDraft);
    await courtPoints.fill(courtDraft);
    await shooter.fill("reviewed-player");
    await releaseInput.fill(String(release));
    await page.getByRole("group", { name: "Correct shot outcome" }).getByRole("button", { name: "MISS", exact: true }).tap();
    const outcomeOnly = await readExport();
    expect(outcomeOnly.outcome).toBe("miss");
    expect(outcomeOnly.evidence.shooter_id).toBe("model-player");
    await expect(shooter).toHaveValue("reviewed-player");
    await expect(releaseInput).toHaveValue(String(release));

    await page.getByRole("button", { name: "Next shot" }).tap();
    await expect(shooter).toHaveValue("");
    await shooter.fill("second-shot-draft");
    await expect(imagePoints).toHaveValue(imageDraft);
    await page.getByRole("button", { name: "Previous shot" }).tap();
    await expect(shooter).toHaveValue("reviewed-player");
    await expect(releaseInput).toHaveValue(String(release));
    await expect(imagePoints).toHaveValue(imageDraft);
    await saveCourt.tap();
    await expect(shooter).toHaveValue("reviewed-player");
    await expect(releaseInput).toHaveValue(String(release));
    await expect(imagePoints).toHaveValue(imageDraft);

    await page.getByRole("button", { name: "Next shot" }).tap();
    await expect(shooter).toHaveValue("second-shot-draft");
    await page.getByRole("button", { name: "Previous shot" }).tap();
    const newerImageDraft = "[[8,0],[20,0],[20,30],[8,30]]";
    await imagePoints.fill(newerImageDraft);
    await releaseInput.fill(String(outcomeOnly.release_frame));
    await save.tap();
    const labelCorrection = await readExport();
    expect(labelCorrection.evidence.shooter_id).toBe("reviewed-player");
    expect(labelCorrection.evidence.defenders).toEqual(outcomeOnly.evidence.defenders);
    expect(labelCorrection.evidence.player_height_m).toBe(1.95);
    expect(labelCorrection.evidence.correction.fields).toEqual(["release_frame", "shooter_id"]);
    await expect(imagePoints).toHaveValue(newerImageDraft);
    await shooter.fill("");
    await releaseInput.fill(String(release));
    await takeoffInput.fill(String(takeoff));
    await page.getByRole("spinbutton", { name: "Shooter height (m, optional)" }).fill("");
    await save.tap();

    const corrected = await readExport();
    expect(corrected.release_frame).toBe(release);
    expect(corrected.evidence.shooter_id).toBeNull();
    expect(corrected.evidence.player_height_m).toBeNull();
    expect(corrected.evidence.defenders).toEqual(outcomeOnly.evidence.defenders);
    expect(corrected.evidence.motion_events).toMatchObject({ release_frame: release, takeoff_frame: takeoff });
    await tracking.tap();
    await expect(releaseButton).toHaveText(`ReleaseFrame ${release}`);
    await releaseButton.tap();
    const video = page.locator(".video-workspace video");
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(release / fps, 2);
    await expect(page.locator(".metric-row").filter({ hasText: "Release after takeoff" }).locator("strong"))
      .toHaveText(`${((release - takeoff) / fps * 1000).toFixed(0)} ms`);

    // Older hosted reviews could keep the detector's nested release and duration.
    await page.evaluate((key) => {
      const queue = JSON.parse(localStorage.getItem(key));
      const events = queue[0].result.shots[0].evidence.motion_events;
      events.release_frame += 3;
      events.release_after_takeoff_ms = 1;
      localStorage.setItem(key, JSON.stringify(queue));
    }, key);
    await page.reload();
    await page.getByTitle("Open this analysis").click();
    await expect(shooter).toHaveValue("");
    await expect(takeoffInput).toHaveValue(String(takeoff));
    await expect(imagePoints).toHaveValue(imageDraft);
    await expect(courtPoints).toHaveValue(courtDraft);
    expect(await readExport()).toEqual(corrected);
    await takeoffInput.fill(String(release + 1));
    await save.tap();
    await expect(takeoffInput).toHaveAttribute("aria-invalid", "true");
    await expect(takeoffInput).toHaveAccessibleDescription(`Enter a whole takeoff frame from 0 to ${release}, or leave it blank`);
    expect(await readExport()).toEqual(corrected);
    await takeoffInput.fill("");
    await save.tap();
    expect((await readExport()).evidence.motion_events).toMatchObject({ takeoff_frame: null, release_after_takeoff_ms: null });
  } finally {
    await page.close();
  }
}

async function checkJumpShotClassification() {
  const page = await openPage({ width: 390, height: 780 }, true);
  const key = "arc-analysis-queue-pages-v1";
  try {
    await page.locator(".example-card").first().tap();
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) ?? "[]")[0]?.result?.shots.length, key);
    await page.evaluate((key) => {
      const queue = JSON.parse(localStorage.getItem(key));
      const result = queue[0].result;
      const shot = result.shots[0];
      result.shot_mode = "jump_shot";
      result.shots = [
        { ...shot, outcome: "make", evidence: { ...shot.evidence, shot_type: "unknown" } },
        { ...shot, id: shot.id + 1, outcome: "review", evidence: { ...shot.evidence, shot_type: "three_pointer" } },
      ];
      localStorage.setItem(key, JSON.stringify(queue));
    }, key);
    await page.reload();
    await page.getByTitle("Open this analysis").click();

    const classification = page.getByRole("combobox", { name: "Shot classification" });
    const save = page.getByRole("button", { name: "Save timing / shooter correction" });
    const overview = page.getByRole("button", { name: "Overview", exact: true });
    const summary = (label) => page.locator(".overview-strip > div").filter({ hasText: label }).locator("strong");
    const warning = page.getByText("1 proposal(s) excluded from jump-shot statistics after review");
    const readExport = async () => {
      const href = await page.getByRole("link", { name: "Shot data JSON" }).getAttribute("href");
      return page.evaluate(async (url) => (await fetch(url)).json(), href);
    };
    for (const [label, type] of [
      ["Layup (exclude)", "layup"], ["Dunk (exclude)", "dunk"],
      ["Pass (exclude)", "pass"], ["Pump fake (exclude)", "pump_fake"],
    ]) {
      if (type === "layup") {
        await classification.press("l");
        await classification.press("Enter");
      } else {
        await classification.tap();
        await page.getByRole("option", { name: label, exact: true }).tap();
      }
      await expect(classification).toHaveText(label);
      await save.tap();
      await overview.tap();
      await expect(summary("Attempts")).toHaveText("1");
      await expect(summary("Three-point%")).toHaveText("—");
      await expect(summary("Observed FG%")).toHaveText("—");
      await expect(warning).toBeVisible();
      const shots = await readExport();
      expect(shots).toHaveLength(2);
      expect(shots[0].evidence).toMatchObject({ shot_type: type, statistics_eligibility: { status: "excluded" } });
    }

    // Earlier hosted saves had the label but omitted its exclusion status.
    await page.evaluate((key) => {
      const queue = JSON.parse(localStorage.getItem(key));
      delete queue[0].result.shots[0].evidence.statistics_eligibility;
      localStorage.setItem(key, JSON.stringify(queue));
    }, key);
    await page.reload();
    await page.getByTitle("Open this analysis").click();
    await expect(classification).toHaveText("Pump fake (exclude)");
    await expect(warning).toBeVisible();
    await page.getByRole("button", { name: "Next shot" }).tap();
    await page.getByRole("group", { name: "Correct shot outcome" }).getByRole("button", { name: "MISS", exact: true }).tap();
    await overview.tap();
    await expect(summary("Observed FG%")).toHaveText("0%");
    await expect(summary("Three-point%")).toHaveText("0%");

    await page.getByRole("button", { name: "Previous shot" }).tap();
    await classification.tap();
    await page.getByRole("option", { name: "Three-pointer", exact: true }).tap();
    await save.tap();
    await overview.tap();
    await expect(summary("Attempts")).toHaveText("2");
    await expect(summary("Three-point%")).toHaveText("50%");
    await expect(warning).toHaveCount(0);
    expect((await readExport())[0].evidence).toMatchObject({ shot_type: "three_pointer", statistics_eligibility: { status: "eligible_pending_validation" } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    await page.close();
  }
}

async function checkDefenderReview() {
  const page = await openPage({ width: 390, height: 780 }, true);
  const key = "arc-analysis-queue-pages-v1";
  try {
    await page.locator(".example-card").first().tap();
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) ?? "[]")[0]?.result?.shots.length, key);
    const { frame, fps, tracked } = await page.evaluate((key) => {
      const queue = JSON.parse(localStorage.getItem(key));
      const result = queue[0].result;
      const shot = result.shots[0];
      const frame = Math.max(0, shot.release_frame - 3);
      const tracked = {
        id: "guard-2", role: "opponent", evidence_frames: [frame],
        separation: { value: 42, units: "px", availability: true, method: "projected", uncertainty: null },
      };
      result.shot_mode = "jump_shot";
      shot.evidence.defenders = [tracked];
      localStorage.setItem(key, JSON.stringify(queue));
      return { frame, fps: result.session.fps, tracked };
    }, key);
    const reopen = async () => {
      await page.reload();
      await page.getByTitle("Open this analysis").click();
    };
    await reopen();

    const labels = page.getByRole("textbox", { name: "Defender track labels" });
    const roles = page.getByRole("textbox", { name: "Team / role assignments JSON" });
    const save = page.getByRole("button", { name: "Save timing / shooter correction" });
    const tracking = page.getByRole("button", { name: "Tracking", exact: true });
    const count = page.locator(".metric-row").filter({ hasText: "Defenders tracked" }).locator("strong");
    const contest = page.getByRole("button", { name: /^Contest/ });
    const readEvidence = async () => {
      const href = await page.getByRole("link", { name: "Shot data JSON" }).getAttribute("href");
      return page.evaluate(async (url) => (await (await fetch(url)).json())[0].evidence, href);
    };
    await expect(labels).toHaveValue("guard-2");
    await labels.fill("guard-manual, guard-2");
    await save.tap();
    await tracking.tap();
    await expect(count).toHaveText("1");
    await expect(contest).toHaveText(`ContestFrame ${frame}`);
    await contest.tap();
    const video = page.locator(".video-workspace video");
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(frame / fps, 2);
    expect(await readEvidence()).toMatchObject({
      defender_ids: ["guard-manual", "guard-2"], defenders: [tracked], detected_defenders: [tracked],
    });

    for (const [text, ids] of [["guard-manual", ["guard-manual"]], ["", []]]) {
      await labels.fill(text);
      await save.tap();
      await expect(count).toHaveText("0");
      await expect(contest).toBeDisabled();
      expect(await readEvidence()).toMatchObject({ defender_ids: ids, defenders: [], detected_defenders: [tracked] });
    }
    await reopen();
    await expect(labels).toHaveValue("");
    await labels.fill("guard-2, guard-manual");
    await save.tap();
    for (const role of ["official", "teammate", "opponent"]) {
      await roles.fill(JSON.stringify({ "guard-2": role }));
      await save.tap();
      expect(await readEvidence()).toMatchObject({
        defender_ids: ["guard-2", "guard-manual"],
        defenders: role === "opponent" ? [tracked] : [],
        detected_defenders: [tracked],
      });
      await expect(labels).toHaveValue("guard-2, guard-manual");
    }
    await page.getByRole("textbox", { name: "Shooter label (optional)" }).fill("reviewed-shooter");
    await save.tap();
    await reopen();
    await expect(labels).toHaveValue("guard-2, guard-manual");
    expect(await readEvidence()).toMatchObject({
      shooter_id: "reviewed-shooter", defender_ids: ["guard-2", "guard-manual"], defenders: [tracked],
    });

    // Old browser saves replaced the detector records with bare labels.
    await page.evaluate((key) => {
      const queue = JSON.parse(localStorage.getItem(key));
      const evidence = queue[0].result.shots[0].evidence;
      evidence.defenders = [{ id: "old-manual-label" }];
      delete evidence.defender_ids;
      delete evidence.detected_defenders;
      localStorage.setItem(key, JSON.stringify(queue));
    }, key);
    await reopen();
    await expect(labels).toHaveValue("old-manual-label");
    await tracking.tap();
    await expect(count).toHaveText("0");
    await expect(contest).toBeDisabled();
    expect(await readEvidence()).toMatchObject({ defender_ids: ["old-manual-label"], defenders: [] });
  } finally {
    await page.close();
  }
}

async function checkHostedAnalyzer() {
  await checkCorrectionDetails();
  console.log("Shot and court drafts survived switching shots and separate saves, and saved corrections stayed in sync through reload");
  await checkJumpShotClassification();
  console.log("Jump-shot exclusions, restored summaries, and confirmed three-point rates passed on mobile");
  await checkDefenderReview();
  console.log("Defender labels, tracked contest evidence, and recovery of legacy reviews passed");
  await checkReviewSeeks();
  console.log("Repeated shot and evidence seeks, slow-source handoff, and the mobile shot strip passed");
  await checkBackgroundCompletion(1440);
  await checkBackgroundCompletion(320);
  console.log("Background completion kept the current tracking review open on desktop and mobile");
  await checkNavigation();
  console.log("Navigation, keyboard and touch controls, and upload layout passed at five widths");
  await checkCancellation("metadata");
  await checkCancellation("pose");
  await checkCancellation("seek");
  console.log("Stopping a clip during metadata, pose loading, and frame seeking preserved the next queue item");
  await checkUploads();
  console.log("File drops, decoder errors, keyboard upload, same-file selection, and successful playback passed");
  await checkSeekTimeout();
  await checkAudioOnlyUpload();
  console.log("Stalled and incorrect-position seeks and audio-only uploads fail cleanly before the next clip runs");
  await checkQueueReload();
  await checkClearQueue(1440);
  await checkClearQueue(320);
  console.log("Upload recovery, resumable examples, and clear/stop behavior passed on desktop and mobile");
  await checkShotReview(1440);
  await checkShotReview(320);
  console.log("Review math, current JSON downloads, frame limits, duplicate-attempt protection, note storage failure, and reload passed on desktop and mobile");
  await checkPlaybackReview(1440, 900);
  await checkPlaybackReview(1280, 780);
  await checkPlaybackReview(1050, 780);
  await checkPlaybackReview(320, 640);
  expect(errors).toEqual([]);
  console.log("Review layout, video modes, fullscreen pose and controls, reopen, and hidden-tab pausing passed");
}

try {
  if (nativeBase) {
    await checkNativeReconnect();
    await checkNativeCorrectionOrder();
    expect(errors).toEqual([]);
    console.log("Local queue restored one status poll per job, recovered missing results, and resumed the next example after stopping a stalled poll");
    console.log("Overlapping local corrections submitted explicit clears in order and restored them after reload");
    console.log("A pending local manual add blocked repeat clicks and an occupied frame restored the control");
  } else {
    await checkHostedAnalyzer();
  }
} finally {
  await browser.close();
}
