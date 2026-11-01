import assert from "node:assert/strict";
import {
  nearbyFreezeFrames,
  freezeEdgeClarity,
  freezeClarityHint,
} from "../frontend/src/features/jumper/freezeFrames.ts";
import {
  newProject,
  editFrame,
} from "../frontend/src/features/jumper/editProject.ts";
const project = newProject(2, "video/mp4");
const original = structuredClone(project);
assert.deepEqual(
  nearbyFreezeFrames(project, 30),
  [24, 27, 30, 33, 36].map((frame) => ({ frame, source: frame })),
);
assert.deepEqual(
  nearbyFreezeFrames(project, 0).map((v) => v.source),
  [0, 3, 6],
);
assert.deepEqual(
  nearbyFreezeFrames(project, 59).map((v) => v.source),
  [53, 56, 59],
);
// A later piece starts after removed footage; no choice may cross that cut.
const cut = {
  ...project,
  pieces: [
    { ...project.pieces[0], end: 15 },
    { ...project.pieces[0], id: "second", start: 40, end: 50 },
  ],
};
assert.deepEqual(nearbyFreezeFrames(cut, 15), [
  { frame: 15, source: 40 },
  { frame: 18, source: 43 },
  { frame: 21, source: 46 },
]);
assert(nearbyFreezeFrames(cut, 14).every((v) => v.source < 15));
const slow = { ...project, pieces: [{ ...project.pieces[0], speed: 0.5 }] };
assert(
  nearbyFreezeFrames(slow, 1).some((v) => v.frame === 1 && v.source === 0),
);
assert.equal(
  new Set(nearbyFreezeFrames(slow, 1).map((v) => v.source)).size,
  nearbyFreezeFrames(slow, 1).length,
);
const fast = { ...project, pieces: [{ ...project.pieces[0], speed: 2 }] };
assert(
  nearbyFreezeFrames(fast, 14).every(
    (v) => v.source === editFrame(fast, v.frame).source,
  ),
);
const freeze = {
  ...project,
  pieces: [{ ...project.pieces[0], start: 17, end: 18, freeze: 30 }],
};
assert.deepEqual(nearbyFreezeFrames(freeze, 12), [{ frame: 12, source: 17 }]);
assert.deepEqual(project, original);
function pixels(values) {
  return new Uint8ClampedArray(
    Array.from({ length: 8 }, () =>
      values.flatMap((v) => [v, v, v, 255]),
    ).flat(),
  );
}
const crisp = freezeEdgeClarity(pixels([0, 0, 0, 0, 224, 224, 224, 224]), 8, 8);
const soft = freezeEdgeClarity(
  pixels([0, 0, 32, 64, 112, 160, 192, 224]),
  8,
  8,
);
assert(crisp > soft * 2);
assert.equal(freezeEdgeClarity(pixels(Array(8).fill(224)), 8, 8), 0);
assert.equal(freezeEdgeClarity(new Uint8ClampedArray(), 0, 0), 0);
assert.equal(freezeClarityHint(crisp, [crisp, soft]), "Sharper edges");
assert.equal(freezeClarityHint(soft, [crisp, soft]), "Softer edges");
assert.equal(
  freezeClarityHint(crisp, [crisp, crisp * 0.99]),
  "Similar edge clarity",
);
assert.equal(freezeClarityHint(0, [0, 0]), "No clear edges");
console.log(
  "Nearby freeze frames: actual source mapping, cut bounds, slow/fast motion, freeze deduplication, edge clarity and flat-frame hints passed.",
);
