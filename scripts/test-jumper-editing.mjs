import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  previewRange,
  previewOrigin,
  previewPlaybackFrame,
} from "../frontend/src/features/jumper/previewPlayback.ts";
import {
  describeVideoEdit,
  videoEditFocus,
} from "../frontend/src/features/jumper/editHistory.ts";
import {
  shiftCaption,
  captionSnapTargets,
  alignCaption,
} from "../frontend/src/features/jumper/captionTiming.ts";
const snapTargets = captionSnapTargets(
  [
    { id: "own", start: 53, end: 113 },
    { id: "other", start: 12, end: 30 },
    { id: "overlap", start: 24, end: 66 },
  ],
  [24, 54, 90],
  66,
  "own",
);
assert.deepEqual(snapTargets, [
  { frame: 24, label: "Cut 1" },
  { frame: 54, label: "Cut 2" },
  { frame: 90, label: "Cut 3" },
  { frame: 66, label: "Playhead" },
  { frame: 12, label: "Caption 2 start" },
  { frame: 30, label: "Caption 2 end" },
]);
const oneTarget = [{ frame: 30, label: "Cut 1" }];
assert.deepEqual(
  alignCaption({ start: 27, end: 47 }, "move", 120, oneTarget, 3, 6),
  {
    interval: { start: 30, end: 50 },
    guide: { frame: 30, label: "Cut 1", edge: "start", snapped: true },
  },
);
assert.deepEqual(
  alignCaption({ start: 10, end: 27 }, "move", 120, oneTarget, 3, 6).interval,
  { start: 13, end: 30 },
);
assert.deepEqual(
  alignCaption({ start: 10, end: 27 }, "end", 120, oneTarget, 3, 6).interval,
  { start: 10, end: 30 },
);
const nearTarget = alignCaption(
  { start: 26, end: 47 },
  "start",
  120,
  oneTarget,
  3,
  6,
);
assert.deepEqual(nearTarget.interval, { start: 26, end: 47 });
assert.equal(nearTarget.guide.snapped, false);
assert.equal(
  alignCaption({ start: 24, end: 47 }, "start", 120, oneTarget, 3, 6).guide
    .snapped,
  false,
);
assert.equal(
  alignCaption({ start: 23, end: 47 }, "start", 120, oneTarget, 3, 6).guide,
  null,
);
assert.equal(
  alignCaption({ start: 29, end: 47 }, "start", 120, oneTarget, 0.8, 1.6).guide
    .snapped,
  false,
);
assert.equal(
  alignCaption({ start: 29, end: 30 }, "start", 120, oneTarget, 3, 6).guide,
  null,
);
assert.equal(
  alignCaption({ start: 30, end: 31 }, "end", 120, oneTarget, 3, 6).guide,
  null,
);
assert.equal(
  alignCaption(
    { start: 100, end: 120 },
    "move",
    120,
    [{ frame: 105, label: "Beyond" }],
    6,
    6,
  ).guide,
  null,
);
assert.deepEqual(
  alignCaption(
    { start: 27, end: 47 },
    "move",
    120,
    [
      { frame: 30, label: "First" },
      { frame: 24, label: "Second" },
    ],
    3,
    6,
  ).guide.label,
  "First",
);
for (const part of ["move", "start", "end"]) {
  for (let start = 0; start < 120; start += 7) {
    for (let duration = 1; start + duration <= 120; duration += 11) {
      const interval = { start, end: start + duration };
      const snapshot = structuredClone(interval);
      const result = alignCaption(interval, part, 120, snapTargets, 3, 6);
      assert(
        result.interval.start >= 0 &&
          result.interval.start < result.interval.end &&
          result.interval.end <= 120,
      );
      if (part === "move")
        assert.equal(result.interval.end - result.interval.start, duration);
      if (part === "start") assert.equal(result.interval.end, interval.end);
      if (part === "end") assert.equal(result.interval.start, interval.start);
      if (result.guide?.snapped)
        assert.equal(result.interval[result.guide.edge], result.guide.frame);
      assert.deepEqual(interval, snapshot);
    }
  }
}
import {
  framingRect,
  panFraming,
} from "../frontend/src/features/jumper/framingGeometry.ts";
assert.deepEqual(framingRect({ zoom: 2, x: 0.5, y: 0.5 }), {
  left: 0.25,
  top: 0.25,
  width: 0.5,
  height: 0.5,
});
assert.deepEqual(framingRect({ zoom: 1, x: 1, y: 0 }), {
  left: 0,
  top: 0,
  width: 1,
  height: 1,
});
assert.deepEqual(panFraming({ zoom: 2, x: 0.5, y: 0.5 }, 0.1, -0.1), {
  zoom: 2,
  x: 0.7,
  y: 0.3,
});
assert.deepEqual(panFraming({ zoom: 2, x: 0.5, y: 0.5 }, 99, -99), {
  zoom: 2,
  x: 1,
  y: 0,
});
assert.deepEqual(panFraming({ zoom: 1, x: 0.5, y: 0.5 }, 99, -99), {
  zoom: 1,
  x: 0.5,
  y: 0.5,
});
for (const zoom of [1, 1.05, 1.5, 2])
  for (const x of [0, 0.3, 1])
    for (const y of [0, 0.7, 1]) {
      const crop = framingRect({ zoom, x, y });
      assert(crop.left >= 0 && crop.left + crop.width <= 1 + Number.EPSILON);
      assert(crop.top >= 0 && crop.top + crop.height <= 1 + Number.EPSILON);
      for (const [w, h] of [
        [640, 250],
        [250, 640],
        [1280, 720],
      ]) {
        assert(Math.abs(crop.left * w - x * (w - w / zoom)) < 1e-10);
        assert(Math.abs(crop.top * h - y * (h - h / zoom)) < 1e-10);
      }
    }
