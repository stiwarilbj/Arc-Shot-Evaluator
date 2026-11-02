import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Browser plugin not available · Exercise real shared IndexedDB in two Chrome tabs
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const a = await context.newPage(), b = await context.newPage();
const errors = [], consoleIssues = [], uploads = [];
for (const page of [a, b]) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (["warning", "error"].includes(e.type())) consoleIssues.push(e.text());
  });
  page.on("request", (r) => { if (r.method() !== "GET") uploads.push(r.url()); });
}
const url = process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/Arc-Shot-Evaluator/#freeze-floor";
const name = (page) => page.getByLabel("Project name");
const saveButton = (page) => page.getByRole("button", { name: "Save project", exact: true });
const saved = (page) => page.getByRole("button", { name: "Saved", exact: true });
const conflict = (page) => page.getByRole("alert");
async function choose(page) {
  if (await page.locator(".ff-chooser").isVisible())
    await page.getByRole("button", { name: "Close photo chooser" }).click();
  await page.getByRole("button", { name: "Choose photo", exact: true }).click();
}
async function openSaved(page, title, saving = false) {
  await choose(page);
  await page.locator(".ff-library").getByRole("button", { name: title, exact: true }).click();
  await expect(name(page)).toHaveValue(title);
  if (!saving) await expect(saved(page)).toBeVisible();
  if (!(await name(page).isVisible()))
    await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
}
async function save(page, title) {
  await name(page).fill(title);
  await saveButton(page).click();
  await expect(saved(page)).toBeVisible();
}
async function records() {
  return a.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const values = await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readonly");
        const r = tx.objectStore("projects").getAll();
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = () => reject(tx.error);
      });
      return await Promise.all(values.map(async (v) => ({
        project: v.project, revision: v.revision,
        image: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await v.image.arrayBuffer()))),
      })));
    } finally { db.close(); }
  });
}
async function gateSave(page) {
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    window.releaseSave = undefined;
    window.createImageBitmap = async (...args) => {
      window.createImageBitmap = original;
      await new Promise((resolve) => { window.releaseSave = resolve; });
      return original(...args);
    };
  });
  await saveButton(page).click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseSave)).toBe("function");
}
try {
  await a.goto(url);
  await expect(a).toHaveTitle(/Freeze Floor/);
  await expect(a.locator(".ff-status")).toContainText("Alignment ready");
  await a.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await save(a, "Shared project");
  await b.goto(url);
  await expect(b.locator(".ff-status")).toContainText("Alignment ready");
  await b.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await openSaved(b, "Shared project");

  // A timestamp collision must not let the second tab overwrite the first
  const timestamp = (await records())[0].project.updatedAt;
  for (const page of [a, b]) await page.evaluate((value) => {
    Date.prototype.toISOString = () => value;
  }, timestamp);
  await name(b).fill("Tab B draft");
  await b.getByRole("checkbox", { name: "Paint", exact: true }).check();
  await save(a, "Tab A saved");
  const first = await records();
  await saveButton(b).click();
  await expect(conflict(b)).toContainText("changed in another tab");
  await expect(name(b)).toHaveValue("Tab B draft");
  await expect(b.getByRole("checkbox", { name: "Paint", exact: true })).toBeChecked();
  await expect(saved(b)).toHaveCount(0);
  assert.deepEqual(await records(), first, "conflicting save must preserve the complete stored record");
  await gateSave(b);
  await name(b).fill("Still editing Tab B draft");
  await b.evaluate(() => window.releaseSave());
  await expect(conflict(b)).toContainText("changed in another tab");
  await expect(name(b)).toHaveValue("Still editing Tab B draft");
  assert.deepEqual(await records(), first);
  const download = b.waitForEvent("download");
  await b.getByRole("button", { name: "Download PNG", exact: true }).click();
  assert.match((await download).suggestedFilename(), /\.png$/);
  await expect(b.locator(".ff-library")).toHaveCount(0);
  await openSaved(b, "Tab A saved");
  await save(b, "Tab B reopened");
  await save(b, "Tab B saved again");
  const second = await records();
  assert.notEqual(second[0].revision, first[0].revision);
  assert.equal(second[0].project.updatedAt, timestamp);

  // Renaming a stale library card must conflict as well
  await a.getByRole("button", { name: "Choose photo", exact: true }).click();
  // A fresh listing arrives on opening; retain its actual row while B changes it
  await expect(a.locator(".ff-library")).toContainText("Tab B saved again");
  await save(b, "Tab B newer");
  a.once("dialog", (d) => d.accept("Stale rename"));
  await a.locator(".ff-library").getByRole("button", { name: "Rename", exact: true }).click();
  await expect(conflict(a)).toContainText("changed in another tab");
  assert.equal((await records())[0].project.name, "Tab B newer");

  // Renaming a fresh card must not bless a different, older editor draft
  await expect(a.locator(".ff-library")).toContainText("Tab B newer");
  a.once("dialog", (d) => d.accept("Fresh rename"));
  await a.locator(".ff-library").getByRole("button", { name: "Rename", exact: true }).click();
  await expect(a.locator(".ff-library")).toContainText("Fresh rename");
  await name(a).fill("Still stale draft");
  await saveButton(a).click();
  await expect(conflict(a)).toContainText("changed in another tab");
  assert.equal((await records())[0].project.name, "Fresh rename");

  // A successful save advances its baseline even if more edits arrive in flight
  await openSaved(a, "Fresh rename");
  await name(a).fill("In-flight save");
  await gateSave(a);
  await name(a).fill("Edited during save");
  await a.evaluate(() => window.releaseSave());
  await expect(a.getByRole("button", { name: "Saving…", exact: true })).toHaveCount(0);
  await expect(saved(a)).toHaveCount(0);
  await saveButton(a).click();
  await expect(saved(a)).toBeVisible();
  assert.equal((await records())[0].project.name, "Edited during save");

  // Aborted writes must not advance the expected revision or prevent a clean retry
  const beforeAbort = await records();
  await a.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (this.name === "arc-freeze-floor-v1" && tx.mode === "readwrite") {
        IDBDatabase.prototype.transaction = original;
        queueMicrotask(() => tx.abort());
      }
      return tx;
    };
  });
  await name(a).fill("Retry after failed save");
  await saveButton(a).click();
  await expect(conflict(a)).toContainText("Could not save");
  assert.deepEqual(await records(), beforeAbort);
  await saveButton(a).click();
  await expect(saved(a)).toBeVisible();

  // Reopening the same ID during an older save must retain the reopened revision
  await name(a).fill("Saved after reopening");
  await gateSave(a);
  await openSaved(a, "Retry after failed save", true);
  await a.evaluate(() => window.releaseSave());
  await expect(a.getByRole("button", { name: "Saving…", exact: true })).toHaveCount(0);
  await name(a).fill("Reopened stale draft");
  await saveButton(a).click();
  await expect(conflict(a)).toContainText("changed in another tab");
  assert.equal((await records())[0].project.name, "Saved after reopening");

  // Legacy records without tokens open normally; first save upgrades them atomically
  await a.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite"), store = tx.objectStore("projects");
      const r = store.getAll();
      r.onsuccess = () => { const v = r.result[0]; delete v.revision; store.put(v); };
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await openSaved(a, "Saved after reopening");
  await openSaved(b, "Saved after reopening");
  await save(a, "Upgraded legacy project");
  await name(b).fill("Stale legacy draft");
  await saveButton(b).click();
  await expect(conflict(b)).toContainText("changed in another tab");
  assert.equal(typeof (await records())[0].revision, "string");

  // Simultaneous transactions from independent tabs may commit exactly one writer
  await openSaved(a, "Upgraded legacy project");
  await openSaved(b, "Upgraded legacy project");
  await name(a).fill("Concurrent A");
  await name(b).fill("Concurrent B");
  await gateSave(a);
  await gateSave(b);
  await Promise.all([a.evaluate(() => window.releaseSave()), b.evaluate(() => window.releaseSave())]);
  await expect.poll(async () => (await saved(a).count()) + (await saved(b).count())).toBe(1);
  const winner = (await saved(a).count()) ? a : b, loser = winner === a ? b : a;
  await expect(conflict(loser)).toContainText("changed in another tab");
  const committed = await records();
  assert.equal(committed[0].project.name, winner === a ? "Concurrent A" : "Concurrent B");
  await saveButton(loser).click();
  await expect(conflict(loser)).toContainText("changed in another tab");
  await expect(loser.getByRole("button", { name: "Saving…", exact: true })).toHaveCount(0);
  assert.deepEqual(await records(), committed);
  await loser.locator(".ff-error").scrollIntoViewIfNeeded();
  await loser.screenshot({ path: "/tmp/freeze-floor-conflict-desktop.png" });
  await loser.setViewportSize({ width: 360, height: 800 });
  await loser.getByRole("button", { name: "Light", exact: true }).click();
  assert.ok(await loser.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await loser.locator(".ff-error").scrollIntoViewIfNeeded();
  await loser.screenshot({ path: "/tmp/freeze-floor-conflict-mobile.png" });

  // A stale tab cannot resurrect a project that was deleted in the other tab
  await choose(winner);
  winner.once("dialog", (d) => d.accept());
  await winner.getByRole("button", { name: `Delete ${committed[0].project.name}`, exact: true }).click();
  await expect(winner.locator(".ff-library")).toHaveCount(0);
  await saveButton(loser).click();
  await expect(conflict(loser)).toContainText("deleted");
  await expect(name(loser)).toHaveValue(loser === a ? "Concurrent A" : "Concurrent B");
  assert.deepEqual(await records(), []);
  for (const page of [a, b]) await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(uploads, []);
  console.log("Freeze Floor conflicts passed: two tabs, same timestamps, stale saves/renames, preserved draft/PNG, reopen/retry, in-flight edits, legacy upgrade, simultaneous commits, deletion, mobile/light layout, no errors or uploads");
} finally { await browser.close(); }
