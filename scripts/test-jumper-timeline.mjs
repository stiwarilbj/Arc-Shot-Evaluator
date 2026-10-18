import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const {
  chromium,
  expect,
} = require("../frontend/node_modules/@playwright/test");
// Controlled worker evidence exercises every timeline state; real inference is checked separately.
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const media = readFileSync(
    new URL("../tests/fixtures/jumper/research-short.mp4", import.meta.url),
  ).toString("base64");
  await page.route(/\/masking[^/]*\.js(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `self.onmessage=({data})=>{const bytes=Uint8Array.from(atob(${JSON.stringify(media)}),c=>c.charCodeAt(0));const blob=new Blob([bytes],{type:'video/mp4'});self.postMessage({kind:'done',id:data.id,result:{highlight:blob,quiz:blob,reveal:blob,duration:.3,objects:[{id:1,prompts:[{frame:0,points:[[.5,.5]],labels:[1]}]},{id:7,prompts:[{frame:0,box:[.1,.1,.3,.9]}]},{id:9,prompts:[{frame:0,box:[.6,.1,.9,.9]}]}],warnings:[{frame:0,kind:'target_lost',track_ids:[1]},{frame:1,kind:'tracking_unstable',track_ids:[1]},{frame:2,kind:'ambiguous_players',track_ids:[7,9]},{frame:3,kind:'ambiguous_players',track_ids:[7,9]},{frame:7,kind:'ambiguous_players',track_ids:[7,9]},{frame:8,kind:'possible_camera_cut'},{frame:4,kind:'mask_joined',track_ids:[7,9]},{frame:5,kind:'mask_joined',track_ids:[7,9]}]}})};`,
    }),
  );
  await page.goto(
    process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/",
  );
  console.log(page.url(), await page.title());
  await page.getByRole("button", { name: /Others/ }).click();
  await page.getByRole("menuitem").click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .locator(".jumper-upload input")
    .setInputFiles(
      new URL("../tests/fixtures/jumper/research-short.mp4", import.meta.url)
        .pathname,
    );
  const image = page.getByAltText(
    "Selected video frame; click to aim a mask point",
  );
  await image.waitFor();
  await image.click();
  await page.getByRole("button", { name: "Place point", exact: true }).click();
  // This fixture supplies worker evidence, not detector output.
  await page.locator(".jumper-corrections summary").click();
  await page
    .getByLabel("Find other people automatically", { exact: false })
    .uncheck();
  await page.locator(".jumper-corrections summary").click();
  await page.getByRole("button", { name: "Process clip", exact: true }).click();
  const timeline = page.getByRole("region", { name: "Mask-quality timeline" });
  await expect(timeline).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: /flagged frames?/ }),
  ).toHaveCount(5);
  const overlap = timeline.getByRole("button", {
    name: "Uncertain player match: 3 flagged frames",
    exact: true,
  });
  const rail = await overlap.locator("svg").boundingBox();
  await page.mouse.click(
    rail.x + (rail.width * 2.5) / 9,
    rail.y + rail.height / 2,
  );
  await expect(
    page.getByLabel("Correction frame", { exact: true }),
  ).toHaveValue("2");
  await expect(
    page.getByText("Editing track 7 ·", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".jumper-corrections")).toHaveAttribute("open", "");
  await timeline
    .getByRole("button", { name: "Inspect track 9", exact: true })
    .click();
  await expect(
    page.getByText("Editing track 9 ·", { exact: false }),
  ).toBeVisible();
  await overlap.focus();
  await overlap.press("ArrowRight");
  await expect(
    page.getByLabel("Correction frame", { exact: true }),
  ).toHaveValue("3");
  await overlap.press("ArrowRight");
  await expect(
    page.getByLabel("Correction frame", { exact: true }),
  ).toHaveValue("7");
  await overlap.press("ArrowLeft");
  await expect(
    page.getByLabel("Correction frame", { exact: true }),
  ).toHaveValue("3");
  await timeline
    .getByRole("button", {
      name: "Possible camera cut: 1 flagged frame",
      exact: true,
    })
    .press("Enter");
  await expect(
    page.getByLabel("Correction frame", { exact: true }),
  ).toHaveValue("8");
  await expect(timeline.getByText(/Scene-wide hint/)).toBeVisible();
  await timeline
    .getByRole("button", {
      name: "Missing shooter: 1 flagged frame",
      exact: true,
    })
    .press("Enter");
  await expect(
    page.getByLabel("Correction frame", { exact: true }),
  ).toHaveValue("0");
  await expect(
    page.getByText("Editing track 1 ·", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save to My Clips", exact: true }),
  ).toBeDisabled();
  const joined = timeline.getByRole("button", {
    name: "Possible joined players: 2 flagged frames",
    exact: true,
  });
  await joined.press("Enter");
  await expect(
    page.getByLabel("Correction frame", { exact: true }),
  ).toHaveValue("4");
  await expect(
    timeline.getByRole("button", { name: "Inspect track 7", exact: true }),
  ).toBeVisible();
  await timeline
    .getByRole("button", { name: "Inspect track 9", exact: true })
    .click();
  await expect(
    page.getByText("Editing track 9 ·", { exact: false }),
  ).toBeVisible();
  await joined.press("ArrowRight");
  await expect(
    page.getByLabel("Correction frame", { exact: true }),
  ).toHaveValue("5");
  await expect(
    timeline.getByText(/Real occlusion can produce similar evidence/),
  ).toBeVisible();
  // Adding a correction retains the report as explicitly stale review evidence.
  await overlap.press("ArrowRight");
  await image.focus();
  await image.press("ArrowRight");
  await image.press("Enter");
  await expect(
    timeline.getByText("Frames to review · Previous run", { exact: true }),
  ).toBeVisible();
  await expect(timeline.getByText(/reprocess to refresh/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(overlap).toBeVisible();
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("Mobile overflow");
  await expect(image).toBeVisible();
  await page.waitForTimeout(200);
  await timeline.screenshot({ path: "/tmp/jumper-timeline-mobile.png" });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await timeline.screenshot({ path: "/tmp/jumper-timeline-light.png" });
  await page
    .getByRole("button", { name: "Select shooter again", exact: true })
    .click();
  await expect(timeline).toHaveCount(0);
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Timeline markers, exact frame/track selection, overlap choices, scene hints, keyboard, stale evidence, reset, mobile/light layout: PASS",
  );
} finally {
  await browser.close();
}