for (const [part, delta, expected] of [
  ["move", 20, { start: 50, end: 80 }],
  ["move", -100, { start: 0, end: 30 }],
  ["move", 100, { start: 90, end: 120 }],
  ["start", 100, { start: 59, end: 60 }],
  ["start", -100, { start: 0, end: 60 }],
  ["end", -100, { start: 30, end: 31 }],
  ["end", 100, { start: 30, end: 120 }],
  ["move", 0.6, { start: 31, end: 61 }],
])
  assert.deepEqual(
    shiftCaption({ start: 30, end: 60 }, part, delta, 120),
    expected,
  );
for (let length = 1; length <= 120; length++) {
  for (const delta of [-999, -1, 0, 1, 999]) {
    const interval = shiftCaption(
      { start: 0, end: length },
      "move",
      delta,
      120,
    );
    assert.equal(interval.end - interval.start, length);
    assert(interval.start >= 0 && interval.end <= 120);
  }
}
import { execFileSync } from "node:child_process";
import {
  newProject,
  isProject,
  projectFrames,
  editFrame,
  splitPiece,
  splitPoint,
  duplicatePiece,
  duplicatePieceReason,
  pieceFrames,
  clampCaptions,
  EditHistory,
  pieceTrimLimits,
} from "../frontend/src/features/jumper/editProject.ts";
import { clip } from "../frontend/src/features/jumper/domain.ts";
import {
  captionLayout,
  wrapCaption,
  snapCaptionPosition,
} from "../frontend/src/features/jumper/captionLayout.ts";
const wrappingCases = JSON.parse(
  readFileSync(
    new URL("../tests/fixtures/jumper-caption-wrapping.json", import.meta.url),
    "utf8",
  ),
);
for (const example of wrappingCases)
  assert.deepEqual(
    wrapCaption(example.text, (text) => [...text].length, example.width),
    example.lines,
  );
