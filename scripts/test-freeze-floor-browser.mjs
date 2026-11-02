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
process.on("uncaughtException", async (error) => {
  await browser.close();
  throw error;
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
expect(errors).toEqual([]);
expect(posts).toEqual([]);
await browser.close();
