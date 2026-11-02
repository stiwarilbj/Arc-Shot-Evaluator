import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { COURT_MODEL } from "../frontend/src/features/freezeFloor/model.ts";
const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
});
const errors = [];
let courtDownloads = 0;
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (new URL(r.url()).pathname.endsWith(COURT_MODEL.file)) courtDownloads++;
});
async function corruptCache() {
  await page.evaluate(async (asset) => {
    const cache = await caches.open("arc-freeze-floor-models-v1");
    await cache.put(new URL(asset.file, location.href).href, new Response(new Uint8Array([9])));
  }, COURT_MODEL);
}
async function hasCachedModel() {
  return page.evaluate(async (asset) => !!(await (await caches.open("arc-freeze-floor-models-v1"))
    .match(new URL(asset.file, location.href).href)), COURT_MODEL);
}
await page.goto(
  process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/#freeze-floor",
);
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
await page.getByLabel("Upload basketball image").setInputFiles({
  name: "oversized.jpg",
  mimeType: "image/jpeg",
  buffer: oversized,
});
await expect(page.getByRole("alert")).toContainText("20 MiB");
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
await page.getByRole("button", { name: "Dismiss error" }).click();
await page.getByLabel("Upload basketball image").setInputFiles({
  name: "broken.png",
  mimeType: "image/png",
  buffer: Buffer.from("broken"),
});
await expect(page.getByRole("alert")).toContainText("Image header");
await page.getByRole("button", { name: "Dismiss error" }).click();
await page
  .getByRole("button", { name: "Check the alignment", exact: true })
  .click();
await corruptCache();
await page.route("**/freeze-floor/models/court-keypoints.onnx", (r) =>
  r.fulfill({
    contentType: "application/octet-stream",
    body: Buffer.from([1, 2, 3]),
  }),
);
await page.getByRole("button", { name: "Retry automatic proposals" }).click();
await expect(page.getByRole("alert")).toContainText("integrity", {
  timeout: 30000,
});
expect(courtDownloads).toBe(1);
expect(await hasCachedModel()).toBe(false);
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
await page.getByRole("button", { name: "Dismiss error" }).click();
await page.unroute("**/freeze-floor/models/court-keypoints.onnx");
await corruptCache();
await page.route("**/freeze-floor/models/court-keypoints.onnx", async (r) => {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    await r.abort();
  } catch {}
});
await page.getByRole("button", { name: "Retry automatic proposals" }).click();
await expect(page.locator(".ff-progress")).toBeVisible();
await expect.poll(() => courtDownloads).toBe(2);
await page
  .locator(".ff-progress")
  .getByRole("button", { name: "Cancel", exact: true })
  .click();
await expect(page.locator(".ff-progress")).toHaveCount(0);
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
await page.waitForTimeout(3300);
await expect(page.getByRole("alert")).toHaveCount(0);
expect(courtDownloads).toBe(2);
expect(await hasCachedModel()).toBe(false);
await page.evaluate(() => {
  indexedDB.open = () => {
    throw new DOMException("Storage blocked", "SecurityError");
  };
});
await page.getByRole("button", { name: "Save project", exact: true }).click();
await expect(page.getByRole("alert")).toContainText("Storage blocked");
await expect(
  page.getByRole("button", { name: "Saved", exact: true }),
).toHaveCount(0);
const promise = page.waitForEvent("download");
await page.getByRole("button", { name: "Download PNG", exact: true }).click();
await promise;
await page.getByRole("button", { name: "Light", exact: true }).click();
await page.setViewportSize({ width: 360, height: 800 });
expect(
  await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
).toBe(false);
await page.screenshot({ path: "/tmp/freeze-floor-light.png", fullPage: true });
expect(errors).toEqual([]);
// A fresh origin context avoids the intentionally blocked storage above.
// Add an EXIF rotation tag without changing the real photograph's pixel data.
const rotatedContext = await browser.newContext();
const rotatedPage = await rotatedContext.newPage();
rotatedPage.on("pageerror", (e) => errors.push(e.message));
await rotatedPage.route("**/freeze-floor/models/court-keypoints.onnx", (r) =>
  r.abort(),
);
await rotatedPage.goto(
  process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/#freeze-floor",
);
await expect(rotatedPage.locator(".ff-status")).toContainText(
  "Alignment ready",
);
const source = readFileSync(
  new URL("../frontend/public/freeze-floor/garden.jpg", import.meta.url),
);
const exif = Buffer.alloc(32);
exif.write("Exif\0\0", 0, "binary");
exif.write("II", 6);
exif.writeUInt16LE(42, 8);
exif.writeUInt32LE(8, 10);
exif.writeUInt16LE(1, 14);
exif.writeUInt16LE(0x0112, 16);
exif.writeUInt16LE(3, 18);
exif.writeUInt32LE(1, 20);
exif.writeUInt16LE(6, 24);
const rotated = Buffer.concat([
  source.subarray(0, 2),
  Buffer.from([255, 225, 0, 34]),
  exif,
  source.subarray(2),
]);
await rotatedPage
  .getByLabel("Upload basketball image")
  .setInputFiles({
    name: "rotated.jpg",
    mimeType: "image/jpeg",
    buffer: rotated,
  });
await expect(rotatedPage.locator(".ff-panel").first()).toContainText(
  "1200 × 1600",
);
await expect(rotatedPage.locator(".ff-progress")).toHaveCount(0, {
  timeout: 30000,
});
// Browser-produced fixtures exercise each supported decoder/header path.
for (const type of ["image/png", "image/webp"]) {
  const base64 = await rotatedPage.evaluate(
    async ({ base64, type }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/jpeg" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, 640, 480);
      bitmap.close();
      return canvas.toDataURL(type).split(",")[1];
    },
    { base64: source.toString("base64"), type },
  );
  await rotatedPage
    .getByLabel("Upload basketball image")
    .setInputFiles({
      name: `format.${type.split("/")[1]}`,
      mimeType: type,
      buffer: Buffer.from(base64, "base64"),
    });
  await expect(rotatedPage.locator(".ff-panel").first()).toContainText(
    "640 × 480",
  );
  await expect(rotatedPage.locator(".ff-progress")).toHaveCount(0, {
    timeout: 30000,
  });
}
await rotatedContext.close();
expect(errors).toEqual([]);
console.log(
  "Invalid files, oversized files, corrupt models, cancellation, retained manual alignment, storage failure, PNG recovery, light theme, mobile, EXIF rotation, PNG and WebP decoding passed",
);
await browser.close();