// Exact vertical boundary: a single 10px line needs 17.5px including padding.
for (const [height, fits] of [
  [19, false],
  [17.5 / 0.92, true],
  [20, true],
]) {
  assert.equal(
    captionLayout(
      { font: "", measureText: (text) => ({ width: text.length }) },
      100,
      height,
      { text: "A", size: "small", position: "center" },
    ).fits,
    fits,
  );
}
// Hit areas and guides share the export layout, including wrapping and all sizes.
const metrics = {
  font: "",
  measureText(text) {
    return { width: text.length * 8 };
  },
};
for (const [width, height] of [
  [640, 250],
  [250, 640],
  [1280, 720],
]) {
  for (const size of ["small", "medium", "large"]) {
    const baseCaption = {
      id: "layout",
      text: "A wrapped caption ".repeat(8),
      start: 0,
      end: 30,
      size,
      position: "center",
    };
    for (const position of ["top", "center", "bottom"]) {
      const layout = captionLayout(metrics, width, height, {
        ...baseCaption,
        position,
      });
      assert(layout.lines.length > 1);
      assert.equal(layout.y + layout.boxHeight / 2, layout.centers[position]);
      assert.equal(layout.width, width * 0.92);
      assert.equal(metrics.font, layout.font);
      assert.deepEqual(layout.safe, {
        x: width * 0.04,
        y: height * 0.04,
        width: width * 0.92,
        height: height * 0.92,
      });
      assert(
        layout.lines.every(
          (line) => metrics.measureText(line).width <= width * 0.88,
        ),
      );
      if (layout.fits) {
        assert(layout.y >= layout.safe.y - 1e-8);
        assert(layout.y + layout.boxHeight <= height * 0.96 + 1e-8);
      }
      assert.equal(snapCaptionPosition(layout.cy, layout.centers), position);
    }
  }
}
assert.equal(
  snapCaptionPosition(-100, { top: 10, center: 50, bottom: 90 }),
  "top",
);
assert.equal(
  snapCaptionPosition(500, { top: 10, center: 50, bottom: 90 }),
  "bottom",
);
assert.equal(
  snapCaptionPosition(31, { top: 10, center: 50, bottom: 90 }),
  "center",
);
const p = newProject(3, "video/mp4");
const previewProject = {
  ...p,
  pieces: [
    { ...p.pieces[0], id: "slow-preview", start: 0, end: 12, speed: 0.5 },
    { ...p.pieces[0], id: "freeze-preview", start: 12, end: 13, freeze: 30 },
    { ...p.pieces[0], id: "fast-preview", start: 13, end: 90, speed: 2 },
  ],
};
const previewSnapshot = structuredClone(previewProject);
const freezeRange = previewRange(previewProject, "freeze-preview");
assert.deepEqual(freezeRange, { start: 24, end: 54 });
assert.deepEqual(previewRange(previewProject, "freeze-preview", 15), {
  start: 9,
  end: 69,
});
assert.deepEqual(previewRange(previewProject, "slow-preview", 15), {
  start: 0,
  end: 39,
});
assert.deepEqual(previewRange(previewProject, "fast-preview", 15), {
  start: 39,
  end: 93,
});
assert.deepEqual(previewRange(p, p.pieces[0].id, 15), { start: 0, end: 90 });
assert.equal(previewOrigin(23, freezeRange), 24);
assert.equal(previewOrigin(54, freezeRange), 24);
assert.equal(previewOrigin(53, freezeRange), 53);
assert.deepEqual(previewPlaybackFrame(24, 999, freezeRange, true), {
  frame: 53,
  finished: false,
});
assert.deepEqual(previewPlaybackFrame(24, 1000, freezeRange, true), {
  frame: 24,
  finished: false,
});
assert.deepEqual(previewPlaybackFrame(24, 1034, freezeRange, true), {
  frame: 25,
  finished: false,
});
assert.deepEqual(previewPlaybackFrame(54, 0, freezeRange, true), {
  frame: 24,
  finished: false,
});
assert.deepEqual(previewPlaybackFrame(53, 34, freezeRange, true), {
  frame: 24,
  finished: false,
});
assert.deepEqual(previewPlaybackFrame(24, 301034, freezeRange, true), {
  frame: 25,
  finished: false,
});
assert.deepEqual(previewPlaybackFrame(80, 334, { start: 0, end: 90 }, false), {
  frame: 89,
  finished: true,
});
assert.deepEqual(previewPlaybackFrame(80, 300, { start: 0, end: 90 }, false), {
  frame: 89,
  finished: false,
});
assert.deepEqual(previewPlaybackFrame(0, -1, { start: 0, end: 90 }, false), {
  frame: 0,
  finished: false,
});
for (const hz of [30, 60, 120]) {
  for (let tick = 0; tick < hz * 5; tick++) {
    const value = previewPlaybackFrame(
      24,
      (tick * 1000) / hz,
      freezeRange,
      true,
    );
    assert(value.frame >= 24 && value.frame < 54 && !value.finished);
  }
  assert.equal(previewPlaybackFrame(24, 5000, freezeRange, true).frame, 24);
}
assert.deepEqual(previewProject, previewSnapshot);
// Every exposed endpoint must remain a valid timeline across speeds and limits.
for (const speed of [0.5, 1, 2]) {
  for (const others of [0, 1, 1500]) {
    const trial = newProject(15, "video/mp4");
    trial.pieces[0] = { ...trial.pieces[0], start: 20, end: 120, speed };
    for (let remaining = others; remaining > 0; remaining -= 450) {
      trial.pieces.push({
        ...trial.pieces[0],
        id: `other-${remaining}`,
        start: 0,
        end: Math.min(450, remaining),
        speed: 1,
      });
    }
    const piece = trial.pieces[0];
    const limits = pieceTrimLimits(
      piece,
      trial.baseFrames,
      projectFrames(trial),
    );
    for (const edge of ["start", "end"]) {
      for (let frame = limits[edge].min; frame <= limits[edge].max; frame++) {
        const next = {
          ...trial,
          pieces: [{ ...piece, [edge]: frame }, ...trial.pieces.slice(1)],
        };
        assert(
          isProject(next),
          `${speed}× ${others} other frames: ${edge} ${frame}`,
        );
      }
    }
  }
}
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
// Splits must preserve every sampled frame, at all speeds and piece boundaries.
for (const speed of [0.5, 1, 2]) {
  const trial = newProject(3, "video/mp4");
  trial.pieces[0] = { ...trial.pieces[0], start: 3, end: 32, speed };
  trial.pieces.push({
    ...trial.pieces[0],
    id: "following",
    start: 40,
    end: 51,
  });
  const samples = Array.from(
    { length: projectFrames(trial) },
    (_, f) => editFrame(trial, f).source,
  );
  for (let frame = 0; frame < samples.length; frame++) {
    const point = splitPoint(trial, frame);
    if (point.reason) {
      assert.throws(() => splitPiece(trial, frame));
      continue;
    }
    const result = splitPiece(trial, frame);
    assert(isProject(result));
    assert.equal(projectFrames(result), samples.length);
    assert.deepEqual(
      Array.from(
        { length: projectFrames(result) },
        (_, f) => editFrame(result, f).source,
      ),
      samples,
    );
    const right = result.pieces[point.index + 1];
    assert.equal(editFrame(result, frame).piece.id, right.id);
    assert.notEqual(right.id, trial.pieces[point.index].id);
  }
}
const capped = newProject(3, "video/mp4");
capped.pieces = Array.from({ length: 100 }, (_, i) => ({
  ...capped.pieces[0],
  id: `p-${i}`,
  start: 0,
  end: 3,
}));
assert.match(splitPoint(capped, 1).reason, /100 pieces/);
assert.throws(() => splitPiece(capped, 1));
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
assert.match(splitPoint(freeze, 45).reason, /Freeze/);
assert.throws(() => splitPiece(freeze, 45));
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
// Descriptions and stable targets survive undo/redo; document version stays unchanged.
const namedHistory = new EditHistory();
const describe = (before, after, selected = before.pieces[0].id, at = 0) =>
  describeVideoEdit(before, after, selected, at);
