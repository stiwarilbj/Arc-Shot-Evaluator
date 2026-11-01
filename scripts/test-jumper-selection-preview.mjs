import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  chromium,
  expect,
} = require("../frontend/node_modules/@playwright/test");
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: process.env.JUMPER_HEADED !== "1",
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    inference = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/onnx|wasm|huggingface|\/api\/jumper-lab\/jobs/.test(r.url()))
      inference.push(r.url());
  });
  await page.goto(process.env.JUMPER_URL || "http://127.0.0.1:5173/");
  console.log("Page", page.url(), await page.title());
  await page.getByRole("button", { name: /Others/ }).click();
  await page.getByRole("menuitem").click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .locator(".jumper-upload input")
    .setInputFiles(
      process.env.JUMPER_FIXTURE ||
        new URL("../tests/fixtures/jumper/research-short.mp4", import.meta.url)
          .pathname,
    );
  const frame = page.getByAltText(
    "Selected video frame; click to aim a mask point",
  );
  await frame.waitFor();
  await expect(
    page.getByRole("button", {
      name: "Retry silhouette preview",
      exact: true,
    }),
  ).toHaveCount(0);
  if (inference.length)
    throw Error("Upload should not initialize inference before selection");
  const box = await frame.boundingBox();
  const point = (process.env.JUMPER_POINT || ".485,.482")
    .split(",")
    .map(Number);
  await frame.click({
    position: { x: box.width * point[0], y: box.height * point[1] },
  });
  await page.getByRole("button", { name: "Place point", exact: true }).click();
  await expect(page.getByLabel("Magnified selection cursor")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Retry silhouette preview",
      exact: true,
    }),
  ).toBeVisible();
  const silhouette = page.getByAltText(
    "First-frame silhouette of the selected shooter",
  );
  await expect(silhouette).toBeVisible({ timeout: 240000 });
  await expect(
    page.getByText(/Full-clip tracking still needs review/),
  ).toBeVisible();
  await expect(
    page.getByText("Your finished clip", { exact: true }),
  ).toHaveCount(0);
  await silhouette.screenshot({ path: "/tmp/jumper-shooter-preview.png" });
  await page.screenshot({
    path: "/tmp/jumper-preview-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Aim left", exact: true }).click();
  await expect(page.getByLabel("Magnified selection cursor")).toBeVisible();
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("Mobile overflow");
  await page.screenshot({
    path: "/tmp/jumper-preview-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Clear this frame’s points" }).click();
  await expect(silhouette).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Process clip", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Aim right", exact: true }).click();
  await page.getByRole("button", { name: "Place point", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Retry silhouette preview",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel selection check", exact: true })
    .click();
  await expect(silhouette).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Preview shooter silhouette",
      exact: true,
    }),
  ).toBeVisible();
  await page.waitForTimeout(800);
  await expect(silhouette).toHaveCount(0);
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Automatic first-frame masking, no inference before selection, desktop/mobile, nudge, invalidation, cancellation: PASS",
  );
} finally {
  await browser.close();
}
