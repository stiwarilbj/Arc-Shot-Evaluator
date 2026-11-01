import assert from "node:assert/strict";
import {
  newProject,
  isProject,
  renderProjectKey,
} from "../frontend/src/features/jumper/editProject.ts";
import { shotMotionWarnings } from "../frontend/src/features/jumper/shotMarkers.ts";
import { describeVideoEdit } from "../frontend/src/features/jumper/editHistory.ts";
const plain = newProject(2, "video/mp4");
const p = { ...plain, shotMarkers: { gather: 10, release: 30, finish: 50 } };
const piece = plain.pieces[0];
const trial = (...ranges) => ({
  ...p,
  pieces: ranges.map(([start, end, extra], i) => ({
    ...piece,
    id: String(i),
    start,
    end,
    ...extra,
  })),
});
const ids = (p) => shotMotionWarnings(p).map((w) => w.id);
assert(isProject(plain));
assert(isProject(p));
assert.deepEqual(ids(p), []);
assert.equal(renderProjectKey(p), renderProjectKey(plain));
assert.notEqual(renderProjectKey({ ...p, fadeIn: true }), renderProjectKey(p));
assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
for (const markers of [
  null,
  [],
  { unknown: 1 },
  { gather: -1 },
  { finish: 60 },
  { release: 1.5 },
  { gather: true },
])
  assert(!isProject({ ...p, shotMarkers: markers }), JSON.stringify(markers));
assert(isProject({ ...p, shotMarkers: { gather: 50, release: 10 } }));
assert.deepEqual(ids({ ...p, shotMarkers: { gather: 50, release: 10 } }), [
  "order",
]);
assert.deepEqual(ids({ ...p, shotMarkers: { gather: 10, release: 10 } }), [
  "order",
]);
assert.deepEqual(ids(trial([0, 30], [30, 60])), []); // clean split, exclusive end
assert.deepEqual(
  ids(trial([0, 30, { speed: 0.5 }], [30, 60, { speed: 2 }])),
  [],
);
assert.deepEqual(ids(trial([0, 60], [0, 60])), []); // full shot repeat
assert.deepEqual(ids(trial([0, 6], [8, 60])), []); // seam before marked motion
assert.deepEqual(ids(trial([0, 53], [55, 60])), []); // seam after motion
assert.deepEqual(ids(trial([0, 30], [31, 60])), ["missing-release", "cut-0-1"]);
assert.deepEqual(ids(trial([0, 10], [10, 60])), []);
assert.deepEqual(ids(trial([0, 10], [11, 60])), ["missing-gather", "cut-0-1"]);
assert.deepEqual(ids(trial([0, 51])), []);
assert.deepEqual(ids(trial([0, 50])), ["missing-finish"]);
assert(ids(trial([31, 60], [0, 31])).includes("cut-0-1"));
assert.deepEqual(ids(trial([0, 30], [30, 31, { freeze: 30 }], [30, 60])), []);
assert.deepEqual(ids(trial([0, 31], [30, 31, { freeze: 30 }], [31, 60])), []);
const held = shotMotionWarnings(
  trial([0, 30], [30, 31, { freeze: 30 }], [31, 60]),
);
assert(
  held.some(
    (w) => w.id === "missing-release" && /only as a freeze/.test(w.message),
  ),
);
const fast = {
  ...p,
  shotMarkers: { release: 31 },
  pieces: [{ ...piece, speed: 2 }],
};
assert.deepEqual(ids(fast), ["missing-release"]);
assert.deepEqual(ids({ ...fast, pieces: [{ ...piece, speed: 0.5 }] }), []);
assert.deepEqual(
  ids({
    ...p,
    shotMarkers: { gather: 10 },
    pieces: trial([0, 20], [40, 60]).pieces,
  }),
  [],
);
assert.deepEqual(
  ids({ ...p, pieces: trial([0, 30], [31, 60], [0, 60]).pieces }),
  ["cut-0-1", "cut-1-2"],
);
const original = structuredClone(p);
shotMotionWarnings(p);
assert.deepEqual(p, original);
assert.equal(describeVideoEdit(plain, p).label, "mark Gather marker");
assert.equal(
  describeVideoEdit(p, { ...p, shotMarkers: { ...p.shotMarkers, gather: 11 } })
    .label,
  "move Gather marker",
);
assert.equal(
  describeVideoEdit(p, { ...p, shotMarkers: { release: 30, finish: 50 } })
    .label,
  "remove Gather marker",
);
console.log(
  "Shot markers: validation, saved metadata, render independence, sampled frames, cut boundaries, replay/freeze/speed semantics, ordering, immutability and history passed.",
);