const sped = { ...p, pieces: p.pieces.map((v) => ({ ...v, speed: 0.5 })) };
const speedEdit = describe(p, sped);
assert.equal(speedEdit.label, "change piece speed");
namedHistory.record(p, speedEdit);
speedEdit.label = "mutated outside history";
assert.equal(namedHistory.nextUndo.label, "change piece speed");
assert.deepEqual(namedHistory.undo(sped), p);
assert.equal(namedHistory.nextRedo.label, "change piece speed");
assert.deepEqual(namedHistory.redo(p), sped);
assert.equal(namedHistory.nextUndo.label, "change piece speed");
const cut = splitPiece(p, 30);
const cutEdit = describe(p, cut);
assert.equal(cutEdit.label, "split piece");
assert.equal(videoEditFocus(cut, cutEdit).pieceId, cut.pieces[1].id);
assert.equal(videoEditFocus(p, cutEdit).pieceId, p.pieces[0].id);
const deleted = { ...cut, pieces: [cut.pieces[1]] };
const deleteEdit = describe(cut, deleted);
assert.equal(deleteEdit.label, "delete piece");
assert.equal(videoEditFocus(cut, deleteEdit).pieceId, cut.pieces[0].id);
assert.equal(videoEditFocus(deleted, deleteEdit).pieceId, cut.pieces[1].id);
const withCaption = {
  ...p,
  captions: [
    {
      id: "focus-caption",
      text: "Note",
      start: 30,
      end: 60,
      size: "medium",
      position: "bottom",
    },
  ],
};
const timed = {
  ...withCaption,
  captions: [{ ...withCaption.captions[0], start: 45 }],
};
const timingEdit = describe(withCaption, timed);
assert.equal(timingEdit.label, "change caption timing");
assert.equal(videoEditFocus(withCaption, timingEdit).frame, 30);
assert.equal(videoEditFocus(timed, timingEdit).frame, 45);
assert.equal(videoEditFocus(timed, timingEdit).captionId, "focus-caption");
const deletedCaptionEdit = describe(withCaption, p);
assert.equal(deletedCaptionEdit.label, "delete caption");
assert.equal(videoEditFocus(p, deletedCaptionEdit).captionId, null);
assert.equal(videoEditFocus(p, deletedCaptionEdit).frame, 30);
assert.equal(videoEditFocus(p, deletedCaptionEdit).panel, "Text");
const freezePiece = {
  ...p.pieces[0],
  id: "focus-freeze",
  start: 0,
  end: 1,
  freeze: 30,
};
const frozen = { ...p, pieces: [freezePiece, ...p.pieces] };
const duplicatedProjects = [];
for (const before of [withCaption, slow, frozen]) {
  for (const [index, original] of before.pieces.entries()) {
    const snapshot = structuredClone(before);
    const after = duplicatePiece(before, original.id);
    duplicatedProjects.push(after);
    assert(isProject(after));
    assert.deepEqual(before, snapshot);
    assert.equal(after.pieces.length, before.pieces.length + 1);
    const copy = after.pieces[index + 1];
    assert.notEqual(copy.id, original.id);
    assert(!before.pieces.some((v) => v.id === copy.id));
    assert.deepEqual({ ...copy, id: original.id }, original);
    assert.notEqual(copy.from, original.from);
    assert.notEqual(copy.to, original.to);
    assert.deepEqual(after.captions, before.captions);
    assert.equal(
      projectFrames(after),
      projectFrames(before) + pieceFrames(original),
    );
    const offset = before.pieces
      .slice(0, index + 1)
      .reduce((n, v) => n + pieceFrames(v), 0);
    const sourceOffset = offset - pieceFrames(original);
    for (let frame = 0; frame < pieceFrames(copy); frame++) {
      const copiedFrame = editFrame(after, offset + frame);
      const originalFrame = editFrame(before, sourceOffset + frame);
      assert.equal(copiedFrame.source, originalFrame.source);
      assert.deepEqual(copiedFrame.framing, originalFrame.framing);
    }
    const edit = describeVideoEdit(before, after, original.id, 0);
    assert.equal(edit.label, "duplicate piece");
    assert.equal(videoEditFocus(after, edit).pieceId, copy.id);
    assert.equal(videoEditFocus(after, edit).frame, offset);
    assert.equal(videoEditFocus(before, edit).pieceId, original.id);
    const undo = new EditHistory();
    undo.record(before, edit);
    assert.deepEqual(undo.undo(after), before);
    assert.equal(undo.nextRedo.label, "duplicate piece");
    assert.deepEqual(undo.redo(before), after);
    copy.from.x = copy.from.x === 0 ? 1 : 0;
    assert.deepEqual(before, snapshot);
    // Keep the original copied framing for the cross-target renderer comparison.
    copy.from = structuredClone(original.from);
  }
}
const boundary = newProject(15, "video/mp4");
boundary.pieces[0].speed = 0.5;
assert.equal(
  projectFrames(duplicatePiece(boundary, boundary.pieces[0].id)),
  1800,
);
const tooLong = {
  ...boundary,
  pieces: [
    ...boundary.pieces,
    { ...boundary.pieces[0], id: "extra", start: 0, end: 1, speed: 1 },
  ],
};
assert.match(
  duplicatePieceReason(tooLong, boundary.pieces[0].id),
  /60 seconds/,
);
assert.throws(
  () => duplicatePiece(tooLong, boundary.pieces[0].id),
  /60 seconds/,
);
assert.match(duplicatePieceReason(capped, capped.pieces[0].id), /100 pieces/);
assert.throws(() => duplicatePiece(capped, capped.pieces[0].id), /100 pieces/);
const nearCap = { ...capped, pieces: capped.pieces.slice(0, 99) };
assert.equal(duplicatePiece(nearCap, nearCap.pieces[0].id).pieces.length, 100);
assert.throws(() => duplicatePiece(p, "missing"), /Select a piece/);
const freezeEdit = describe(p, frozen);
assert.equal(freezeEdit.label, "insert freeze");
assert.equal(videoEditFocus(frozen, freezeEdit).pieceId, freezePiece.id);
assert.equal(videoEditFocus(p, freezeEdit).pieceId, p.pieces[0].id);
assert.equal(
  describe(frozen, {
    ...frozen,
    pieces: [{ ...freezePiece, freeze: 60 }, ...p.pieces],
  }).label,
  "change freeze duration",
);
assert.equal(
  describe(p, { ...p, fadeIn: !p.fadeIn }).label,
  p.fadeIn ? "disable fade-in" : "enable fade-in",
);
const endpoint = {
  ...p,
  pieces: p.pieces.map((v) => ({ ...v, to: { zoom: 2, x: 0.2, y: 0.8 } })),
};
const endpointEdit = describe(p, endpoint);
assert.equal(endpointEdit.label, "change end framing");
assert.equal(videoEditFocus(endpoint, endpointEdit).framingEnd, true);
assert.equal(
  videoEditFocus(endpoint, endpointEdit).frame,
  projectFrames(endpoint) - 1,
);
namedHistory.undo(sped);
namedHistory.record(p, describe(p, withCaption));
assert.equal(namedHistory.nextUndo.label, "add caption");
assert(!namedHistory.canRedo);
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
const cases = [
  p,
  split,
  slow,
  effects,
  shorter,
  removed,
  limit,
  ...duplicatedProjects,
];
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

