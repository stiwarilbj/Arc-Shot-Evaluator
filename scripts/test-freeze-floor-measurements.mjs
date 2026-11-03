import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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
async function checkCoverage() {
  const toggle = page.getByRole("checkbox", { name: "Measurement coverage", exact: true });
  const outlines = page.locator("[data-measurement-coverage]");
  const undo = page.getByRole("button", { name: "Undo floor edit" });
  const legend = page.locator(".ff-coverage-key");
  await expect(toggle).not.toBeChecked();
  await expect(outlines).toHaveCount(0);
  await expect(saveStatus).toHaveText("Sample unchanged");
  await expect(undo).toBeDisabled();
  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).toBeChecked();
  await expect(outlines).toHaveCount(2);
  await expect(legend).toContainText("Dashed blue outline");
  await expect(saveStatus).toHaveText("Sample unchanged");
  await expect(undo).toBeDisabled();
  for (const outline of await outlines.all()) {
    await expect(outline).toHaveAttribute("fill", "none");
    await expect(outline).toHaveAttribute("pointer-events", "none");
    await expect(outline.locator("polygon")).toHaveCount(2);
  }
  const courtPolygon = court.locator("[data-measurement-coverage] polygon").first();
  const vertices = (await courtPolygon.getAttribute("points")).split(" ").map((v) => v.split(",").map(Number));
  assert.deepEqual(vertices.map(([x, y]) => [x - 2, y - 2]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), [[17, 0], [17, 19], [33, 0], [33, 19]]);
  const photoVertices = (await photo.locator("[data-measurement-coverage] polygon").first().getAttribute("points"))
    .split(" ").map((v) => v.split(",").map(Number));
  for (const [x, y] of [[217, 623], [321, 704], [536, 598], [636, 653]]) {
    assert.ok(photoVertices.some(([px, py]) => Math.hypot(px - x, py - y) < 0.01), "photo coverage uses the same accepted correspondences");
  }
  // Pointer hit testing remains available through the display-only outline
  await measure();
  await clickCourt(40, 10);
  await expect(feedback).toContainText("Outside supported region");
  await court.press("Escape");
  await expect(feedback).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await clickCourt(25, 10);
  await clickCourt(40, 10);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Withheld");
  await expect(rows.first()).toContainText("Outside supported region");
  for (const stage of [photo, court]) {
    await expect(stage.locator('[data-measurement] circle[data-outside="true"]')).toHaveCount(1);
    await expect(stage.locator("[data-measurement] text")).toHaveText("Outside");
  }
  await page.screenshot({ path: "/tmp/freeze-floor-coverage-desktop.png", fullPage: true });
  const getPng = async (path) => {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PNG", exact: true }).click();
    const file = await download;
    assert.ok(file.suggestedFilename().endsWith(".png"));
    await file.saveAs(path);
    return (await readFile(await file.path())).toString("base64");
  };
  const withCoverage = await getPng("/tmp/freeze-floor-coverage-export.png");
  await toggle.uncheck();
  await expect(outlines).toHaveCount(0);
  await expect(rows.first()).toContainText("Outside supported region");
  const withoutCoverage = await getPng("/tmp/freeze-floor-no-coverage-export.png");
  const changedPixels = await page.evaluate(async (images) => {
    const decode = async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const img = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      if (img.width !== 1800) throw Error("Unexpected PNG dimensions");
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      img.close();
      return ctx.getImageData(1095, 115, 690, 652).data;
    };
    const [withOutline, withoutOutline] = await Promise.all(images.map(decode));
    let count = 0;
    // Antialiased blue borders remain visible beside the normal court lines
    for (let i = 0; i < withOutline.length; i += 4) {
      const blueChange = withOutline[i + 2] - withoutOutline[i + 2];
      const redChange = withOutline[i] - withoutOutline[i];
      if (blueChange > 10 && blueChange > redChange + 10) count++;
    }
    return count;
  }, [withCoverage, withoutCoverage]);
  assert.ok(changedPixels > 100, `decoded PNG includes the coverage outline only when enabled (${changedPixels} changed blue edge pixels)`);
  await toggle.check();
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await page.getByRole("checkbox", { name: "Include landmark 1", exact: true }).uncheck();
  await expect(outlines).toHaveCount(0);
  await expect(legend).toContainText("Measurement coverage unavailable");
  await undo.click();
  await expect(outlines).toHaveCount(2);
  await expect(courtPolygon).toHaveAttribute("points", vertices.map((v) => v.map((q) => q.toFixed(3)).join(",")).join(" "));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await toggle.scrollIntoViewIfNeeded();
  const box = await toggle.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(outlines).toHaveCount(0);
  await toggle.check();
  await expect(outlines).toHaveCount(2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: "/tmp/freeze-floor-coverage-mobile.png", fullPage: true });
  // Fresh page restores the sample without carrying test measurements forward
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.reload();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await expect(toggle).not.toBeChecked();
}
try {
  await page.goto(process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/Arc-Shot-Evaluator/#freeze-floor");
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await checkCoverage();
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
  console.log("Freeze Floor measurement regressions passed: accepted-landmark coverage in both views, outside-region endpoints, display-only toggles, insufficient fits and undo, decoded PNG coverage, repeated players and points, retained pending selection, reversed/cross-view duplicates, moved contacts, exact undo, full-limit reuse, Escape, reload, deletion, mobile, both themes, no errors or uploads");
} finally {
  await browser.close();
}
