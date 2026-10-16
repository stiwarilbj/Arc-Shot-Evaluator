// Technical fixtures only: never publish this manifest or count it as reviewed footage.
// Run against a production preview with JUMPER_TEST_VIDEO pointing to a muted
// three-second / 30fps synthetic MP4. No inference models are needed.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const {
  chromium,
  expect,
} = require("../frontend/node_modules/@playwright/test");
if (!process.env.JUMPER_TEST_VIDEO)
  throw Error("Set JUMPER_TEST_VIDEO to a synthetic 3s MP4");
const video = await readFile(process.env.JUMPER_TEST_VIDEO);
const manifest = {
  version: 1,
  release: "test-only",
  collection_kind: "starter",
  clip_count: 2,
  player_count: 2,
  players: [0, 1].map((i) => ({
    id: `player-${i}`,
    name: `Fixture ${i}`,
    aliases: [],
  })),
  clips: [0, 1].map((i) => ({
    id: i.toString(16).padStart(32, "0"),
    player_id: `player-${i}`,
    event_id: `fixture-${i}`,
    duration: 3,
    fps: 30,
    frame_count: 90,
    ...Object.fromEntries(
      ["quiz", "reveal", "thumbnail"].map((kind, j) => {
        const serial = i * 3 + j + 1;
        return [
          kind,
          {
            file: `${serial.toString(16).padStart(32, "0")}.${j === 2 ? "png" : "mp4"}`,
            bytes: video.length,
            sha256: serial.toString(16).padStart(64, "0"),
          },
        ];
      }),
    ),
    provenance: {
      source_url: "https://example.org/source",
      permission_url: "https://example.org/license",
      identity_url: "https://example.org/identity",
      license: "TEST ONLY",
      attribution: "Synthetic browser fixture",
      changes: "Synthetic neutral background",
    },
  })),
};
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [],
    inference = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/onnx|wasm|huggingface|sam2/i.test(request.url()))
      inference.push(request.url());
  });
  let corrupt = false;
  await page.route("**/api/jumper-lab/media", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/jumper/catalog/**", async (route) => {
    const name = route.request().url().split("/").at(-1);
    if (name === "availability.json")
      return route.fulfill({
        json: { version: 1, status: "ready", release: "test-only" },
      });
    if (name === "manifest.json")
      return route.fulfill({
        json: corrupt ? { ...manifest, clip_count: 3 } : manifest,
      });
    return route.fulfill({ contentType: "video/mp4", body: video });
  });
  const open = async () => {
    await page.getByRole("button", { name: /Others/ }).click();
    await page.getByRole("menuitem").click();
  };
  await page.goto(
    process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/",
  );
  await open();
  await expect(
    page.getByText(/Starter collection · 2 NBA clips · 2 players/),
  ).toBeVisible();
  await page.locator(".jumper-toolbar select").selectOption("nba");
  const visited = [];
  const stat = (name) =>
    page
      .locator(".jumper-stats > div")
      .filter({
        has: page.locator("span", { hasText: new RegExp(`^${name}$`) }),
      })
      .locator("strong");
  for (let i = 0; i < 2; i++) {
    await expect(page.getByLabel("Player name", { exact: true })).toBeVisible();
    await expect(page.locator(".jumper-video")).toHaveJSProperty(
      "readyState",
      4,
    );
    const source = await page.locator(".jumper-video").getAttribute("src");
    visited.push(source);
    const clip = manifest.clips.find((c) => source.endsWith(c.quiz.file));
    await page
      .getByLabel("Player name", { exact: true })
      .fill(`Fixture ${clip.player_id.at(-1)}`);
    await page.getByRole("button", { name: "Lock answer" }).click();
    await expect(page.getByText("YOU GOT IT", { exact: true })).toBeVisible();
    await expect(stat("correct")).toHaveText(String(i + 1));
    await expect(page.locator(".jumper-video")).toHaveAttribute(
      "src",
      new RegExp(clip.reveal.file),
    );
    await expect(page.locator(".jumper-video")).toHaveJSProperty("duration", 3);
    await page.getByText("Footage attribution", { exact: true }).click();
    await expect(
      page.getByText("Synthetic browser fixture", { exact: true }),
    ).toBeVisible();
    if (i === 0)
      await page.getByRole("button", { name: "Next jumper" }).click();
  }
  expect(new Set(visited).size).toBe(2);
  await page.reload();
  await open();
  await page.locator(".jumper-toolbar select").selectOption("nba");
  await expect(stat("correct")).toHaveText("2");
  await expect(page.getByText("YOU GOT IT", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next jumper" }).click();
  await expect(page.getByLabel("Player name", { exact: true })).toBeVisible();
  // Failed quiz playback must not record an attempt.
  await page.locator(".jumper-video").dispatchEvent("error");
  await expect(
    page.getByRole("button", { name: "Lock answer" }),
  ).toBeDisabled();
  await expect(stat("correct")).toHaveText("2");
  corrupt = true;
  await page.reload();
  await open();
  await expect(
    page.getByRole("button", { name: "Retry NBA collection" }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: /NBA/ })).toHaveAttribute(
    "disabled",
    "",
  );
  corrupt = false;
  await page.getByRole("button", { name: "Retry NBA collection" }).click();
  await expect(
    page.getByText(/Starter collection · 2 NBA clips · 2 players/),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(inference).toEqual([]);
  console.log(
    "Starter round/reveal, attribution, shuffle exhaustion, persisted exactly-once scoring, playback failure, manifest retry, zero inference: passed",
  );
} finally {
  await browser.close();
}
