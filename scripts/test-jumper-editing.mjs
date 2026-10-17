import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  newProject,
  isProject,
  projectFrames,
  editFrame,
  splitPiece,
  clampCaptions,
  EditHistory,
} from "../frontend/src/features/jumper/editProject.ts";
import { clip } from "../frontend/src/features/jumper/domain.ts";
const p = newProject(3, "video/mp4");
assert(isProject(p));
assert.equal(projectFrames(p), 90);
const split = splitPiece(p, 30);
assert.equal(split.pieces.length, 2);
assert.equal(projectFrames(split), 90);
assert.deepEqual(
  Array.from({ length: 90 }, (_, f) => editFrame(split, f).source),
  Array.from({ length: 90 }, (_, f) => f),
);
assert.throws(() => splitPiece(p, 0));
let slow = structuredClone(split);
slow.pieces[0].speed = 0.5;
assert.equal(projectFrames(slow), 120);
assert.equal(editFrame(slow, 1).source, 0);
assert.equal(editFrame(slow, 59).source, 29);
assert.equal(editFrame(slow, 60).source, 30);
let freeze = structuredClone(p);
freeze.pieces[0] = { ...freeze.pieces[0], start: 12, end: 13, freeze: 90 };
assert.equal(projectFrames(freeze), 90);
assert.equal(editFrame(freeze, 89).source, 12);
assert(isProject(freeze));
freeze.pieces[0].freeze = 91;
assert(!isProject(freeze));
const effects = structuredClone(p);
effects.fadeIn = effects.fadeOut = true;
effects.pieces[0].from.zoom = 2;
effects.pieces[0].to.x = 1;
effects.captions = [
  {
    id: "caption",
    text: "Footwork",
    start: 5,
    end: 45,
    size: "medium",
    position: "bottom",
  },
];
assert.equal(editFrame(effects, 0).opacity, 0);
assert.equal(editFrame(effects, 89).opacity, 0);
assert.equal(editFrame(effects, 7).opacity, 1);
assert.equal(editFrame(effects, 5).captions.length, 1);
assert.equal(editFrame(effects, 45).captions.length, 0);
assert.equal(editFrame(effects, 5, true).captions.length, 0);
assert.equal(editFrame(effects, 0, true).opacity, 1);
assert.equal(editFrame(effects, 0, true).framing.zoom, 1);
const shorter = clampCaptions({
  ...effects,
  pieces: [{ ...effects.pieces[0], end: 10 }],
});
assert(isProject(shorter));
assert.equal(shorter.captions[0].end, 10);
assert(shorter.captions[0].outside);
const removed = clampCaptions({
  ...effects,
  pieces: [{ ...effects.pieces[0], end: 3 }],
});
assert.equal(removed.captions[0].start, 2);
assert.equal(removed.captions[0].end, 3);
assert(removed.captions[0].outside);
assert(!isProject({ ...p, pieces: [] }));
assert(
  !isProject({
    ...p,
    pieces: [{ ...p.pieces[0], from: { zoom: 2.01, x: 0.5, y: 0.5 } }],
  }),
);
assert(
  !isProject({
    ...p,
    pieces: Array.from({ length: 21 }, (_, i) => ({
      ...p.pieces[0],
      id: String(i),
    })),
  }),
);
let limit = {
  ...p,
  baseFrames: 450,
  pieces: [
    { ...p.pieces[0], end: 450, speed: 0.5 },
    { ...p.pieces[0], id: "b", end: 450, speed: 0.5 },
  ],
};
assert(isProject(limit));
assert.equal(projectFrames(limit), 1800);
assert(
  !isProject({
    ...limit,
    pieces: [...limit.pieces, { ...p.pieces[0], id: "c", start: 0, end: 1 }],
  }),
);
const history = new EditHistory();
let current = p;
for (let i = 0; i < 70; i++) {
  history.record(current);
  current = { ...current, fadeIn: !current.fadeIn };
}
let undos = 0;
while (history.canUndo) {
  current = history.undo(current);
  undos++;
}
assert.equal(undos, 50);
assert(history.canRedo);
history.record(current);
assert(!history.canRedo);
const cases = [p, split, slow, effects, shorter, removed, limit];
const python = JSON.parse(
  execFileSync(
    new URL("../.venv/bin/python", import.meta.url).pathname,
    [
      "-c",
      "import json,sys;from backend.jumper.editing import validate_project,frame_state,length;ps=json.load(sys.stdin);print(json.dumps([[frame_state(validate_project(p),i) for i in range(length(p))] for p in ps]))",
    ],
    {
      input: JSON.stringify(cases),
      cwd: new URL("../", import.meta.url),
      maxBuffer: 20 * 1024 * 1024,
    },
  ).toString(),
);
for (let c = 0; c < cases.length; c++)
  for (let f = 0; f < projectFrames(cases[c]); f++) {
    const js = editFrame(cases[c], f),
      py = python[c][f];
    assert.equal(js.source, py.source);
    assert(Math.abs(js.opacity - py.opacity) < 1e-12);
    assert.deepEqual(js.captions, py.captions);
    for (const key of ["zoom", "x", "y"])
      assert(Math.abs(js.framing[key] - py.framing[key]) < 1e-12);
  }
const record = {
  version: 1,
  id: "test",
  player: { id: "a", name: "A", aliases: [] },
  duration: 3,
  mime: "video/mp4",
  createdAt: new Date().toISOString(),
  quiz: true,
  presentation: "silhouette-edited-v1",
  project: p,
};
assert(clip(record));
assert(!clip({ ...record, duration: 4 }));
assert(!clip({ ...record, project: undefined }));
assert(
  !clip({
    ...record,
    presentation: "silhouette",
    duration: 16,
    project: undefined,
  }),
);
console.log(
  "Edit timeline: exact source mapping, cuts/splits/speed/freezes, caption bounds, effects/clean separation, 50-step history, 60s cap, legacy validation, and native parity passed",
);
