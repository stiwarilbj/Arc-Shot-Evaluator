import { createRequire } from "node:module";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const base = process.env.ARC_ANALYZER_URL || "http://127.0.0.1:5190/Arc-Shot-Evaluator/";
const browser = await chromium.launch({
  channel: process.env.ARC_CHROMIUM_CHANNEL || "chrome",
});
const errors = [];

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

async function checkCancellation(stage) {
  const page = await openPage({ width: 1440, height: 900 });
  const cards = page.locator(".example-card");
  const first = cards.nth(0);
  const second = cards.nth(1);
  const videos = await Promise.all([first, second].map((card) => card.locator("video").evaluate((video) => video.src)));
  const names = videos.map((url) => decodeURIComponent(new URL(url).pathname.split("/").at(-1)));
  const poseUrl = (video, filename) => new URL(`pose-data/${encodeURIComponent(filename)}.json`, video).href;
  const stopped = stage === "seek" ? null
    : await delayResponse(page, stage === "metadata" ? videos[0] : poseUrl(videos[0], names[0]));
  if (stage === "seek") {
    await page.evaluate((source) => {
      const position = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
        ...position,
        set(time) {
          if (!this.isConnected && this.src === source) {
            window.delayedAnalyzerSeek = true;
            return;
          }
          position.set.call(this, time);
        },
      });
    }, videos[0]);
  }
  const waiting = await delayResponse(page, poseUrl(videos[1], names[1]));
  try {
    await first.click();
    if (stopped) await waitForRequest(stopped);
    else await page.waitForFunction(() => window.delayedAnalyzerSeek === true);
    const stop = page.getByRole("button", { name: `Stop ${names[0]}`, exact: true });
    await expect(stop).toBeVisible();
    await second.click();
    await expect(page.locator(".queue-queued")).toContainText(names[1]);
    await stop.click();
    await expect(page.locator(".queue-processing")).toContainText(names[1]);
    await waitForRequest(waiting);
    stopped?.release();
    await expect(page.locator(".analysis-session-shell .workspace-tabs")).toHaveCount(0);
    waiting.release();
    await expect(page.locator(".queue-done")).toHaveCount(1);
    await expect(page.locator(".queue-done")).toContainText(names[1]);
    await expect(page.locator(".header-filename")).toHaveText(names[1]);
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

    const file = fileURLToPath(new URL("../examples/20.0-26.0.mp4", import.meta.url));
    await choose(file);
    await expect(page.locator(".queue-done")).toContainText("20.0-26.0.mp4");
    await expect.poll(() => page.locator(".analysis-session-shell video").first().evaluate(
      (video) => video.currentSrc.startsWith("blob:") && video.readyState >= 1,
    )).toBe(true);
    await page.locator(".header-actions button").last().click();
    await choose(file);
    await expect(page.locator(".queue-done")).toHaveCount(2);
  } finally {
    await transfer.dispose();
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
  expect(errors).toEqual([]);
  console.log("File drops, decoder errors, keyboard upload, same-file selection, and successful playback passed");
} finally {
  await browser.close();
}