// Effect clipboard isolates copies and only changes selected executable settings.
const { copyPieceEffects, pastePieceEffects } =
  await import("../frontend/src/features/jumper/pieceEffects.ts");
const effectSource = {
  id: "source",
  start: 3,
  end: 20,
  freeze: 0,
  speed: 0.5,
  from: { zoom: 1.5, x: 0.2, y: 0.3 },
  to: { zoom: 2, x: 0.7, y: 0.8 },
};
const effectTarget = {
  id: "target",
  start: 25,
  end: 45,
  freeze: 0,
  speed: 2,
  from: { zoom: 1, x: 0.5, y: 0.5 },
  to: { zoom: 1, x: 0.5, y: 0.5 },
};
const copiedEffects = copyPieceEffects(effectSource);
const sourceSnapshot = structuredClone(effectSource),
  targetSnapshot = structuredClone(effectTarget);
for (const speed of [false, true])
  for (const from of [false, true])
    for (const to of [false, true]) {
      const patch = pastePieceEffects(copiedEffects, effectTarget, {
        speed,
        from,
        to,
      });
      const actual = { ...effectTarget, ...patch };
      assert.deepEqual(
        Object.keys(patch).sort(),
        Object.entries({ speed, from, to })
          .filter(([, on]) => on)
          .map(([key]) => key)
          .sort(),
      );
      for (const key of ["speed", "from", "to"])
        assert.deepEqual(
          actual[key],
          { speed, from, to }[key] ? effectSource[key] : effectTarget[key],
        );
      for (const key of ["id", "start", "end", "freeze"])
        assert.equal(actual[key], effectTarget[key]);
      if (patch.from) patch.from.x = 1;
      if (patch.to) patch.to.y = 0;
      assert.deepEqual(effectSource, sourceSnapshot);
      assert.deepEqual(effectTarget, targetSnapshot);
      assert.deepEqual(copiedEffects, copyPieceEffects(sourceSnapshot));
    }
