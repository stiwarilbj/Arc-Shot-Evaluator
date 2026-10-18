import assert from "node:assert/strict";
import fs from "node:fs";
import {
  confirmedShooterFrame,
  trackingCheckSegments,
  masksDisagree,
  sampleMask,
  ShooterTrackingCheck,
} from "../frontend/src/features/jumper/trackingCheck.ts";
import { buildBank } from "../frontend/src/features/jumper/trackingMath.ts";
import {
  maskResult,
  validateMaskRequest,
} from "../frontend/src/features/jumper/domain.ts";
import { warningLabels } from "../frontend/src/features/jumper/warningTimeline.ts";

const fixtures = JSON.parse(
  fs.readFileSync(
    new URL("../tests/fixtures/jumper/tracking-check.json", import.meta.url),
  ),
);
for (const f of fixtures)
  assert.equal(
    masksDisagree(Uint8Array.from(f.a), Uint8Array.from(f.b)),
    f.expected,
    f.name,
  );
const tracks = [
  {
    id: 7,
    prompts: [
      { frame: 0, points: [[0.5, 0.5]], labels: [1] },
      { frame: 2, points: [[0.2, 0.2]], labels: [0] },
      { frame: 4, points: [[0.5, 0.5]], labels: [1] },
      { frame: 8, box: [0.1, 0.1, 0.5, 0.9] },
    ],
  },
];
assert.equal(confirmedShooterFrame(tracks, 7), 8);
assert.deepEqual(trackingCheckSegments(tracks, 7), [
  { anchor: 4, first: 0 },
  { anchor: 8, first: 5 },
]);
assert.equal(
  confirmedShooterFrame([{ id: 7, prompts: tracks[0].prompts.slice(0, 2) }], 7),
  undefined,
  "negative points do not confirm identity",
);
const a = new Float32Array(32 * 20).fill(-1),
  b = a.slice();
for (let y = 2; y < 18; y++) for (let x = 2; x < 10; x++) a[y * 32 + x] = 1;
for (let y = 2; y < 18; y++) for (let x = 20; x < 28; x++) b[y * 32 + x] = 1;
const original = a.slice(),
  check = new ShooterTrackingCheck(8, 7);
for (let frame = 0; frame <= 8; frame++) check.record(frame, a, 32, 20);
a.fill(-1); // History must be independent of reused inference arrays.
for (let frame = 8; frame >= 0; frame--)
  check.compare(frame, frame === 3 ? b : original, 32, 20);
const result = check.finish();
assert.deepEqual(result.warnings, [
  { frame: 3, kind: "tracking_disagreement", track_ids: [7] },
]);
assert.deepEqual(result.tracking_check, {
  anchor_frame: 8,
  checked_frames: 9,
  disagreement_frames: 1,
  target_id: 7,
});
assert.equal(sampleMask(original, 32, 20).length, 128 * 128);
assert.throws(() => new ShooterTrackingCheck(2, 7).finish(), /did not finish/);
const blob = new Blob(["video"], { type: "video/mp4" });
const value = {
  ...result,
  objects: tracks,
  highlight: blob,
  quiz: blob,
  reveal: blob,
  duration: 0.3,
};
assert(maskResult(value));
for (const bad of [
  { checked_frames: 8 },
  { anchor_frame: 9 },
  { disagreement_frames: 0 },
  { target_id: 1 },
])
  assert(
    !maskResult({
      ...value,
      tracking_check: { ...result.tracking_check, ...bad },
    }),
  );
const request = {
  start: 0,
  end: 0.3,
  target_id: 7,
  objects: tracks,
  verify_shooter: true,
};
validateMaskRequest(request);
assert.throws(() => validateMaskRequest({ ...request, verify_shooter: "yes" }));
assert.equal(warningLabels.tracking_disagreement, "Forward/backward mismatch");

// Mirror time, not the spatial content or pointer time encoding. Defaults must
// retain the exact original forward ordering and reverse must use future memory.
const memory = (frame) => ({
  frame,
  tokens: new Float32Array(4096 * 64).fill(frame),
  position: new Float32Array(4096 * 64),
  pointer: new Float32Array(256).fill(frame),
});
const weights = {
  maskmem_tpos_enc: Array.from({ length: 7 }, () => Array(64).fill(0)),
  pointer_weight: Array.from({ length: 64 }, () => Array(256).fill(0.01)),
  pointer_bias: Array(64).fill(0),
};
const forward = buildBank(
  3,
  9,
  new Map([[0, memory(0)]]),
  new Map([
    [2, memory(2)],
    [1, memory(1)],
  ]),
  weights,
);
const reverse = buildBank(
  5,
  9,
  new Map([[8, memory(8)]]),
  new Map([
    [6, memory(6)],
    [7, memory(7)],
  ]),
  weights,
  true,
);
assert.deepEqual(forward.pointerPosition, reverse.pointerPosition);
assert.deepEqual(
  [...reverse.pointerData].filter((_, i) => i % 256 === 0),
  [8, 6, 7],
);
assert.deepEqual(
  [...reverse.spatial].filter((_, i) => i % (4096 * 64) === 0),
  [8, 7, 6],
);
console.log(
  "PASS bidirectional mask thresholds, independent history, confirmed anchors, complete coverage, runtime validation and reverse memory ordering",
);
