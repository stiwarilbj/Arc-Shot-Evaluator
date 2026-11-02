import assert from "node:assert/strict";
import {
  align,
  fit,
  project,
  invert,
  LANDMARKS,
  measure,
  inCourt,
  supported,
  uncertainty,
  regionPolygons,
  COURT,
  courtLines,
} from "../frontend/src/features/freezeFloor/geometry.ts";
import {
  newProject,
  validateProject,
  validResponse,
  MAX_IMAGE_BYTES,
} from "../frontend/src/features/freezeFloor/types.ts";
import { readImageHeader } from "../frontend/src/features/freezeFloor/images.ts";
import { SAMPLES } from "../frontend/src/features/freezeFloor/samples.ts";
import { COURT_MODEL } from "../frontend/src/features/freezeFloor/model.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const close = (a, b, t = 1e-7) =>
  assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);
const h = [0.015, 0.002, 0.08, -0.001, 0.012, 0.25, 0.001, 0.002, 1];
const keys = [
  "baseline-left",
  "baseline-right",
  "free-left",
  "free-right",
  "half-left",
  "half-right",
];
const anchors = keys.map((key, i) => ({
  id: String(i),
  landmark: key,
  image: project(h, LANDMARKS.find((l) => l.id === key).court),
  enabled: true,
  origin: "manual",
  confidence: 1,
}));
for (const mirror of [false, true]) {
  const actual = mirror
    ? [-h[0], -h[1], 1 - h[2], h[3], h[4], h[5], h[6], h[7], h[8]]
    : h;
  const src = LANDMARKS.slice(0, 9).map((l) => l.court),
    dst = src.map((p) => project(actual, p));
  const calculated = fit(src, dst);
  assert.ok(calculated);
  for (let x = 0; x <= 50; x += 2)
    for (let y = 0; y <= 47; y += 2) {
      const p = { x, y };
      const q = project(calculated, p);
      const expected = project(actual, p);
      close(q.x, expected.x);
      close(q.y, expected.y);
      const back = project(invert(calculated), q);
      close(back.x, x);
      close(back.y, y);
    }
}
const ready = align(anchors, true);
assert.equal(ready.status, "ready");
assert.equal(align(anchors).status, "review");
assert.equal(align(anchors.slice(0, 3), true).status, "insufficient");
assert.equal(
  align([...anchors, { ...anchors[0], id: "duplicate" }], true).status,
  "insufficient",
);
const outlier = {
  id: "outlier",
  landmark: "free-center",
  image: { x: 0.95, y: 0.95 },
  enabled: true,
  origin: "model",
  confidence: 0.9,
};
const withOutlier = align([...anchors, outlier], true);
assert.ok(withOutlier.rejected.includes("outlier"));
assert.equal(withOutlier.status, "review");
// Eight anchors exposed low-bit RANSAC sampling that repeatedly chose only two
// subsets, each containing an outlier, and missed the six-anchor consensus.
const eight = [...keys, "corner-left", "corner-right"].map((landmark, i) => ({
  ...anchors[0],
  id: `a${i}`,
  landmark,
  image: [0, 3].includes(i)
    ? { x: 0.95 - i * 0.03, y: 0.85 - i * 0.02 }
    : project(h, LANDMARKS.find((l) => l.id === landmark).court),
}));
const robust = align(eight, true);
assert.equal(robust.status, "review");
assert.equal(robust.inliers.length, 6);
assert.deepEqual([...robust.rejected].sort(), ["a0", "a3"]);
// Every pair of bad observations must leave the other six available to fit.
for (let first = 0; first < eight.length; first++) {
  for (let second = first + 1; second < eight.length; second++) {
    const candidates = eight.map((a, i) => ({
      ...a,
      image: [first, second].includes(i)
        ? { x: 0.95 - i * 0.03, y: 0.85 - i * 0.02 }
        : project(h, LANDMARKS.find((l) => l.id === a.landmark).court),
    }));
    const result = align(candidates, true);
    assert.equal(result.status, "review");
    assert.equal(result.inliers.length, 6);
    assert.deepEqual([...result.rejected].sort(), [`a${first}`, `a${second}`]);
  }
}
for (let offset = 0; offset < eight.length; offset++) {
  const shuffled = [
    ...eight.slice(offset),
    ...eight.slice(0, offset),
  ].reverse();
  const result = align(shuffled, true);
  assert.deepEqual(result.inliers, robust.inliers);
  assert.deepEqual(result.rejected, robust.rejected);
  const q = project(result.h, { x: 25, y: 19 });
  const expected = project(h, { x: 25, y: 19 });
  close(q.x, expected.x);
  close(q.y, expected.y);
}
assert.equal(
  fit(
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ],
  ),
  null,
);
assert.equal(invert([1, 2, 3, 2, 4, 6, 1, 2, 3]), null);
assert.equal(project([1, 0, 0, 0, 1, 0, 0, 0, 0], { x: 1, y: 1 }), null);
let p = { ...newProject(1600, 1200, "Test"), anchors, reviewed: true };
const a = { image: project(h, { x: 20, y: 20 }) },
  b = { image: project(h, { x: 23, y: 24 }) };
