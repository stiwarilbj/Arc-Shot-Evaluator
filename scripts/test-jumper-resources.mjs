import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  estimateResources,
  checkResources,
} from "../frontend/src/features/jumper/resources.ts";
const request = {
  start: 0,
  end: 3,
  target_id: 1,
  auto_detect_others: true,
  objects: [
    { id: 1, prompts: [{ frame: 0, points: [[0.5, 0.5]], labels: [1] }] },
  ],
};
const estimate = estimateResources(request, 1280, 720);
assert.equal(estimate.players, 10);
assert.doesNotThrow(() => checkResources(estimate));
assert.doesNotThrow(() => checkResources(estimate, { deviceMemoryGB: 8 }));
for (const deviceMemoryGB of [NaN, 0, -1, Infinity])
  assert.doesNotThrow(() => checkResources(estimate, { deviceMemoryGB }));
assert.throws(
  () => checkResources(estimate, { deviceMemoryGB: 2 }),
  /shorter segment/,
);
assert.throws(
  () => checkResources(estimate, { maxStorageBufferBindingSize: 1024 }),
  /GPU buffer limit/,
);
assert.doesNotThrow(() =>
  checkResources(estimate, { maxBufferSize: estimate.largestBufferBytes }),
);
const corrected = structuredClone(request);
corrected.objects[0].prompts.push({
  frame: 10,
  points: [[0.5, 0.5]],
  labels: [1],
});
assert(estimateResources(corrected, 1280, 720).bytes > estimate.bytes);
corrected.objects[0].prompts.push({
  frame: 10,
  points: [[0.4, 0.5]],
  labels: [0],
});
assert.equal(estimateResources(corrected, 1280, 720).correctionFrames, 11);
const fixtures = [
  request,
  corrected,
  { ...request, auto_detect_others: false },
  {
    ...request,
    end: 15,
    objects: Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      prompts: [{ frame: 0 }],
    })),
  },
  {
    ...request,
    auto_detect_others: false,
    objects: [
      ...request.objects,
      { id: 2, ignored: true, prompts: [{ frame: 5 }] },
    ],
  },
];
fixtures.push({ ...request, refine_small_players: true });
const native = spawnSync(
  new URL("../.venv/bin/python", import.meta.url).pathname,
  [
    "-c",
    "import json,sys; from backend.jumper.resources import estimate_resources; print(json.dumps([estimate_resources(j,1280,720) for j in json.load(sys.stdin)]))",
  ],
  {
    cwd: new URL("..", import.meta.url),
    input: JSON.stringify(fixtures),
    encoding: "utf8",
  },
);
assert.equal(native.status, 0, native.stderr);
assert.deepEqual(
  JSON.parse(native.stdout),
  fixtures.map((r) => estimateResources(r, 1280, 720)),
);
assert(
  estimateResources({ ...request, end: 15 }, 1280, 720).bytes > estimate.bytes,
);
assert(
  estimateResources(request, 1280, 720, 3840, 2160).bytes > estimate.bytes,
);
assert(estimateResources(fixtures[3], 1280, 720).bytes > estimate.bytes);
assert(estimateResources(request, 640, 360).bytes < estimate.bytes);
console.log(
  "Resource planning: cross-target parity, resolution/duration/players/corrections, GPU limits, unknown capacity, and low-memory guidance passed",
);
