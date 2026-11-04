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
  measurementPointSupported,
  uncertainty,
  regionPolygons,
  COURT,
  courtLines,
  findContactAt,
  sameMeasurementLocation,
  findExistingMeasurement,
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
import { mergeContactProposals } from "../frontend/src/features/freezeFloor/contactProposals.ts";
import { hasProjectChanges } from "../frontend/src/features/freezeFloor/projectChanges.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const close = (a, b, t = 1e-7) =>
  assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);
const clean = {
  ...newProject(1600, 1200, "Clean sample"),
  anchors: structuredClone(SAMPLES[0].anchors),
  contacts: structuredClone(SAMPLES[0].contacts),
};
assert.equal(hasProjectChanges(null, null), false);
assert.equal(hasProjectChanges(clean, clean), false);
assert.equal(hasProjectChanges(structuredClone(clean), clean), false);
assert.equal(hasProjectChanges({ ...clean, updatedAt: "2030-01-01T00:00:00Z" }, clean), false);
for (const edited of [
  { ...clean, name: "Renamed" },
  { ...clean, units: "m" },
  { ...clean, regions: { ...clean.regions, paint: true } },
  { ...clean, reviewed: true },
  { ...clean, anchors: clean.anchors.slice(1) },
  { ...clean, contacts: clean.contacts.map((c, i) => i ? c : { ...c, status: "hidden" }) },
  { ...clean, measurements: [{ id: "distance", a: { image: { x: 0.1, y: 0.2 } }, b: { image: { x: 0.3, y: 0.4 } } }] },
]) {
  const before = structuredClone({ clean, edited });
  assert.equal(hasProjectChanges(edited, clean), true);
  assert.equal(hasProjectChanges(clean, clean), false, "undoing all edits restores the loaded baseline");
  assert.equal(hasProjectChanges(edited, edited), false, "saving establishes a new clean baseline");
  assert.equal(hasProjectChanges(clean, edited), true, "undoing a saved edit is a new unsaved change");
  assert.deepEqual({ clean, edited }, before, "comparison does not mutate the project or baseline");
}
const merge = (existing, proposals) =>
  mergeContactProposals(existing, proposals, { width: 1600, height: 1200 });
const person = (id, box, x = 0.5, y = 0.8) => ({
  id, label: id, image: { x, y }, status: "uncertain", ...(box ? { box } : {}),
});
const left = person("left", [0.45, 0.3, 0.53, 0.82]);
const right = person("right", [0.51, 0.4, 0.59, 0.82], 0.52);
const overlap = person("overlap", [0.47, 0.32, 0.55, 0.82], 0.52);
const repeat = person("repeat", [0.451, 0.301, 0.531, 0.821], 0.501);
const corrected = { ...left, label: "7", status: "grounded" };
const source = structuredClone({ corrected, right, overlap, repeat });
// Nearby feet from the same batch never suppress a second returned person
assert.equal(merge([], [left, right]).contacts.length, 2);
let merged = merge([corrected], [right]);
assert.equal(merged.contacts.length, 2, "distinct boxes defeat foot-point proximity");
assert.deepEqual(merged.contacts.map((c) => c.label), ["7", "1"]);
merged = merge([corrected], [repeat, right]);
assert.equal(merged.contacts.length, 2);
assert.strictEqual(merged.contacts[0], corrected, "duplicate proposals preserve corrected contacts");
assert.equal(merged.contacts[1].id, "right");
assert.equal(merged.contacts[1].status, "uncertain");
assert.equal(merge(merged.contacts, [repeat, right]).contacts.length, 2,
  "a clear retry cannot accumulate duplicates");
