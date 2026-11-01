import { createRequire } from "node:module";
import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(process.cwd() + "/frontend/package.json");
const { chromium, expect } = require("@playwright/test");
// Only the masking worker is stubbed; actual mask decoding, editor and export run.
// Run against a dev/preview server with JUMPER_URL; requires the local Python setup.
const temporary = fs.mkdtempSync(join(tmpdir(), "jumper-caption-ui-"));
const fixture = join(temporary, "silhouette.mp4");
if (!process.env.CAPTION_MEDIA) {
  const ffmpeg = execFileSync(
    ".venv/bin/python",
    ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],
    { encoding: "utf8" },
  ).trim();
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xe0e0e0:s=640x360:r=30:d=1",
    "-vf",
    "drawbox=x=285:y=60:w=65:h=240:color=black:t=fill,drawbox=x=90:y=70:w=55:h=220:color=0x808080:t=fill",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    fixture,
  ]);
}
const media = fs
  .readFileSync(process.env.CAPTION_MEDIA || fixture)
  .toString("base64");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(10000);
  const errors = [],
    requests = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning")
      console.log("Browser error:", msg.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.route(/\/masking[^/]*\.(?:js|ts)(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `self.onmessage=({data})=>{if(data.kind!=='process')return;const blob=new Blob([Uint8Array.from(atob(${JSON.stringify(media)}),c=>c.charCodeAt(0))],{type:'video/mp4'});self.postMessage({kind:'done',id:data.id,result:{highlight:blob,quiz:blob,reveal:blob,duration:${process.env.CAPTION_MEDIA ? 0.2 : 1},presentation:'silhouette-palette-v1',objects:data.request.objects,warnings:[]}})};`,
    }),
  );
  await page.goto(
    (process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/") +
      "#jumper/create",
  );
  await expect(page).toHaveTitle("ARCade Hoops · Create · Guess the Jumper");
  await page
    .locator(".jumper-upload input")
    .setInputFiles(process.cwd() + "/tests/fixtures/jumper/research-shot.mp4");
  const image = page.getByAltText(
    "Selected video frame; click to aim a mask point",
  );
  await image.waitFor();
  await image.click();
  await page.getByRole("button", { name: "Place point", exact: true }).click();
  await page
    .getByText("Correct masks & player selection", { exact: true })
    .click();
  await page
    .getByLabel("Find other people automatically, including later entrants")
    .uncheck();
  await page.getByRole("button", { name: "Process clip", exact: true }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const before = requests.length;
  await page.getByLabel("New caption", { exact: true }).fill("Watch the shot");
  await page
    .getByRole("button", { name: "Add at current time", exact: true })
    .click();
  await page.getByLabel(/^Placement/).selectOption("center");
  await expect(
    page.getByText("Silhouette overlap checked.", { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  if (!process.env.CAPTION_MEDIA) {
    await expect(
      page.getByRole("button", { name: "Inspect caption 1", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Inspect caption 1", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Try top · less silhouette overlap",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: join(temporary, "desktop.png"),
      fullPage: true,
    });
    // Warning is advisory: exporting at the user's selected position is allowed.
    await page
      .getByRole("button", { name: "Update finished video", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Finished video up to date",
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      page.getByRole("button", { name: "Inspect caption 1", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Try top · less silhouette overlap",
        exact: true,
      })
      .click();
    await expect(page.getByLabel(/^Placement/)).toHaveValue("top");
    await expect(
      page.getByText("Silhouette overlap checked.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Inspect caption 1", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /Undo: move caption/ }).click();
    await expect(page.getByLabel(/^Placement/)).toHaveValue("center");
    await expect(
      page.getByRole("button", { name: "Inspect caption 1", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await page
      .getByRole("button", { name: "Inspect caption 1", exact: true })
      .scrollIntoViewIfNeeded();
    assert(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )),
    );
    const suggestion = page.getByRole("button", {
      name: "Try top · less silhouette overlap",
      exact: true,
    });
    await suggestion.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel(/^Placement/)).toHaveValue("top");
    await page.screenshot({
      path: join(temporary, "mobile.png"),
      fullPage: true,
    });
  }
  assert(
    !requests
      .slice(before)
      .some((u) => /huggingface|onnx|\/api\/jumper-lab/.test(u)),
    "editing must not start inference",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS caption browser UI, mask decoding, advisory export, suggestion/undo, mobile/light/keyboard, no inference",
    process.env.JUMPER_URL || "local",
  );
} catch (e) {
  console.error(e);
  throw e;
} finally {
  await browser.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
