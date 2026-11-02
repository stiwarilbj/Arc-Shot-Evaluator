import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  uploads = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.method() !== "GET") uploads.push(r.url());
});
const url =
  process.env.FREEZE_FLOOR_URL ||
  "http://127.0.0.1:5178/Arc-Shot-Evaluator/#freeze-floor";
const court = page.locator(".ff-panel").nth(1).locator("svg");
const photo = page.locator(".ff-photo>svg");
const garden = "Madison Square Garden · Floor alignment";
const knicks = "Knicks at the Garden · Wide view";
async function clickCourt(x, y) {
  await court.scrollIntoViewIfNeeded();
  const q = await court.evaluate(
    (svg, v) => {
      const q = new DOMPoint(v.x + 2, v.y + 2).matrixTransform(
        svg.getScreenCTM(),
      );
      return { x: q.x, y: q.y };
    },
    { x, y },
  );
  await page.mouse.click(q.x, q.y);
}
async function circlePoint(locator) {
  return locator.evaluate((c) => ({
    x: +c.getAttribute("cx"),
    y: +c.getAttribute("cy"),
  }));
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
async function choose() {
  if (!(await page.locator(".ff-chooser").isVisible()))
    await page
      .getByRole("button", { name: "Choose photo", exact: true })
      .click();
}
async function openSaved(name) {
  await choose();
  await page
    .locator(".ff-library")
    .getByRole("button", { name, exact: true })
    .click();
  const protection = page.getByRole("dialog", { name: "Keep your corrections?" });
  if (await protection.isVisible())
    await protection.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue(name);
}
const saved = () => page.getByRole("button", { name: "Saved", exact: true });
async function save() {
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(saved()).toBeVisible();
}
function row(name) {
  return page
    .locator(".ff-library>div")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
}
// Delay just one storage image check, leaving subsequent project opens usable.
async function gateImageCheck(fail = false) {
  await page.evaluate((fail) => {
    const original = window.createImageBitmap;
    window.createImageBitmap = async (...args) => {
      window.createImageBitmap = original;
      await new Promise((resolve, reject) => {
        window.releaseStorage = fail
          ? () => reject(Error("Injected delayed save failure"))
          : resolve;
      });
      return original(...args);
    };
  }, fail);
}
try {
  await page.goto(url);
  await expect(page).toHaveTitle(/Freeze Floor/);
  assert.match(page.url(), /#freeze-floor$/);
  await expect(
    page.getByRole("heading", { name: "Freeze Floor", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  // An unfinished drag must not override restored history in either view.
  for (const view of ["court", "photo"]) {
    for (const action of ["redo", "undo"]) {
      await page
        .getByRole("button", { name: "Check the alignment", exact: true })
        .click();
      const paint = page.getByRole("checkbox", { name: "Paint", exact: true });
      await paint.check();
      if (action === "redo")
        await page.getByRole("button", { name: "Undo floor edit" }).click();
      const stage = view === "court" ? court : photo;
      const marker = stage
        .locator(view === "court" ? "[data-contact]" : "[data-anchor]")
        .first()
        .locator("circle");
      const before = await circlePoint(marker);
      await stage.scrollIntoViewIfNeeded();
      const start = await marker.evaluate((c) => {
        const point = new DOMPoint(
          +c.getAttribute("cx"),
          +c.getAttribute("cy"),
        ).matrixTransform(c.getScreenCTM());
        return { x: point.x, y: point.y };
      });
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 15, start.y + 15, { steps: 5 });
      assert.notDeepEqual(await circlePoint(marker), before);
      await page.keyboard.press(
        action === "redo" ? "Control+Shift+z" : "Control+z",
      );
      await expect(paint).toBeChecked({ checked: action === "redo" });
      near((await circlePoint(marker)).x, before.x);
      near((await circlePoint(marker)).y, before.y);
      // Late pointer movement/release cannot resurrect the cancelled gesture.
      await page.mouse.move(start.x + 25, start.y + 25);
      await page.mouse.up();
      await expect(paint).toBeChecked({ checked: action === "redo" });
      near((await circlePoint(marker)).x, before.x);
      near((await circlePoint(marker)).y, before.y);
      // A completed new drag still creates exactly one undoable history entry.
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 15, start.y + 15, { steps: 5 });
      await page.mouse.up();
      const moved = await circlePoint(marker);
      assert.notDeepEqual(moved, before);
      await page.getByRole("button", { name: "Undo floor edit" }).click();
      near((await circlePoint(marker)).x, before.x);
      near((await circlePoint(marker)).y, before.y);
      await expect(paint).toBeChecked({ checked: action === "redo" });
      await page.getByRole("button", { name: "Redo floor edit" }).click();
      near((await circlePoint(marker)).x, moved.x);
      near((await circlePoint(marker)).y, moved.y);
      if (view === "court" && action === "redo")
        await page.screenshot({ path: "/tmp/freeze-floor-redo-after.png" });
      await page.reload();
      await expect(page.locator(".ff-status")).toContainText("Alignment ready");
    }
  }
  await page
    .getByRole("button", { name: "Check the alignment", exact: true })
    .click();
  // Perspective-compressed photo pixels must not create a huge overhead hit area.
  await page
    .getByRole("button", { name: "Add player contact", exact: true })
    .click();
  await clickCourt(25, 10);
  await page.getByLabel("Player 3 contact status").selectOption("grounded");
  await page
    .getByRole("button", { name: "Measure distance", exact: true })
    .click();
  await clickCourt(17.75, 12.75);
  await clickCourt(31, 3);
  await expect(page.getByRole("region", { name: "Distances" })).toContainText(
    "Approx 16.5 ft",
  );
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await clickCourt(17.75, 12.75);
  await expect(page.getByLabel("Contact X (px)")).toHaveCount(0);
  await clickCourt(25.2, 10);
  await expect(page.getByLabel("Contact X (px)")).toBeVisible();
  await page.getByLabel("Player 3 contact status").selectOption("hidden");
  await expect(page.getByRole("region", { name: "Distances" })).toContainText(
    "Approx 16.5 ft",
  );
  // Repeat at a narrow touch-sized viewport and in light mode.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await clickCourt(17.75, 12.75);
  await expect(page.getByLabel("Contact X (px)")).toHaveCount(0);
  await clickCourt(25.2, 10);
  await expect(page.getByLabel("Contact X (px)")).toBeVisible();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByLabel("Project name")
    .fill("Perspective selection regression");
  await save();
  await page.reload();
  await openSaved("Perspective selection regression");
  await expect(page.getByRole("region", { name: "Distances" })).toContainText(
    "Approx 16.5 ft",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs("/tmp/freeze-floor-perspective-export.png");
  assert.equal(await download.failure(), null);
  await court.screenshot({ path: "/tmp/freeze-floor-hit-after.png" });
  await page.reload();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await page
    .getByRole("button", { name: "Check the alignment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add player contact", exact: true })
    .click();
  await clickCourt(22, 8);
  await page.getByLabel("Player 3 contact status").selectOption("hidden");
  await page.getByRole("button", { name: "Player 3", exact: true }).click();
  await page
    .getByRole("button", { name: "Measure distance", exact: true })
    .click();
  await court.focus();
  await page.keyboard.press("Enter");
  await clickCourt(27, 12);
  const distances = page.getByRole("region", { name: "Distances" });
  await expect(distances).toContainText("Withheld");
  for (const status of ["airborne", "uncertain", "grounded"]) {
    await page.getByLabel("Player 3 contact status").selectOption(status);
    await expect(distances).toContainText(
      status === "grounded" ? "Approx 6.4 ft" : "Withheld",
    );
  }
  // Undo/redo the grounding change must retain the keyboard contact binding.
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await expect(distances).toContainText("Withheld");
  await page.getByRole("button", { name: "Redo floor edit" }).click();
  await expect(distances).toContainText("Approx 6.4 ft");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByRole("button", { name: "Player 3", exact: true }).click();
  const marker = court.locator("[data-contact]").last().locator("circle");
  let before = await circlePoint(marker);
  await court.focus();
  await page.keyboard.press("ArrowRight");
  let after = await circlePoint(marker);
  near(after.x - before.x, 0.1);
  near(after.y, before.y);
  before = after;
  await page.keyboard.press("Shift+ArrowDown");
  after = await circlePoint(marker);
  near(after.x, before.x);
  near(after.y - before.y, 1);
  const photoMarker = photo.locator("[data-contact]").last().locator("circle");
  before = await circlePoint(photoMarker);
  await photo.focus();
  await page.keyboard.press("ArrowRight");
  after = await circlePoint(photoMarker);
  near(after.x - before.x, 1);
  near(after.y, before.y);
  await page.getByLabel("Landmark to add").selectOption("half-left");
  await page.getByRole("button", { name: "Add anchor", exact: true }).click();
  const anchors = page.getByLabel(/Include landmark/);
  const count = await anchors.count();
  await court.focus();
  await page.keyboard.press("Enter");
  await expect(anchors).toHaveCount(count);
  await photo.focus();
  await page.keyboard.press("Enter");
  await expect(anchors).toHaveCount(count + 1);
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await expect(anchors).toHaveCount(count);
  await save();
  await page.reload();
  await openSaved(garden);
  await expect(page.getByRole("region", { name: "Distances" })).toContainText(
    "Approx",
  );
  await page
    .getByRole("button", { name: "Check the alignment", exact: true })
    .click();
  await page.getByLabel("Player 3 contact status").selectOption("hidden");
  await expect(page.getByRole("region", { name: "Distances" })).toContainText(
    "Withheld",
  );
  await save();
  await choose();
  await page
    .getByRole("button", {
      name: /Knicks at the Garden.*Reviewed manual alignment/,
    })
    .click();
  await save();
  await openSaved(garden);
  await choose();
  await gateImageCheck();
  page.once("dialog", (d) => d.accept("Renamed Garden"));
  await row(garden)
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseStorage))
    .toBe("function");
  await openSaved(knicks);
  await page.evaluate(() => window.releaseStorage());
  await choose();
  await expect(
    page
      .locator(".ff-library")
      .getByRole("button", { name: "Renamed Garden", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue(knicks);
  await expect(saved()).toBeVisible();
  // A delayed save failure from A must not mark the newly opened B as unsaved.
  await openSaved("Renamed Garden");
  await page.getByLabel("Project name").fill("Unsaved A");
  await gateImageCheck(true);
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseStorage))
    .toBe("function");
  await openSaved(knicks);
  await page.evaluate(() => window.releaseStorage());
  await expect(
    page.getByRole("button", { name: "Saving", exact: true }),
  ).toHaveCount(0);
  await expect(saved()).toBeVisible();
  await expect(page.locator(".ff-error")).toHaveCount(0);
  // Hold the deletion's DB-open callback while B is opened through a separate request.
  await openSaved("Renamed Garden");
  await choose();
  await page.evaluate(() => {
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      IDBFactory.prototype.open = original;
      const request = original.apply(this, args);
      Object.defineProperty(request, "onsuccess", {
        set(fn) {
          request.addEventListener("success", (event) => {
            window.releaseDelete = () => fn.call(request, event);
          });
        },
      });
      return request;
    };
  });
  page.once("dialog", (d) => d.accept());
  await row("Renamed Garden")
    .getByRole("button", { name: "Delete Renamed Garden", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseDelete))
    .toBe("function");
  await openSaved(knicks);
  await page.evaluate(() => window.releaseDelete());
  await choose();
  await expect(
    page
      .locator(".ff-library")
      .getByRole("button", { name: "Renamed Garden", exact: true }),
  ).toHaveCount(0);
  await expect(saved()).toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue(knicks);
  // An unaligned overhead view cannot create invisible contacts via Enter.
  await page
    .getByRole("button", { name: /Finals.*Insufficient floor evidence/ })
    .click();
  await expect(page.locator(".ff-status")).toContainText(
    "Insufficient court evidence",
  );
  await page
    .getByRole("button", { name: "Check the alignment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add player contact", exact: true })
    .click();
  const contacts = page.getByLabel(/Player \d+ contact status/);
  const contactCount = await contacts.count();
  await court.focus();
  await page.keyboard.press("Enter");
  await expect(contacts).toHaveCount(contactCount);
  await photo.focus();
  await page.keyboard.press("Enter");
  await expect(contacts).toHaveCount(contactCount + 1);
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await openSaved(knicks);
  await page.locator(".ff-heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/freeze-floor-interactions-desktop.png" });
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/freeze-floor-interactions-mobile.png" });
  assert.deepEqual(errors, []);
  assert.deepEqual(uploads, []);
  console.log(
    "Freeze Floor browser regressions passed: undo/redo during contact and landmark drags, perspective-safe selection and measurements, PNG export, contact-safe keyboard measurements, view-aware nudging/placement, reload, delayed rename/save/delete, mobile overflow, no runtime errors or uploads",
  );
} finally {
  await browser.close();
}
