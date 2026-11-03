import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Browser plugin not available · Use the repository's installed Playwright/Chrome
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], uploads = [], consoleIssues = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (entry) => {
  if (["warning", "error"].includes(entry.type())) consoleIssues.push(entry.text());
});
page.on("request", (r) => {
  if (r.method() !== "GET") uploads.push(r.url());
});
const url = process.env.FREEZE_FLOOR_URL || "http://127.0.0.1:5178/#freeze-floor";
const chooser = page.getByRole("button", { name: "Choose photo", exact: true });
const warning = page.getByRole("status", { name: "Unavailable saved projects" });
const library = page.locator(".ff-library");

async function choose() {
  if (!(await page.locator(".ff-chooser").isVisible())) await chooser.click();
}
async function refresh() {
  await page.getByRole("button", { name: "Close photo chooser" }).click();
  await chooser.click();
}
async function traceProjectReads() {
  await page.evaluate(() => {
    window.projectReads = [];
    if (window.projectReadTracking) return;
    window.projectReadTracking = true;
    for (const method of ["get", "getAll", "openCursor", "getAllKeys", "openKeyCursor"]) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (...args) {
        if (this.transaction.db.name === "arc-freeze-floor-v1" &&
          this.transaction.mode === "readonly")
          window.projectReads.push({ method, key: args[0] ?? null });
        return original.apply(this, args);
      };
    }
  });
}
// Hold delivery after a real readonly transaction finishes, releasing its locks
// so subsequent saves/deletions can complete before the older promise settles
async function holdNextListing(fail = false) {
  await page.evaluate((fail) => {
    window.releaseListing = undefined;
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (this.name === "arc-freeze-floor-v1" && tx.mode === "readonly") {
        IDBDatabase.prototype.transaction = original;
        const deliveries = [];
        for (const event of ["complete", "error", "abort"]) {
          Object.defineProperty(tx, `on${event}`, {
            set(callback) {
              tx.addEventListener(event, (e) => {
                deliveries.push(() => callback.call(tx, e));
                window.releaseListing = () => deliveries.splice(0).forEach((deliver) => deliver());
              });
            },
          });
        }
        if (fail) queueMicrotask(() => tx.abort());
      }
      return tx;
    };
  }, fail);
  await refresh();
  await expect.poll(() => page.evaluate(() => typeof window.releaseListing)).toBe("function");
}
async function releaseListing() {
  await page.evaluate(async () => {
    window.releaseListing();
    // Let React commit any stale update before asserting the visible result
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function records() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readonly");
        const store = tx.objectStore("projects");
        const values = store.getAll(), keys = store.getAllKeys();
        tx.oncomplete = () => resolve(values.result.map((value, i) => ({
          key: keys.result[i], value,
        })));
        tx.onabort = () => reject(tx.error);
      });
      return await Promise.all(rows.map(async ({ key, value }) => ({
        key,
        project: value.project,
        revision: value.revision,
        image: value.image instanceof Blob ? {
          type: value.image.type,
          size: value.image.size,
          digest: Array.from(new Uint8Array(await crypto.subtle.digest(
            "SHA-256", await value.image.arrayBuffer(),
          ))).map((n) => n.toString(16).padStart(2, "0")).join(""),
        } : value.image,
      })));
    } finally {
      db.close();
    }
  });
}
async function deleteKeys(keys) {
  await page.evaluate(async (keys) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readwrite");
        for (const key of keys) tx.objectStore("projects").delete(key);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, keys);
}
async function replaceLookupRecord(mode) {
  await page.evaluate(async (mode) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readwrite"), store = tx.objectStore("projects");
        const original = window.lookupRecord;
        if (mode === "missing") store.delete(original.project.id);
        else store.put(mode === "revision" ? { ...original, revision: null }
          : mode === "metadata" ? { ...original, project: { ...original.project, width: 0 } }
          : mode === "newer" ? { ...original, revision: crypto.randomUUID(),
            project: { ...original.project, name: "Latest single lookup" } }
          : original);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, mode);
}