for (const proposal of [overlap, person("no-box"), person("moved", left.box, 0.5, 0.35)]) {
  merged = merge([corrected], [proposal]);
  assert.equal(merged.contacts.length, 2);
  assert.match(merged.warnings.join(" "), /Players 7, 1 remain separate/);
  assert.equal(merged.contacts[1].status, "uncertain");
}
merged = merge([person("manual")], [left]);
assert.equal(merged.contacts.length, 2, "a missing existing box cannot justify a merge");
assert.match(merged.warnings.join(" "), /need review/);
merged = merge([], [left, overlap]);
assert.equal(merged.contacts.length, 2);
assert.match(merged.warnings.join(" "), /Players 1, 2 remain separate/);
merged = merge([corrected, { ...left, id: "other", label: "9" }], [repeat]);
assert.equal(merged.contacts.length, 3, "a proposal cannot arbitrarily choose between two people");
assert.match(merged.warnings.join(" "), /need review/);
merged = merge([
  corrected,
  { ...person("similar", [0.4575, 0.3075, 0.5375, 0.8275]), label: "9" },
], [repeat]);
assert.equal(merged.contacts.length, 3, "near-equal box matches straddling a threshold remain ambiguous");
assert.match(merged.warnings.join(" "), /need review/);
merged = merge([corrected], [repeat, { ...repeat, id: "second" }]);
assert.equal(merged.contacts.length, 3, "two proposals cannot silently claim the same contact");
assert.match(merged.warnings.join(" "), /need review/);
for (const existing of [[corrected], []]) {
  const forward = merge(existing, [repeat, right, overlap]);
  const reverse = merge(existing, [overlap, right, repeat]);
  assert.deepEqual(forward.contacts.map((c) => c.id).sort(), reverse.contacts.map((c) => c.id).sort(),
    "contact retention cannot depend on proposal order");
}
const full = Array.from({ length: 40 }, (_, i) => person(String(i + 1), undefined, 0, i / 100));
merged = merge(full, [right]);
assert.equal(merged.contacts.length, 40);
assert.match(merged.warnings.join(" "), /1 player proposal could not be added/);
// Count only additions blocked by capacity, not proposals matched to saved contacts
const capacityContacts = Array.from({ length: 40 }, (_, i) => {
  const x = 0.05 + (i % 10) * 0.1, y = 0.1 + Math.floor(i / 10) * 0.15;
  return { ...person(`saved-${i}`, [x - 0.02, y - 0.05, x + 0.02, y + 0.01], x, y),
    label: String(i + 1), status: i % 2 ? "hidden" : "grounded" };
});
const capacityBefore = structuredClone(capacityContacts);
const newSuggestions = [0.2, 0.5, 0.8].map((x, i) =>
  person(`new-${i}`, [x - 0.02, 0.85, x + 0.02, 0.95], x, 0.9));
const matchedRetry = { ...capacityContacts[39], id: "retry-saved", status: "uncertain" };
merged = merge(capacityContacts, [newSuggestions[0], matchedRetry, ...newSuggestions.slice(1)]);
assert.equal(merged.contacts.length, 40);
assert.deepEqual(merged.warnings, [
  "3 player proposals could not be added · 40-contact limit reached · Existing contacts and corrections kept · Remove spectators, then retry automatic proposals or add missing players manually",
]);
capacityContacts.forEach((c, i) => assert.strictEqual(merged.contacts[i], c));
assert.deepEqual(merge(capacityContacts, [matchedRetry]).warnings, [],
  "a matched retry consumes no capacity and is not omitted");
assert.deepEqual(merge(capacityContacts, []).warnings, []);
merged = merge(capacityContacts.slice(0, 38), newSuggestions);
assert.equal(merged.contacts.length, 40);
assert.deepEqual(merged.contacts.slice(38).map((c) => c.id), ["new-0", "new-1"]);
assert.match(merged.warnings.join(" "), /^1 player proposal could not be added/);
assert.deepEqual(merge(capacityContacts.slice(0, 38), newSuggestions.slice(0, 2)).warnings, [],
  "filling the final slots exactly must not report omitted suggestions");
