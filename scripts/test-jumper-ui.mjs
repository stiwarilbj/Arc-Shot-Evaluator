import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  chromium,
  expect,
} = require("../frontend/node_modules/@playwright/test");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const requests = [];
  const errors = [];
  page.on("request", (r) => {
    if (/onnx|wasm|huggingface/.test(r.url())) requests.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/",
  );
  const others = page.getByRole("button", { name: /Others/ });
  await others.focus();
  await expect(others).toHaveAttribute("aria-expanded", "true");
  await others.press("ArrowDown");
  await expect(page.getByRole("menuitem")).toBeFocused();
  await page.getByRole("menuitem").press("Escape");
  await expect(others).toHaveAttribute("aria-expanded", "false");
  await others.click();
  await page.getByRole("menuitem").click();
  await expect(
    page.getByRole("heading", { name: "Who’s That Jumper?", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator(".jumper-upload input").waitFor();
  await page.locator(".jumper-upload input").setInputFiles({
    name: "broken.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("invalid media"),
  });
  await expect(page.locator(".jumper-editor [role=alert]")).toBeVisible();
  await page
    .locator(".jumper-upload input")
    .setInputFiles(
      new URL("../tests/fixtures/jumper/research-short.mp4", import.meta.url)
        .pathname,
    );
  const frame = page.getByAltText(
    "Selected video frame; click to add a mask point",
  );
  await frame.waitFor();
  if (requests.length)
    throw Error("Guess or upload initialized inference before a selection");
  await frame.focus();
  await frame.press("ArrowLeft");
  await frame.press("Enter");
  await expect(
    page.getByRole("button", { name: "Clear this frame’s points" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Clear this frame’s points" }).click();
  await expect(
    page.getByRole("button", { name: "Process clip", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Add an Include point for track 1 before processing."),
  ).toBeVisible();
  await frame.press("Enter");
  await expect(
    page.getByRole("button", { name: "Process clip", exact: true }),
  ).toBeEnabled();
  await page.locator(".jumper-corrections summary").click();
  await page.getByRole("button", { name: "Add player", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Process clip", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Exclude", exact: true }).click();
  await frame.press("Enter");
  await expect(page.locator(".jumper-editor [role=alert]")).toContainText(
    "Start this player with an Include point",
  );
  await expect(
    page.getByRole("button", { name: "Process clip", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Include", exact: true }).click();
  await frame.press("Enter");
  await expect(
    page.getByRole("button", { name: "Process clip", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Add player", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Process clip", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Remove track 3", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Process clip", exact: true }),
  ).toBeEnabled();

  if (errors.length) throw Error(errors.join("\n"));
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("Mobile horizontal overflow");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Playbook", exact: true }).click();
  await others.click();
  await page.getByRole("menuitem").click();
  await expect(
    page.getByRole("button", { name: "Clear this frame’s points" }),
  ).toBeEnabled();
  await page.screenshot({
    path: "/tmp/jumper-selection-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await others.click();
  await page.mouse.move(10, 300);
  await expect(others).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("menuitem").click();
  await expect(others).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({
    path: "/tmp/jumper-selection-desktop.png",
    fullPage: true,
  });
  console.log(
    "Menu keyboard/mobile, themes, invalid decode, workspace preservation, no inference before selection: passed",
  );
} finally {
  await browser.close();
}
