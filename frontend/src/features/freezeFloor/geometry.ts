import { Matrix, SingularValueDecomposition } from "ml-matrix";
import type {
  Anchor,
  Contact,
  FloorProject,
  MeasurePoint,
  Point,
} from "./types.ts";
export const COURT = {
  width: 50,
  length: 47,
  basket: { x: 25, y: 5.25 },
  laneWidth: 16,
  laneDepth: 19,
  threeRadius: 23.75,
  restrictedRadius: 4,
} as const;
const arcY = 5.25 + Math.sqrt(23.75 ** 2 - 22 ** 2);
export const LANDMARKS: {
  id: string;
  label: string;
  court: Point;
  slots: number[];
}[] = [
  {
    id: "baseline-left",
    label: "Baseline × left sideline",
    court: { x: 0, y: 0 },
    slots: [0, 35],
  },
  {
    id: "corner-left",
    label: "Baseline × left corner-three",
    court: { x: 3, y: 0 },
    slots: [1, 36],
  },
  {
    id: "lane-left-base",
    label: "Baseline × left lane edge",
    court: { x: 17, y: 0 },
    slots: [3, 38],
  },
  {
    id: "lane-right-base",
    label: "Baseline × right lane edge",
    court: { x: 33, y: 0 },
    slots: [4, 39],
  },
  {
    id: "corner-right",
    label: "Baseline × right corner-three",
    court: { x: 47, y: 0 },
    slots: [6, 41],
  },
  {
    id: "baseline-right",
    label: "Baseline × right sideline",
    court: { x: 50, y: 0 },
    slots: [7, 42],
  },
  {
    id: "free-left",
    label: "Free-throw line × left lane edge",
    court: { x: 17, y: 19 },
    slots: [12, 29],
  },
  {
    id: "free-center",
    label: "Free-throw line midpoint",
    court: { x: 25, y: 19 },
    slots: [13, 30],
  },
  {
    id: "free-right",
    label: "Free-throw line × right lane edge",
    court: { x: 33, y: 19 },
    slots: [14, 31],
  },
  {
    id: "three-left",
    label: "Left straight / three-point arc join",
    court: { x: 3, y: arcY },
    slots: [9, 32],
  },
  {
    id: "three-right",
    label: "Right straight / three-point arc join",
    court: { x: 47, y: arcY },
    slots: [11, 33],
  },
  {
    id: "half-left",
    label: "Half-court line × left sideline",
    court: { x: 0, y: 47 },
    slots: [],
  },
  {
    id: "half-right",
    label: "Half-court line × right sideline",
    court: { x: 50, y: 47 },
    slots: [],
  },
];
export type Transform = number[];
export type Alignment = {
  status: "ready" | "review" | "insufficient";
  reason: string;
  h?: Transform;
  inverse?: Transform;
  inliers: string[];
  rejected: string[];
  mismatches: { id: string; pixels: number }[];
  leaveOneOutShifts: { id: string; pixels: number | null }[];
  rms: number;
  hull: Point[];
};
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export function project(h: Transform, p: Point): Point | null {
  const d = h[6] * p.x + h[7] * p.y + h[8];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  const q = {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / d,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / d,
  };
  return Number.isFinite(q.x) && Number.isFinite(q.y) ? q : null;
}
export function invert(h: Transform): Transform | null {
  const [a, b, c, d, e, f, g, k, i] = h;
  const out = [
    e * i - f * k,
    c * k - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * k - e * g,
    b * g - a * k,
    a * e - b * d,
  ];
  const det = a * out[0] + b * out[3] + c * out[6];
  return Math.abs(det) > 1e-14 && Number.isFinite(det)
    ? out.map((v) => v / det)
    : null;
}
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function hull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y),
    lo: Point[] = [],
    hi: Point[] = [];
  for (const q of p) {
    while (lo.length > 1 && cross(lo.at(-2)!, lo.at(-1)!, q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (hi.length > 1 && cross(hi.at(-2)!, hi.at(-1)!, q) <= 0) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function area(p: Point[]) {
  return (
    Math.abs(
      p.reduce((s, q, i) => {
        const r = p[(i + 1) % p.length];
        return s + q.x * r.y - q.y * r.x;
      }, 0),
    ) / 2
  );
}
function normalization(p: Point[]) {
  const c = {
    x: p.reduce((s, q) => s + q.x, 0) / p.length,
    y: p.reduce((s, q) => s + q.y, 0) / p.length,
  };
  const mean = p.reduce((s, q) => s + distance(q, c), 0) / p.length;
  if (mean < 1e-10) throw Error("Coincident landmarks");
  const s = Math.SQRT2 / mean;
  return new Matrix([
    [s, 0, -s * c.x],
    [0, s, -s * c.y],
    [0, 0, 1],
  ]);
}
export function fit(source: Point[], target: Point[]): Transform | null {
  try {
    if (
      source.length < 4 ||
      source.length !== target.length ||
      area(hull(source)) < 1e-8 ||
      area(hull(target)) < 1e-8
    )
      return null;
    const s = normalization(source),
      t = normalization(target);
    const sp = source.map((p) => project(s.to1DArray(), p)!),
      tp = target.map((p) => project(t.to1DArray(), p)!);
    const rows = sp.flatMap((p, i) => {
      const q = tp[i];
      return [
        [-p.x, -p.y, -1, 0, 0, 0, q.x * p.x, q.x * p.y, q.x],
        [0, 0, 0, -p.x, -p.y, -1, q.y * p.x, q.y * p.y, q.y],
      ];
    });
    // A square padded system retains the right-nullspace for four correspondences.
    if (rows.length === 8) rows.push(Array(9).fill(0));
    const svd = new SingularValueDecomposition(new Matrix(rows));
    const values = svd.diagonal;
    if (values[7] < 1e-8 || values[0] / values[7] > 1e7) return null;
    const v = svd.rightSingularVectors.getColumn(8),
      ht = new Matrix([v.slice(0, 3), v.slice(3, 6), v.slice(6, 9)]);
    const ti = invert(t.to1DArray())!;
    const h = new Matrix([ti.slice(0, 3), ti.slice(3, 6), ti.slice(6, 9)])
      .mmul(ht)
      .mmul(s)
      .to1DArray();
    const n = h[8];
    if (Math.abs(n) < 1e-12) return null;
    const result = h.map((v) => v / n);
    return result.every(Number.isFinite) && invert(result) ? result : null;
  } catch {
    return null;
  }
}
function insidePolygon(p: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      (a.y > p.y) !== (b.y > p.y) &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
function courtShiftSamples(polygon: Point[]) {
  const xs = polygon.map((p) => p.x),
    ys = polygon.map((p) => p.y),
    minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys),
    samples: Point[] = [...polygon];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    samples.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  // Interior grid samples compare the projected court across the supported area
  for (let xStep = 1; xStep < 6; xStep++) {
    for (let yStep = 1; yStep < 6; yStep++) {
      const point = {
        x: minX + ((maxX - minX) * xStep) / 6,
        y: minY + ((maxY - minY) * yStep) / 6,
      };
      if (insidePolygon(point, polygon)) samples.push(point);
    }
  }
  return samples;
}
export function align(
  anchors: Anchor[],
  reviewed = false,
  image?: { width: number; height: number },
): Alignment {
  const empty: Alignment = {
    status: "insufficient",
    reason: "Add at least four well-spread floor landmarks",
    inliers: [],
    rejected: [],
    mismatches: [],
    leaveOneOutShifts: [],
    rms: 0,
    hull: [],
  };
  // Stable input order makes the seeded fit independent of inspector ordering.
  const a = anchors
    .filter((a) => a.enabled && LANDMARKS.some((l) => l.id === a.landmark))
    .sort((a, b) =>
      a.landmark < b.landmark ? -1 : a.landmark > b.landmark ? 1 : 0,
    );
  if (new Set(a.map((a) => a.landmark)).size !== a.length)
    return {
      ...empty,
      reason:
        "Two anchors reference the same landmark · Reassign or exclude one",
    };
  if (a.length < 4) return empty;
  const src = a.map((a) => LANDMARKS.find((l) => l.id === a.landmark)!.court),
    dst = a.map((a) => a.image);
  let best: number[] = [],
    bestError = Infinity,
    seed = 0x27ab241;
  for (let trial = 0; trial < 160; trial++) {
    const chosen = new Set<number>();
    while (chosen.size < 4) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      // Low LCG bits cycle through only a few subsets for power-of-two counts.
      chosen.add(Math.floor((seed / 0x100000000) * a.length));
    }
    const indices = [...chosen],
      h = fit(
        indices.map((i) => src[i]),
        indices.map((i) => dst[i]),
      );
    if (!h) continue;
    const errors = src.map((p, i) => {
      const q = project(h, p);
      return q ? distance(q, dst[i]) : Infinity;
    });
    const inside = errors.flatMap((e, i) => (e <= 0.009 ? [i] : [])),
      error = inside.reduce((s, i) => s + errors[i] ** 2, 0);
    if (
      inside.length > best.length ||
      (inside.length === best.length && error < bestError)
    ) {
      best = inside;
      bestError = error;
    }
  }
  if (best.length < 4)
    return {
      ...empty,
      reason: "Landmarks do not support a stable floor alignment",
    };
  const candidateHull = hull(best.map((i) => src[i])),
    candidateImageHull = hull(best.map((i) => dst[i]));
  if (area(candidateHull) < 45 || area(candidateImageHull) < 0.0015)
    return {
      ...empty,
      reason:
        "Landmarks are too clustered or nearly collinear · Spread them across the visible floor",
    };
  const h = fit(
    best.map((i) => src[i]),
    best.map((i) => dst[i]),
  );
  if (!h) return empty;
  const inverse = invert(h)!;
  const finalErrors = src.map((p, i) => {
      const q = project(h, p);
      return q ? distance(q, dst[i]) : Infinity;
    }),
    finalIndices = best.filter((i) => finalErrors[i] <= 0.009),
    finalIndexSet = new Set(finalIndices),
    finalFitRejected = best.filter((i) => !finalIndexSet.has(i)),
    finalHull = hull(finalIndices.map((i) => src[i])),
    finalImageHull = hull(finalIndices.map((i) => dst[i])),
    hasFinalSupport =
      finalIndices.length >= 4 &&
      area(finalHull) >= 45 &&
      area(finalImageHull) >= 0.0015,
    validationHull = finalIndices.length >= 3 ? finalHull : candidateHull,
    validationImageHull =
      finalIndices.length >= 3 ? finalImageHull : candidateImageHull;
  const denominators = validationHull.map(
    (p) => h[6] * p.x + h[7] * p.y + h[8],
  );
  const inverseDenominators = validationImageHull.map(
    (p) => inverse[6] * p.x + inverse[7] * p.y + inverse[8],
  );
  const crossesHorizon = (values: number[]) =>
    values.some((v) => !Number.isFinite(v) || Math.abs(v) < 1e-7) ||
    values.some((v) => Math.sign(v) !== Math.sign(values[0]));
  if (crossesHorizon(denominators) || crossesHorizon(inverseDenominators))
    return {
      ...empty,
      reason:
        "The fitted horizon crosses the supported floor · Check landmark assignments",
    };
  if (
    (finalIndices.length >= 3 ? finalIndices : best).some((i) => {
      const q = project(inverse, dst[i]);
      return !q || distance(q, src[i]) > 2;
    })
  )
    return {
      ...empty,
      reason: "Floor projection is unstable · Check the landmark labels",
    };
  const rms = Math.sqrt(
    finalIndices.reduce(
      (s, i) => s + finalErrors[i] ** 2,
      0,
    ) / (finalIndices.length || 1),
  );
  const rejected = a
    .filter((_, i) => !finalIndexSet.has(i))
    .map((anchor) => anchor.id);
  // Conflicting included anchors must be corrected or explicitly excluded before measurement.
  const status = rejected.length ? "review" : reviewed ? "ready" : "review";
  // Diagnostics use the final refit, including observations excluded from it
  // Convert each axis separately: normalized image coordinates are not pixels
  const mismatches =
    image &&
    Number.isFinite(image.width) && image.width > 0 &&
    Number.isFinite(image.height) && image.height > 0
      ? anchors.flatMap((anchor) => {
          const landmark = LANDMARKS.find((l) => l.id === anchor.landmark),
            fitted = landmark ? project(h, landmark.court) : null;
          if (!fitted) return [];
          const pixels = Math.hypot(
            (fitted.x - anchor.image.x) * image.width,
            (fitted.y - anchor.image.y) * image.height,
          );
          return Number.isFinite(pixels) ? [{ id: anchor.id, pixels }] : [];
        }).sort((a, b) =>
          b.pixels - a.pixels || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
      : [];
  const leaveOneOutShifts =
    image &&
    Number.isFinite(image.width) && image.width > 0 &&
    Number.isFinite(image.height) && image.height > 0 &&
    finalIndices.length > 4
      ? finalIndices.map((omitted) => {
          const retained = finalIndices.filter((i) => i !== omitted),
            withoutAnchor = fit(
              retained.map((i) => src[i]),
              retained.map((i) => dst[i]),
            );
          if (!withoutAnchor)
            return { id: a[omitted].id, pixels: null };
          const shifts = courtShiftSamples(finalHull).map((courtPoint) => {
            const original = project(h, courtPoint),
              refit = project(withoutAnchor, courtPoint);
            return original && refit
              ? Math.hypot(
                  (original.x - refit.x) * image.width,
                  (original.y - refit.y) * image.height,
                )
              : null;
          });
          const validShifts = shifts.filter(
            (shift): shift is number =>
              shift !== null && Number.isFinite(shift),
          );
          if (!shifts.length || validShifts.length !== shifts.length)
            return { id: a[omitted].id, pixels: null };
          const rmsShift = Math.sqrt(
            validShifts.reduce((sum, shift) => sum + shift ** 2, 0) /
              validShifts.length,
          );
          return {
            id: a[omitted].id,
            pixels: Number.isFinite(rmsShift) ? rmsShift : null,
          };
        })
      : [];
  return {
    h,
    inverse,
    inliers: finalIndices.map((i) => a[i].id),
    rejected,
    mismatches,
    leaveOneOutShifts,
    rms,
    hull: hasFinalSupport ? finalHull : [],
    status,
    reason: finalFitRejected.length
      ? `${finalFitRejected.length} accepted anchor${finalFitRejected.length === 1 ? "" : "s"} exceed the final fit tolerance · Correct or exclude before measuring`
      : rejected.length
        ? `${rejected.length} conflicting anchor${rejected.length === 1 ? "" : "s"} · Correct or exclude before measuring`
        : reviewed
          ? "Reviewed floor alignment · Distances remain approximate"
          : "Review the court-line overlay before measuring",
  };
}
export function inCourt(p: Point) {
  return p.x >= 0 && p.x <= 50 && p.y >= 0 && p.y <= 47;
}
// Hit testing must use the coordinates of the view the user is interacting with.
// A small photograph gap can represent many feet on the overhead court.
export function findContactAt(
  p: FloorProject,
  alignment: Alignment,
  image: Point,
  view: "photo" | "court",
): Contact | null {
  const photo = view === "photo";
  const position = (image: Point) =>
    photo
      ? { x: image.x * p.width, y: image.y * p.height }
      : alignment.inverse
        ? project(alignment.inverse, image)
        : null;
  const query = position(image);
  if (
    !query ||
    !Number.isFinite(query.x) ||
    !Number.isFinite(query.y) ||
    (!photo && !inCourt(query))
  )
    return null;
  // One court foot covers the displayed marker with a small aiming margin.
  const radius = photo ? Math.max(p.width, p.height) * 0.02 : 1;
  let nearest: Contact | null = null,
    nearestDistance = Infinity;
  for (const c of p.contacts) {
    const point = position(c.image);
    if (!point || (!photo && !inCourt(point))) continue;
    const d = distance(point, query);
    const bodyHit =
      photo &&
      c.box &&
      image.x >= c.box[0] &&
      image.x <= c.box[2] &&
      image.y >= c.box[1] &&
      image.y <= c.box[3];
    if ((d < radius || bodyHit) && d < nearestDistance) {
      nearest = c;
      nearestDistance = d;
    }
  }
  return nearest;
}
export function supported(p: Point, a: Alignment) {
  // Homography round trips can place a court-edge point a few ulps outside
  // the court · Keep exact boundary points supported without widening coverage
  const edgeTolerance = 1e-9;
  if (
    a.hull.length < 3 ||
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y) ||
    p.x < -edgeTolerance ||
    p.x > COURT.width + edgeTolerance ||
    p.y < -edgeTolerance ||
    p.y > COURT.length + edgeTolerance
  )
    return false;
  return a.hull.every(
    (q, i) => cross(q, a.hull[(i + 1) % a.hull.length], p) >= -0.001,
  );
}
export function uncertainty(
  a: Alignment,
  p: Point,
  width: number,
  height: number,
): number | null {
  if (
    !a.inverse ||
    !supported(p, a) ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  )
    return null;
  const q = project(a.h!, p);
  if (!q) return null;
  const epsX = Math.max(2 / width, a.rms * 2),
    epsY = Math.max(2 / height, a.rms * 2),
    offsets = [
      { x: q.x + epsX, y: q.y },
      { x: q.x - epsX, y: q.y },
      { x: q.x, y: q.y + epsY },
      { x: q.x, y: q.y - epsY },
    ];
  const errors = offsets.map((q) => project(a.inverse!, q));
  if (errors.some((p) => !p)) return null;
  const e = Math.max(...errors.map((v) => distance(v!, p))) + 0.25;
  return Number.isFinite(e) && e < 3 ? e : null;
}
function measurementImage(p: FloorProject, v: MeasurePoint): Point | undefined {
  return v.contactId
    ? p.contacts.find((c) => c.id === v.contactId)?.image
    : v.image;
}
export function measurementPointSupported(
  p: FloorProject,
  alignment: Alignment,
  endpoint: MeasurePoint,
): boolean | null {
  if (!alignment.h || !alignment.inverse || alignment.hull.length < 3) return null;
  const image = measurementImage(p, endpoint),
    floor = image ? project(alignment.inverse, image) : null;
  return floor ? supported(floor, alignment) : null;
}
export function sameMeasurementLocation(
  p: FloorProject,
  first: MeasurePoint,
  second: MeasurePoint,
): boolean {
  const a = measurementImage(p, first),
    b = measurementImage(p, second);
  // Allow only subpixel round-off from moving between the two projections
  return (
    !!a &&
    !!b &&
    Math.hypot((a.x - b.x) * p.width, (a.y - b.y) * p.height) <= 0.001
  );
}
export function findExistingMeasurement(
  p: FloorProject,
  first: MeasurePoint,
  second: MeasurePoint,
) {
  const same = (a: MeasurePoint, b: MeasurePoint) =>
    a.contactId && b.contactId
      ? a.contactId === b.contactId
      : sameMeasurementLocation(p, a, b);
  return p.measurements.find(
    (m) =>
      (same(m.a, first) && same(m.b, second)) ||
      (same(m.a, second) && same(m.b, first)),
  );
}
export function measure(
  p: FloorProject,
  a: Alignment,
  first: MeasurePoint,
  second: MeasurePoint,
) {
  if (a.status !== "ready" || !a.inverse) return { reason: a.reason };
  if (
    [first, second].some(
      (v) =>
        v.contactId &&
        p.contacts.find((c) => c.id === v.contactId)?.status !== "grounded",
    )
  )
    return { reason: "Confirm both contacts are grounded and visible" };
  const srcA = measurementImage(p, first),
    srcB = measurementImage(p, second);
  if (!srcA || !srcB) return { reason: "Contact is unavailable" };
  const x = project(a.inverse, srcA),
    y = project(a.inverse, srcB);
  if (!x || !y || !supported(x, a) || !supported(y, a))
    return { reason: "Outside supported region" };
  const ea = uncertainty(a, x, p.width, p.height),
    eb = uncertainty(a, y, p.width, p.height);
  if (ea === null || eb === null)
    return { reason: "Projection uncertainty is too large here" };
  const feet = distance(x, y),
    error = ea + eb,
    scale = p.units === "m" ? 0.3048 : 1;
  return {
    value: feet * scale,
    error: error * scale,
    low: Math.max(0, feet - error) * scale,
    high: (feet + error) * scale,
    reason:
      "Estimated sensitivity range · Not a calibrated confidence interval",
  };
}
export function courtLines(): Point[][] {
  const arc = (cx: number, cy: number, r: number, start: number, end: number) =>
    Array.from({ length: 65 }, (_, i) => ({
      x: cx + r * Math.cos(start + ((end - start) * i) / 64),
      y: cy + r * Math.sin(start + ((end - start) * i) / 64),
    }));
  const start = Math.acos(22 / 23.75);
  return [
    [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 47 },
      { x: 0, y: 47 },
      { x: 0, y: 0 },
    ],
    [
      { x: 17, y: 0 },
      { x: 17, y: 19 },
      { x: 33, y: 19 },
      { x: 33, y: 0 },
    ],
    arc(25, 19, 6, 0, Math.PI * 2),
    [
      { x: 3, y: 0 },
      { x: 3, y: arcY },
    ],
    arc(25, 5.25, 23.75, start, Math.PI - start),
    [
      { x: 47, y: arcY },
      { x: 47, y: 0 },
    ],
    arc(25, 5.25, 4, 0, Math.PI),
    [
      { x: 21, y: 5.25 },
      { x: 21, y: 4 },
    ],
    [
      { x: 29, y: 5.25 },
      { x: 29, y: 4 },
    ],
    arc(25, 47, 6, Math.PI, Math.PI * 2),
  ];
}
export function regionPolygons(): {
  paint: Point[];
  corners: Point[][];
  restricted: Point[];
} {
  const restricted = [
    { x: 21, y: 4 },
    ...Array.from({ length: 33 }, (_, i) => ({
      x: 25 + 4 * Math.cos(Math.PI - (i * Math.PI) / 32),
      y: 5.25 + 4 * Math.sin(Math.PI - (i * Math.PI) / 32),
    })),
    { x: 29, y: 4 },
  ];
  return {
    paint: [
      { x: 17, y: 0 },
      { x: 33, y: 0 },
      { x: 33, y: 19 },
      { x: 17, y: 19 },
    ],
    corners: [
      [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: arcY },
        { x: 0, y: arcY },
      ],
      [
        { x: 47, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: arcY },
        { x: 47, y: arcY },
      ],
    ],
    restricted,
  };
}
