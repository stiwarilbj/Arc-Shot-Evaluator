import assert from "node:assert/strict";
import { browserPoseAtTime, browserReleasePose, BROWSER_MOTION_WINDOW_FLAG } from "../frontend/src/domain/browserPose.ts";
import { refreshBrowserShotReview } from "../frontend/src/domain/shotReview.ts";

function sample(frame) {
  const keypoints = Array.from({ length: 17 }, () => [0, 0, 0]);
  for (const [index, x, y] of [[5, 1, 1], [7, 1, 2], [9, 2, 2], [11, 0, 2], [13, 0, 3], [15, 1, 3]]) {
    keypoints[index] = [x, y, 1];
  }
  return { frame, confidence: 0.8, keypoints };
}

const track = { width: 1280, height: 720, fps: 60, stride: 2, frames: [sample(6), sample(4), sample(10)] };
const at = (frame) => browserPoseAtTime(track, frame / track.fps)?.frame;
assert.equal(at(2), undefined);
assert.equal(at(3), 4);
assert.equal(at(5), 4, "Exact ties favor the earlier sample even when the track is unsorted");
assert.equal(at(6.2), 6);
assert.equal(at(8), undefined);
assert.equal(at(10), 10);
assert.equal(at(11), 10);
assert.equal(at(11.01), undefined);
assert.equal(browserPoseAtTime({ ...track, stride: 1 }, 7 / 60), undefined);
assert.equal(browserPoseAtTime({ ...track, stride: undefined }, 7 / 60)?.frame, 6);
assert.equal(browserPoseAtTime({ ...track, fps: 30, stride: undefined }, 7 / 30), undefined);
assert.equal(browserPoseAtTime(track, NaN), undefined);
const hidden = { ...sample(8), keypoints: Array.from({ length: 17 }, () => [0, 0, 0.1]) };
assert.equal(browserPoseAtTime({ ...track, frames: [...track.frames, hidden] }, 8 / 60), undefined);

const supported = browserReleasePose(track, 6 / 60);
assert.equal(supported.evidence.pose_sample_frame, 6);
assert.equal(supported.evidence.pose_confidence, 0.8);
assert.equal(supported.form.elbow, 90);
assert.equal(supported.evidence.metric_availability.elbow, true);
const unsupported = browserReleasePose(track, 8 / 60);
assert.equal(unsupported.evidence.pose_sample_frame, null);
assert.equal(unsupported.evidence.pose_confidence, 0);
assert.equal(unsupported.evidence.shot_quality, null);
assert.equal(unsupported.evidence.mechanics_quality, null);
assert.ok(Object.values(unsupported.form).every((angle) => angle === null));

const correction = { source: "local_user", fields: ["release_frame", "outcome"] };
const shot = {
  id: 1, outcome: "make", release_time: 8 / 60, release_frame: 8, observation_confidence: 0.62,
  form: supported.form, flags: [BROWSER_MOTION_WINDOW_FLAG, "Visible form needs review", "Other evidence"],
  evidence: { ...supported.evidence, metric_availability: { entry_angle_deg: true }, correction },
};
const manual = { ...shot, id: 2, outcome: "miss", flags: ["Added in browser review"] };
const session = { session: { id: "browser-pose", fps: 60 }, shots: [shot, manual], artifacts: {}, pose_overlay: track };
const refreshed = refreshBrowserShotReview(session);
assert.equal(refreshed.pose_overlay, track);
assert.equal(refreshed.shots[1], manual);
assert.equal(refreshed.shots[0].evidence.correction, correction);
assert.equal(refreshed.shots[0].evidence.metric_availability.entry_angle_deg, true);
assert.equal(refreshed.shots[0].evidence.metric_availability.elbow, false);
assert.equal(refreshed.shots[0].evidence.pose_sample_frame, null);
assert.equal(refreshed.shots[0].observation_confidence, 0.62);
assert.deepEqual(refreshed.shots[0].flags, [BROWSER_MOTION_WINDOW_FLAG, "Other evidence"]);
assert.deepEqual(refreshed.shots[0].form, unsupported.form);
assert.equal(refreshed.summary.observed_ft_pct, 50);
const exported = await (await fetch(refreshed.artifacts.shots_jsonl)).json();
assert.deepEqual(exported, refreshed.shots);

const moved = { ...refreshed.shots[0], release_time: 6 / 60, release_frame: 6 };
const corrected = refreshBrowserShotReview({ ...refreshed, shots: [moved, manual] });
assert.deepEqual(corrected.shots[0].form, supported.form);
assert.equal(corrected.shots[0].evidence.pose_sample_frame, 6);
assert.equal(corrected.shots[0].evidence.metric_availability.elbow, true);
assert.equal(corrected.summary.observed_ft_pct, 50);
console.log("Prepared pose cadence, gaps, legacy restores, corrected releases, and shot-data exports passed");
