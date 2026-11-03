import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
// Browser plugin unavailable · Use installed Chrome against the real editor
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
const errors = [], uploads = [], consoleIssues = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (e) => { if (["warning", "error"].includes(e.type())) consoleIssues.push(e.text()); });
page.on("request", (r) => { if (r.method() !== "GET") uploads.push(r.url()); });
const court = page.locator(".ff-panel").nth(1).locator("svg");
const photo = page.locator(".ff-photo>svg");
const distances = page.getByRole("region", { name: "Distances" });
const rows = distances.locator(":scope > div");
const feedback = page.locator(".ff-measurement-feedback");
const saveStatus = page.getByRole("status", { name: "Project save status" });
async function clickPoint(stage, point, touch = false) {
  await stage.scrollIntoViewIfNeeded();
  const q = await stage.evaluate((svg, p) => {
    const q = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  }, point);
  if (touch) await page.touchscreen.tap(q.x, q.y);
  else await page.mouse.click(q.x, q.y);
}
const clickCourt = (x, y) => clickPoint(court, { x: x + 2, y: y + 2 });
async function clickContact(stage, id, touch = false) {
  const point = await stage.locator(`[data-contact="${id}"] circle`).evaluate((c) => ({
    x: +c.getAttribute("cx"), y: +c.getAttribute("cy"),
  }));
  await clickPoint(stage, point, touch);
}
async function measure() {
  await page.getByRole("button", { name: "Measure distance", exact: true }).click();
}
async function expectDuplicate(count, distance) {
  await expect(rows).toHaveCount(count);
  await expect(feedback).toHaveText(`Distance ${distance} already exists · Highlighted in both views`);
  await expect(rows.nth(distance - 1)).toHaveAttribute("data-highlighted", "true");
  for (const stage of [court, photo]) {
    const marked = stage.locator('[data-measurement][data-highlighted="true"]');
    await expect(marked).toHaveCount(1);
    await expect(marked.locator("line")).not.toHaveAttribute("stroke-dasharray");
  }
}
try {
  await page.goto(process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/Arc-Shot-Evaluator/#freeze-floor");
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  for (const [label, x, y] of [["3", 22, 8], ["4", 27, 12]]) {
    await page.getByRole("button", { name: "Add player contact", exact: true }).click();
    await clickCourt(x, y);
    await page.getByLabel(`Player ${label} contact status`).selectOption("grounded");
  }
  const contactIds = await court.locator("[data-contact]").evaluateAll((nodes) => nodes.slice(-2).map((n) => n.dataset.contact));
  const [first, second] = contactIds;
  await measure();
  await clickContact(court, first);
  await clickContact(photo, first);
  await expect(rows).toHaveCount(0);
  await expect(feedback).toHaveText("Choose a different player or floor point for the second endpoint");
  // Keep the first endpoint selected after rejection, including a keyboard repeat
  await court.focus();
  await court.press("Enter");
  await expect(rows).toHaveCount(0);
  await clickContact(court, second);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Approx 6.4 ft");
  await expect(feedback).toHaveCount(0);
  // Save first so rejected clicks must not make the project dirty or enter history
  await page.getByLabel("Project name").fill("Measurement guard regression");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(saveStatus).toHaveText("Saved on this device");
  for (const ids of [[first, second], [second, first]]) {
    await clickContact(photo, ids[0]);
    await clickContact(court, ids[1]);
    await expectDuplicate(1, 1);
    await expect(saveStatus).toHaveText("Saved on this device");
  }
  await court.screenshot({ path: "/tmp/freeze-floor-existing-distance-court.png" });
  // One undo removes the last real edit, not a duplicate-selection operation
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await expect(page.getByLabel("Project name")).not.toHaveValue("Measurement guard regression");
  await expect(feedback).toHaveCount(0);
  await page.getByRole("button", { name: "Redo floor edit" }).click();
  await expect(saveStatus).toHaveText("Saved on this device");
  // Identity comparison must use the moved contact, not its old endpoint image
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await clickContact(court, first);
  await court.press("ArrowRight");
  await measure();
  await clickContact(court, second);
  await clickContact(photo, first);
  await expectDuplicate(1, 1);
  // Free-space repeats also preserve the pending start rather than adding zero
  await clickCourt(17.75, 12.75);
  await court.press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(feedback).toContainText("Choose a different");
  await clickCourt(31, 3);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Approx 16.5 ft");
  // Select the exact drawn endpoints in the other projection, in reverse order
  const endpoints = await photo.locator("[data-measurement]").nth(1).locator("circle").evaluateAll((nodes) =>
    nodes.map((c) => ({ x: +c.getAttribute("cx"), y: +c.getAttribute("cy") })),
  );
  await clickPoint(photo, endpoints[1]);
  await clickPoint(photo, endpoints[0]);
  await expectDuplicate(2, 2);
  // Escape cancels a pending retry and clears transient feedback
  await clickCourt(17.75, 12.75);
  await court.press("Enter");
  await court.press("Escape");
  await expect(feedback).toHaveCount(0);
  // Fill the real UI limit, then confirm existing distances remain selectable
  for (let i = 0; i < 18; i++) {
    await clickCourt(17.75, 1 + i * 0.4);
    await clickCourt(31, 1 + i * 0.4);
  }
  await expect(rows).toHaveCount(20);
  await clickContact(court, first);
  await clickContact(photo, second);
  await expectDuplicate(20, 1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // A genuinely new distance still respects the limit and can be cancelled
  await clickCourt(19, 17);
  await clickCourt(30, 17);
  await expect(page.getByRole("alert")).toContainText("Limit 20");
  await expect(rows).toHaveCount(20);
  await court.press("Escape");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await clickContact(photo, second);
  await clickContact(court, first);
  await expectDuplicate(20, 1);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await clickContact(photo, second, true);
  await clickContact(court, first, true);
  await expectDuplicate(20, 1);
  await rows.first().screenshot({ path: "/tmp/freeze-floor-existing-distance-mobile.png" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(saveStatus).toHaveText("Saved on this device");
  await page.reload();
  await page.getByRole("button", { name: "Choose photo", exact: true }).click();
  await page.locator(".ff-library").getByRole("button", { name: "Measurement guard regression", exact: true }).click();
  await expect(rows).toHaveCount(20);
  await measure();
  await clickContact(photo, second);
  await clickContact(photo, first);
  await expectDuplicate(20, 1);
  await expect(saveStatus).toHaveText("Saved on this device");
  await page.getByRole("button", { name: "Delete distance 1", exact: true }).click();
  await expect(rows).toHaveCount(19);
  await expect(feedback).toHaveCount(0);
  await expect(court.locator('[data-highlighted="true"]')).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(uploads, []);
  console.log("Freeze Floor measurement regressions passed: repeated players and points, retained pending selection, reversed/cross-view duplicates, moved contacts, exact undo, full-limit reuse, Escape, reload, deletion, mobile, both themes, no errors or uploads");
} finally {
  await browser.close();
}
