import assert from "node:assert/strict";
import {
  captionRisks,
  shooterSample,
  silhouetteCoverage,
} from "../frontend/src/features/jumper/captionOcclusion.ts";
import { newProject } from "../frontend/src/features/jumper/editProject.ts";
const context = {
  font: "",
  measureText: (text) => ({ width: text.length * 5 }),
};
const signal = new AbortController().signal;
function body(x, y, w = 20, h = 60) {
  const pixels = new Uint8ClampedArray(100 * 100 * 4).fill(224);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++) {
      const at = (row * 100 + col) * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
    }
  return shooterSample(pixels, 100, 100);
}
const project = newProject(1, "video/mp4");
project.captions = [
  {
    id: "caption",
    text: "Shot",
    size: "small",
    position: "center",
    start: 0,
    end: 30,
  },
];
const masks = {
  width: 100,
  height: 100,
  frames: Array.from({ length: 30 }, () => body(40, 20)),
};
let risks = await captionRisks(project, masks, context, signal);
assert.equal(risks.length, 1);
assert.equal(risks[0].suggestion, "bottom");
assert(risks[0].body >= 0.15);
assert.equal(
  (
    await captionRisks(
      { ...project, captions: [{ ...project.captions[0], position: "top" }] },
      masks,
      context,
      signal,
    )
  ).length,
  0,
);
// Only visible black cores count, not other gray players, translucent pixels, or edge noise.
assert.equal(
  shooterSample(
    new Uint8ClampedArray([
      64, 64, 64, 255, 0, 0, 0, 255, 23, 23, 23, 255, 24, 24, 24, 255, 0, 0, 0,
      0,
    ]),
    5,
    1,
  ).points.length,
  4,
);
const empty = { points: new Float32Array() };
assert.deepEqual(
  silhouetteCoverage(
    empty,
    { left: 0, top: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 1, height: 1 },
  ),
  { body: 0, upper: 0 },
);
// Source outside zoom crop must not be mistaken for an obscured shooter.
assert.equal(
  (
    await captionRisks(
      {
        ...project,
        pieces: project.pieces.map((p) => ({
          ...p,
          from: { zoom: 2, x: 1, y: 0 },
          to: { zoom: 2, x: 1, y: 0 },
        })),
      },
      { ...masks, frames: masks.frames.map(() => body(5, 20)) },
      context,
      signal,
    )
  ).length,
  0,
);
// Upper silhouette hint can fire before substantial total-body coverage.
risks = await captionRisks(
  { ...project, captions: [{ ...project.captions[0], position: "top" }] },
  { ...masks, frames: masks.frames.map(() => body(40, 4, 20, 90)) },
  context,
  signal,
);
assert(risks[0].upper >= 0.15);
// Time interval excludes later hazards; cut/reorder and freeze use the same source mapping as export.
const varying = {
  ...masks,
  frames: [
    ...Array(15).fill(body(40, 20)),
    ...Array(15).fill(body(40, 4, 20, 90)),
  ],
};
const topCaption = { ...project.captions[0], position: "top", end: 15 };
assert.equal(
  (
    await captionRisks(
      { ...project, captions: [topCaption] },
      varying,
      context,
      signal,
    )
  ).length,
  0,
);
const freeze = {
  ...project,
  pieces: [{ ...project.pieces[0], start: 15, end: 30, freeze: 30 }],
  captions: [{ ...topCaption, end: 30 }],
};
assert.equal((await captionRisks(freeze, varying, context, signal)).length, 1);
const speed = {
  ...project,
  pieces: [{ ...project.pieces[0], speed: 2 }],
  captions: [{ ...topCaption, end: 15 }],
};
assert((await captionRisks(speed, varying, context, signal))[0].frame >= 8);
// Fades do not suppress hints; a fade is presentation, not safe placement.
assert.equal(
  (
    await captionRisks(
      { ...freeze, fadeIn: true, fadeOut: true },
      varying,
      context,
      signal,
    )
  ).length,
  1,
);
const controller = new AbortController();
controller.abort();
await assert.rejects(captionRisks(project, masks, context, controller.signal), {
  name: "AbortError",
});
await assert.rejects(
  captionRisks(project, { ...masks, frames: [] }, context, signal),
  /source frame is missing/,
);
assert.deepEqual(
  await captionRisks({ ...project, captions: [] }, masks, context, signal),
  [],
);
console.log(
  "Caption silhouette overlap: positions, gray exclusion, upper-body hints, crop, intervals, freeze/speed mapping, fades, cancellation and missing frames passed.",
);
