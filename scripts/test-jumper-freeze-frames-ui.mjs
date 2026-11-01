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
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByLabel("Edit playhead", { exact: true }).fill("15");
  const before = requests.length;
  await page.evaluate(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    window.freezeCanvasFailure = true;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      if (
        window.freezeCanvasFailure &&
        this.width === 256 &&
        args[1]?.willReadFrequently === true &&
        !this.isConnected
      ) {
        window.freezeCanvasFailure = false;
        return null;
      }
      return get.apply(this, args);
    };
  });
  await page
    .getByRole("button", { name: "Choose a nearby freeze frame", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry freeze previews", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Freeze at playhead", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Retry freeze previews", exact: true })
    .click();
  const choices = page.getByRole("group", {
    name: "Choose recorded freeze frame",
    exact: true,
  });
  await expect(choices.getByRole("button")).toHaveCount(5);
  await expect(
    page.getByRole("button", {
      name: "Finished video up to date",
      exact: true,
    }),
  ).toBeVisible();
  const choice = choices.getByRole("button").filter({
    has: page.getByAltText("Masked source frame 19", { exact: true }),
  });
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Edit playhead", { exact: true })).toHaveValue(
    "18",
  );
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  // Choosing a recorded frame only seeks. It is not a dirty edit or undo operation.
  await expect(
    page.getByRole("button", {
      name: "Finished video up to date",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo: no edits", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path:
      process.env.FREEZE_DESKTOP_SCREENSHOT || join(temporary, "desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await choices.scrollIntoViewIfNeeded();
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )),
  );
  await page.screenshot({
    path: process.env.FREEZE_MOBILE_SCREENSHOT || join(temporary, "mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Freeze at playhead", exact: true })
    .click();
  await expect(page.getByLabel("Freeze duration", { exact: true })).toHaveValue(
    "1.00",
  );
  await expect(
    page.getByRole("button", { name: "Undo: insert freeze", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", {
      name: "Refresh around current playhead",
      exact: true,
    })
    .click();
  await expect(choices.getByRole("button")).toHaveCount(1);
  await expect(choices.getByRole("img")).toHaveAttribute(
    "alt",
    "Masked source frame 19",
  );
  await page
    .getByRole("button", { name: "Update finished video", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Finished video up to date",
      exact: true,
    }),
  ).toBeVisible({ timeout: 60000 });
  const bytes = await page.evaluate(async () =>
    Array.from(new Uint8Array(await window.freezeExport.clean.arrayBuffer())),
  );
  const exported = join(temporary, "frozen.mp4");
  fs.writeFileSync(exported, Buffer.from(bytes));
  const verification = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import subprocess,sys,imageio_ffmpeg
raw=subprocess.check_output([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-i',sys.argv[1],'-f','rawvideo','-pix_fmt','gray','pipe:1'])
size=320*180
assert len(raw)==60*size, len(raw)
def center(frame):
    data=raw[frame*size:(frame+1)*size]
    xs=[i%320 for i,v in enumerate(data) if v<24]
    return sum(xs)/len(xs)
for frame in (18,25,35,47):
    assert abs(center(frame)-106.5)<1, (frame,center(frame))
assert center(49)>center(47)+2
print('Independent decode: exact selected source pose held for all 30 freeze frames, 60 total frames.')
`,
      exported,
    ],
    { encoding: "utf8" },
  );
  console.log(verification.trim());
  await page
    .getByRole("button", { name: "Undo: insert freeze", exact: true })
    .click();
  await expect(page.getByLabel("Freeze duration", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Redo: insert freeze", exact: true })
    .click();
  await expect(page.getByLabel("Freeze duration", { exact: true })).toHaveValue(
    "1.00",
  );
  assert(
    !requests
      .slice(before)
      .some((url) => /huggingface|onnx|\/api\/jumper-lab/.test(url)),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS freeze frame browser choices, keyboard, no-dirty selection, mobile/light, insert/undo/redo and real export",
    process.env.JUMPER_URL || "local",
  );
} finally {
  await browser.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
