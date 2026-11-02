import { createRequire } from "node:module";
const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
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
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const errors = [];
process.once("uncaughtException", async (error) => {
  console.error(error);
  process.exitCode = 1;
  await browser.close();
});
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("ERROR", e.message);
});
// React's development checks also report malformed SVG tooltip children here.
page.on("console", (message) => {
  if (message.type() === "error" && /React expects/.test(message.text()))
    errors.push(message.text());
});
const posts = [];
page.on("request", (r) => {
  if (r.method() !== "GET") posts.push(r.url());
});
await page.goto(
  process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/#freeze-floor",
);
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
await page
  .getByRole("button", { name: "Check the alignment", exact: true })
  .click();
// Select and keyboard-adjust a floor anchor, then undo it and re-review.
await page.getByRole("button", { name: /L3 · Free-throw/ }).click();
await page.getByRole("img", { name: /Basketball photograph/ }).focus();
await page.keyboard.press("ArrowRight");
await expect(page.locator(".ff-status")).toContainText("Check alignment");
await page.getByRole("button", { name: "Undo floor edit" }).click();
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
// Removing a chosen first endpoint must not leave an unsavable contact reference.
await page
  .getByRole("button", { name: "Measure distance", exact: true })
  .click();
await page.locator(".ff-photo>svg").scrollIntoViewIfNeeded();
const contactPoint = await page.locator(".ff-photo>svg").evaluate((svg) => {
  const p = new DOMPoint(256, 582).matrixTransform(svg.getScreenCTM());
  return { x: p.x, y: p.y };
});
await page.mouse.click(contactPoint.x, contactPoint.y);
await expect(page.locator(".ff-caption")).toContainText("Select the second");
await page
  .getByRole("button", { name: "Remove player 2", exact: true })
  .click();
await expect(page.locator(".ff-caption")).toContainText(
  "Select two grounded floor points",
);
await page.getByRole("checkbox", { name: "Paint", exact: true }).check();
await page
  .getByRole("checkbox", { name: "Restricted area", exact: true })
  .check();
// Place endpoints by mapping known floor positions through the current SVG matrix in the browser.
await page
  .getByRole("button", { name: "Measure distance", exact: true })
  .click();
await page.locator(".ff-panel").nth(1).locator("svg").scrollIntoViewIfNeeded();
for (const v of [
  { x: 22, y: 8 },
  { x: 27, y: 12 },
]) {
  const xy = await page
    .locator(".ff-panel")
    .nth(1)
    .locator("svg")
    .evaluate((svg, v) => {
      const m = svg.getScreenCTM(),
        q = new DOMPoint(v.x + 2, v.y + 2).matrixTransform(m);
      return { x: q.x, y: q.y };
    }, v);
  await page.mouse.click(xy.x, xy.y);
}
await expect(page.locator(".ff-measurements")).toContainText("Approx 6.4 ft");
await page.getByRole("button", { name: "m", exact: true }).click();
await expect(page.locator(".ff-measurements")).toContainText("Approx 2.0 m");
await page.getByRole("button", { name: "Save project", exact: true }).click();
await expect(
  page.getByRole("button", { name: "Saved", exact: true }),
).toBeVisible();
const downloadPromise = page.waitForEvent("download");
await page.getByRole("button", { name: "Download PNG", exact: true }).click();
const download = await downloadPromise;
console.log("download", download.suggestedFilename());
await download.saveAs(
  process.env.FREEZE_FLOOR_PNG || "/tmp/freeze-floor-export.png",
);
await page.reload();
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
await page.getByRole("button", { name: "Choose photo", exact: true }).click();
await page
  .locator(".ff-library")
  .getByRole("button", {
    name: "Madison Square Garden · Floor alignment",
    exact: true,
  })
  .click();
await expect(page.locator(".ff-measurements")).toContainText("Approx 2.0 m");
// Preserve the workspace while navigating away, including browser history.
await page.evaluate(() => (location.hash = "#games/box-score-error-hunt"));
await expect(
  page.getByRole("heading", { name: "Box-Score Error Hunt" }),
).toBeVisible();
await page.goBack();
await expect(page.locator(".ff-measurements")).toContainText("Approx 2.0 m");
// Rounded time labels must not become seeks when an untouched field loses focus.
await page
  .getByLabel("Upload basketball video", { exact: true })
  .setInputFiles(
    new URL(
      "../frontend/public/freeze-floor/videos/kobe-warmup.mp4",
      import.meta.url,
    ).pathname,
  );
const video = page.getByLabel("Local video preview", { exact: true }),
  seconds = page.getByLabel("Video moment in seconds", { exact: true }),
  frameDownload = page.getByRole("button", {
    name: "Download frame JPEG",
    exact: true,
  });
await expect(frameDownload).toBeEnabled();
async function frameState() {
  return video.evaluate(async (v) => {
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(v, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    return { seconds: v.currentTime, hash };
  });
}
for (let step = 1; step <= 2; step++) {
  await page
    .getByRole("button", {
      name: "Seek forward one thirtieth of a second",
      exact: true,
    })
    .click();
  await expect(seconds).toHaveValue(step === 1 ? "0.03" : "0.07");
  await expect(frameDownload).toBeEnabled();
  const before = await frameState();
  for (const key of ["Tab", "Enter"]) {
    await seconds.focus();
    await page.keyboard.press(key);
    await expect.poll(() => video.evaluate((v) => !v.seeking)).toBe(true);
    expect(await frameState()).toEqual(before);
  }
}
const beforeDraft = await frameState();
await seconds.fill("1.25");
// A pending pause/timeupdate event must not replace the typed draft.
await video.evaluate((v) => v.dispatchEvent(new Event("timeupdate")));
await expect(seconds).toHaveValue("1.25");
await seconds.press("Escape");
expect(await frameState()).toEqual(beforeDraft);
await seconds.fill("");
await seconds.press("Tab");
expect(await frameState()).toEqual(beforeDraft);
await seconds.fill("0.5");
await seconds.press("Enter");
await expect
  .poll(() => video.evaluate((v) => !v.seeking && v.currentTime === 0.5))
  .toBe(true);
await expect(frameDownload).toBeEnabled();
const framePromise = page.waitForEvent("download");
await frameDownload.click();
const frame = await framePromise;
expect(frame.suggestedFilename()).toBe("freeze-floor-frame-0.50s.jpg");
await frame.saveAs("/tmp/freeze-floor-video-time-frame.jpg");
expect(await frame.failure()).toBe(null);
await page
  .locator(".ff-video-picker")
  .screenshot({ path: "/tmp/freeze-floor-video-time-after.png" });
await page
  .getByRole("button", { name: "Close video picker", exact: true })
  .click();
await page.setViewportSize({ width: 360, height: 800 });
if (process.env.FREEZE_FLOOR_SCREENSHOT)
  await page.screenshot({
    path: process.env.FREEZE_FLOOR_SCREENSHOT,
    fullPage: true,
  });
expect(
  await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
).toBe(false);
console.log("errors", errors, "nonGet", posts);
console.log(
  "Video timing: untouched blur/Enter preserve exact time and pixels, draft survives timeupdate, Escape/empty input preserve frame, intentional seek and JPEG download passed",
);
expect(errors).toEqual([]);
expect(posts).toEqual([]);
await browser.close();
