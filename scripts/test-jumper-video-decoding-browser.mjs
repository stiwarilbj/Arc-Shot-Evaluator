// Run against the hosted development target; real media decoders, no inference.
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const fixtures = await mkdtemp(join(tmpdir(), "arc-jumper-video-check-"));
const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(
  join(root, ".venv/bin/python"),
  [
    "-c",
    `
from pathlib import Path
import sys, subprocess, numpy as np, imageio_ffmpeg
from backend.jumper.pipeline import encoder
p=Path(sys.argv[1])
for name,color in [('valid',224),('colored',(255,0,0))]:
 with encoder(p/f'{name}.mp4',64,48) as stream:
  for _ in range(9): stream.write(np.full((48,64,3),color,np.uint8).tobytes())
for name,options in [('valid.webm',['-i',str(p/'valid.mp4'),'-c:v','libvpx-vp9']),('audio.mp4',['-i',str(p/'valid.mp4'),'-f','lavfi','-i','anullsrc=r=48000:cl=mono','-shortest','-c:v','copy','-c:a','aac']),('rotated.mp4',['-display_rotation','180','-i',str(p/'valid.mp4'),'-c','copy'])]:
 subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-y',*options,str(p/name)],check=True)
(p/'truncated.mp4').write_bytes((p/'valid.mp4').read_bytes()[:100])
`,
    fixtures,
  ],
  { cwd: root },
);
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto(
    process.env.JUMPER_URL || "http://127.0.0.1:5177/Arc-Shot-Evaluator/",
  );
  for (const [name, count, valid] of [
    ["valid.mp4", 9, true],
    ["valid.webm", 9, true],
    ["audio.mp4", 9, false],
    ["rotated.mp4", 9, false],
    ["truncated.mp4", 9, false],
    ["valid.mp4", 8, false],
    ["colored.mp4", 9, false],
  ]) {
    const bytes = [...(await readFile(join(fixtures, name)))];
    const result = await page.evaluate(
      async ({ bytes, count }) => {
        const { validateFinishedVideo } = await import(
          "./src/features/jumper/media.ts"
        );
        const { silhouetteProof } = await import(
          "./src/features/jumper/videoValidation.ts"
        );
        const pixels = new Uint8ClampedArray(64 * 48 * 4);
        for (let i = 0; i < pixels.length; i += 4)
          pixels.set([224, 224, 224, 255], i);
        try {
          await validateFinishedVideo(
            new Blob([new Uint8Array(bytes)]),
            { width: 64, height: 48, count },
            Array.from({ length: count }, () =>
              silhouetteProof(pixels, 64, 48),
            ),
          );
          return "valid";
        } catch (error) {
          return error.message;
        }
      },
      { bytes, count },
    );
    assert.equal(result === "valid", valid, `${name}/${count}: ${result}`);
    console.log(name, count, result);
  }
} finally {
  await browser.close();
  await rm(fixtures, { recursive: true, force: true });
}