merged = merge(capacityContacts.slice(0, 39), [matchedRetry, newSuggestions[0]]);
assert.equal(merged.contacts.length, 40);
assert.equal(merged.contacts[39].id, "retry-saved");
assert.match(merged.warnings.join(" "), /^1 player proposal could not be added/);
// Remove one spectator and retry while retaining every other correction
merged = merge(capacityContacts.slice(1), [matchedRetry, newSuggestions[0]]);
assert.equal(merged.contacts.length, 40);
assert.deepEqual(merged.warnings, []);
capacityContacts.slice(1).forEach((c, i) => assert.strictEqual(merged.contacts[i], c));
assert.equal(merged.contacts[39].id, "new-0");
assert.deepEqual(capacityContacts, capacityBefore);
assert.deepEqual({ corrected, right, overlap, repeat }, source, "merging cannot mutate source evidence");
// Proximity uses pixels on both axes, with a radius of 3.5% of the short edge
const centerContact = { ...person("center", [0.1, 0.1, 0.9, 0.9], 0.5, 0.5), status: "grounded" };
for (const dimensions of [
  { width: 1600, height: 400 }, { width: 400, height: 1600 },
  { width: 800, height: 800 }, { width: 2048, height: 256 },
]) {
  const radius = 0.035 * Math.min(dimensions.width, dimensions.height);
  for (const [dx, dy, near] of [
    [radius / 2, 0, true], [0, radius / 2, true],
    [radius * 1.2, 0, false], [0, radius * 1.2, false],
    [radius * 0.8, radius * 0.8, false],
  ]) {
    const proposed = { ...centerContact, id: "proposal", status: "uncertain", image: {
      x: centerContact.image.x + dx / dimensions.width,
      y: centerContact.image.y + dy / dimensions.height,
    } };
    const before = structuredClone({ centerContact, proposed });
    const outcome = mergeContactProposals([centerContact], [proposed], dimensions);
    assert.equal(outcome.contacts.length, near ? 1 : 2, `${JSON.stringify(dimensions)} offset ${dx}, ${dy}`);
    assert.strictEqual(outcome.contacts[0], centerContact, "matching preserves corrected contacts");
    assert.equal(outcome.contacts[0].status, "grounded");
    assert.equal(outcome.warnings.length, near ? 0 : 1);
    const resized = mergeContactProposals([centerContact], [proposed], {
      width: dimensions.width / 2, height: dimensions.height / 2,
    });
    assert.deepEqual(resized, outcome, "proportional resizing cannot change association");
    assert.deepEqual({ centerContact, proposed }, before);
  }
}
for (const dimensions of [
  { width: 0, height: 900 }, { width: 1600, height: -1 },
  { width: NaN, height: 900 }, { width: 1600, height: Infinity },
]) {
  assert.throws(() => mergeContactProposals([centerContact], [], dimensions), /image dimensions/i);
}
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
// Pixel diagnostics are derived from the final refit without altering it
const imageSize = { width: 1600, height: 900 };
const diagnosed = align([...anchors, outlier], true, imageSize);
const { mismatches, ...diagnosedFit } = diagnosed;
const { mismatches: omitted, ...originalFit } = withOutlier;
assert.deepEqual(diagnosedFit, originalFit);
assert.deepEqual(omitted, []);
assert.equal(mismatches[0].id, "outlier");
const expectedOutlier = project(h, LANDMARKS.find((l) => l.id === outlier.landmark).court);
close(mismatches[0].pixels, Math.hypot(
  (expectedOutlier.x - outlier.image.x) * imageSize.width,
  (expectedOutlier.y - outlier.image.y) * imageSize.height,
));
for (const mismatch of mismatches.slice(1)) close(mismatch.pixels, 0);
const excluded = {
  ...anchors[0], id: "excluded", enabled: false,
  image: { x: anchors[0].image.x + 12 / imageSize.width, y: anchors[0].image.y + 16 / imageSize.height },
};
const snapshot = structuredClone([...anchors, excluded]);
const excludedFit = align(snapshot, true, imageSize);
close(excludedFit.mismatches[0].pixels, 20);
assert.equal(excludedFit.status, "ready");
assert.equal(excludedFit.inliers.includes("excluded"), false);
assert.deepEqual(snapshot, [...anchors, excluded], "diagnostics never move or remove anchors");
const noisy = anchors.map((a, i) => ({ ...a, image: { x: a.image.x + (i % 2 ? 0.001 : -0.001), y: a.image.y } }));
const noisyFit = align(noisy, true, imageSize);
for (const entry of noisyFit.mismatches) {
  const anchor = noisy.find((a) => a.id === entry.id);
  const fitted = project(noisyFit.h, LANDMARKS.find((l) => l.id === anchor.landmark).court);
  close(entry.pixels, Math.hypot((fitted.x - anchor.image.x) * 1600, (fitted.y - anchor.image.y) * 900));
}
for (const dimensions of [undefined, { width: 0, height: 900 }, { width: 1600, height: NaN }, { width: Infinity, height: 900 }]) {
  assert.deepEqual(align(anchors, true, dimensions).mismatches, []);
}
assert.deepEqual(align(anchors.slice(0, 3), true, imageSize).mismatches, []);
assert.deepEqual(align([...anchors, { ...anchors[0], id: "duplicate" }], true, imageSize).mismatches, []);
const tied = [...anchors, { ...excluded, id: "z" }, { ...excluded, id: "a" }];
assert.deepEqual(align(tied, true, imageSize).mismatches.slice(0, 2).map((m) => m.id), ["a", "z"]);
assert.deepEqual(align([...tied].reverse(), true, imageSize).mismatches, align(tied, true, imageSize).mismatches);
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
// Repeated endpoints and pairs must not consume measurement slots or depend on
// endpoint order, contact snapshots, units, grounding, or projection round-off
const firstContact = { id: "first", label: "1", image: a.image, status: "grounded" };
const secondContact = { id: "second", label: "2", image: b.image, status: "uncertain" };
const boundA = { ...a, contactId: firstContact.id };
const boundB = { ...b, contactId: secondContact.id };
const measurementProject = {
  ...p,
  contacts: [firstContact, secondContact],
  measurements: [{ id: "bound", a: boundA, b: boundB }, { id: "free", a, b }],
};
const initialMeasurements = structuredClone(measurementProject);
assert.equal(sameMeasurementLocation(measurementProject, boundA, { image: b.image, contactId: "first" }), true);
assert.equal(sameMeasurementLocation(measurementProject, a, boundA), true);
assert.equal(sameMeasurementLocation(measurementProject, a, b), false);
assert.equal(sameMeasurementLocation(measurementProject, a, {
  image: { x: a.image.x + 1e-8, y: a.image.y - 1e-8 },
}), true);
assert.equal(sameMeasurementLocation(measurementProject, a, {
  image: { ...a.image, x: a.image.x + 0.01 / p.width },
}), false, "nearby distinct points are not merged");
assert.equal(sameMeasurementLocation(measurementProject, a, { ...a, contactId: "missing" }), false);
for (const [first, second] of [[boundA, boundB], [boundB, boundA], [a, b], [b, a]]) {
  assert.equal(findExistingMeasurement(measurementProject, first, second)?.id, "bound");
}
const movedMeasurementProject = {
  ...measurementProject,
  units: "m",
  contacts: measurementProject.contacts.map((c) => ({ ...c, image: { ...c.image, x: c.image.x + 0.02 } })),
};
const movedA = { contactId: "first", image: movedMeasurementProject.contacts[0].image };
const movedB = { contactId: "second", image: movedMeasurementProject.contacts[1].image };
assert.equal(findExistingMeasurement(movedMeasurementProject, movedB, movedA)?.id, "bound");
assert.equal(sameMeasurementLocation(movedMeasurementProject, boundA, movedA), true);
assert.equal(findExistingMeasurement({ ...measurementProject, measurements: measurementProject.measurements.slice(1) },
  { image: project(h, project(invert(h), b.image)) }, a)?.id, "free", "projection round trips reuse free endpoints");
