export type Point = { x: number; y: number };
export type Anchor = {
  id: string;
  landmark: string;
  image: Point;
  enabled: boolean;
  origin: "model" | "manual" | "sample";
  confidence: number;
};
export type Contact = {
  id: string;
  label: string;
  image: Point;
  status: "uncertain" | "grounded" | "hidden" | "airborne";
  box?: [number, number, number, number];
};
export type MeasurePoint = { image: Point; contactId?: string };
export type Measurement = { id: string; a: MeasurePoint; b: MeasurePoint };
export type Attribution = {
  title: string;
  creator: string;
  license: string;
  url: string;
};
export type VideoFrameSource = { seconds: number; duration: number };
export type FloorProject = {
  version: 1;
  id: string;
  name: string;
  imageId: string;
  width: number;
  height: number;
  anchors: Anchor[];
  contacts: Contact[];
  measurements: Measurement[];
  reviewed: boolean;
  units: "ft" | "m";
  regions: { paint: boolean; corners: boolean; restricted: boolean };
  attribution?: Attribution;
  videoFrame?: VideoFrameSource;
  updatedAt: string;
};
export type StoredProject = {
  project: FloorProject;
  image: Blob;
  // Older saved projects acquire a revision on their next successful save
  revision?: string;
};
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PIXELS = 24_000_000;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 600;
export const MAX_PROJECTS = 20;
export const MAX_LIBRARY_BYTES = 200 * 1024 * 1024;
export const id = () => crypto.randomUUID();
export const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
export function point(v: unknown): v is Point {
  const p = v as Point;
  return !!p && finite(p.x) && finite(p.y);
}
export function imagePoint(v: unknown): v is Point {
  return point(v) && v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1;
}
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const LANDMARK_IDS = new Set([
  "baseline-left",
  "corner-left",
  "lane-left-base",
  "lane-right-base",
  "corner-right",
  "baseline-right",
  "free-left",
  "free-center",
  "free-right",
  "three-left",
  "three-right",
  "half-left",
  "half-right",
]);
const unique = (v: { id: string }[]) =>
  new Set(v.map((x) => x.id)).size === v.length;
export function validateProject(v: unknown): v is FloorProject {
  if (!v || typeof v !== "object") return false;
  const p = v as FloorProject;
  if (
    p.version !== 1 ||
    !text(p.id, 100) ||
    !text(p.imageId, 100) ||
    !text(p.name, 80) ||
    !Number.isInteger(p.width) ||
    !Number.isInteger(p.height) ||
    p.width < 1 ||
    p.height < 1 ||
    Math.max(p.width, p.height) > 2048 ||
    !["ft", "m"].includes(p.units) ||
    typeof p.reviewed !== "boolean" ||
    !p.regions ||
    ![p.regions.paint, p.regions.corners, p.regions.restricted].every(
      (v) => typeof v === "boolean",
    ) ||
    typeof p.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(p.updatedAt))
  )
    return false;
  if (
    !Array.isArray(p.anchors) ||
    p.anchors.length > 64 ||
    !p.anchors.every(
      (a) =>
        a &&
        text(a.id, 100) &&
        LANDMARK_IDS.has(a.landmark) &&
        imagePoint(a.image) &&
        typeof a.enabled === "boolean" &&
        ["manual", "model", "sample"].includes(a.origin) &&
        finite(a.confidence) &&
        a.confidence >= 0 &&
        a.confidence <= 1,
    ) ||
    !unique(p.anchors)
  )
    return false;
  if (
    !Array.isArray(p.contacts) ||
    p.contacts.length > 40 ||
    !p.contacts.every(
      (c) =>
        c &&
        text(c.id, 100) &&
        text(c.label, 40) &&
        imagePoint(c.image) &&
        ["uncertain", "grounded", "hidden", "airborne"].includes(c.status) &&
        (!c.box ||
          (Array.isArray(c.box) &&
            c.box.length === 4 &&
            c.box.every((n) => finite(n) && n >= 0 && n <= 1) &&
            c.box[0] < c.box[2] &&
            c.box[1] < c.box[3])),
    ) ||
    !unique(p.contacts)
  )
    return false;
  const mp = (m: MeasurePoint) =>
    m &&
    imagePoint(m.image) &&
    (m.contactId === undefined || p.contacts.some((c) => c.id === m.contactId));
  if (
    !Array.isArray(p.measurements) ||
    p.measurements.length > 20 ||
    !p.measurements.every((m) => m && text(m.id, 100) && mp(m.a) && mp(m.b)) ||
    !unique(p.measurements)
  )
    return false;
  if (p.videoFrame !== undefined && !validVideoFrameSource(p.videoFrame))
    return false;
  if (
    p.attribution &&
    (!text(p.attribution.title, 250) ||
      !text(p.attribution.creator, 250) ||
      !text(p.attribution.license, 100) ||
      !/^https:\/\//.test(p.attribution.url) ||
      p.attribution.url.length > 1000)
  )
    return false;
  return true;
}
export function validVideoFrameSource(v: unknown): v is VideoFrameSource {
  const f = v as VideoFrameSource;
  return (
    !!f &&
    finite(f.seconds) &&
    finite(f.duration) &&
    f.duration > 0 &&
    f.duration <= MAX_VIDEO_SECONDS &&
    f.seconds >= 0 &&
    f.seconds <= f.duration
  );
}
export function newProject(
  width: number,
  height: number,
  name: string,
): FloorProject {
  return {
    version: 1,
    id: id(),
    imageId: id(),
    name: name.slice(0, 80) || "Untitled photo",
    width,
    height,
    anchors: [],
    contacts: [],
    measurements: [],
    reviewed: false,
    units: "ft",
    regions: { paint: false, corners: false, restricted: false },
    updatedAt: new Date().toISOString(),
  };
}
export type InferenceRequest = {
  type: "analyze";
  imageId: string;
  jobId: string;
  revision: number;
  image: ImageBitmap;
};
export type InferenceResponse = {
  imageId: string;
  jobId: string;
  revision: number;
} & (
  | { type: "progress"; message: string }
  | { type: "error"; message: string }
  | {
      type: "result";
      anchors: Anchor[];
      contacts: Contact[];
      provider: "webgpu" | "wasm";
      warnings: string[];
    }
);
export function validResponse(v: unknown): v is InferenceResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as InferenceResponse;
  if (
    !text(r.imageId, 100) ||
    !text(r.jobId, 100) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0
  )
    return false;
  if (r.type === "progress" || r.type === "error") return text(r.message, 1000);
  if (
    r.type !== "result" ||
    !["webgpu", "wasm"].includes(r.provider) ||
    !Array.isArray(r.warnings) ||
    r.warnings.length > 10 ||
    !r.warnings.every((s) => text(s, 1000))
  )
    return false;
  return validateProject({
    ...newProject(1, 1, "response"),
    anchors: r.anchors,
    contacts: r.contacts,
  });
}
