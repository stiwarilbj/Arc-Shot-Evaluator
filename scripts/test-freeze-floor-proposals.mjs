import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Browser plugin not available · Deterministic worker fixtures isolate UI merging
// Real-model execution is covered separately by test-freeze-floor-upload.mjs
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [], uploads = [], consoleIssues = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (e) => {
  if (["error", "warning"].includes(e.type())) consoleIssues.push(e.text());
});
page.on("request", (r) => { if (r.method() !== "GET") uploads.push(r.url()); });
await page.addInitScript(() => {
  const NativeWorker = window.Worker;
  window.proposalFixtures = [];
  window.proposalRuns = 0;
  window.Worker = function (url, options) {
    if (!String(url).includes("inference.worker")) return new NativeWorker(url, options);
    return {
      terminate() {},
      postMessage(request) {
        request.image.close();
        const contacts = window.proposalFixtures.shift();
        if (!contacts) throw Error("Missing proposal fixture");
        window.proposalRuns++;
        queueMicrotask(() => this.onmessage({ data: {
          type: "result", imageId: request.imageId, jobId: request.jobId,
          revision: request.revision, anchors: [], contacts, provider: "wasm", warnings: [],
        } }));
      },
    };
  };
});
const url = process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/Arc-Shot-Evaluator/#freeze-floor";
const statuses = () => page.getByLabel(/Player \d+ contact status/);
const person = (id, box, x = 0.5) => ({
  id, label: id, image: { x, y: 0.8 }, box, status: "uncertain",
});
const left = person("left", [0.45, 0.3, 0.53, 0.82]);
const right = person("right", [0.51, 0.4, 0.59, 0.82], 0.52);
const overlap = person("overlap", [0.47, 0.32, 0.55, 0.82], 0.52);
async function sample() {
  await page.getByRole("button", { name: "Choose photo", exact: true }).click();
  await page.getByRole("button", { name: /Knicks at the Garden.*Reviewed manual alignment/ }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Knicks at the Garden · Wide view");
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
}
async function propose(contacts) {
  await page.evaluate((contacts) => window.proposalFixtures.push(contacts), contacts);
  await page.getByRole("button", { name: "Retry automatic proposals", exact: true }).click();
  await expect(page.locator(".ff-notice")).toContainText("CPU processing");
  await expect(page.locator(".ff-progress")).toHaveCount(0);
}
try {
  await page.goto(url);
  await expect(page).toHaveTitle(/Freeze Floor/);
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await sample();
  await propose([left, right]);
  await expect(statuses()).toHaveCount(2);
  await page.getByLabel("Player 1 contact status").selectOption("grounded");
  await propose([{ ...left, id: "retry-left" }, { ...right, id: "retry-right" }]);
  await expect(statuses()).toHaveCount(2);
  await expect(page.getByLabel("Player 1 contact status")).toHaveValue("grounded");
  await expect(page.locator('.ff-photo [data-contact="left"]')).toHaveCount(1);
  await propose([overlap]);
  await expect(statuses()).toHaveCount(3);
  await expect(page.locator(".ff-notice")).toContainText("Players 1, 2, 3 remain separate");
  await expect(page.getByLabel("Player 3 contact status")).toHaveValue("uncertain");
  await page.getByRole("button", { name: "Player 3", exact: true }).click();
  await expect(page.locator('.ff-photo [data-contact="overlap"] rect')).toHaveCount(1);
  await propose([{ ...left, id: "r-left" }, { ...right, id: "r-right" }, { ...overlap, id: "r-overlap" }]);
  await expect(statuses()).toHaveCount(3);
  await page.getByLabel("Project name").fill("Proposal merge review");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await page.getByRole("button", { name: "Choose photo", exact: true }).click();
  await page.locator(".ff-library").getByRole("button", { name: "Proposal merge review", exact: true }).click();
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await expect(statuses()).toHaveCount(3);
  await expect(page.getByLabel("Player 1 contact status")).toHaveValue("grounded");
  await expect(page.getByLabel("Player 3 contact status")).toHaveValue("uncertain");
  await page.getByRole("button", { name: "Remove player 3", exact: true }).click();
  await expect(statuses()).toHaveCount(2);
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await expect(statuses()).toHaveCount(3);
  await page.getByRole("button", { name: "Redo floor edit" }).click();
  await expect(statuses()).toHaveCount(2);
  assert.equal(await page.evaluate(() => window.proposalRuns), 0, "reopening and corrections must not run inference");

  // A manually added contact has no box; proximity cannot establish identity
  await sample();
  await page.getByRole("button", { name: "Add player contact", exact: true }).click();
  await page.locator(".ff-photo>svg").focus();
  await page.keyboard.press("Enter");
  const dimensions = await page.locator(".ff-photo>svg").getAttribute("viewBox");
  const [, , width, height] = dimensions.split(" ").map(Number);
  for (const [axis, value] of [["X", 0.5 * width], ["Y", 0.8 * height]]) {
    await page.getByLabel(`Contact ${axis} (px)`, { exact: true }).fill(String(value));
    await page.getByLabel(`Contact ${axis} (px)`, { exact: true }).press("Tab");
  }
  await page.getByLabel("Player 1 contact status").selectOption("grounded");
  await propose([left]);
  await expect(statuses()).toHaveCount(2);
  await expect(page.locator(".ff-notice")).toContainText("Player proposals need review");
  await expect(page.getByLabel("Player 1 contact status")).toHaveValue("grounded");
  await expect(page.getByLabel("Player 2 contact status")).toHaveValue("uncertain");
  await page.locator(".ff-notice").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/freeze-floor-proposals-desktop.png" });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.locator(".ff-notice").scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: "/tmp/freeze-floor-proposals-mobile.png" });

  // Capacity notices count omitted additions and leave reviewed contacts intact
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await sample();
  const crowd = Array.from({ length: 39 }, (_, i) => {
    const x = 0.05 + (i % 10) * 0.1, y = 0.1 + Math.floor(i / 10) * 0.15;
    return { ...person(`crowd-${i}`, [x - 0.02, y - 0.05, x + 0.02, y + 0.01], x), image: { x, y } };
  });
  const extras = [0.2, 0.5, 0.8].map((x, i) => ({
    ...person(`extra-${i}`, [x - 0.02, 0.85, x + 0.02, 0.95], x), image: { x, y: 0.9 },
  }));
  await propose(crowd);
  await expect(statuses()).toHaveCount(39);
  await page.getByRole("button", { name: "Player 1", exact: true }).click();
  await page.getByLabel("Player 1 contact status").selectOption("grounded");
  const contactX = page.getByLabel("Contact X (px)", { exact: true });
  const correctedX = String(Number(await contactX.inputValue()) + 1);
  await contactX.fill(correctedX);
  await contactX.press("Tab");
  const retryBatch = [{ ...crowd[0], id: "retry-crowd-0" }, ...extras];
  await propose(retryBatch);
  await expect(statuses()).toHaveCount(40);
  await expect(page.locator(".ff-notice")).toContainText("2 player proposals could not be added");
  await expect(page.locator(".ff-notice")).toContainText("Existing contacts and corrections kept");
  await expect(page.locator(".ff-notice")).toContainText("Remove spectators, then retry automatic proposals");
  await expect(page.getByLabel("Player 1 contact status")).toHaveValue("grounded");
  await expect(contactX).toHaveValue(correctedX);
  await expect(page.locator('.ff-photo [data-contact="crowd-0"]')).toHaveCount(1);
  await expect(page.locator('.ff-photo [data-contact="extra-0"]')).toHaveCount(1);
  await expect(page.locator('.ff-photo [data-contact="extra-1"]')).toHaveCount(0);
  await page.locator(".ff-notice").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/freeze-floor-capacity-desktop.png" });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.locator(".ff-notice").scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: "/tmp/freeze-floor-capacity-mobile.png" });
  await page.getByLabel("Project name").fill("Contact capacity review");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await page.getByRole("button", { name: "Choose photo", exact: true }).click();
  await page.locator(".ff-library").getByRole("button", { name: "Contact capacity review", exact: true }).click();
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await expect(statuses()).toHaveCount(40);
  await page.getByRole("button", { name: "Player 1", exact: true }).click();
  await expect(page.getByLabel("Player 1 contact status")).toHaveValue("grounded");
  await expect(contactX).toHaveValue(correctedX);
  await page.getByRole("button", { name: "Remove player 2", exact: true }).click();
  await propose(retryBatch);
  await expect(statuses()).toHaveCount(40);
  await expect(page.locator(".ff-notice")).toContainText("1 player proposal could not be added");
  await expect(page.locator('.ff-photo [data-contact="extra-1"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Remove player 3", exact: true }).click();
  await propose(retryBatch);
  await expect(statuses()).toHaveCount(40);
  await expect(page.locator(".ff-notice")).not.toContainText("could not be added");
  await expect(page.locator('.ff-photo [data-contact="extra-2"]')).toHaveCount(1);
  await expect(page.getByLabel("Player 1 contact status")).toHaveValue("grounded");
  await expect(contactX).toHaveValue(correctedX);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(uploads, []);
  console.log("Freeze Floor proposal UI passed: nearby players, box-based retries, ambiguous overlap warnings, exact capacity counts, spectator-removal retries, preserved corrections/identities, save/reload, undo/redo, missing boxes, mobile/light layout, no errors or uploads");
} finally { await browser.close(); }