assert.equal(findExistingMeasurement(measurementProject, a, { image: { ...b.image, x: b.image.x + 0.001 } }), undefined);
const otherPerson = { ...firstContact, id: "third" };
assert.equal(findExistingMeasurement({ ...measurementProject, contacts: [...measurementProject.contacts, otherPerson],
  measurements: measurementProject.measurements.slice(0, 1) },
  { ...boundA, contactId: "third" }, boundB), undefined, "distinct co-located player identities stay separate");
assert.deepEqual(measurementProject, initialMeasurements, "checks never modify saved measurements or contacts");
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
// Coverage is exactly the accepted-landmark hull, independent of review,
// units, source-point snapshots, or rejected and disabled anchors
const coverageProject = { ...clean, reviewed: true };
const coverageFit = align(coverageProject.anchors, true);
const endpointAt = (x, y) => ({ image: project(coverageFit.h, { x, y }) });
for (const [x, y, expected] of [
  [25, 10, true], [17, 10, true], [33, 10, true],
  [17, 0, true], [33, 19, true], [25, 19, true],
  [16.99, 10, false], [33.01, 10, false], [25, 19.01, false],
  [25, -0.01, false], [51, 10, false],
]) {
  for (const units of ["ft", "m"]) {
    assert.equal(measurementPointSupported({ ...coverageProject, units }, coverageFit, endpointAt(x, y)), expected);
  }
}
const coverageReview = align(coverageProject.anchors, false);
assert.equal(measurementPointSupported(coverageProject, coverageReview, endpointAt(25, 10)), true);
assert.equal(measure(coverageProject, coverageReview, endpointAt(25, 10), endpointAt(28, 10)).value, undefined);
assert.equal(measure(coverageProject, coverageFit, endpointAt(25, 10), endpointAt(40, 10)).reason, "Outside supported region");
for (const invalidFit of [align([]), align(coverageProject.anchors.slice(1)), { ...coverageFit, hull: [] }, { ...coverageFit, h: undefined }]) {
  assert.equal(measurementPointSupported(coverageProject, invalidFit, endpointAt(25, 10)), null);
}
assert.equal(measurementPointSupported(coverageProject, coverageFit, { ...endpointAt(25, 10), contactId: "missing" }), null);
const linkedEndpoint = { ...endpointAt(25, 10), contactId: "moving" };
for (const [x, expected] of [[25, true], [40, false]]) {
  const current = { ...coverageProject, contacts: [{ id: "moving", label: "1", status: "uncertain", image: endpointAt(x, 10).image }] };
  assert.equal(measurementPointSupported(current, coverageFit, linkedEndpoint), expected, "bound endpoints use the current contact even when their stored image or grounding is stale");
}
const coverageDisabled = {
  ...coverageProject.anchors[0], id: "ignored", enabled: false,
  landmark: "baseline-left", image: project(coverageFit.h, { x: 0, y: 0 }),
};
assert.deepEqual(align([...coverageProject.anchors, coverageDisabled], true).hull, coverageFit.hull);
assert.deepEqual(withOutlier.hull, ready.hull, "rejected anchors cannot extend coverage");
const narrowConsensus = [
  ...coverageProject.anchors,
  { ...coverageProject.anchors[0], id: "lane-center", landmark: "free-center", image: endpointAt(25, 19).image },
  { ...coverageDisabled, enabled: true, image: { x: 0.99, y: 0.99 } },
];
const narrowFit = align(narrowConsensus, true);
assert.ok(narrowFit.rejected.includes("ignored"));
assert.deepEqual(narrowFit.hull, coverageFit.hull, "an outlying court landmark cannot enlarge the accepted hull");
assert.equal(measurementPointSupported(coverageProject, narrowFit, endpointAt(10, 10)), false);
for (const floor of [{ x: -1e-6, y: 0 }, { x: 50.000001, y: 10 }, { x: 25, y: 47.000001 }, { x: NaN, y: 10 }]) {
  assert.equal(supported(floor, ready), false, "boundary round-off tolerance cannot admit genuinely out-of-court or invalid points");
}
const impossibleProjection = { ...coverageFit, inverse: [1, 0, 0, 0, 1, 0, 0, 0, 0] };
assert.equal(measurementPointSupported(coverageProject, impossibleProjection, endpointAt(25, 10)), null);
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
assert.ok(!validateProject({ ...p, contacts: [...p.contacts, { ...p.contacts[0] }] }));
// Selection shares an identity namespace for landmarks and player contacts
for (const anchor of anchors) {
  const collision = {
    ...p,
    contacts: [{ ...p.contacts[0], id: anchor.id }],
  };
  assert.equal(validateProject(collision), false, `shared ID ${anchor.id}`);
  assert.equal(
    validateProject({
      ...collision,
      anchors: anchors.map((a) => ({ ...a, enabled: false })),
    }),
    false,
    "disabled landmarks still participate in selection identities",
  );
  assert.equal(
    validResponse({
      type: "result",
      imageId: "x",
      jobId: "y",
      revision: 0,
      provider: "wasm",
      anchors: collision.anchors,
      contacts: collision.contacts,
      warnings: [],
    }),
    false,
    "inference results must reject the same identity collision",
  );
}
assert.ok(validateProject({ ...p, contacts: [] }));
assert.ok(validateProject({ ...p, anchors: [] }));
assert.ok(validateProject(p), "distinct landmark and contact IDs remain valid");
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
// Use a real sample's perspective, with a synthetic contact at a known floor
// point. The old photo-space court hit test snapped a click almost 8 ft away.
const hitProject = {
  ...newProject(1600, 1200, "Selection regression"),
  anchors: SAMPLES[0].anchors,
  contacts: [{ id: "target", label: "3", status: "grounded", image: null }],
};
const hitAlignment = align(hitProject.anchors, true);
hitProject.contacts[0].image = project(hitAlignment.h, { x: 25, y: 10 });
const farClick = project(hitAlignment.h, { x: 17.75, y: 12.75 });
assert.ok(
  Math.hypot(
    (farClick.x - hitProject.contacts[0].image.x) * 1600,
    (farClick.y - hitProject.contacts[0].image.y) * 1200,
  ) < 32,
);
assert.equal(findContactAt(hitProject, hitAlignment, farClick, "court"), null);
assert.equal(
  findContactAt(hitProject, hitAlignment, farClick, "photo")?.id,
  "target",
);
const endpoint = (floor) => {
  const image = project(hitAlignment.h, floor);
  const hit = findContactAt(hitProject, hitAlignment, image, "court");
  return hit ? { image: hit.image, contactId: hit.id } : { image };
};
close(
  measure(
    hitProject,
    hitAlignment,
    endpoint({ x: 17.75, y: 12.75 }),
    endpoint({ x: 31, y: 3 }),
  ).value,
  Math.hypot(13.25, -9.75),
);
for (const mirror of [false, true]) {
  const contacts = [
    {
      ...hitProject.contacts[0],
      image: { x: 0.55, y: 0.6 },
      box: [0.5, 0.3, 0.6, 0.61],
    },
    { ...hitProject.contacts[0], id: "other", image: { x: 0.57, y: 0.6 } },
  ];
  const transform = [
    mirror ? -0.02 : 0.02,
    0,
    mirror ? 1 : 0,
    0,
    0.02,
    0,
    0,
    0,
    1,
  ];
  const alignment = {
    ...hitAlignment,
    h: transform,
    inverse: invert(transform),
  };
  const projectValue = { ...hitProject, contacts };
  const floor = project(alignment.inverse, contacts[0].image);
  assert.equal(
    findContactAt(projectValue, alignment, contacts[0].image, "court")?.id,
    "target",
  );
  assert.equal(
    findContactAt(
      projectValue,
      alignment,
      project(transform, { x: floor.x, y: floor.y - 0.5 }),
      "court",
    )?.id,
    "target",
  );
  assert.equal(
    findContactAt(
      projectValue,
      alignment,
      project(transform, { x: floor.x, y: floor.y - 1.1 }),
      "court",
    ),
    null,
  );
  assert.equal(
    findContactAt(projectValue, alignment, contacts[1].image, "court")?.id,
    "other",
  );
  // Person boxes are a photograph-only convenience, never an overhead hit area.
  assert.equal(
    findContactAt(projectValue, alignment, { x: 0.55, y: 0.35 }, "photo")?.id,
    "target",
  );
  assert.equal(
    findContactAt(projectValue, alignment, { x: 0.55, y: 0.35 }, "court"),
    null,
  );
  assert.equal(
    findContactAt(
      projectValue,
      { ...alignment, inverse: undefined },
      contacts[0].image,
      "court",
    ),
    null,
  );
  assert.equal(
    findContactAt(projectValue, alignment, { x: NaN, y: 0.6 }, "court"),
    null,
  );
}
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
