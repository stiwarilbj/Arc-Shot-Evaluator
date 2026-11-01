import assert from "node:assert/strict";
import { CorrectionHistory } from "../frontend/src/features/jumper/correctionHistory.ts";
const state = (n = 0) => ({
  tracks: [
    {
      id: 7,
      prompts: [{ frame: n, points: [[0.2, 0.4]], labels: [1] }],
      ignored: n === 2,
    },
  ],
  target: 7,
  editing: 7,
  frame: n,
  negative: false,
  automatic: true,
});
const h = new CorrectionHistory(3);
assert.equal(h.undo(state()), undefined);
const original = state();
h.record(original, "point");
original.tracks[0].prompts[0].points[0][0] = 0.9;
assert.equal(h.undo(state(1)).tracks[0].prompts[0].points[0][0], 0.2);
assert.equal(h.redo(state()).frame, 1);
for (let i = 0; i < 5; i++) h.record(state(i), "point " + i);
assert.equal(h.undo(state(5)).frame, 4);
assert.equal(h.undo(state(4)).frame, 3);
assert.equal(h.undo(state(3)).frame, 2);
assert.equal(h.undo(state(2)), undefined);
h.record(state(), "branch");
assert.equal(h.redoLabel, undefined);
assert.equal(h.redo(state()), undefined);
h.clear();
assert.equal(h.undoLabel, undefined);
assert.equal(h.redoLabel, undefined);
console.log(
  "Correction history: bounded snapshots, independent nested points, undo/redo context, branching and clear passed",
);

const bounded = new CorrectionHistory();
for (let i = 0; i < 60; i++) bounded.record(state(i), `Edit ${i}`);
let current = state(60),
  steps = 0;
while (bounded.undoLabel) {
  current = bounded.undo(current);
  steps++;
}
assert.equal(steps, 50);
assert.equal(current.frame, 10);
const restored = bounded.redo(current);
restored.tracks[0].prompts[0].points[0][0] = 0.99;
assert.equal(bounded.undo(restored).tracks[0].prompts[0].points[0][0], 0.2);
