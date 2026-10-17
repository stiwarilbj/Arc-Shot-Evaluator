import assert from "node:assert/strict";
import {
  ProcessingEstimate,
  processingPhase,
} from "../frontend/src/features/jumper/processingEstimate.ts";
const e = new ProcessingEstimate();
const update = (stage, progress, time) => e.update({ stage, progress }, time);
update("Tracking and rendering · frame 1 / 20", 0, 0);
assert.match(e.hint(0), /several frames/);
for (let i = 1; i <= 3; i++) {
  update(`Finding players · frame ${i + 1} / 20`, i / 20, i * 1000);
  update(`Rendering silhouettes · frame ${i + 1} / 20`, i / 20, i * 1000 + 50);
}
assert.match(e.hint(3050), /About 20 seconds left for tracking and rendering/);
// No countdown on repeated polling or time alone, and no extra samples.
const before = e.hint(3050);
update("Tracking and rendering · frame 4 / 20", 0.15, 4000);
assert.equal(e.hint(5000), before);
assert.match(e.hint(18050), /No new frame progress/);
// A slower measured device raises the estimate; a new frame recovers from stalls.
update("Tracking and rendering · frame 5 / 20", 0.2, 19000);
assert.match(e.hint(19000), /About 80 seconds|About 2 minutes/);
// Stage/reset and CPU fallback must discard old rates.
update("Rendering masked videos", 0, 20000);
assert.match(e.hint(20000), /Exporting/);
update("Restarting tracking on CPU", 0, 21000);
assert.doesNotMatch(e.hint(21000), /About/);
update("Tracking players · CPU", 0.3, 22000);
update("Tracking players · CPU", 0.1, 23000);
assert.doesNotMatch(e.hint(23000), /About/);
// MB labels change continuously, while model identity stays separate.
assert.equal(
  processingPhase("Downloading masking model · vision · 12.3 MB"),
  "Downloading masking model · vision",
);
update("Downloading masking model · vision", 0, 24000);
for (let i = 1; i <= 3; i++)
  update(
    `Downloading masking model · vision · ${i} MB`,
    i * 0.1,
    24000 + i * 1000,
  );
assert.match(e.hint(27000), /this model download/);
update("Downloading masking model · memory", 0, 28000);
assert.match(e.hint(28000), /First-time/);
assert.match(e.hint(43000), /No new download/);
// Unknown totals and invalid updates never produce a made-up ETA.
update("Downloading local masking model", 0, 44000);
for (let i = 1; i < 10; i++)
  update("Downloading local masking model", 0, 44000 + i * 100);
update("Downloading local masking model", NaN, 45000);
assert.doesNotMatch(e.hint(45000), /About/);
update("Finalizing videos", 1, 46000);
assert.match(e.hint(46000), /Encoding/);
console.log(
  "Processing estimates: measured speeds, interleaved frames, duplicate polls, stalls, stage resets, CPU restart, downloads and unknown totals passed",
);

const native = new ProcessingEstimate();
for (let i = 0; i <= 3; i++)
  native.update(
    { stage: "Tracking players · MPS", progress: i / 10 },
    i * 1000,
  );
assert.match(native.hint(3000), /left for tracking\./);
assert.doesNotMatch(native.hint(3000), /tracking and rendering/);
