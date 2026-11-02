// Offline acceptance gate · Inputs must come from independent real-photo annotations
// No synthetic/generated fixtures count toward the required real-photo benchmark
import { readFileSync, writeFileSync } from "node:fs";
import {
  project,
  invert,
} from "../frontend/src/features/freezeFloor/geometry.ts";
import assert from "node:assert/strict";
const file = process.argv[2];
if (!file) {
  console.error(
    "Usage: node --experimental-strip-types scripts/evaluate-freeze-floor.mjs benchmark.json [report.json]",
  );
  process.exit(2);
}
const data = JSON.parse(readFileSync(file, "utf8"));
assert.equal(data.version, 1);
assert.ok(Array.isArray(data.photos));
assert.ok(Array.isArray(data.trainingGroups));
const ids = new Set(),
  errors = [],
  groups = new Set();
let supported = 0,
  accepted = 0,
  unsuitable = 0,
  falseAccepts = 0;
for (const photo of data.photos) {
  assert.equal(photo.realPhotograph, true);
  assert.ok(typeof photo.id === "string" && !ids.has(photo.id));
  ids.add(photo.id);
  assert.ok(
    typeof photo.cameraGroup === "string" &&
      !data.trainingGroups.includes(photo.cameraGroup),
    "Held-out camera groups must not overlap training",
  );
  groups.add(photo.cameraGroup);
  assert.ok(
    typeof photo.source === "string" && photo.source.startsWith("https://"),
  );
  assert.ok(typeof photo.license === "string" && photo.license.length > 0);
  assert.equal(typeof photo.supported, "boolean");
  assert.equal(typeof photo.accepted, "boolean");
  if (photo.supported) {
    supported++;
    if (photo.accepted) accepted++;
  } else {
    unsuitable++;
    if (photo.accepted) falseAccepts++;
  }
  if (!photo.accepted) continue;
  assert.ok(
    Array.isArray(photo.homography) &&
      photo.homography.length === 9 &&
      photo.homography.every(Number.isFinite),
  );
  const inverse = invert(photo.homography);
  assert.ok(inverse);
  assert.ok(
    Array.isArray(photo.independentPoints) &&
      photo.independentPoints.length >= 4,
    "At least four independent floor checks per accepted photograph",
  );
  for (const p of photo.independentPoints) {
    assert.ok(p.usedForFit === false);
    assert.ok(
      [p.image.x, p.image.y, p.court.x, p.court.y].every(Number.isFinite),
    );
    const floor = project(inverse, p.image);
    assert.ok(floor);
    if (photo.supported)
      errors.push(
        Math.hypot(floor.x - p.court.x, floor.y - p.court.y) * 0.3048,
      );
  }
}
errors.sort((a, b) => a - b);
const quantile = (p) =>
  errors.length ? errors[Math.ceil(p * errors.length) - 1] : null;
const report = {
  version: 1,
  realPhotos: data.photos.length,
  cameraGroups: groups.size,
  supported,
  accepted,
  unsuitable,
  falseAccepts,
  acceptanceRate: supported ? accepted / supported : 0,
  medianMetres: quantile(0.5),
  p95Metres: quantile(0.95),
};
const passed =
  supported >= 40 &&
  unsuitable >= 20 &&
  groups.size >= 3 &&
  report.acceptanceRate >= 0.7 &&
  errors.length > 0 &&
  report.medianMetres <= 0.3 &&
  report.p95Metres <= 0.6 &&
  falseAccepts <= 1;
const output = { ...report, passed };
if (process.argv[3])
  writeFileSync(process.argv[3], JSON.stringify(output, null, 2) + "\n");
console.log(output);
if (!passed) process.exitCode = 1;
