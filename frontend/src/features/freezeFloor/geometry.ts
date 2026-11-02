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
export function align(anchors: Anchor[], reviewed = false): Alignment {
  const empty: Alignment = {
    status: "insufficient",
    reason: "Add at least four well-spread floor landmarks",
    inliers: [],
    rejected: [],
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
  const floorHull = hull(best.map((i) => src[i]));
  if (area(floorHull) < 45 || area(hull(best.map((i) => dst[i]))) < 0.0015)
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
  const denominators = floorHull.map((p) => h[6] * p.x + h[7] * p.y + h[8]);
  const imageHull = hull(best.map((i) => dst[i])),
    inverseDenominators = imageHull.map(
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
    best.some((i) => {
      const q = project(inverse, dst[i]);
      return !q || distance(q, src[i]) > 2;
    })
  )
    return {
      ...empty,
      reason: "Floor projection is unstable · Check the landmark labels",
    };
  const rms = Math.sqrt(
    best.reduce((s, i) => s + distance(project(h, src[i])!, dst[i]) ** 2, 0) /
      best.length,
  );
  const rejected = a.filter((_, i) => !best.includes(i)).map((a) => a.id);
  // Conflicting included anchors must be corrected or explicitly excluded before measurement.
  const status = rejected.length ? "review" : reviewed ? "ready" : "review";
  return {
    h,
    inverse,
    inliers: best.map((i) => a[i].id),
    rejected,
    rms,
    hull: floorHull,
    status,
    reason: rejected.length
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
  if (!inCourt(p) || a.hull.length < 3) return false;
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
  if (!a.inverse || !supported(p, a)) return null;
  const q = project(a.h!, p);
  if (!q) return null;
  const eps = Math.max(2 / Math.min(width, height), a.rms * 2),
    offsets = [
      { x: q.x + eps, y: q.y },
      { x: q.x - eps, y: q.y },
      { x: q.x, y: q.y + eps },
      { x: q.x, y: q.y - eps },
    ];
  const errors = offsets.map((q) => project(a.inverse!, q));
  if (errors.some((p) => !p)) return null;
  const e = Math.max(...errors.map((v) => distance(v!, p))) + 0.25;
  return Number.isFinite(e) && e < 3 ? e : null;
}
export function measure(
  p: FloorProject,
  a: Alignment,
  first: MeasurePoint,
  second: MeasurePoint,
) {
  const source = (v: MeasurePoint) =>
    v.contactId ? p.contacts.find((c) => c.id === v.contactId)?.image : v.image;
  if (a.status !== "ready" || !a.inverse) return { reason: a.reason };
  if (
    [first, second].some(
      (v) =>
        v.contactId &&
        p.contacts.find((c) => c.id === v.contactId)?.status !== "grounded",
    )
  )
    return { reason: "Confirm both contacts are grounded and visible" };
  const srcA = source(first),
    srcB = source(second);
  if (!srcA || !srcB) return { reason: "Contact is unavailable" };
  const x = project(a.inverse, srcA),
    y = project(a.inverse, srcB);
  if (!x || !y || !supported(x, a) || !supported(y, a))
    return { reason: "Outside the floor region supported by the anchors" };
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
