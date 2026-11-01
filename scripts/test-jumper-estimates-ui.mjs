// Controlled progress exercises timing UI; real inference is covered separately.
import {
  chromium,
  expect,
} from "../frontend/node_modules/@playwright/test/index.mjs";
import { readFile } from "node:fs/promises";
const browser = await chromium.launch({
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
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const fixture = new URL(
    "../tests/fixtures/jumper/research-short.mp4",
    import.meta.url,
  );
  const media = (await readFile(fixture)).toString("base64");
  await page.route(/\/masking[^/]*\.js(?:\?.*)?$/, (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `
    onmessage=({data})=>{
      const progress=(stage,progress)=>postMessage({kind:'progress',id:data.id,stage,progress});
      progress('Downloading masking model · vision',0);
      for(let i=1;i<=3;i++)setTimeout(()=>progress('Downloading masking model · vision · '+i+' MB',i/10),i*1000);
      setTimeout(()=>progress('Tracking and rendering · frame 1 / 20',0),4100);
      for(let i=1;i<=3;i++)setTimeout(()=>progress('Finding players · frame '+(i+1)+' / 20',i/20),4100+i*1000);
      setTimeout(()=>progress('Rendering masked videos',0),24000);
      for(let i=1;i<=3;i++)setTimeout(()=>progress('Rendering masked videos',i/5),24000+i*1000);
      setTimeout(()=>{let v=new Blob([Uint8Array.from(atob('${media}'),c=>c.charCodeAt(0))],{type:'video/mp4'});postMessage({kind:'done',id:data.id,result:{highlight:v,quiz:v,reveal:v,duration:.3,objects:data.request.objects,warnings:[]}})},28500);
    }`,
    }),
  );
  await page.goto(
    process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/",
  );
  await page.getByRole("button", { name: /Others/ }).click();
  await page.getByRole("menuitem").click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator(".jumper-upload input").setInputFiles(fixture.pathname);
  await page
    .getByAltText("Selected video frame; click to aim a mask point")
    .click();
  await page.getByRole("button", { name: "Place point", exact: true }).click();
  // This fixture supplies worker evidence, not detector output.
  await page.locator(".jumper-corrections summary").click();
  await page.getByLabel("Find other people automatically", { exact: false }).uncheck();
  await page.locator(".jumper-corrections summary").click();
  await page.getByRole("button", { name: "Process clip", exact: true }).click();
  const hint = page.locator(".jumper-progress-hint");
  await expect(hint).toContainText("First-time");
  await expect(hint).toContainText("left for this model download", {
    timeout: 6000,
  });
  await expect(hint).toContainText("several frames", { timeout: 6000 });
  await expect(hint).toContainText("left for tracking and rendering", {
    timeout: 6000,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await expect(hint).toContainText("No new frame progress", { timeout: 20000 });
  await page
    .locator(".jumper-progress")
    .screenshot({ path: "/tmp/jumper-estimates-mobile.png" });
  await expect(hint).toContainText("Exporting", { timeout: 5000 });
  await expect(hint).toContainText("left for this stage", { timeout: 5000 });
  await expect(
    page.getByRole("heading", { name: "Your finished clip", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(hint).toHaveCount(0);
  await page.getByRole("button", { name: "Process clip", exact: true }).click();
  await expect(hint).toContainText("First-time");
  await page
    .getByRole("button", { name: "Cancel processing", exact: true })
    .click();
  await expect(hint).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    "PASS download/tracking/export estimates, stall guidance, completion/cancel cleanup, fresh retry, mobile/light layout; no runtime errors",
  );
} finally {
  await browser.close();
}
