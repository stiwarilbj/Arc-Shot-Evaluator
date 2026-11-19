import type { BrowserPoseFrame, BrowserPoseOverlay, PoseKeypoint, ShotAnalysis } from "./analysisTypes";

export const BROWSER_MOTION_WINDOW_FLAG = "Motion window ready for review";
export const VISIBLE_FORM_REVIEW_FLAG = "Visible form needs review";

export function browserPoseAtTime(overlay: BrowserPoseOverlay | undefined, time: number): BrowserPoseFrame | undefined {
  if (!overlay || !Number.isFinite(overlay.fps) || overlay.fps <= 0 || !Number.isFinite(time) || time < 0) return undefined;
  const frame = time * overlay.fps;
  // Legacy browser saves omitted the stride from the prepared 30 Hz tracks.
  const stride = overlay.stride && Number.isSafeInteger(overlay.stride) && overlay.stride > 0
    ? overlay.stride
    : Math.max(1, Math.round(overlay.fps / 30));
  let best: BrowserPoseFrame | undefined;
  let distance = stride / 2;
  for (const candidate of overlay.frames) {
    const nextDistance = Math.abs(candidate.frame - frame);
    if (nextDistance < distance || (nextDistance === distance && (!best || candidate.frame < best.frame))) {
      best = candidate;
      distance = nextDistance;
    }
  }
  return best?.keypoints.some((point) => point?.[2] >= 0.16) ? best : undefined;
}

function jointAngle(first?: PoseKeypoint, middle?: PoseKeypoint, last?: PoseKeypoint) {
  if (!first || !middle || !last || first[2] < 0.16 || middle[2] < 0.16 || last[2] < 0.16) return null;
  const firstVector = [first[0] - middle[0], first[1] - middle[1]];
  const lastVector = [last[0] - middle[0], last[1] - middle[1]];
  const firstLength = Math.hypot(firstVector[0], firstVector[1]);
  const lastLength = Math.hypot(lastVector[0], lastVector[1]);
  if (!firstLength || !lastLength) return null;
  const cosine = Math.min(1, Math.max(-1, (firstVector[0] * lastVector[0] + firstVector[1] * lastVector[1]) / (firstLength * lastLength)));
  return Math.round((Math.acos(cosine) * 180) / Math.PI * 10) / 10;
}

function formAtPose(pose: BrowserPoseFrame | undefined): ShotAnalysis["form"] {
  if (pose) {
    const sides = [[5, 7, 9, 11, 13, 15], [6, 8, 10, 12, 14, 16]];
    const candidates = sides.map(([shoulder, elbow, wrist, hip, knee, ankle]) => ({
      elbow: jointAngle(pose.keypoints[shoulder], pose.keypoints[elbow], pose.keypoints[wrist]),
      knee: jointAngle(pose.keypoints[hip], pose.keypoints[knee], pose.keypoints[ankle]),
      shoulder: jointAngle(pose.keypoints[elbow], pose.keypoints[shoulder], pose.keypoints[hip]),
      hip: jointAngle(pose.keypoints[shoulder], pose.keypoints[hip], pose.keypoints[knee]),
    })).filter((candidate) => candidate.elbow != null);
    if (candidates.length) return candidates.sort((left, right) => (right.elbow ?? 0) - (left.elbow ?? 0))[0];
  }
  return { elbow: null, knee: null, shoulder: null, hip: null };
}

function rangeQuality(value: number | null, minimum: number, maximum: number) {
  if (value == null) return null;
  if (value >= minimum && value <= maximum) return 1;
  const distance = value < minimum ? minimum - value : value - maximum;
  return Math.max(0, 1 - distance / 70);
}

export function browserReleasePose(overlay: BrowserPoseOverlay | undefined, time: number) {
  const pose = browserPoseAtTime(overlay, time);
  const form = formAtPose(pose);
  const values = [
    rangeQuality(form.elbow, 65, 125),
    rangeQuality(form.knee, 125, 195),
    rangeQuality(form.shoulder, 20, 105),
    rangeQuality(form.hip, 125, 205),
  ].filter((value): value is number => value != null);
  const quality = values.length ? values.reduce((total, value) => total + value, 0) / values.length : overlay ? null : 0.62;
  return {
    form,
    evidence: {
      pose_sample_frame: overlay ? pose?.frame ?? null : undefined,
      pose_confidence: pose?.confidence ?? 0,
      shot_quality: quality,
      mechanics_quality: quality,
      metric_availability: {
        elbow: form.elbow != null,
        knee: form.knee != null,
        shoulder: form.shoulder != null,
        hip: form.hip != null,
      },
    },
  };
}