const copiedFreeze = copyPieceEffects({ ...effectSource, freeze: 30 });
assert.equal(copiedFreeze.speed, null);
assert(
  !(
    "speed" in
    pastePieceEffects(copiedFreeze, effectTarget, {
      speed: true,
      from: true,
      to: true,
    })
  ),
);
assert(
  !(
    "speed" in
    pastePieceEffects(
      copiedEffects,
      { ...effectTarget, freeze: 30 },
      { speed: true, from: false, to: false },
    )
  ),
);
effectSource.from.x = 1;
assert.equal(copiedEffects.from.x, 0.2);
console.log(
  "Effect clipboard: selective speed/framing, independent snapshots, unchanged source ranges, and freeze protection passed",
);
const atLimit = newProject(15, "video/mp4");
atLimit.pieces = Array.from({ length: 4 }, (_, i) => ({
  ...atLimit.pieces[0],
  id: `limit-${i}`,
}));
assert(isProject(atLimit));
const slowPatch = pastePieceEffects(copiedEffects, atLimit.pieces[0], {
  speed: true,
  from: false,
  to: false,
});
assert(
  !isProject({
    ...atLimit,
    pieces: atLimit.pieces.map((p, i) =>
      i === 0 ? { ...p, ...slowPatch } : p,
    ),
  }),
);
