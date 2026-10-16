import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("../frontend/node_modules/@playwright/test");
const output =
  process.env.JUMPER_MASKS || path.join(tmpdir(), "arc-jumper-masks.json");
(async () => {
  const b = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--use-angle=metal",
    ],
  });
  try {
    const p = await b.newPage();
    await p.addInitScript(() => {
      window.checkMasks = [];
      window.checkRgb = [];
      window.checkPred = [];
      const Original = window.Worker;
      window.Worker = class extends Original {
        postMessage(data, ...rest) {
          if (data.kind === "process") window.maskRequest = data.request;
          return super.postMessage(data, ...rest);
        }
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (data.kind === "verify-mask")
              window.checkMasks.push({
                ...data,
                owners: Array.from(data.owners),
              });
            if (data.kind === "verify-rgb")
              window.checkRgb.push({ ...data, rgb: Array.from(data.rgb) });
            if (data.kind === "verify-pred")
              window.checkPred.push({ ...data, low: Array.from(data.low) });
          });
        }
      };
    });
    await p.route("**/masking.worker.ts*", async (route) => {
      let r = await route.fetch();
      let code = await r.text();
      code = code.replace(
        "if (!owners.includes(target_id))",
        'context.postMessage({kind:"verify-mask",frame,width,height,owners}); if (!owners.includes(target_id))',
      );
      code = code.replace(
        "const rgb = canvasContext.getImageData(0, 0, width, height).data;",
        'const rgb = canvasContext.getImageData(0, 0, width, height).data; context.postMessage({kind:"verify-rgb",frame,width,height,rgb});',
      );
      code = code.replace(
        "const prediction = await predict(feats, raw, prompt);",
        'const prediction = await predict(feats, raw, prompt); context.postMessage({kind:"verify-pred",frame,low:prediction.low});',
      );
      await route.fulfill({ response: r, body: code });
    });
    p.on("pageerror", (e) => console.log(e.message));
    await p.goto(
      process.env.JUMPER_URL || "http://127.0.0.1:5175/Arc-Shot-Evaluator/",
    );
    await p.getByRole("button", { name: /Others/ }).click();
    await p.getByRole("menuitem").click();
    await p.getByRole("button", { name: "Create", exact: true }).click();
    await p.locator(".jumper-upload input").waitFor();
    await p
      .locator(".jumper-upload input")
      .setInputFiles(
        process.env.JUMPER_FIXTURE ||
          new URL(
            "../tests/fixtures/jumper/research-short.mp4",
            import.meta.url,
          ).pathname,
      );
    await p.getByPlaceholder("e.g. Stephen Curry").fill("Test Shooter");
    const img = p.getByAltText(
      "Selected video frame; click to add a mask point",
    );
    await img.waitFor();
    const box = await img.boundingBox();
    const point = (process.env.JUMPER_POINT || ".485,.64")
      .split(",")
      .map(Number);
    await img.click({
      position: { x: box.width * point[0], y: box.height * point[1] },
    });
    await p.locator(".jumper-corrections summary").click();
    // Compare the same explicit identities/prompts rather than detector differences.
    await p
      .getByLabel("Find other people automatically", { exact: false })
      .uncheck();
    if (process.env.JUMPER_SECOND_POINT) {
      const second = process.env.JUMPER_SECOND_POINT.split(",").map(Number);
      await p.getByRole("button", { name: "Add player", exact: true }).click();
      await img.click({
        position: { x: box.width * second[0], y: box.height * second[1] },
      });
      await p.getByRole("button", { name: "Track 1", exact: true }).click();
    }
    if (process.env.JUMPER_CORRECTION) {
      await p.getByLabel("Correction frame").fill("4");
      await p.getByRole("button", { name: "Exclude", exact: true }).click();
      await p.waitForTimeout(300);
      await img.click({
        position: { x: box.width * 0.1, y: box.height * 0.1 },
      });
      await p.getByRole("button", { name: "Include", exact: true }).click();
      await img.click({
        position: { x: box.width * point[0], y: box.height * point[1] },
      });
    }
    await p.getByRole("button", { name: "Process clip", exact: true }).click();
    await p
      .locator(".jumper-progress")
      .filter({ hasText: "Ready for review" })
      .waitFor({ timeout: 180000 });
    const masks = await p.evaluate(() => window.checkMasks);
    if (masks.length !== 9) throw Error("Incomplete mask capture");
    console.log("masks", masks.length, "output", output);
    const request = await p.evaluate(() => window.maskRequest);
    const rgb = await p.evaluate(() => window.checkRgb);
    const predictions = await p.evaluate(() => window.checkPred);
    if (rgb.length !== 9) throw Error("Incomplete decoded frame capture");
    fs.writeFileSync(
      output,
      JSON.stringify({ request, masks, rgb, predictions }),
    );
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
