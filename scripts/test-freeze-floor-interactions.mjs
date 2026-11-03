import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
// Browser plugin not available · Exercise the real editor with installed Chrome
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  uploads = [],
  consoleIssues = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (entry) => {
  if (["warning", "error"].includes(entry.type())) consoleIssues.push(entry.text());
});
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
async function checkExportText() {
  async function downloadTextCase(expectedTitle, expectedCredit, path) {
    // Observe the real export SVG without replacing rendering or downloading
    await page.evaluate(() => {
      const original = URL.createObjectURL;
      window.exportTextSvg = null;
      URL.createObjectURL = function (blob) {
        if (blob.type === "image/svg+xml") {
          window.exportTextSvg = blob.text();
          URL.createObjectURL = original;
        }
        return original.call(this, blob);
      };
    });
    const nextDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PNG", exact: true }).click();
    const download = await nextDownload;
    assert.equal(await download.failure(), null);
    await download.saveAs(path);
    const svg = await page.evaluate(async () => await window.exportTextSvg);
    const png = (await readFile(path)).toString("base64");
    const result = await page.evaluate(async ({ svgText, pngBase64 }) => {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      if (doc.querySelector("parsererror")) throw Error("Export SVG cannot be parsed");
      const rendered = document.importNode(doc.documentElement, true);
      rendered.style.cssText = "position:fixed;left:-10000px;top:0;font-family:Arial,sans-serif";
      document.body.append(rendered);
      try {
        const info = (id) => {
          const text = rendered.querySelector(id), box = text.getBBox();
          return {
            content: text.textContent,
            bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
            lines: [...text.querySelectorAll("tspan")].map((line) => {
              const b = line.getBBox();
              return { text: line.textContent, x: b.x, end: b.x + b.width, y: b.y, bottom: b.y + b.height };
            }),
          };
        };
        const title = info("#ff-export-title"), credit = info("#ff-export-attribution");
        const img = await createImageBitmap(new Blob([
          Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0)),
        ], { type: "image/png" }));
        try {
          const canvas = new OffscreenCanvas(img.width, img.height), ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const last = credit.lines.at(-1);
          const pixels = ctx.getImageData(0, Math.floor(last.y), img.width, Math.ceil(last.bottom - last.y) + 1).data;
          let ink = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 70 && pixels[i + 1] > 70) ink++;
          return {
            title, credit, ink, width: img.width, height: img.height,
            svgHeight: +rendered.getAttribute("height"),
            scenes: [...rendered.querySelectorAll(":scope > svg")].map((scene) => ({ y: +scene.getAttribute("y"), height: +scene.getAttribute("height") })),
            notes: [...rendered.querySelectorAll(':scope > text[fill="#d4dcdd"]')].map((note) => ({ text: note.textContent, y: +note.getAttribute("y") })),
          };
        } finally { img.close(); }
      } finally { rendered.remove(); }
    }, { svgText: svg, pngBase64: png });
    const compact = (value) => value.replace(/\s+/gu, "");
    assert.equal(compact(result.title.content), compact(`Freeze Floor · ${expectedTitle}`));
    assert.equal(compact(result.credit.content), compact(expectedCredit), "complete title, creator, license and URL survive wrapping");
    assert.equal(result.width, 1800);
    assert.equal(result.height, result.svgHeight);
    for (const line of [...result.title.lines, ...result.credit.lines]) {
      assert.ok(line.x >= 29 && line.end <= 1772, `text stays inside its measured margin: ${line.end}`);
      assert.ok(line.y >= 0 && line.bottom < result.height - 15);
      assert.ok(!/^[\p{Mark}\u200d]/u.test(line.text), "wrapping keeps combining marks with their glyphs");
    }
    for (const scene of result.scenes) {
      assert.ok(scene.y > result.title.bounds.y + result.title.bounds.height + 50);
      assert.ok(scene.y + scene.height < result.credit.bounds.y - 30);
    }
    for (const note of result.notes) {
      assert.ok(note.y > Math.max(...result.scenes.map((s) => s.y + s.height)) + 50);
      assert.ok(note.y < result.credit.bounds.y - 30, "measurement notes stay between the courts and credits");
    }
    assert.ok(result.ink > 10, "independently decoded PNG contains the final credit line");
    return result;
  }
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await page.getByLabel("Project name").fill("Export text regression");
  await save();
  const baseline = await downloadTextCase("Export text regression", "Madison Square Garden court · Ganley894 · Public domain · https://commons.wikimedia.org/wiki/File:Madison_Square_Garden_court.jpg", "/tmp/freeze-floor-export-short-text.png");
  const longName = "W".repeat(80);
  const attribution = {
    title: (`Court <photo> & \"credit\"\n` + "W".repeat(250)).slice(0, 250),
    creator: "摄影者 · e\u0301 · 🏀 ".repeat(16) + "作者",
    license: "License <permission> & " + "W".repeat(77),
    url: "https://example.com/" + "W".repeat(980),
  };
  const ids = await page.evaluate(async ({ longName, attribution }) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readwrite"), store = tx.objectStore("projects");
        const read = store.getAll();
        let ids;
        read.onsuccess = () => {
          const base = read.result.find((r) => r.project.name === "Export text regression");
          const long = structuredClone(base), privatePhoto = structuredClone(base);
          long.project = { ...long.project, id: "export-long", name: longName, attribution };
          long.project.measurements = [{
            id: "export-distance", a: { image: base.project.anchors[0].image }, b: { image: base.project.anchors[1].image },
          }];
          privatePhoto.project = { ...privatePhoto.project, id: "export-private", name: "Private <court> & notes" };
          delete privatePhoto.project.attribution;
          store.put(long);
          store.put(privatePhoto);
          ids = [base.project.id, long.project.id, privatePhoto.project.id];
        };
        tx.oncomplete = () => resolve(ids);
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => {};
      });
    } finally { db.close(); }
  }, { longName, attribution });
  await openSaved(longName);
  const fullCredit = [attribution.title, attribution.creator, attribution.license, attribution.url].join(" · ");
  const longer = await downloadTextCase(longName, fullCredit, "/tmp/freeze-floor-export-long-text.png");
  assert.ok(longer.title.lines.length > 1);
  assert.ok(longer.credit.lines.length > 2);
  assert.ok(longer.height > baseline.height, "wrapped title and full credits increase PNG height");
  assert.equal(longer.notes.length, 1);
  assert.match(longer.notes[0].text, /Approx 16\.0 ft/);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  const mobile = await downloadTextCase(longName, fullCredit, "/tmp/freeze-floor-export-long-text-mobile.png");
  assert.deepEqual(mobile, longer, "export text layout is independent of viewport and UI theme");
  await openSaved("Private <court> & notes");
  const privatePhoto = await downloadTextCase("Private <court> & notes", "Your private photograph", "/tmp/freeze-floor-export-private-text.png");
  assert.equal(privatePhoto.credit.lines.length, 1);
  // Remove only this regression's fixtures before the existing library tests
  await page.evaluate(async (ids) => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("arc-freeze-floor-v1", 1); r.onsuccess = () => resolve(r.result); });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readwrite");
        for (const id of ids) tx.objectStore("projects").delete(id);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, ids);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.reload();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
}
async function checkLandmarkMismatches() {
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  const floorInspector = page.locator(".ff-inspector-grid > section").first();
  const labels = floorInspector.locator(".ff-landmark-label small");
  const largest = page.getByRole("button", { name: /^Select largest mismatch/ });
  await expect(labels).toHaveCount(4);
  await expect(labels).toHaveText(Array(4).fill("Fit mismatch: 0 px"));
  await largest.click();
  await expect(page.getByRole("status", { name: "Project save status" })).toHaveText("Sample unchanged");
  await expect(page.getByRole("button", { name: "Undo floor edit" })).toBeDisabled();
  const boundary = (await photo.locator("polyline").first().getAttribute("points"))
    .split(" ").slice(0, 2).map((s) => s.split(",").map(Number));
  async function addAnchor(landmark, x, y) {
    await page.getByLabel("Landmark to add", { exact: true }).selectOption(landmark);
    await page.getByRole("button", { name: "Add anchor", exact: true }).click();
    await photo.scrollIntoViewIfNeeded();
    const q = await photo.evaluate((svg, p) => {
      const q = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: q.x, y: q.y };
    }, { x, y });
    await page.mouse.click(q.x, q.y);
  }
  // Add two consistent floor points from the actual overlay, then a bad seventh
  await addAnchor("baseline-left", ...boundary[0]);
  await addAnchor("baseline-right", ...boundary[1]);
  await addAnchor("free-center", 1500, 150);
  await expect(labels).toHaveCount(7);
  const mismatchedLabel = labels.nth(6);
  await expect(largest).toHaveText(/Select largest mismatch · L7 · [1-9]\d* px/);
  const originalLabel = await mismatchedLabel.innerText();
  const marker = photo.locator("[data-anchor]").nth(6).locator("circle");
  const point = await circlePoint(marker);
  await page.getByRole("button", { name: /^L1 ·/ }).click();
  const smallRadius = await marker.getAttribute("r");
  await largest.focus();
  await largest.press("Enter");
  assert.ok(Number(await marker.getAttribute("r")) > Number(smallRadius));
  assert.deepEqual(await circlePoint(marker), point);
  await expect(floorInspector.locator(".ff-item-selected")).toContainText("L7 · Free-throw line midpoint");
  await expect(page.getByLabel("Reassign landmark")).toHaveValue("free-center");
  await expect(page.getByLabel("Include landmark 7", { exact: true })).toBeChecked();
  // Choosing the diagnostic adds no edit: undo removes the last authored anchor
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await expect(labels).toHaveCount(6);
  await page.getByRole("button", { name: "Redo floor edit" }).click();
  await expect(mismatchedLabel).toHaveText(originalLabel);
  await largest.click();
  await page.getByLabel("Landmark X (px)", { exact: true }).fill("1450");
  await page.getByLabel("Landmark X (px)", { exact: true }).press("Enter");
  await expect(mismatchedLabel).not.toHaveText(originalLabel);
  await page.getByRole("button", { name: "Undo floor edit" }).click();
  await expect(mismatchedLabel).toHaveText(originalLabel);
  // Drag previews update diagnostics immediately; Escape restores them exactly
  await photo.scrollIntoViewIfNeeded();
  const dragStart = await marker.evaluate((c) => {
    const q = new DOMPoint(+c.getAttribute("cx"), +c.getAttribute("cy")).matrixTransform(c.getScreenCTM());
    return { x: q.x, y: q.y };
  });
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x - 20, dragStart.y + 10, { steps: 4 });
  await expect(mismatchedLabel).not.toHaveText(originalLabel);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(mismatchedLabel).toHaveText(originalLabel);
  assert.deepEqual(await circlePoint(marker), point);
  await page.getByLabel("Include landmark 7", { exact: true }).uncheck();
  await expect(mismatchedLabel).toHaveText(originalLabel);
  await expect(largest).toContainText("L7");
  await expect(page.locator(".ff-status")).toContainText("Check alignment");
  await largest.click();
  await floorInspector.screenshot({ path: "/tmp/freeze-floor-mismatch-desktop.png" });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await floorInspector.screenshot({ path: "/tmp/freeze-floor-mismatch-mobile.png" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (let i = 1; i <= 6; i++) await page.getByLabel(`Include landmark ${i}`, { exact: true }).uncheck();
  await expect(labels).toHaveText(Array(7).fill("Fit mismatch: unavailable"));
  await expect(largest).toBeDisabled();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
async function checkNumeric(label, marker, axis) {
  const input = page.getByLabel(label, { exact: true });
  const original = await input.inputValue(), before = await circlePoint(marker);
  const max = Number(await input.getAttribute("max"));
  for (const invalid of [String(max + 1), "-1", ""]) {
    await input.fill(invalid);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription(`Enter a value from 0 to ${max} px`);
    await input.press(invalid === "-1" ? "Enter" : "Tab");
    await expect(input).toHaveValue(invalid);
    assert.deepEqual(await circlePoint(marker), before);
    await expect(page.getByRole("button", { name: "Undo floor edit" })).toBeDisabled();
    await input.press("Escape");
    await expect(input).toHaveValue(original);
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription("");
  }
  // Boundary values and a fractional correction commit once and undo exactly
  for (const valid of [0, max, Math.round((Number(original) + 0.1) * 10) / 10]) {
    await input.fill(String(valid));
    await input.press("Enter");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    near((await circlePoint(marker))[axis], valid);
    near((await circlePoint(marker))[axis === "x" ? "y" : "x"], before[axis === "x" ? "y" : "x"]);
    await page.getByRole("button", { name: "Undo floor edit" }).click();
    assert.deepEqual(await circlePoint(marker), before);
    await expect(input).toHaveValue(original);
    await expect(page.getByRole("button", { name: "Undo floor edit" })).toBeDisabled();
  }
}
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
  await checkExportText();
  await checkLandmarkMismatches();
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await page.getByRole("button", { name: /^L1 ·/ }).click();
  const firstAnchor = photo.locator("[data-anchor]").first().locator("circle");
  await checkNumeric("Landmark X (px)", firstAnchor, "x");
  await checkNumeric("Landmark Y (px)", firstAnchor, "y");
  const landmarkX = page.getByLabel("Landmark X (px)", { exact: true });
  await landmarkX.fill(String(Number(await landmarkX.getAttribute("max")) + 1));
  await page.locator(".ff-coordinate-fields").screenshot({ path: "/tmp/freeze-floor-coordinate-error-desktop.png" });
  await landmarkX.press("Escape");
  await page.getByRole("button", { name: "Player 1", exact: true }).click();
  const firstContact = photo.locator("[data-contact]").first().locator("circle");
  await checkNumeric("Contact X (px)", firstContact, "x");
  await checkNumeric("Contact Y (px)", firstContact, "y");
  // An invalid draft belongs to one selection, even when another has the same X
  const contactX = page.getByLabel("Contact X (px)", { exact: true });
  const sharedX = await contactX.inputValue();
  await page.getByRole("button", { name: "Player 2", exact: true }).click();
  await contactX.fill(sharedX);
  await contactX.press("Enter");
  await page.getByRole("button", { name: "Player 1", exact: true }).click();
  await contactX.fill("-1");
  await page.getByRole("button", { name: "Player 2", exact: true }).click();
  await expect(contactX).toHaveValue(sharedX);
  await expect(contactX).not.toHaveAttribute("aria-invalid", "true");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  const contactY = page.getByLabel("Contact Y (px)", { exact: true });
  await contactY.fill("-1");
  await contactY.press("Tab");
  await page.locator(".ff-coordinate-fields").screenshot({ path: "/tmp/freeze-floor-coordinate-error-mobile.png" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await contactY.press("Escape");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
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
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(uploads, []);
  console.log(
    "Freeze Floor browser regressions passed: measured PNG text wrapping, untruncated long credits and URLs, Unicode and XML escaping, decoded footer visibility, private-photo labels, viewport-independent exports, pixel-fit mismatch labels, largest-anchor keyboard selection without edits, correction/undo, excluded and unavailable diagnostics, accessible coordinate range errors, retained invalid drafts, Enter/blur/Escape, boundary/fractional edits, exact undo, selection isolation, undo/redo during contact and landmark drags, perspective-safe selection and measurements, contact-safe keyboard measurements, view-aware nudging/placement, reload, delayed rename/save/delete, mobile overflow, both themes, no runtime errors or uploads",
  );
} finally {
  await browser.close();
}
