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
const temporary = fs.mkdtempSync(join(tmpdir(), "jumper-freeze-ui-"));
const fixture = join(temporary, "silhouette.mp4");
if (!process.env.CAPTION_MEDIA) {
  execFileSync(".venv/bin/python", [
    "-c",
    `import subprocess, sys, imageio_ffmpeg
p = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s','320x180','-r','30','-i','pipe:0','-an','-c:v','libx264','-pix_fmt','yuv420p','-y',sys.argv[1]],stdin=subprocess.PIPE)
for frame in range(30):
    data = bytearray([224,224,224]) * (320*180)
    for y in range(40,140):
        for x in range(20+frame*4,50+frame*4):
            at = (y*320+x)*3
            data[at:at+3] = bytes([0,0,0])
    p.stdin.write(data)
p.stdin.close()
assert p.wait() == 0
`,
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
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes("editing"))
          this.addEventListener("message", ({ data }) => {
            if (data.kind === "done") window.freezeExport = data.result;
          });
      }
    };
  });
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
  await page
    .getByText("Protect shooting motion (optional)", { exact: true })
    .click();
  const markerFrame = page.getByLabel("Shot marker source frame", {
    exact: true,
  });
  const review = page.getByLabel("I reviewed the full motion:", {
    exact: false,
  });
  await review.check();
  const before = requests.length;
  for (const [kind, source] of [
    ["Gather", 3],
    ["Release", 15],
    ["Finish", 26],
  ]) {
    await markerFrame.fill(String(source));
    await page
      .getByRole("button", { name: `Mark ${kind} here`, exact: true })
      .click();
  }
  await expect(review).toBeChecked();
  await expect(
    page.getByRole("button", {
      name: "Finished video up to date",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No marker-based interruptions detected. Review the complete motion yourself.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Return to edited preview", exact: true })
    .click();
  await page.getByLabel("Piece start seconds", { exact: true }).fill("0.20");
  await expect(page.getByText(/Gather source frame 4 is absent/)).toBeVisible();
  await expect(review).not.toBeChecked();
  await page
    .getByRole("button", { name: "Inspect marked source frame 4", exact: true })
    .click();
  await expect(
    page.getByText(/Shot marker preview · source frame 4/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Undo: trim piece", exact: true })
    .click();
  await expect(page.getByText(/Gather source frame 4 is absent/)).toHaveCount(
    0,
  );
  // Clean split, then remove one source frame inside the marked motion.
  await page.getByLabel("Edit playhead", { exact: true }).fill("15");
  await page
    .getByRole("button", { name: "Split at playhead", exact: true })
    .click();
  await expect(page.getByText(/jumps through or reorders/)).toHaveCount(0);
  await page.getByLabel("Piece start seconds", { exact: true }).fill("0.53");
  await expect(
    page.getByText(/Release source frame 16 is absent/),
  ).toBeVisible();
  await expect(
    page.getByText(/The cut before Piece 2 jumps through/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Update finished video", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Finished video up to date",
      exact: true,
    }),
  ).toBeVisible({ timeout: 60000 });
  await review.check();
  // Advisory warning does not block saving, including source-frame metadata.
  await page
    .getByRole("button", { name: "Save to My Clips", exact: true })
    .click();
  await expect(
    page.getByText("Saved to My Clips", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove Finish marker", exact: true })
    .click();
  await expect(review).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Save to My Clips", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Undo: remove Finish marker", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove Finish marker", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await markerFrame.scrollIntoViewIfNeeded();
  await markerFrame.focus();
  await page.keyboard.press("ArrowRight");
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )),
  );
  await page.screenshot({
    path: "/tmp/jumper-shot-markers-mobile.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "My Clips", exact: true }).click();
  await page.getByRole("button", { name: "Edit copy", exact: true }).click();
  await page
    .getByText("Protect shooting motion (optional)", { exact: true })
    .click();
  for (const [kind, seconds, source] of [
    ["Gather", "0.10", 4],
    ["Release", "0.50", 16],
    ["Finish", "0.87", 27],
  ])
    await expect(
      page.getByRole("button", {
        name: `${kind} · ${seconds}s · Source frame ${source}`,
        exact: true,
      }),
    ).toBeVisible();
  await expect(
    page.getByText(/Release source frame 16 is absent/),
  ).toBeVisible();
  assert(
    !requests
      .slice(before)
      .some((url) => /huggingface|onnx|\/api\/jumper-lab/.test(url)),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS shot-marker browser workflow: exact source preview, warning/undo, clean split/gap, unrestricted render/save, review preservation, metadata reload, mobile/light/keyboard; " +
      (process.env.JUMPER_URL || "local"),
  );
} finally {
  await browser.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