try {
  await page.goto(url);
  await expect(page).toHaveTitle(/Freeze Floor/);
  assert.match(page.url(), /#freeze-floor$/);
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await choose();
  await expect(page.locator(".ff-chooser")).toContainText("Save your first project");
  await expect(warning).toHaveCount(0);
  await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await page.getByLabel("Project name").fill("Healthy newest project");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Healthy newest project", exact: true })).toBeVisible();
  await expect(warning).toHaveCount(0);

  // An older snapshot must not hide a project saved by a newer refresh
  await holdNextListing();
  await page.getByRole("button", { name: /Knicks at the Garden.*Reviewed manual alignment/ }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Knicks at the Garden · Wide view");
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await page.getByLabel("Project name").fill("Newly saved project");
  await choose();
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Newly saved project", exact: true })).toBeVisible();
  await releaseListing();
  await expect(library.getByRole("button", { name: "Newly saved project", exact: true })).toBeVisible();
  await expect(page.locator(".ff-chooser h3")).toContainText("2/20");

  // A captured card must not return after its actual deletion has committed
  await holdNextListing();
  page.once("dialog", (dialog) => dialog.accept());
  await library.getByRole("button", { name: "Delete Newly saved project", exact: true }).click();
  await expect(library.getByRole("button", { name: "Newly saved project", exact: true })).toHaveCount(0);
  await releaseListing();
  await expect(library.getByRole("button", { name: "Newly saved project", exact: true })).toHaveCount(0);
  await expect(page.locator(".ff-chooser h3")).toContainText("1/20");
  await library.getByRole("button", { name: "Healthy newest project", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Healthy newest project");
  await choose();

  // An older clean read cannot clear a newer damaged-record warning
  await holdNextListing();
  // Seed real IndexedDB with one older healthy project and four malformed records
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readwrite");
        const store = tx.objectStore("projects"), request = store.getAll();
        request.onsuccess = () => {
          const original = request.result[0];
          store.put({ ...original, project: {
            ...original.project, id: "healthy-older", name: "Healthy older project",
            updatedAt: "2020-01-01T00:00:00Z",
          } });
          store.put({ ...original, project: {
            ...original.project, id: "damaged-metadata", name: "Damaged dimensions", width: 0,
          } });
          store.put({ project: {
            ...original.project, id: "damaged-image", name: "Missing image",
          }, image: "preserve these original recovery bytes" });
          store.put({ project: { id: "damaged-unnamed", name: null }, image: null });
          store.put({ ...original, project: {
            ...original.project, id: "damaged-nested", name: "Damaged attribution",
            attribution: { title: "Photo", creator: "Author", license: "CC",
              url: { toString: null, valueOf: null } },
          } });
        };
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
  const original = await records();
  await refresh();
  await expect(library.getByRole("button", { name: "Healthy newest project", exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Healthy older project", exact: true })).toBeVisible();
  await expect(library.locator(":scope > div > button:first-child")).toHaveText([
    "Healthy newest project", "Healthy older project",
  ]);
  await expect(warning).toContainText("4 saved projects unavailable");
  for (const label of ["Damaged dimensions", "damaged-metadata", "Missing image", "damaged-image", "damaged-unnamed", "Damaged attribution", "damaged-nested"])
    await expect(warning).toContainText(label);
  await expect(warning).toContainText("preserved for recovery");
  await expect(page.locator(".ff-chooser h3")).toContainText("6/20");
  await releaseListing();
  await expect(warning).toContainText("4 saved projects unavailable");
  await expect(library.getByRole("button", { name: "Healthy older project", exact: true })).toBeVisible();
  await expect(page.locator(".ff-chooser h3")).toContainText("6/20");
  assert.deepEqual(await records(), original, "listing must not rewrite or delete any record");

  // Healthy projects still open, and source changes cannot erase the library warning
  await traceProjectReads();
  await library.getByRole("button", { name: "Healthy older project", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Healthy older project");
  assert.deepEqual(await page.evaluate(() => window.projectReads),
    [{ method: "get", key: "healthy-older" }],
    "opening a saved photograph must read only its keyed record, not other image blobs");
  await choose();
  await expect(warning).toContainText("4 saved projects unavailable");
  await page.getByLabel("Project name").fill("Healthy updated project");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(library.getByRole("button", { name: "Healthy updated project", exact: true })).toBeVisible();
  assert.deepEqual((await records()).filter((r) => String(r.key).startsWith("damaged-")),
    original.filter((r) => String(r.key).startsWith("damaged-")),
    "saving a healthy project must preserve damaged metadata and media");

  // An older failure cannot replace a newer save's success notice
  await holdNextListing(true);
  const paint = page.getByRole("checkbox", { name: "Paint", exact: true });
  await paint.setChecked(!(await paint.isChecked()));
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await expect(page.locator(".ff-notice")).toHaveText("Saved on this device");
  await releaseListing();
  await expect(page.locator(".ff-notice")).toHaveText("Saved on this device");

  // A genuinely interrupted read must reject, retaining the last known library
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = function (...args) {
      const request = original.apply(this, args);
      if (this.name === "projects" && this.transaction.mode === "readonly") {
        IDBObjectStore.prototype.openCursor = original;
        this.transaction.abort();
      }
      return request;
    };
  });
  await refresh();
  await expect(page.locator(".ff-notice")).toContainText("Project listing was interrupted");
  await expect(library.getByRole("button", { name: "Healthy updated project", exact: true })).toBeVisible();
  await expect(warning).toContainText("4 saved projects unavailable");

  await page.locator(".ff-chooser h3").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/freeze-floor-library-desktop.png" });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(warning).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await warning.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/freeze-floor-library-mobile.png" });

  // Persisted damage stays visible after reload, including an entirely damaged library
  await page.reload();
  await expect(page.locator(".ff-status")).toContainText("Alignment ready");
  await choose();
  await expect(warning).toContainText("4 saved projects unavailable");
  await expect(library.getByRole("button", { name: "Healthy updated project", exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Healthy newest project", exact: true })).toBeVisible();
  // Keep a real image and otherwise-valid metadata for the identity-only fixture
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readonly");
        const r = tx.objectStore("projects").get("healthy-older");
        tx.oncomplete = () => {
          const original = r.result;
          window.lookupRecord = original;
          window.identityCollisionRecord = { ...original, project: {
            ...original.project, id: "damaged-identities", name: "Shared landmark/player ID",
            contacts: [{ ...original.project.contacts[0], id: original.project.anchors[0].id }],
          } };
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  });

  // Stale cards must still validate only their requested record and preserve
  // the open photograph when that record was damaged or deleted elsewhere
  const openName = await page.getByLabel("Project name").inputValue();
  const openImage = await page.locator(".ff-photo>svg image").getAttribute("href");
  for (const mode of ["metadata", "revision", "missing"]) {
    await replaceLookupRecord(mode);
    const before = await records();
    await traceProjectReads();
    await library.getByRole("button", { name: "Healthy updated project", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Saved project is unavailable");
    await expect(page.getByLabel("Project name")).toHaveValue(openName);
    assert.equal(await page.locator(".ff-photo>svg image").getAttribute("href"), openImage);
    assert.deepEqual(await page.evaluate(() => window.projectReads),
      [{ method: "get", key: "healthy-older" }]);
    assert.deepEqual(await records(), before, "failed opens must not rewrite stored recovery data");
    await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
  }
  await replaceLookupRecord("newer");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      const request = original.apply(this, args);
      if (this.transaction.db.name === "arc-freeze-floor-v1" &&
        this.transaction.mode === "readonly") {
        IDBObjectStore.prototype.get = original;
        this.transaction.abort();
      }
      return request;
    };
  });
  await library.getByRole("button", { name: "Healthy updated project", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Saved project loading was interrupted");
  await expect(page.getByLabel("Project name")).toHaveValue(openName);
  assert.equal(await page.locator(".ff-photo>svg image").getAttribute("href"), openImage);
  await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
  // The next attempt uses the latest stored revision, not the stale card's token
  await library.getByRole("button", { name: "Healthy updated project", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Latest single lookup");
  if (!(await page.getByLabel("Project name").isVisible()))
    await page.getByRole("button", { name: "Check the alignment", exact: true }).click();
  await page.getByLabel("Project name").fill("Saved after single lookup");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await choose();
  await deleteKeys((await records()).filter((r) => !String(r.key).startsWith("damaged-")).map((r) => r.key));
  await refresh();
  await expect(library).toHaveCount(0);
  await expect(page.locator(".ff-chooser")).toContainText("No saved projects are currently available");
  await expect(page.locator(".ff-chooser")).not.toContainText("Save your first project");
  await expect(warning).toContainText("4 saved projects unavailable");
  assert.deepEqual(await records(), original.filter((r) => String(r.key).startsWith("damaged-")));

  // Remove only test fixtures to verify a later complete read clears the warning
  await holdNextListing();
  await deleteKeys(["damaged-metadata", "damaged-image", "damaged-nested"]);
  await refresh();
  await expect(warning).toContainText("1 saved project unavailable");
  await releaseListing();
  await expect(warning).toContainText("1 saved project unavailable");
  await deleteKeys(["damaged-unnamed"]);
  await refresh();
  await expect(warning).toHaveCount(0);
  await expect(page.locator(".ff-chooser")).toContainText("Save your first project");

  // Cross-collection identity collisions remain stored, without exposing an
  // ambiguous project that could select a landmark instead of its player
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("arc-freeze-floor-v1", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readwrite");
        tx.objectStore("projects").put(window.identityCollisionRecord);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
  const collisionRecord = await records();
  await refresh();
  await expect(warning).toContainText("Shared landmark/player ID");
  await expect(warning).toContainText("damaged-identities");
  await expect(library).toHaveCount(0);
  assert.deepEqual(await records(), collisionRecord, "identity conflicts must remain unchanged for recovery");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(uploads, []);
  console.log("Freeze Floor library passed: single-record loading, stale-card revision refresh, missing/damaged records, interrupted lookups and retries, out-of-order saves/deletions/warnings/errors, healthy/partial/damaged/empty listings, stored identities, chronological order, unchanged recovery records, open/save/reload, mobile/light layout, no runtime errors or uploads");
} finally {
  await browser.close();
}
