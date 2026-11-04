import { createRequire } from "node:module";
import { COURT_MODEL } from "../frontend/src/features/freezeFloor/model.ts";
const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: process.env.FREEZE_FLOOR_CPU
    ? ["--disable-webgpu", "--disable-gpu"]
    : ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  acceptDownloads: true,
});
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("ERROR", e.message);
});
const requests = [];
const courtDownloads = [];
page.on("request", (r) => {
  if (r.method() !== "GET") requests.push(r.url());
  if (new URL(r.url()).pathname.endsWith(COURT_MODEL.file)) courtDownloads.push(r.url());
});
await page.goto(
  process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/#freeze-floor",
);
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
// A damaged model must recover automatically without touching unrelated cache data
await page.evaluate(async (asset) => {
  const cache = await caches.open("arc-freeze-floor-models-v1");
  await cache.put(new URL(asset.file, location.href).href, new Response(new Uint8Array([1, 2, 3])));
  await cache.put(new URL("freeze-floor/cache-test-sentinel", location.href).href, new Response("keep"));
}, COURT_MODEL);
await page
  .getByLabel("Upload basketball image", { exact: true })
  .setInputFiles(
    new URL("../frontend/public/freeze-floor/garden.jpg", import.meta.url)
      .pathname,
  );
// Wait for this upload, rather than observing the initial sample's load progress
await expect(page.getByLabel("Project name")).toHaveValue("garden");
await expect(page.locator(".ff-progress")).toHaveCount(0, { timeout: 120000 });
await expect(page.locator(".ff-error")).toHaveCount(0);
await expect(page.locator(".ff-notice")).toContainText(
  process.env.FREEZE_FLOOR_CPU ? "CPU processing" : /(?:WebGPU|CPU) processing/,
);
console.log(
  "Inference",
  await page.locator(".ff-notice,.ff-error").allTextContents(),
);
expect(courtDownloads).toHaveLength(1);
const recovered = await page.evaluate(async (asset) => {
  const cache = await caches.open("arc-freeze-floor-models-v1");
  const response = await cache.match(new URL(asset.file, location.href).href);
  const digest = response && Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await response.arrayBuffer())),
    (x) => x.toString(16).padStart(2, "0")).join("");
  const sentinel = await cache.match(new URL("freeze-floor/cache-test-sentinel", location.href).href);
  return { digest, sentinel: await sentinel?.text() };
}, COURT_MODEL);
expect(recovered).toEqual({ digest: COURT_MODEL.sha256, sentinel: "keep" });
// Remove automatic proposals to exercise manual alignment independently.
while (await page.getByRole("button", { name: /^Delete landmark / }).count())
  await page
    .getByRole("button", { name: /^Delete landmark / })
    .first()
    .click();
await expect(page.locator(".ff-status")).toContainText("Insufficient");
const definitions = [
  ["lane-left-base", 217, 623],
  ["lane-right-base", 321, 704],
  ["free-left", 536, 598],
  ["free-right", 636, 653],
];
for (const [landmark, x, y] of definitions) {
  await page
    .getByLabel("Landmark to add", { exact: true })
    .selectOption(landmark);
  await page.getByRole("button", { name: "Add anchor", exact: true }).click();
  const xy = await page.locator(".ff-photo>svg").evaluate(
    (svg, p) => {
      const q = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: q.x, y: q.y };
    },
    { x, y },
  );
  await page.mouse.click(xy.x, xy.y);
}
await expect(page.locator(".ff-status")).toContainText("Check alignment");
await page
  .getByRole("button", { name: "I checked the floor-line overlay" })
  .click();
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
// Explicit contact correction through the inspector and a single undoable gesture.
await page
  .getByRole("button", { name: "Add player contact", exact: true })
  .click();
await page.locator(".ff-photo>svg").focus();
await page.keyboard.press("Enter");
await expect(page.getByLabel("Contact X (px)", { exact: true })).toBeVisible();
const field = page.getByLabel("Contact X (px)", { exact: true });
await field.fill("256");
await field.press("Tab");
const fy = page.getByLabel("Contact Y (px)", { exact: true });
await fy.fill("582");
await fy.press("Tab");
await page
  .getByRole("button", { name: "Measure distance", exact: true })
  .click();
for (const v of [
  { x: 22, y: 8 },
  { x: 27, y: 12 },
]) {
  const xy = await page
    .locator(".ff-panel")
    .nth(1)
    .locator("svg")
    .evaluate((svg, v) => {
      const q = new DOMPoint(v.x + 2, v.y + 2).matrixTransform(
        svg.getScreenCTM(),
      );
      return { x: q.x, y: q.y };
    }, v);
  await page.mouse.click(xy.x, xy.y);
}
await expect(page.locator(".ff-measurements")).toContainText("Approx 6.4 ft");
await page.getByRole("button", { name: "Save project", exact: true }).click();
await expect(
  page.getByRole("button", { name: "Saved", exact: true }),
).toBeVisible();
await page.reload();
await expect(page.locator(".ff-status")).toContainText("Alignment ready");
await page.getByRole("button", { name: "Choose photo", exact: true }).click();
await page
  .locator(".ff-library")
  .getByRole("button", { name: "garden", exact: true })
  .click();
await expect(page.locator(".ff-measurements")).toContainText("Approx 6.4 ft");
const promise = page.waitForEvent("download");
await page.getByRole("button", { name: "Download PNG", exact: true }).click();
await (await promise).saveAs("/tmp/freeze-floor-upload-export.png");
expect(errors).toEqual([]);
expect(requests).toEqual([]);
console.log(
  "Real upload → one-shot corrupt model recovery → proposals → manual alignment → contact correction → measurement → save/reload → PNG passed",
  process.env.FREEZE_FLOOR_CPU ? "CPU" : "WebGPU",
);
await browser.close();
