import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const base = process.env.ARC_ANALYZER_URL || "http://127.0.0.1:5190/Arc-Shot-Evaluator/";
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
    await frame.fill("0");
    await addMiss.click();
    await expect(observed).toHaveText("50%");
    expect((await readExport()).at(-1)).toMatchObject({ outcome: "miss", release_frame: 0 });
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

try {
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
  expect(errors).toEqual([]);
  console.log("Review math, current JSON downloads, frame limits, note storage failure, and reload passed on desktop and mobile");
} finally {
  await browser.close();
}