let m = measure(p, ready, a, b);
close(m.value, 5);
assert.ok(m.low < 5 && m.high > 5);
close(measure({ ...p, units: "m" }, ready, a, b).value, 1.524);
assert.equal(measure(p, align(anchors), a, b).value, undefined);
p.contacts = [{ id: "c", label: "1", image: a.image, status: "airborne" }];
assert.equal(measure(p, ready, { ...a, contactId: "c" }, b).value, undefined);
assert.equal(
  measure(p, ready, { image: project(h, { x: 100, y: 100 }) }, b).value,
  undefined,
);
assert.ok(!supported({ x: 51, y: 10 }, ready));
assert.ok(!inCourt({ x: 0, y: -1 }));
assert.ok(inCourt({ x: 50, y: 47 }));
assert.equal(uncertainty(ready, { x: 200, y: 1 }, 1600, 1200), null);
const regions = regionPolygons();
assert.deepEqual(regions.paint, [
  { x: 17, y: 0 },
  { x: 33, y: 0 },
  { x: 33, y: 19 },
  { x: 17, y: 19 },
]);
close(regions.restricted[17].y, 9.25);
assert.ok(
  courtLines()
    .flat()
    .every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)),
);
assert.equal(COURT.threeRadius, 23.75);
assert.ok(validateProject(p));
for (const key of ["width", "height"])
  assert.ok(!validateProject({ ...p, [key]: Infinity }));
assert.ok(
  !validateProject({
    ...p,
    contacts: [{ ...p.contacts[0], image: { x: NaN, y: 0 } }],
  }),
);
assert.ok(
  !validateProject({
    ...p,
    measurements: [{ id: "bad", a: { ...a, contactId: "missing" }, b }],
  }),
);
assert.ok(!validateProject({ ...p, anchors: [...anchors, { ...anchors[0] }] }));
assert.ok(
  !validResponse({
    type: "result",
    imageId: "x",
    jobId: "y",
    revision: 0,
    provider: "webgpu",
    anchors: null,
    contacts: [],
    warnings: [],
  }),
);
assert.ok(
  validResponse({
    type: "result",
    imageId: "x",
    jobId: "y",
    revision: 0,
    provider: "wasm",
    anchors,
    contacts: [],
    warnings: [],
  }),
);
const png = new Uint8Array(24);
png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
png.set([73, 72, 68, 82], 12);
new DataView(png.buffer).setUint32(16, 1200);
new DataView(png.buffer).setUint32(20, 1600);
assert.deepEqual(readImageHeader(png), {
  width: 1200,
  height: 1600,
  type: "image/png",
});
new DataView(png.buffer).setUint32(16, 100000);
assert.throws(() => readImageHeader(png), /24 megapixels/);
for (const b of [
  new Uint8Array(),
  new Uint8Array(100),
  new Uint8Array([255, 216, 255, 192, 0, 1]),
])
  assert.throws(() => readImageHeader(b));
for (const s of SAMPLES) {
  const header = readImageHeader(
    new Uint8Array(
      readFileSync(
        new URL(`../frontend/public/freeze-floor/${s.file}`, import.meta.url),
      ),
    ),
  );
  assert.ok(
    validateProject({
      ...newProject(header.width, header.height, s.name),
      anchors: s.anchors,
      contacts: s.contacts,
      attribution: s.attribution,
    }),
  );
  if (s.id !== "closeup") assert.equal(align(s.anchors, true).status, "ready");
  else assert.equal(align(s.anchors, true).status, "insufficient");
}
const bytes = readFileSync(
  new URL("../frontend/public/" + COURT_MODEL.file, import.meta.url),
);
assert.ok(bytes.length <= COURT_MODEL.bytes);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  COURT_MODEL.sha256,
);
// Seeded perspective sweeps preserve independent geometry, including four-point fits.
let seed = 91842;
const random = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
for (let trial = 0; trial < 120; trial++) {
  const t = [
    0.008 + random() * 0.006,
    random() * 0.002,
    0.05,
    random() * 0.002,
    0.008 + random() * 0.006,
    0.1,
    random() * 0.002,
    random() * 0.002,
    1,
  ];
  const s = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 0, y: 47 },
    { x: 50, y: 47 },
  ];
  const fitted = fit(
    s,
    s.map((p) => project(t, p)),
  );
  assert.ok(fitted);
  const q = { x: random() * 50, y: random() * 47 };
  close(project(fitted, q).x, project(t, q).x);
  close(project(fitted, q).y, project(t, q).y);
}
console.log(
  "Freeze Floor: projection, DLT, RANSAC, inverse, outliers, singular/mirrored fits, regions, uncertainty, contacts, image headers, schemas, samples and model integrity passed",
);
