from __future__ import annotations

import argparse
import json
import math
import shutil
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from backend.analysis.geometry import clamp, distance, joint_angle, line_angle_degrees, robust_median, smooth_xy
from backend.analysis.jump_shot import analyze_jump_shot, assign_player_tracks, distance_from_calibration
from backend.analysis.video_normalization import normalize_video
from backend.analysis.vision_models import (
    BasketballVisionModels,
    add_model_hoops,
    color_ball_candidates,
    color_rim_candidates,
    frame_sharpness,
    merge_ball_candidates,
    select_rim_track,
)
from backend.prediction.jump_models import JUMP_MODEL_VERSION
from backend.coaching.retriever import attach_coaching
from backend.config import ANALYSIS_SESSIONS_DIR, MODEL_WEIGHTS_DIR
from backend.domain.models import BoundingBox, BallCandidate, FrameDetections, PlayerPose, ShotAnalysis, BallTrackPoint


Progress = Callable[[str, int, int], None]

# Bump this whenever the interpretation of a stored result changes. Saved
# sessions are immutable evidence; readers may backfill display fields but
# must never recompute the original observation.
ANALYSIS_VERSION = "3.0.0"
PREDICTION_STATUS = "unavailable_unvalidated"

# Ultralytics' MPS path is fast for one batch, but two model predictions at
# once can make Metal allocate a second copy of the graph and exhaust the
# shared GPU memory on an ordinary Mac. Keep the model pair shared between
# concurrent queue jobs and arbitrate the short inference sections. Jobs still
# run concurrently (decode, tracking, geometry, and rendering overlap), while
# the heavyweight model calls stay predictable and do not take down the local
# worker when two videos are submitted together.
_MODEL_SUITE: BasketballVisionModels | None = None
_MODEL_SUITE_LOCK = threading.Lock()
_MODEL_INFERENCE_LOCK = threading.Lock()


def get_shared_vision_models() -> BasketballVisionModels:
    global _MODEL_SUITE
    if _MODEL_SUITE is None:
        with _MODEL_SUITE_LOCK:
            if _MODEL_SUITE is None:
                _MODEL_SUITE = BasketballVisionModels(
                    MODEL_WEIGHTS_DIR / "ebard-yolov8n.pt",
                    MODEL_WEIGHTS_DIR / "yolo11n-pose.pt",
                )
    return _MODEL_SUITE


@dataclass(slots=True)
class VideoMetadata:
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    source_fps: float | None = None
    source_frame_count: int | None = None
    timing_preserved: bool = True
    slow_motion_unknown: bool = False


@dataclass
class BallTrackCandidate:
    points: list[BallTrackPoint]
    score: float
    gap: int = 0

    def observed(self) -> list[BallTrackPoint]:
        return [point for point in self.points if point.observed]


def probe_video(path: Path) -> VideoMetadata:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError("OpenCV could not open this video")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    capture.release()
    if fps <= 1 or frame_count <= 0 or width <= 0 or height <= 0:
        raise ValueError("Video metadata is incomplete or unsupported")
    return VideoMetadata(
        width,
        height,
        fps,
        frame_count,
        frame_count / fps,
        source_fps=fps,
        source_frame_count=frame_count,
        timing_preserved=True,
    )


def read_video_frame_batch(capture: cv2.VideoCapture, size: int) -> list[np.ndarray]:
    frames: list[np.ndarray] = []
    for _ in range(size):
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame)
    return frames


def collect_evidence(
    path: Path,
    meta: VideoMetadata,
    progress: Progress | None = None,
    processing_mode: str = "normal",
) -> list[FrameDetections]:
    suite = get_shared_vision_models()
    capture = cv2.VideoCapture(str(path))
    evidence: list[FrameDetections] = []
    deep = processing_mode == "deep"
    batch_size = 6 if deep else 12
    completed = 0
    previous_gray: np.ndarray | None = None
    while True:
        frames = read_video_frame_batch(capture, batch_size)
        if not frames:
            break
        # Keep both model calls inside one critical section so a second
        # analysis can be decoding and preparing its next batch without
        # issuing a simultaneous MPS prediction. This is the difference
        # between safe concurrent jobs and two workers competing for a second
        # copy of the Metal graph.
        with _MODEL_INFERENCE_LOCK:
            detected = suite.infer_detector(frames, deep=deep)
            pose_stride = 1 if deep else 2
            pose_frames = frames[::pose_stride]
            pose_results = suite.infer_pose(pose_frames, deep=deep)
        pose_by_offset = {offset: poses for offset, poses in zip(range(0, len(frames), pose_stride), pose_results, strict=True)}
        for offset, (frame, item) in enumerate(zip(frames, detected, strict=True)):
            item.balls = merge_ball_candidates(item.balls, color_ball_candidates(frame))
            item.hoops = add_model_hoops(color_rim_candidates(frame), item.hoops)
            item.poses = pose_by_offset.get(offset, [])
            item.sharpness = frame_sharpness(frame)
            gray = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (96, 54))
            if previous_gray is not None:
                # A cut/replay boundary is a high-signal event, not a reason
                # to manufacture a long ball gap. Keep the threshold
                # conservative so normal pans and ball motion do not split a
                # continuous attempt.
                change = float(np.mean(cv2.absdiff(gray, previous_gray)) / 255.0)
                item.scene_cut = change >= 0.38
                # Only suppress near-identical frames when normalization had
                # to change cadence. A static hold in a native-rate source is
                # still real footage; a cadence conversion can insert exact
                # duplicates that must not count as extra observations.
                item.duplicate_frame = bool(
                    not meta.timing_preserved and change <= 0.0025 and not item.scene_cut
                )
            previous_gray = gray
            evidence.append(item)
        completed += len(frames)
        if progress:
            progress("Tracking ball, rim, and pose", completed, meta.frame_count)
    capture.release()
    if not evidence:
        raise ValueError("No video frames could be decoded")
    return evidence


def find_pose_nearest_ball(evidence: list[FrameDetections], frame: int, point: BallCandidate | BallTrackPoint) -> PlayerPose | None:
    for delta in (0, -1, 1, -2, 2, -3, 3):
        index = frame + delta
        if not 0 <= index < len(evidence):
            continue
        poses = evidence[index].poses
        if not poses:
            continue
        # Broadcast and portrait clips often contain several people at very
        # different depths.  Selecting only the person with the lowest feet
        # silently discards the shooter when a foreground player or referee
        # is lower in the frame.  Prefer a pose that contains the ball first;
        # for a ball in flight, use the nearest trusted wrist/body instead.
        containing = [
            pose
            for pose in poses
            if pose.box.x1 - pose.box.width * 0.18 <= point.x <= pose.box.x2 + pose.box.width * 0.18
            and pose.box.y1 - pose.box.height * 0.16 <= point.y <= pose.box.y2 + pose.box.height * 0.22
        ]

        def wrist_distance(pose: PlayerPose) -> float:
            trusted = [pose.keypoints[index] for index in (9, 10) if pose.keypoints[index][2] >= 0.18]
            return min((distance((point.x, point.y), (x, y)) for x, y, _ in trusted), default=1e9)

        if containing:
            return min(containing, key=lambda pose: (wrist_distance(pose), -pose.confidence))

        def body_distance(pose: PlayerPose) -> float:
            x = clamp(point.x, pose.box.x1, pose.box.x2)
            y = clamp(point.y, pose.box.y1, pose.box.y2)
            return distance((point.x, point.y), (x, y))

        return min(
            poses,
            key=lambda pose: (
                wrist_distance(pose) if wrist_distance(pose) < 1e9 else body_distance(pose),
                -pose.confidence,
            ),
        )
    return None


def _pose_near_anchor(evidence: list[FrameDetections], frame: int, anchor: PlayerPose) -> PlayerPose | None:
    """Follow the shooter after the ball leaves the hand.

    Once a shot is released, the ball can be closer to a teammate, referee,
    or rim-side player than to the shooter.  Re-associating the pose from the
    ball at every frame therefore corrupts release mechanics.  This helper
    follows the pose whose box remains closest in position and scale to the
    pose identified while the ball was still in the shooter's hand.
    """
    anchor_x, anchor_y = anchor.box.center
    anchor_height = max(1.0, anchor.box.height)
    for delta in (0, -1, 1, -2, 2, -3, 3):
        index = frame + delta
        if not 0 <= index < len(evidence) or not evidence[index].poses:
            continue

        def cost(pose: PlayerPose) -> tuple[float, float]:
            center_x, center_y = pose.box.center
            center_cost = distance((center_x, center_y), (anchor_x, anchor_y)) / anchor_height
            scale_cost = abs(math.log(max(1e-3, pose.box.height / anchor_height)))
            return (center_cost + scale_cost * 0.35, -pose.confidence)

        return min(evidence[index].poses, key=cost)
    return None


def _release_seed_candidates(
    evidence: list[FrameDetections], rims: list[BoundingBox | None], frame_size: tuple[int, int]
) -> list[tuple[float, int, BallCandidate]]:
    _, frame_height = frame_size
    seeds: list[tuple[float, int, BallCandidate]] = []
    for frame, item in enumerate(evidence[:-8]):
        if item.scene_cut or item.duplicate_frame:
            continue
        for ball in item.balls:
            pose = find_pose_nearest_ball(evidence, frame, ball)
            if pose is None or pose.box.height < frame_height * 0.18:
                continue
            trusted = [(x, y) for index in (9, 10) for x, y, c in [pose.keypoints[index]] if c >= 0.18]
            if not trusted:
                continue
            wrist_distance = min(distance((ball.x, ball.y), wrist) for wrist in trusted)
            radius = max(48.0, pose.box.height * 0.24)
            if wrist_distance > radius:
                continue
            if not (pose.box.y1 - 20 <= ball.y <= pose.box.y1 + pose.box.height * 0.72):
                continue
            upward = 0.0
            target = rims[frame] if frame < len(rims) else None
            for future in range(frame + 2, min(len(evidence), frame + 16)):
                if evidence[future].scene_cut:
                    break
                for candidate in evidence[future].balls:
                    dt = future - frame
                    start_rim = _rim_center_at(rims, frame)
                    future_rim = _rim_center_at(rims, future)
                    shift = (
                        (future_rim[0] - start_rim[0], future_rim[1] - start_rim[1])
                        if (
                            start_rim is not None
                            and future_rim is not None
                            and _rim_motion_ratio(rims, frame_size) >= 0.075
                        )
                        else (0.0, 0.0)
                    )
                    relative_candidate = (candidate.x - shift[0], candidate.y - shift[1])
                    if candidate.y < ball.y - max(18.0, pose.box.height * 0.055) and distance(
                        (ball.x, ball.y), relative_candidate
                    ) < 42 * dt + 75:
                        progress_to_rim = 0.0
                        if target is not None:
                            progress_to_rim = clamp(
                                (distance((ball.x, ball.y), target.center) - distance((candidate.x, candidate.y), target.center))
                                / max(1.0, target.width * 4),
                                -0.3,
                                0.8,
                            )
                        upward = max(upward, candidate.confidence + progress_to_rim)
            if upward <= 0:
                continue
            centered = 1.0 - wrist_distance / radius
            score = ball.confidence * 1.5 + pose.confidence * 0.3 + centered * 0.9 + upward * 0.8
            seeds.append((score, frame, ball))
    seeds.sort(key=lambda value: value[0], reverse=True)
    return seeds


def predict_ball_from_recent_motion(
    candidate: BallTrackCandidate, frame: int
) -> tuple[float, float, float, float]:
    observed = candidate.observed()
    last = observed[-1]
    if len(observed) < 2:
        return last.x, last.y, 0.0, -3.0
    previous = observed[-2]
    dt = max(1, last.frame - previous.frame)
    vx = (last.x - previous.x) / dt
    vy = (last.y - previous.y) / dt
    gap = frame - last.frame
    return last.x + vx * gap, last.y + vy * gap, vx, vy


def _rim_center_at(rims: list[BoundingBox | None], frame: int, search: int = 4) -> tuple[float, float] | None:
    """Return a nearby rim center for camera-motion compensation."""
    if 0 <= frame < len(rims) and rims[frame] is not None:
        return rims[frame].center
    for delta in range(1, search + 1):
        for candidate_frame in (frame - delta, frame + delta):
            if 0 <= candidate_frame < len(rims) and rims[candidate_frame] is not None:
                return rims[candidate_frame].center
    return None


def _rim_motion_ratio(rims: list[BoundingBox | None], frame_size: tuple[int, int]) -> float:
    """Estimate global camera motion from the detected rim track.

    A small amount of detector jitter is normal even with a locked-off phone.
    Only enable camera compensation when the rim travels far enough across the
    frame that treating that movement as a pan is more likely than noise.
    """
    visible = [rim.center for rim in rims if rim is not None]
    if len(visible) < 3:
        return 0.0
    frame_width, frame_height = frame_size
    if frame_width <= 0 or frame_height <= 0:
        return 0.0
    centers = np.asarray(visible, dtype=float)
    span_x = float(np.ptp(centers[:, 0])) / frame_width
    span_y = float(np.ptp(centers[:, 1])) / frame_height
    return max(span_x, span_y)


def predict_ball_with_camera_motion(
    beam: BallTrackCandidate, frame: int, rims: list[BoundingBox | None], frame_size: tuple[int, int] | None = None
) -> tuple[float, float, float, float]:
    """Predict after learning velocity in rim-relative coordinates.

    The rim is fixed on the court, so its image displacement is a useful
    camera-pan estimate. This keeps a moving phone from looking like a ball
    acceleration and lets the tracker bridge short motion-blurred gaps.
    """
    # Keep the helper's historical standalone behavior for callers/tests that
    # do not have video dimensions; production tracking always supplies them
    # and can therefore distinguish detector jitter from a real camera pan.
    if frame_size is not None and _rim_motion_ratio(rims, frame_size) < 0.075:
        return predict_ball_from_recent_motion(beam, frame)
    observed = beam.observed()
    last = observed[-1]
    current_rim = _rim_center_at(rims, frame)
    last_rim = _rim_center_at(rims, last.frame)
    if current_rim is None or last_rim is None:
        return predict_ball_from_recent_motion(beam, frame)
    if len(observed) < 2:
        return (
            last.x + current_rim[0] - last_rim[0],
            last.y + current_rim[1] - last_rim[1],
            0.0,
            0.0,
        )
    previous = observed[-2]
    previous_rim = _rim_center_at(rims, previous.frame)
    if previous_rim is None:
        return predict_ball_from_recent_motion(beam, frame)
    dt = max(1, last.frame - previous.frame)
    last_relative = (last.x - last_rim[0], last.y - last_rim[1])
    previous_relative = (previous.x - previous_rim[0], previous.y - previous_rim[1])
    vx = (last_relative[0] - previous_relative[0]) / dt
    vy = (last_relative[1] - previous_relative[1]) / dt
    gap = frame - last.frame
    return (
        last_relative[0] + vx * gap + current_rim[0],
        last_relative[1] + vy * gap + current_rim[1],
        vx,
        vy,
    )


def track_ball_from_release_candidate(
    evidence: list[FrameDetections],
    seed_frame: int,
    seed: BallCandidate,
    fps: float,
    rims: list[BoundingBox | None],
    frame_size: tuple[int, int],
) -> list[BallTrackPoint]:
    first = BallTrackPoint(seed_frame, seed.x, seed.y, seed.confidence, True, seed.source)
    beams = [BallTrackCandidate([first], seed.confidence * 2.0)]
    maximum_frame = min(len(evidence), seed_frame + int(fps * 4.2))
    diagonal = math.hypot(*frame_size)
    for frame in range(seed_frame + 1, maximum_frame):
        if evidence[frame].scene_cut:
            break
        candidates = [] if evidence[frame].duplicate_frame else evidence[frame].balls
        expanded: list[BallTrackCandidate] = []
        for beam in beams:
            predicted_x, predicted_y, vx, vy = predict_ball_with_camera_motion(
                beam, frame, rims, frame_size
            )
            observed = beam.observed()
            last = observed[-1]
            gap = frame - last.frame
            maximum_distance = min(diagonal * 0.11, 54.0 + 32.0 * gap + math.hypot(vx, vy) * 0.45)
            target = rims[frame] if frame < len(rims) else None
            for candidate in candidates:
                candidate_distance = distance((predicted_x, predicted_y), (candidate.x, candidate.y))
                if candidate_distance > maximum_distance:
                    continue
                transition = candidate.confidence * 2.2 - candidate_distance / maximum_distance * 0.85
                if len(observed) >= 2:
                    previous_vx = vx
                    previous_vy = vy
                    dt = max(1, frame - last.frame)
                    last_rim = _rim_center_at(rims, last.frame)
                    candidate_rim = _rim_center_at(rims, frame)
                    if last_rim is not None and candidate_rim is not None:
                        next_vx = ((candidate.x - candidate_rim[0]) - (last.x - last_rim[0])) / dt
                        next_vy = ((candidate.y - candidate_rim[1]) - (last.y - last_rim[1])) / dt
                    else:
                        next_vx = (candidate.x - last.x) / dt
                        next_vy = (candidate.y - last.y) / dt
                    acceleration = math.hypot(next_vx - previous_vx, next_vy - previous_vy)
                    transition -= min(0.7, acceleration / 90.0)
                if frame - seed_frame <= int(fps * 0.55) and candidate.y > seed.y + 45:
                    transition -= 0.8
                if target is not None:
                    before = distance((last.x, last.y), target.center)
                    after = distance((candidate.x, candidate.y), target.center)
                    transition += clamp((before - after) / max(35.0, target.width * 2.5), -0.28, 0.35)
                expanded.append(
                    BallTrackCandidate(
                        beam.points + [BallTrackPoint(frame, candidate.x, candidate.y, candidate.confidence, True, candidate.source)],
                        beam.score + transition,
                        0,
                    )
                )
            recent_sharpness = [
                evidence[index].sharpness
                for index in range(max(0, frame - 2), frame + 1)
                if index < len(evidence)
            ]
            max_gap = 10 if recent_sharpness and min(recent_sharpness) < 0.22 else 7
            if beam.gap < max_gap:
                expanded.append(
                    BallTrackCandidate(
                        beam.points + [BallTrackPoint(frame, predicted_x, predicted_y, 0.04, False, "prediction")],
                        beam.score - 0.24 - beam.gap * 0.06,
                        beam.gap + 1,
                    )
                )
        if not expanded:
            break
        expanded.sort(key=lambda beam: beam.score, reverse=True)
        # Beam diversity prevents many near-identical branches from crowding
        # out a lower-confidence but physically coherent small-ball path.
        beams = []
        endpoints: list[tuple[float, float]] = []
        for beam in expanded:
            endpoint = beam.points[-1]
            if any(distance((endpoint.x, endpoint.y), other) < 11 for other in endpoints):
                continue
            beams.append(beam)
            endpoints.append((endpoint.x, endpoint.y))
            if len(beams) >= 18:
                break

    def quality(beam: BallTrackCandidate) -> float:
        observed = beam.observed()
        if len(observed) < 5:
            return -1e9
        ys = [point.y for point in observed]
        vertical_range = max(ys) - min(ys)
        observed_ratio = len(observed) / max(1, len(beam.points))
        target_bonus = 0.0
        for point in observed:
            rim = rims[point.frame] if point.frame < len(rims) else None
            if rim is not None:
                target_bonus = max(target_bonus, clamp(1.0 - distance((point.x, point.y), rim.center) / max(1.0, rim.width * 5), 0, 1))
        return beam.score + min(4.0, vertical_range / 50.0) + observed_ratio * 2.0 + target_bonus * 3.0

    if not beams:
        return []
    best = max(beams, key=quality)
    return best.points


def _release_frame(trace: list[BallTrackPoint], evidence: list[FrameDetections], fallback: int, fps: float) -> int | None:
    observed = [point for point in trace if point.observed]
    if len(observed) < 3:
        return None
    valid: list[int] = []
    set_launches: list[int] = []
    early = observed[: min(len(observed), 72)]

    # A ball can leave the shooter's hand long before it becomes separated
    # from every pose in a crowded broadcast frame.  Anchor the release to
    # the pose at the seed (when the ball is still near a wrist), then look
    # for the first sustained upward departure.  This is independent of the
    # video's absolute width/height and works for portrait crops where the
    # player occupies only a small fraction of the full frame.
    anchor_pose = find_pose_nearest_ball(evidence, fallback, early[0]) if early else None
    if anchor_pose is not None:
        trusted_anchor_wrists = [
            (x, y)
            for index in (9, 10)
            for x, y, confidence in [anchor_pose.keypoints[index]]
            if confidence >= 0.18
        ]
        if trusted_anchor_wrists:
            # The hand can carry the ball through a substantial gather phase;
            # require roughly one third of a body height of separation before
            # calling it airborne.  This avoids labeling a low set position
            # as the release while still recovering portrait clips where the
            # first truly separated frame is the only reliable cue.
            departure_limit = max(42.0, anchor_pose.box.height * 0.30)
            rise_limit = max(28.0, anchor_pose.box.height * 0.075)
            for index, point in enumerate(early[1:], start=1):
                if point.frame <= fallback:
                    continue
                wrist_distance = min(
                    distance((point.x, point.y), wrist) for wrist in trusted_anchor_wrists
                )
                future = early[index + 1 : index + 10]
                if wrist_distance <= departure_limit or len(future) < 5:
                    continue
                rise = point.y - min(future_point.y for future_point in future)
                upward_frames = sum(
                    future_point.y < point.y - max(8.0, anchor_pose.box.height * 0.018)
                    for future_point in future
                )
                if rise >= rise_limit and upward_frames >= max(4, len(future) // 2):
                    return max(fallback + 1, point.frame - 1)

    for index, point in enumerate(early):
        pose = find_pose_nearest_ball(evidence, point.frame, point)
        if pose is None:
            continue
        wrists = [(x, y) for index in (9, 10) for x, y, confidence in [pose.keypoints[index]] if confidence >= 0.18]
        if not wrists:
            continue
        close_limit = max(32.0, pose.box.height * 0.115)
        close = min(distance((point.x, point.y), wrist) for wrist in wrists) <= close_limit
        if not close:
            continue
        future = early[index + 1 : index + 21]
        if len(future) < 12:
            continue
        separated = 0
        for future_point in future:
            future_pose = find_pose_nearest_ball(evidence, future_point.frame, future_point)
            if future_pose is None:
                continue
            future_wrists = [
                (x, y)
                for wrist_index in (9, 10)
                for x, y, confidence in [future_pose.keypoints[wrist_index]]
                if confidence >= 0.18
            ]
            future_limit = max(32.0, future_pose.box.height * 0.115)
            if future_wrists and min(distance((future_point.x, future_point.y), wrist) for wrist in future_wrists) > future_limit:
                separated += 1
        rise = point.y - min(future_point.y for future_point in future)
        required_separation = max(8, math.ceil(len(future) * 0.68))
        if separated >= required_separation and rise >= max(30.0, pose.box.height * 0.095):
            valid.append(point.frame)
            prior = early[max(0, index - 3) : index + 1]
            if len(prior) >= 3:
                prior_motion = max(item.y for item in prior) - min(item.y for item in prior)
                if prior_motion <= max(22.0, pose.box.height * 0.065) and rise >= max(52.0, pose.box.height * 0.13):
                    set_launches.append(point.frame)
    if set_launches:
        return max(set_launches) + max(1, round(fps * 0.06))
    if valid:
        return max(valid) + max(1, round(fps * 0.04))
    # PlayerPose-free fallback: use a strong local launch only when it occurs after
    # the seed and persists. This keeps the app useful on partially occluded
    # footage while avoiding a held/dribbled ball at the seed itself.
    kinematic_launches: list[int] = []
    for index in range(3, max(3, len(early) - 7)):
        point = early[index]
        future = early[index + 1 : index + 8]
        prior = early[index - 3 : index + 1]
        prior_motion = max(item.y for item in prior) - min(item.y for item in prior)
        if (
            len(future) >= 5
            and prior_motion <= 30
            and point.y - min(item.y for item in future) >= 70
            and point.frame > fallback + 2
        ):
            kinematic_launches.append(point.frame)
    return max(kinematic_launches) + max(1, round(fps * 0.06)) if kinematic_launches else None


def _dense_trace(
    trace: list[BallTrackPoint],
    release: int,
    rims: list[BoundingBox | None] | None = None,
    frame_size: tuple[int, int] | None = None,
) -> list[BallTrackPoint]:
    observed = [point for point in trace if point.observed and point.frame >= release]
    if len(observed) < 2:
        return observed
    output: list[BallTrackPoint] = []
    for first, second in zip(observed, observed[1:]):
        if not output:
            output.append(first)
        gap = second.frame - first.frame
        if 1 < gap <= 8:
            for offset in range(1, gap):
                fraction = offset / gap
                output.append(
                    BallTrackPoint(
                        first.frame + offset,
                        first.x + (second.x - first.x) * fraction,
                        first.y + (second.y - first.y) * fraction,
                        min(first.confidence, second.confidence) * 0.62,
                        False,
                        "interpolation",
                    )
                )
        output.append(second)
    output.sort(key=lambda point: point.frame)
    camera_moving = bool(
        rims is not None
        and frame_size is not None
        and _rim_motion_ratio(rims, frame_size) >= 0.075
    )
    if camera_moving and rims is not None and all(
        _rim_center_at(rims, point.frame) is not None for point in output
    ):
        relative = [
            (
                point.x - _rim_center_at(rims, point.frame)[0],
                point.y - _rim_center_at(rims, point.frame)[1],
            )
            for point in output
        ]
        smoothed = smooth_xy(relative, 3)
        for point, (x, y) in zip(output, smoothed, strict=True):
            rim_center = _rim_center_at(rims, point.frame)
            point.x, point.y = x + rim_center[0], y + rim_center[1]
    else:
        smoothed = smooth_xy([(point.x, point.y) for point in output], 3)
        for point, (x, y) in zip(output, smoothed, strict=True):
            point.x, point.y = x, y
    return output


def _form_metrics(
    pose: PlayerPose | None,
    ball: BallTrackPoint,
    *,
    allow_separated_ball: bool = False,
    preferred_hand: str | None = None,
) -> dict[str, float | None]:
    empty = {"elbow": None, "knee": None, "shoulder": None, "hip": None}
    if pose is None:
        return empty
    left_side = (5, 7, 9, 11, 13, 15)
    right_side = (6, 8, 10, 12, 14, 16)
    sides = (
        (left_side, right_side)
        if preferred_hand == "left"
        else (right_side, left_side)
        if preferred_hand == "right"
        else (left_side, right_side)
    )
    candidates: list[tuple[float, dict[str, float | None]]] = []
    for shoulder, elbow, wrist, hip, knee, ankle in sides:
        required = [shoulder, elbow, wrist, hip, knee, ankle]
        if any(pose.keypoints[index][2] < 0.16 for index in required):
            continue
        if not allow_separated_ball and distance((ball.x, ball.y), pose.keypoints[wrist][:2]) > pose.box.height * 0.42:
            continue
        point = lambda index: pose.keypoints[index][:2]
        elbow_angle = joint_angle(point(shoulder), point(elbow), point(wrist))
        if elbow_angle is None:
            continue
        metrics = {
            "elbow": elbow_angle,
            "knee": joint_angle(point(hip), point(knee), point(ankle)),
            "shoulder": joint_angle(point(elbow), point(shoulder), point(hip)),
            "hip": joint_angle(point(shoulder), point(hip), point(knee)),
        }
        # The guide arm can be closest to the ball in a front/three-quarter
        # view. The shooting arm is the extending arm, so prefer the larger
        # trusted elbow angle instead of blindly choosing nearest wrist.
        candidates.append((elbow_angle, metrics))
    if not candidates:
        return empty
    if preferred_hand is not None:
        # ``sides`` puts the inferred shooting side first. Use it whenever the
        # keypoints are usable; the larger-elbow fallback is only for unknown
        # handedness where the guide arm may otherwise win by proximity.
        return candidates[0][1]
    return max(candidates, key=lambda item: item[0])[1]


def infer_shooting_hand(
    evidence: list[FrameDetections],
    dense: list[BallTrackPoint],
    release: int,
    anchor_pose: PlayerPose | None,
) -> tuple[str, float]:
    """Infer the hand that stays closest to the ball through release.

    COCO pose labels wrists as 9 (left) and 10 (right). The result is only a
    sequence-level association cue; when both wrists are occluded or equally
    plausible, return ``unknown`` instead of forcing a handedness guess.
    """
    if anchor_pose is None:
        return "unknown", 0.0
    distances: dict[str, list[float]] = {"left": [], "right": []}
    scale = max(1.0, anchor_pose.box.height)
    for point in dense:
        if not release - 6 <= point.frame <= release + 4:
            continue
        pose = _pose_near_anchor(evidence, point.frame, anchor_pose)
        if pose is None:
            continue
        for hand, keypoint_index in (("left", 9), ("right", 10)):
            x, y, confidence = pose.keypoints[keypoint_index]
            if confidence >= 0.18:
                distances[hand].append(distance((point.x, point.y), (x, y)) / scale)
    medians = {
        hand: float(np.median(values))
        for hand, values in distances.items()
        if len(values) >= 2
    }
    if len(medians) < 2:
        return "unknown", 0.0
    best, second = sorted(medians.items(), key=lambda item: item[1])[:2]
    margin = second[1] - best[1]
    # A margin below 2% of body height is effectively a tie in a single view.
    if margin < 0.02:
        return "unknown", round(clamp(0.50 + margin * 2.0, 0.0, 0.95), 3)
    return best[0], round(clamp(0.50 + margin * 1.8, 0.0, 0.95), 3)


def _form_metrics_window(
    evidence: list[FrameDetections],
    dense: list[BallTrackPoint],
    release: int,
    anchor_pose: PlayerPose | None = None,
    shooting_hand: str | None = None,
) -> dict[str, float | None]:
    samples: dict[str, list[float]] = {"elbow": [], "knee": [], "shoulder": [], "hip": []}
    for point in dense:
        if not release - 2 <= point.frame <= release + 8:
            continue
        pose = (
            _pose_near_anchor(evidence, point.frame, anchor_pose)
            if anchor_pose is not None
            else find_pose_nearest_ball(evidence, point.frame, point)
        )
        metrics = _form_metrics(
            pose,
            point,
            allow_separated_ball=anchor_pose is not None,
            preferred_hand=shooting_hand,
        )
        for key, measurement in metrics.items():
            if measurement is not None:
                samples[key].append(measurement)
    output = {key: round(robust_median(values), 1) if values else None for key, values in samples.items()}
    if samples["elbow"]:
        # Wrist keypoints are commonly occluded by the ball on the exact
        # separation frame. The upper quartile across the 0.3 s release
        # window captures the shooting arm's extension without one-frame
        # guide-hand swaps dominating the reported angle.
        output["elbow"] = round(float(np.percentile(samples["elbow"], 75)), 1)
    return output


def measure_temporal_mechanics(
    evidence: list[FrameDetections],
    dense: list[BallTrackPoint],
    release: int,
    anchor_pose: PlayerPose | None,
    shooting_hand: str,
    fps: float,
    timing_preserved: bool,
) -> dict[str, float | int | None | dict[str, float | int | None]]:
    """Measure mechanics as changes through the release window.

    These are descriptive timing and motion measurements, not outcome causes.
    Every joint is accumulated independently so an occluded ankle does not
    erase a visible elbow signal.
    """
    samples: dict[str, list[tuple[int, float]]] = {key: [] for key in ("elbow", "knee", "shoulder", "hip")}
    alignment: list[float] = []
    if anchor_pose is None:
        return {
            "release_frame_uncertainty": None,
            "elbow_extension_timing_ms": None,
            "follow_through_duration_ms": None,
            "body_alignment_offset": None,
            "joint_motion_range_deg": {key: None for key in samples},
        }
    for point in dense:
        if not release <= point.frame <= release + max(12, round(fps * 0.85)):
            continue
        pose = _pose_near_anchor(evidence, point.frame, anchor_pose)
        if pose is None:
            continue
        metrics = _form_metrics(
            pose,
            point,
            allow_separated_ball=True,
            preferred_hand=shooting_hand if shooting_hand != "unknown" else None,
        )
        for key, value in metrics.items():
            if value is not None:
                samples[key].append((point.frame, float(value)))
        shoulders = [pose.keypoints[index] for index in (5, 6) if pose.keypoints[index][2] >= 0.18]
        hips = [pose.keypoints[index] for index in (11, 12) if pose.keypoints[index][2] >= 0.18]
        if shoulders and hips:
            shoulder_x = float(np.mean([value[0] for value in shoulders]))
            hip_x = float(np.mean([value[0] for value in hips]))
            alignment.append(abs(shoulder_x - hip_x) / max(1.0, pose.box.height))

    ranges = {
        key: round(max(value for _, value in values) - min(value for _, value in values), 1)
        if len(values) >= 2
        else None
        for key, values in samples.items()
    }
    elbow = samples["elbow"]
    extension_index = next(
        (
            index
            for index, (_, value) in enumerate(elbow)
            if value >= 150.0
            and all(next_value >= 145.0 for _, next_value in elbow[index : index + 2])
        ),
        None,
    )
    extension_frame = elbow[extension_index][0] if extension_index is not None else None
    follow_duration: float | None = None
    extension_timing: float | None = None
    if extension_frame is not None:
        extension_timing = round((extension_frame - release) / max(1.0, fps) * 1000.0, 1)
        last_extended = extension_frame
        for frame, value in elbow[extension_index:]:
            if value < 145.0:
                break
            last_extended = frame
        if timing_preserved:
            follow_duration = round((last_extended - extension_frame) / max(1.0, fps) * 1000.0, 1)
    return {
        "release_frame_uncertainty": 1 if len(elbow) >= 3 else 3,
        "elbow_extension_timing_ms": extension_timing,
        "follow_through_duration_ms": follow_duration,
        "body_alignment_offset": round(float(np.median(alignment)), 3) if alignment else None,
        "joint_motion_range_deg": ranges,
    }


def _angle_quality(
    value: float,
    *,
    ideal_min: float,
    ideal_max: float,
    poor_min: float,
    poor_max: float,
) -> float:
    """Turn a release angle into a soft mechanics-quality signal.

    This is deliberately a gentle heuristic, not a claim that one camera can
    grade a player's whole form. It is a coaching signal and never changes
    confidence in the observed outcome.
    """
    if ideal_min <= value <= ideal_max:
        return 1.0
    if value < ideal_min:
        return clamp(0.45 + 0.55 * (value - poor_min) / max(1.0, ideal_min - poor_min), 0.25, 1.0)
    return clamp(0.45 + 0.55 * (poor_max - value) / max(1.0, poor_max - ideal_max), 0.25, 1.0)


def _soft_range_quality(
    value: float,
    *,
    good_min: float,
    good_max: float,
    poor_min: float,
    poor_max: float,
) -> float:
    """Score a measured release value without treating one target as universal."""
    if good_min <= value <= good_max:
        return 1.0
    if value < good_min:
        return clamp(0.22 + 0.78 * (value - poor_min) / max(1.0, good_min - poor_min), 0.12, 1.0)
    return clamp(0.22 + 0.78 * (poor_max - value) / max(1.0, poor_max - good_max), 0.12, 1.0)


def estimate_mechanics_quality(form: dict[str, float | None]) -> float | None:
    """Estimate how repeatable the visible release shape looks from the pose."""
    rules = {
        "elbow": (155.0, 180.0, 110.0, 205.0, 0.45),
        "knee": (135.0, 175.0, 95.0, 205.0, 0.20),
        "shoulder": (85.0, 150.0, 45.0, 195.0, 0.15),
        "hip": (140.0, 180.0, 105.0, 205.0, 0.20),
    }
    weighted_score = 0.0
    weight_total = 0.0
    for metric, (ideal_min, ideal_max, poor_min, poor_max, weight) in rules.items():
        value = form.get(metric)
        if value is None:
            continue
        weighted_score += _angle_quality(
            float(value),
            ideal_min=ideal_min,
            ideal_max=ideal_max,
            poor_min=poor_min,
            poor_max=poor_max,
        ) * weight
        weight_total += weight
    if not weight_total:
        return None
    return round(weighted_score / weight_total, 3)


def estimate_follow_through_quality(form: dict[str, float | None]) -> float | None:
    """Use the visible elbow finish and shoulder line as a follow-through proxy."""
    elbow = form.get("elbow")
    shoulder = form.get("shoulder")
    scores: list[tuple[float, float]] = []
    if elbow is not None:
        scores.append(
            (
                _angle_quality(
                    float(elbow), ideal_min=155.0, ideal_max=180.0, poor_min=85.0, poor_max=205.0
                ),
                0.7,
            )
        )
    if shoulder is not None:
        scores.append(
            (
                _angle_quality(
                    float(shoulder), ideal_min=85.0, ideal_max=150.0, poor_min=40.0, poor_max=195.0
                ),
                0.3,
            )
        )
    if not scores:
        return None
    total_weight = sum(weight for _, weight in scores)
    return round(sum(score * weight for score, weight in scores) / total_weight, 3)


def estimate_trajectory_quality(
    release_speed_ms: float | None,
    release_height_m: float | None,
    entry_angle_deg: float | None,
    arc_peak_m: float | None,
) -> float | None:
    """Score the release profile using broad single-camera ranges."""
    measured: list[tuple[float, float]] = []
    rules = (
        (release_speed_ms, 4.5, 9.5, 1.8, 15.0, 0.28),
        (release_height_m, 1.55, 2.95, 1.2, 3.35, 0.20),
        (entry_angle_deg, 38.0, 67.0, 25.0, 82.0, 0.24),
        (arc_peak_m, 2.85, 5.0, 2.5, 6.5, 0.28),
    )
    for value, good_min, good_max, poor_min, poor_max, weight in rules:
        if value is not None:
            measured.append(
                (
                    _soft_range_quality(
                        float(value),
                        good_min=good_min,
                        good_max=good_max,
                        poor_min=poor_min,
                        poor_max=poor_max,
                    ),
                    weight,
                )
            )
    if not measured:
        return None
    total_weight = sum(weight for _, weight in measured)
    return round(sum(score * weight for score, weight in measured) / total_weight, 3)


def combine_shot_quality(
    mechanics_quality: float | None,
    follow_through_quality: float | None,
    trajectory_quality: float | None,
) -> float | None:
    """Combine the available form and release evidence into a soft shot score."""
    components: list[tuple[float, float]] = []
    if mechanics_quality is not None:
        components.append((mechanics_quality, 0.48))
    if follow_through_quality is not None:
        components.append((follow_through_quality, 0.20))
    if trajectory_quality is not None:
        components.append((trajectory_quality, 0.32))
    if not components:
        # Missing evidence is unavailable, not an average-quality shot.
        return None
    total_weight = sum(weight for _, weight in components)
    return round(sum(score * weight for score, weight in components) / total_weight, 3)


def estimate_shot_quality(
    form: dict[str, float | None],
    release_speed_ms: float | None,
    release_height_m: float | None,
    entry_angle_deg: float | None,
    arc_peak_m: float | None,
) -> float | None:
    """Return a bounded visible mechanics-and-trajectory coaching signal."""
    return combine_shot_quality(
        estimate_mechanics_quality(form),
        estimate_follow_through_quality(form),
        estimate_trajectory_quality(release_speed_ms, release_height_m, entry_angle_deg, arc_peak_m),
    )


def adjust_shot_confidence(
    base_confidence: float,
    outcome: str,
    mechanics_quality: float | None,
    *,
    outcome_supported: bool = False,
    trajectory_quality: float | None = None,
    follow_through_quality: float | None = None,
    miss_proximity: float | None = None,
) -> float:
    """Return confidence in the observed outcome and tracked attempt.

    The quality arguments remain accepted for compatibility with saved-session
    readers, but are intentionally ignored. Form and trajectory quality are
    coaching signals; using them to lower outcome confidence makes an obvious
    miss look uncertain merely because the release looked awkward.
    """
    starting_confidence = float(base_confidence)
    confidence = starting_confidence
    if outcome == "miss":
        if miss_proximity is None:
            confidence = min(confidence * 0.88, 0.73)
        elif (
            miss_proximity >= 0.68
        ):
            # A close miss with a clean release is still a strong, useful call.
            confidence = min(0.93, max(confidence, starting_confidence * 0.96))
        elif miss_proximity <= 0.25:
            # A tracked ball that clearly misses wide is an equally strong
            # observation. Distance from the hoop describes the outcome, not
            # the quality of the release, so it must not turn into REVIEW.
            confidence = min(0.93, max(confidence, starting_confidence * 0.96))
        else:
            confidence = min(0.86, max(confidence, starting_confidence * 0.90))
    if outcome == "make" and outcome_supported:
        confidence = max(confidence, 0.84)
    return round(clamp(confidence, 0.18, 0.97), 3)


def _stabilized(point: BallTrackPoint, rim: BoundingBox) -> tuple[float, float]:
    scale = 0.4572 / max(1.0, rim.width)
    return ((point.x - rim.center[0]) * scale, (point.y - rim.center[1]) * scale)


def evaluate_net_occlusion(
    dense: list[BallTrackPoint], crossing: BallTrackPoint, rim: BoundingBox, fps: float
) -> dict[str, float | int | bool | None]:
    """Measure whether a ball reappears below the cylinder with net drag.

    A single camera cannot recover depth, so this is evidence rather than an
    unconditional make rule. The ratio compares observed downward displacement
    after the rim plane with the freefall displacement predicted from the
    pre-crossing descent and the 18-inch rim scale.
    """
    observed = [point for point in dense if point.observed]
    before = [point for point in observed if crossing.frame - 8 <= point.frame <= crossing.frame]
    after = [
        point
        for point in observed
        if crossing.frame < point.frame <= crossing.frame + max(8, round(fps * 0.65))
        and rim.x1 - rim.width * 0.40 <= point.x <= rim.x2 + rim.width * 0.40
        and rim.y1 <= point.y <= rim.y2 + rim.width * 3.1
    ]
    pre_speeds = [
        (second.y - first.y) / max(1, second.frame - first.frame)
        for first, second in zip(before, before[1:])
        if second.frame > first.frame and second.y > first.y
    ]
    reappearance = min(after, key=lambda point: point.frame) if after else None
    ratio: float | None = None
    if reappearance is not None and pre_speeds:
        frames = reappearance.frame - crossing.frame
        initial_speed = float(np.median(pre_speeds))
        pixels_per_meter = rim.width / 0.4572
        gravity_per_frame = 9.81 * pixels_per_meter / max(1.0, fps * fps)
        expected = initial_speed * frames + 0.5 * gravity_per_frame * frames * frames
        observed_drop = reappearance.y - crossing.y
        if expected > 1.0:
            ratio = round(clamp(observed_drop / expected, 0.0, 2.5), 3)
    confirmed = bool(reappearance is not None and ratio is not None and 0.08 <= ratio <= 1.05)
    return {
        "reappeared_below_rim": reappearance is not None,
        "reappearance_frame": reappearance.frame if reappearance else None,
        "net_slowdown_ratio": ratio,
        "net_drag_confirmed": confirmed,
    }


def _measure_shot(
    shot_id: int,
    trace: list[BallTrackPoint],
    release: int,
    meta: VideoMetadata,
    evidence: list[FrameDetections],
    rims: list[BoundingBox | None],
) -> ShotAnalysis | None:
    dense = _dense_trace(trace, release, rims, (meta.width, meta.height))
    observed = [point for point in dense if point.observed]
    if len(observed) < 6:
        return None
    ys = [point.y for point in observed]
    release_point = min(dense, key=lambda point: abs(point.frame - release))
    # Identify the shooter while the ball is still near the hand.  At the
    # actual release frame the ball may already be several body-widths away,
    # so choosing a pose solely by ball proximity can select a nearby player
    # instead of the shooter (especially in broadcast and portrait footage).
    anchor_pose = None
    for point in trace:
        if not point.observed or point.frame > release_point.frame:
            continue
        anchor_pose = find_pose_nearest_ball(evidence, point.frame, point)
        if anchor_pose is not None:
            break
    shooting_hand, handedness_confidence = infer_shooting_hand(
        evidence, dense, release_point.frame, anchor_pose
    )
    form = _form_metrics_window(
        evidence,
        dense,
        release_point.frame,
        anchor_pose,
        shooting_hand if shooting_hand != "unknown" else None,
    )
    temporal_mechanics = measure_temporal_mechanics(
        evidence,
        dense,
        release_point.frame,
        anchor_pose,
        shooting_hand,
        meta.fps,
        meta.timing_preserved and not meta.slow_motion_unknown,
    )
    apex_index = int(np.argmin([point.y for point in dense]))
    if apex_index < 2 or apex_index >= len(dense) - 3:
        return None
    rise = release_point.y - dense[apex_index].y
    descent = max(point.y for point in dense[apex_index:]) - dense[apex_index].y
    available_rims = [
        rims[point.frame]
        for point in dense
        if point.frame < len(rims) and rims[point.frame] is not None
    ]
    release_pose = (
        _pose_near_anchor(evidence, release_point.frame, anchor_pose)
        if anchor_pose is not None
        else find_pose_nearest_ball(evidence, release_point.frame, release_point)
    )
    observed_ratio = len(observed) / max(1, len(dense))
    pose_confidence = release_pose.confidence if release_pose else 0.0
    # A valid release and a tracked flight are still an attempt when the rim
    # is outside the frame. Preserve it as REVIEW so users can correct the
    # outcome locally instead of silently losing the attempt.
    if not available_rims:
        flags = ["rim was not confidently visible; outcome and physical metrics require review"]
        observation_confidence = clamp(
            observed_ratio * 0.72 + pose_confidence * 0.18 + 0.10,
            0.18,
            0.72,
        )
        return ShotAnalysis(
            id=shot_id,
            outcome="review",
            confidence=round(observation_confidence, 3),
            observation_confidence=round(observation_confidence, 3),
            release_frame=release_point.frame,
            release_time=round(release_point.frame / meta.fps, 3),
            end_frame=dense[-1].frame,
            release_speed_ms=None,
            release_height_m=None,
            entry_angle_deg=None,
            arc_peak_m=None,
            form=form,
            flags=flags,
            evidence={
                "observed_ball_frames": len([point for point in dense if point.observed]),
                "tracked_frames": len(dense),
                "rim_track_confidence": 0.0,
                "pose_confidence": round(pose_confidence, 3),
                "shooter_box": anchor_pose.box.to_list() if anchor_pose is not None else None,
                "shooting_hand": shooting_hand,
                "handedness_confidence": handedness_confidence,
                "temporal_mechanics": temporal_mechanics,
                "crossing_frame": None,
                "outcome_basis": "release and flight tracked, but no rim was confidently visible",
                "metric_availability": {"release_speed_ms": False, "release_height_m": False, "entry_angle_deg": False, "arc_peak_m": False},
                "metric_uncertainty": {"release_speed_ms": None, "release_height_m": None, "entry_angle_deg": None, "arc_peak_m": None},
                "measurement_space": "unavailable",
                "calibration_status": "insufficient_single_camera_geometry",
                "mechanics_quality": estimate_mechanics_quality(form) if release_pose is not None else None,
                "follow_through_quality": estimate_follow_through_quality(form) if release_pose is not None else None,
                "trajectory_quality": None,
                "shot_quality": combine_shot_quality(
                    estimate_mechanics_quality(form) if release_pose is not None else None,
                    estimate_follow_through_quality(form) if release_pose is not None else None,
                    None,
                ),
                "prediction_status": PREDICTION_STATUS,
            },
            trace=dense,
        )
    rim_scale = robust_median([rim.width for rim in available_rims]) or max(24.0, min(meta.width, meta.height) * 0.06)
    # Use the rim diameter as the scale reference.  Full-frame percentages
    # reject valid portrait/letterboxed clips where the court occupies only
    # part of a tall canvas.
    if max(ys) - min(ys) < rim_scale * 1.25:
        return None
    if rise < rim_scale * 0.90 or descent < rim_scale * 0.55:
        return None
    applicable_rims = available_rims
    if not applicable_rims:
        return None

    crossing: tuple[BallTrackPoint, BoundingBox] | None = None
    crossing_x: float | None = None
    descending_rim_approach = False
    nearest_rim_distance = float("inf")
    nearest_rim_frame: int | None = None
    for previous, current in zip(dense, dense[1:]):
        rim = rims[current.frame] if current.frame < len(rims) else None
        if rim is None:
            continue
        current_distance = distance((current.x, current.y), rim.center)
        if current_distance < nearest_rim_distance:
            nearest_rim_distance = current_distance
            nearest_rim_frame = current.frame
        if current.y <= previous.y:
            continue
        rim_top = rim.y1 + rim.height * 0.22
        if previous.y < rim_top <= current.y:
            fraction = (rim_top - previous.y) / max(1e-6, current.y - previous.y)
            crossing_x = previous.x + (current.x - previous.x) * fraction
            if rim.x1 - rim.width * 0.08 <= crossing_x <= rim.x2 + rim.width * 0.08:
                crossing = (current, rim)
                break
            # Keep a near-rim trajectory alive long enough to label an
            # obvious miss. Portrait clips often have a very small physical
            # rim box, so a 2.2× margin can discard a ball that is visibly
            # headed toward the basket but passes just outside it.
            if rim.x1 - rim.width * 3.6 <= crossing_x <= rim.x2 + rim.width * 3.6:
                descending_rim_approach = True

    median_rim_width = robust_median([rim.width for rim in applicable_rims]) or 1.0
    if nearest_rim_distance > median_rim_width * 2.45:
        return None
    if crossing is None and not descending_rim_approach:
        return None
    if nearest_rim_frame is not None:
        interaction_time = (nearest_rim_frame - release_point.frame) / meta.fps
        if not 0.25 <= interaction_time <= 2.2:
            return None

    flags: list[str] = []
    net_evidence: dict[str, float | int | bool | None] = {
        "reappeared_below_rim": False,
        "reappearance_frame": None,
        "net_slowdown_ratio": None,
        "net_drag_confirmed": False,
    }
    outcome = "miss"
    outcome_basis = "visible trajectory missed the rim cylinder"
    crossing_offset = None
    geometric_miss = False
    if crossing is not None:
        crossing_point, crossing_rim = crossing
        net_evidence = evaluate_net_occlusion(dense, crossing_point, crossing_rim, meta.fps)
        crossing_offset = (
            abs(crossing_x - crossing_rim.center[0]) / max(1.0, crossing_rim.width)
            if crossing_x is not None
            else None
        )
        centered = bool(
            crossing_x is not None
            and crossing_rim.x1 + crossing_rim.width * 0.08
            <= crossing_x
            <= crossing_rim.x2 - crossing_rim.width * 0.08
        )
        slowdown_ratio = net_evidence["net_slowdown_ratio"]
        post_rim_supported = bool(
            net_evidence["net_drag_confirmed"]
            or (
                net_evidence["reappeared_below_rim"]
                and (slowdown_ratio is None or float(slowdown_ratio) <= 1.15)
            )
        )
        if centered and post_rim_supported:
            outcome = "make"
            outcome_basis = (
                "rim-plane crossing with net-drag evidence"
                if net_evidence["net_drag_confirmed"]
                else "centered rim-plane crossing with ball reappearance below the net"
            )
        elif (
            net_evidence["net_drag_confirmed"]
            and net_evidence["reappeared_below_rim"]
            and crossing_offset is not None
            and crossing_offset <= 0.72
        ):
            # A learned hoop box can include the backboard and a color rim
            # proposal can be a few pixels narrow during a pan. If the ball
            # crosses the rim plane, slows to net-like speed, and reappears
            # below the cylinder, resolve the old review state as a make even
            # when the crossing lands just outside the strict inner bracket.
            outcome = "make"
            outcome_basis = "rim-plane crossing with net-drag evidence and camera-tolerant geometry"
            flags.append("rim geometry was camera-tolerant at the crossing")
        else:
            outcome = "review"
            outcome_basis = "2D rim-plane crossing without enough post-rim depth evidence"
            flags.append("rim crossing needs review because net reappearance was not conclusive")
    elif descending_rim_approach:
        # A trajectory can pass the rim plane just outside the cylinder without
        # ever producing a literal crossing. Keep genuinely close front-rim
        # interactions in review, but resolve a clearly outside path as a miss
        # instead of leaving an otherwise obvious attempt unresolved.
        if nearest_rim_distance < median_rim_width * 0.48:
            outcome = "review"
            outcome_basis = "visible rim interaction is ambiguous in 2D"
            flags.append("rim interaction is ambiguous in 2D")
        else:
            outcome = "miss"
            outcome_basis = "descending trajectory passed outside the rim cylinder"
            geometric_miss = True
            flags.append("ball descended outside the rim centerline")

    miss_proximity = None
    if crossing_offset is not None:
        miss_proximity = clamp(1.0 - crossing_offset / 2.45, 0.0, 1.0)
    elif median_rim_width > 0:
        miss_proximity = clamp(
            1.0 - nearest_rim_distance / max(1.0, median_rim_width * 2.45), 0.0, 1.0
        )

    release_rim = rims[release_point.frame] if release_point.frame < len(rims) else None
    release_speed: float | None = None
    release_height: float | None = None
    if release_rim is not None:
        later = next((point for point in dense if point.frame >= release_point.frame + 3), None)
        if later is not None and rims[later.frame] is not None:
            a = _stabilized(release_point, release_rim)
            b = _stabilized(later, rims[later.frame])
            dt = (later.frame - release_point.frame) / meta.fps
            release_speed = round(distance(a, b) / max(dt, 1e-3), 2)
        if crossing is not None:
            crossing_point, crossing_rim = crossing
            flight_time = (crossing_point.frame - release_point.frame) / meta.fps
            if 0.3 <= flight_time <= 2.4:
                start_x, start_y = _stabilized(release_point, release_rim)
                end_x, end_y = _stabilized(crossing_point, crossing_rim)
                velocity_x = (end_x - start_x) / flight_time
                velocity_y = (end_y - start_y - 0.5 * 9.81 * flight_time * flight_time) / flight_time
                release_speed = round(math.hypot(velocity_x, velocity_y), 2)
        release_height = round(3.048 + (release_rim.center[1] - release_point.y) / max(1.0, release_rim.width) * 0.4572, 2)
        if release_speed is not None and not 2.0 <= release_speed <= 18.0:
            release_speed = None
            flags.append("release speed was outside the trustworthy single-camera range")
        if release_height is not None and not 1.2 <= release_height <= 3.3:
            release_height = None
            flags.append("release height was outside the trustworthy single-camera range")

    if outcome == "miss" and release_height is None and not geometric_miss:
        outcome = "review"
        outcome_basis = "trajectory approached the rim but release calibration was not trustworthy"
        flags.append("miss was not counted because release calibration was incomplete")

    if not meta.timing_preserved or meta.slow_motion_unknown:
        release_speed = None
        flags.append("release speed unavailable because source timing or slow-motion timing is unknown")

    stabilized = [
        (_stabilized(point, rims[point.frame]), point)
        for point in dense
        if point.frame < len(rims) and rims[point.frame] is not None
    ]
    entry_angle: float | None = None
    if crossing is not None:
        crossing_frame = crossing[0].frame
        descending = [(coords, point) for coords, point in stabilized if crossing_frame - 6 <= point.frame <= crossing_frame]
        if len(descending) >= 2:
            entry_angle = round(line_angle_degrees(descending[0][0], descending[-1][0]), 1)
    floor_heights = [3.048 - coords[1] for coords, _ in stabilized]
    arc_peak = round(max(floor_heights), 2) if floor_heights else None
    if arc_peak is not None and not 2.5 <= arc_peak <= 6.5:
        arc_peak = None

    trajectory_quality = estimate_trajectory_quality(
        release_speed,
        release_height,
        entry_angle,
        arc_peak,
    )

    rim_confidence = float(np.median([rim.confidence for rim in applicable_rims]))
    confidence = clamp(
        observed_ratio * 0.44
        + rim_confidence * 0.28
        + pose_confidence * 0.18
        + (0.08 if crossing else 0.05),
        0.18,
        0.97,
    )
    if outcome == "review":
        confidence = min(confidence, 0.61)
    if observed_ratio < 0.55:
        flags.append("ball was interpolated through several frames")
    rim_centers = np.asarray([rim.center for rim in applicable_rims], dtype=float)
    if len(rim_centers) > 2 and np.ptp(rim_centers[:, 0]) > meta.width * 0.035:
        flags.append("moving camera; metrics are rim-stabilized estimates")
        confidence *= 0.9
    if release_pose is None:
        flags.append("release pose not confidently visible")
    mechanics_quality = (
        estimate_mechanics_quality(form)
        if release_pose is not None and pose_confidence >= 0.60
        else None
    )
    follow_through_quality = (
        estimate_follow_through_quality(form)
        if release_pose is not None and pose_confidence >= 0.60
        else None
    )
    shot_quality = combine_shot_quality(
        mechanics_quality,
        follow_through_quality,
        trajectory_quality,
    )
    if mechanics_quality is not None and mechanics_quality < 0.88:
        flags.append("release mechanics look inconsistent; treat the form estimate as a cue")
    if trajectory_quality is not None and trajectory_quality < 0.42:
        flags.append("release profile was far outside the broad single-camera range")
    outcome_supported = bool(
        outcome == "make"
        and crossing is not None
        and (net_evidence["net_drag_confirmed"] or net_evidence["reappeared_below_rim"])
    )
    confidence = adjust_shot_confidence(
        confidence,
        outcome,
        mechanics_quality,
        outcome_supported=outcome_supported,
        trajectory_quality=trajectory_quality,
        follow_through_quality=follow_through_quality,
        miss_proximity=miss_proximity,
    )
    observation_confidence = confidence
    metric_reliability = clamp(
        observed_ratio * 0.42 + rim_confidence * 0.36 + pose_confidence * 0.22,
        0.05,
        0.97,
    )
    metric_values = {
        "release_speed_ms": release_speed,
        "release_height_m": release_height,
        "entry_angle_deg": entry_angle,
        "arc_peak_m": arc_peak,
    }
    metric_availability = {key: value is not None for key, value in metric_values.items()}
    metric_uncertainty = {
        key: round(1.0 - metric_reliability, 3) if value is not None else None
        for key, value in metric_values.items()
    }

    return ShotAnalysis(
        id=shot_id,
        outcome=outcome,
        confidence=round(confidence, 3),
        observation_confidence=round(observation_confidence, 3),
        release_frame=release_point.frame,
        release_time=round(release_point.frame / meta.fps, 3),
        end_frame=dense[-1].frame,
        release_speed_ms=release_speed,
        release_height_m=release_height,
        entry_angle_deg=entry_angle,
        arc_peak_m=arc_peak,
        form=form,
        flags=flags,
        evidence={
            "observed_ball_frames": len(observed),
            "tracked_frames": len(dense),
            "rim_track_confidence": round(rim_confidence, 3),
            "pose_confidence": round(pose_confidence, 3),
            "shooter_box": anchor_pose.box.to_list() if anchor_pose is not None else None,
            "shooting_hand": shooting_hand,
            "handedness_confidence": handedness_confidence,
            "temporal_mechanics": temporal_mechanics,
            "crossing_frame": crossing[0].frame if crossing else None,
            "crossing_offset_rim": round(crossing_offset, 3) if crossing_offset is not None else None,
            "rim_centered": bool(crossing_offset is not None and crossing_offset <= 0.08),
            "mechanics_quality": mechanics_quality,
            "follow_through_quality": follow_through_quality,
            "trajectory_quality": trajectory_quality,
            "shot_quality": shot_quality,
            "metric_availability": metric_availability,
            "metric_uncertainty": metric_uncertainty,
            "measurement_space": "rim_relative_2d",
            "calibration_status": "single_camera_rim_scale_estimate",
            "prediction_status": PREDICTION_STATUS,
            "miss_proximity": round(miss_proximity, 3) if miss_proximity is not None else None,
            "outcome_basis": outcome_basis,
            **net_evidence,
        },
        trace=dense,
    )


def _minimal_review_shot(
    shot_id: int,
    trace: list[BallTrackPoint],
    release: int,
    meta: VideoMetadata,
    evidence: list[FrameDetections],
) -> ShotAnalysis | None:
    """Keep a plausible but incomplete attempt visible for local review."""
    observed = [point for point in trace if point.observed and point.frame >= release]
    if len(observed) < 3:
        return None
    release_point = min(observed, key=lambda point: abs(point.frame - release))
    anchor_pose = find_pose_nearest_ball(evidence, release_point.frame, release_point)
    shooting_hand, handedness_confidence = infer_shooting_hand(
        evidence, observed, release_point.frame, anchor_pose
    )
    form = _form_metrics_window(
        evidence,
        observed,
        release_point.frame,
        anchor_pose,
        shooting_hand if shooting_hand != "unknown" else None,
    )
    temporal_mechanics = measure_temporal_mechanics(
        evidence,
        observed,
        release_point.frame,
        anchor_pose,
        shooting_hand,
        meta.fps,
        meta.timing_preserved and not meta.slow_motion_unknown,
    )
    pose_confidence = anchor_pose.confidence if anchor_pose is not None else 0.0
    observation_confidence = clamp(
        len(observed) / max(1, len(trace)) * 0.60 + pose_confidence * 0.20 + 0.08,
        0.18,
        0.58,
    )
    return ShotAnalysis(
        id=shot_id,
        outcome="review",
        confidence=round(observation_confidence, 3),
        observation_confidence=round(observation_confidence, 3),
        release_frame=release_point.frame,
        release_time=round(release_point.frame / meta.fps, 3),
        end_frame=observed[-1].frame,
        release_speed_ms=None,
        release_height_m=None,
        entry_angle_deg=None,
        arc_peak_m=None,
        form=form,
        flags=["trajectory is incomplete; confirm the attempt and outcome"],
        evidence={
            "observed_ball_frames": len(observed),
            "tracked_frames": len(trace),
            "rim_track_confidence": 0.0,
            "pose_confidence": round(pose_confidence, 3),
            "shooter_box": anchor_pose.box.to_list() if anchor_pose is not None else None,
            "shooting_hand": shooting_hand,
            "handedness_confidence": handedness_confidence,
            "temporal_mechanics": temporal_mechanics,
            "crossing_frame": None,
            "outcome_basis": "release-like motion found, but the complete rim interaction was not observed",
            "metric_availability": {"release_speed_ms": False, "release_height_m": False, "entry_angle_deg": False, "arc_peak_m": False},
            "metric_uncertainty": {"release_speed_ms": None, "release_height_m": None, "entry_angle_deg": None, "arc_peak_m": None},
            "measurement_space": "unavailable",
            "calibration_status": "insufficient_single_camera_geometry",
            "prediction_status": PREDICTION_STATUS,
        },
        trace=trace,
    )


def _shot_trajectory_signature(
    shot: ShotAnalysis,
    rims: list[BoundingBox | None],
    meta: VideoMetadata,
    samples: int = 9,
) -> np.ndarray | None:
    """Sample a shot in rim-relative coordinates for replay de-duplication."""
    observed = [point for point in shot.trace if point.observed]
    if len(observed) < 5 or shot.end_frame <= shot.release_frame:
        return None
    values: list[float] = []
    for index in range(samples):
        fraction = index / max(1, samples - 1)
        target_frame = shot.release_frame + fraction * (shot.end_frame - shot.release_frame)
        point = min(observed, key=lambda candidate: abs(candidate.frame - target_frame))
        rim = rims[point.frame] if 0 <= point.frame < len(rims) else None
        if rim is not None:
            scale = max(1.0, rim.width)
            values.extend(((point.x - rim.center[0]) / scale, (point.y - rim.center[1]) / scale))
        else:
            values.extend((point.x / max(1.0, meta.width), point.y / max(1.0, meta.height)))
    return np.asarray(values, dtype=float)


def _is_replay_duplicate(
    candidate: ShotAnalysis,
    existing: ShotAnalysis,
    evidence: list[FrameDetections],
    rims: list[BoundingBox | None],
    meta: VideoMetadata,
) -> bool:
    """Reject a near-identical trajectory repeated after an edit/replay."""
    gap = candidate.release_frame - existing.end_frame
    if gap <= max(8, round(meta.fps * 0.35)):
        return False
    start = max(0, existing.end_frame)
    end = min(len(evidence), candidate.release_frame + 1)
    if not any(item.scene_cut for item in evidence[start:end]):
        return False
    if candidate.outcome != existing.outcome and "review" not in {candidate.outcome, existing.outcome}:
        return False
    first = _shot_trajectory_signature(existing, rims, meta)
    second = _shot_trajectory_signature(candidate, rims, meta)
    if first is None or second is None or first.shape != second.shape:
        return False
    distance_value = float(np.mean(np.linalg.norm(first.reshape(-1, 2) - second.reshape(-1, 2), axis=1)))
    duration_first = max(1, existing.end_frame - existing.release_frame)
    duration_second = max(1, candidate.end_frame - candidate.release_frame)
    duration_ratio = min(duration_first, duration_second) / max(duration_first, duration_second)
    return distance_value <= 0.16 and duration_ratio >= 0.68


def find_shots(
    evidence: list[FrameDetections], rims: list[BoundingBox | None], meta: VideoMetadata
) -> list[ShotAnalysis]:
    raw_seeds = _release_seed_candidates(evidence, rims, (meta.width, meta.height))
    # Work in overlapping temporal windows so a long session is not silently
    # truncated by a global candidate/shot cap. The overlap catches releases
    # at window boundaries; temporal non-maximum suppression below removes the
    # duplicate proposals.
    window = max(1, round(meta.fps * 8.0))
    step = max(1, round(meta.fps * 4.0))
    windowed: list[tuple[float, int, BallCandidate]] = []
    seen_seed_keys: set[tuple[int, int, int, str]] = set()
    for start in range(0, max(1, len(evidence)), step):
        end = min(len(evidence), start + window)
        candidates = [seed for seed in raw_seeds if start <= seed[1] < end]
        for candidate in candidates:
            # Keep each hypothesis once across overlapping windows. Keying by
            # a quantized location preserves genuinely different same-frame
            # ball hypotheses while removing only the overlap duplicate.
            ball = candidate[2]
            key = (candidate[1], round(ball.x / 12.0), round(ball.y / 12.0), ball.source)
            if key in seen_seed_keys:
                continue
            seen_seed_keys.add(key)
            windowed.append(candidate)
    seeds = windowed
    proposals: list[tuple[float, ShotAnalysis]] = []
    for seed_score, seed_frame, seed in seeds:
        trace = track_ball_from_release_candidate(evidence, seed_frame, seed, meta.fps, rims, (meta.width, meta.height))
        if not trace:
            continue
        release = _release_frame(trace, evidence, seed_frame, meta.fps)
        if release is None:
            continue
        shot = _measure_shot(1, trace, release, meta, evidence, rims)
        if shot is None:
            shot = _minimal_review_shot(1, trace, release, meta, evidence)
        if shot is None:
            continue
        # Keep every release-like proposal visible as REVIEW when the outcome
        # or trajectory is incomplete. Review is the safe fallback for weak
        # evidence; silently dropping it makes a detector miss impossible to
        # correct locally and hides failures from evaluation.
        trajectory_quality = seed_score + shot.confidence * 3 + (2 if shot.evidence["crossing_frame"] else 0)
        proposals.append((trajectory_quality, shot))
    proposals.sort(key=lambda value: value[0], reverse=True)
    selected: list[ShotAnalysis] = []
    for _, proposal in proposals:
        if any(
            not (proposal.end_frame < existing.release_frame - 10 or proposal.release_frame > existing.end_frame + 10)
            for existing in selected
        ):
            continue
        if any(_is_replay_duplicate(proposal, existing, evidence, rims, meta) for existing in selected):
            continue
        proposal.id = len(selected) + 1
        selected.append(proposal)
    selected.sort(key=lambda shot: shot.release_frame)
    for index, shot in enumerate(selected, 1):
        shot.id = index
    return selected


def session_consistency_score(shots: list[ShotAnalysis]) -> float | None:
    """Estimate repeatability from the measurements that are actually present."""
    if len(shots) < 2:
        return None
    tolerances = {
        "release_speed_ms": 0.45,
        "release_height_m": 0.12,
        "entry_angle_deg": 4.0,
        "arc_peak_m": 0.30,
        "elbow": 8.0,
        "knee": 10.0,
        "shoulder": 10.0,
        "hip": 10.0,
    }
    scores: list[float] = []
    for metric, tolerance in tolerances.items():
        values: list[float] = []
        for shot in shots:
            value = getattr(shot, metric, None) if metric.endswith(("_ms", "_m", "_deg")) else shot.form.get(metric)
            if value is not None:
                values.append(float(value))
        if len(values) < 2:
            continue
        median = float(np.median(values))
        spread = float(np.median(np.abs(np.asarray(values) - median)))
        scores.append(clamp(1.0 - spread / max(1e-6, tolerance), 0.0, 1.0))
    return round(float(np.mean(scores)), 3) if scores else None


def calibrate_session_confidence(shots: list[ShotAnalysis]) -> None:
    """Compatibility shim for the removed quality-based confidence pass.

    Older callers imported this helper after an analysis. Confidence now means
    confidence in the observed event, so a session-level mechanics score must
    never rewrite it. Keep the name callable for those integrations while
    intentionally leaving every stored value unchanged.
    """
    return None


def predict_ft_percentage(shots: list[ShotAnalysis]) -> float | None:
    """Return a future make probability only after a validated model exists.

    A hand-written blend of mechanics, a single observed result, and a
    population prior is not a calibrated prediction. Returning ``None`` keeps
    the observed make rate useful while preventing a made-up FT% from being
    presented as predictive. A trained model can replace this function without
    changing the session schema.
    """
    return None


def refresh_saved_analysis(payload: dict) -> dict:
    """Backfill new confidence, FT projection, and coaching fields for old sessions."""
    # Treat the caller's decoded JSON as immutable input. This keeps repeated
    # reads and repeated refreshes byte-for-byte stable while allowing the
    # returned view to include compatibility fields and corrections.
    payload = dict(payload)
    legacy_prediction = (
        "analysis_version" not in payload
        and payload.get("summary", {}).get("predicted_ft_pct") is not None
    )
    raw_shots = [dict(raw) for raw in (payload.get("shots") or [])]
    session_id = str(payload.get("session", {}).get("id", ""))
    shot_mode = payload.get("shot_mode", "free_throw")
    shot_mode = shot_mode if shot_mode in {"free_throw", "jump_shot"} else "free_throw"
    corrections_path = ANALYSIS_SESSIONS_DIR / session_id / "corrections.json"
    corrections: dict[str, dict] = {}
    session_context: dict[str, Any] = {}
    if session_id and corrections_path.is_file():
        try:
            stored = json.loads(corrections_path.read_text())
            corrections = stored.get("shots", {}) if isinstance(stored, dict) else {}
            session_context = stored.get("session_context", {}) if isinstance(stored, dict) else {}
            if not isinstance(session_context, dict):
                session_context = {}
        except (OSError, ValueError, TypeError):
            corrections = {}
    manual_shots: list[dict] = []
    if session_id and corrections_path.is_file():
        try:
            stored = json.loads(corrections_path.read_text())
            raw_manual = stored.get("manual_shots", []) if isinstance(stored, dict) else []
            if isinstance(raw_manual, list):
                manual_shots = [dict(item) for item in raw_manual if isinstance(item, dict)]
        except (OSError, ValueError, TypeError):
            manual_shots = []
    if session_context.get("shot_mode") in {"free_throw", "jump_shot"}:
        shot_mode = session_context["shot_mode"]
    for manual in manual_shots:
        manual.setdefault("correction", {"source": "local_user", "fields": ["manual_attempt"]})
    raw_shots.extend(manual_shots)
    for raw in raw_shots:
        correction = corrections.get(str(raw.get("id")))
        if not isinstance(correction, dict):
            continue
        if correction.get("outcome") in {"make", "miss", "review"}:
            raw["outcome"] = correction["outcome"]
        if isinstance(correction.get("release_frame"), int) and correction["release_frame"] >= 0:
            raw["release_frame"] = correction["release_frame"]
            fps = float(payload.get("session", {}).get("fps") or 0.0)
            if fps > 0:
                raw["release_time"] = round(correction["release_frame"] / fps, 3)
        if correction.get("shooter_id") is not None:
            raw["evidence"] = {
                **dict(raw.get("evidence") or {}),
                "shooter_id": str(correction["shooter_id"]),
            }
        for field in ("shot_type", "shooting_hand", "takeoff_frame", "defender_ids", "team_assignments", "player_height_m"):
            if field in correction:
                raw["evidence"] = {**dict(raw.get("evidence") or {}), field: correction[field]}
        if correction.get("shot_type") in {"layup", "dunk", "pass", "pump_fake"}:
            raw["evidence"] = {
                **dict(raw.get("evidence") or {}),
                "statistics_eligibility": {"status": "excluded", "reason": "non-jump attempt excluded from jump-shot statistics"},
            }
        if "takeoff_frame" in correction:
            evidence = dict(raw.get("evidence") or {})
            motion_events = dict(evidence.get("motion_events") or {})
            motion_events["takeoff_frame"] = correction["takeoff_frame"]
            evidence["motion_events"] = motion_events
            raw["evidence"] = evidence
        if "defender_ids" in correction:
            evidence = dict(raw.get("evidence") or {})
            defenders = evidence.get("defenders")
            if isinstance(defenders, list) and isinstance(correction.get("defender_ids"), list):
                allowed_ids = set(correction["defender_ids"])
                evidence["defenders"] = [item for item in defenders if isinstance(item, dict) and item.get("id") in allowed_ids]
            raw["evidence"] = evidence
        if "team_assignments" in correction:
            evidence = dict(raw.get("evidence") or {})
            assignments = correction.get("team_assignments")
            if isinstance(assignments, dict):
                evidence["team_assignments"] = assignments
                defenders = evidence.get("defenders")
                if isinstance(defenders, list):
                    updated_defenders = [dict(defender) if isinstance(defender, dict) else defender for defender in defenders]
                    filtered_defenders: list[Any] = []
                    for defender in updated_defenders:
                        if isinstance(defender, dict) and defender.get("id") in assignments:
                            role = assignments[defender["id"]]
                            defender["role"] = role
                            if role in {"teammate", "official"}:
                                continue
                        filtered_defenders.append(defender)
                    evidence["defenders"] = filtered_defenders
            raw["evidence"] = evidence
        raw["correction"] = {
            "source": "local_user",
            "updated_at": correction.get("updated_at"),
            "fields": sorted(key for key in correction if key not in {"updated_at"}),
            **({"comment": str(correction["comment"])} if correction.get("comment") is not None else {}),
        }
    shots: list[ShotAnalysis] = []
    for index, raw in enumerate(raw_shots, 1):
        form = raw.get("form")
        if not isinstance(form, dict):
            form = {}
        raw_evidence = raw.get("evidence")
        if not isinstance(raw_evidence, dict):
            raw_evidence = {}
        shots.append(
            ShotAnalysis(
                id=int(raw.get("id", index)),
                outcome=str(raw.get("outcome", "review")),
                confidence=float(raw.get("confidence", 0.5)),
                observation_confidence=(
                    float(raw["observation_confidence"])
                    if raw.get("observation_confidence") is not None
                    else float(raw.get("confidence", 0.5))
                ),
                release_frame=int(raw.get("release_frame", 0)),
                release_time=float(raw.get("release_time", 0.0)),
                end_frame=int(raw.get("end_frame", raw.get("release_frame", 0))),
                release_speed_ms=raw.get("release_speed_ms"),
                release_height_m=raw.get("release_height_m"),
                entry_angle_deg=raw.get("entry_angle_deg"),
                arc_peak_m=raw.get("arc_peak_m"),
                form={
                    "elbow": form.get("elbow"),
                    "knee": form.get("knee"),
                    "shoulder": form.get("shoulder"),
                    "hip": form.get("hip"),
                },
                flags=list(raw.get("flags") or []),
                evidence={
                    "observed_ball_frames": int(raw_evidence.get("observed_ball_frames", 0)),
                    "tracked_frames": int(raw_evidence.get("tracked_frames", 0)),
                    "rim_track_confidence": float(raw_evidence.get("rim_track_confidence", 0.0)),
                    "pose_confidence": float(raw_evidence.get("pose_confidence", 0.0)),
                    "crossing_frame": raw_evidence.get("crossing_frame"),
                    **raw_evidence,
                    **({"correction": raw["correction"]} if raw.get("correction") else {}),
                },
                trace=[],
                coaching=raw.get("coaching"),
                shot_mode=str(raw.get("shot_mode", shot_mode)),
            )
        )
    if shots:
        for shot in shots:
            mechanics_quality = shot.evidence.get("mechanics_quality")
            mechanics = (
                float(mechanics_quality)
                if mechanics_quality is not None
                else estimate_mechanics_quality(shot.form)
            )
            trajectory_quality = shot.evidence.get("trajectory_quality")
            trajectory = (
                float(trajectory_quality)
                if trajectory_quality is not None
                else estimate_trajectory_quality(
                    shot.release_speed_ms,
                    shot.release_height_m,
                    shot.entry_angle_deg,
                    shot.arc_peak_m,
                )
            )
            follow_through_quality = shot.evidence.get("follow_through_quality")
            follow_through = (
                float(follow_through_quality)
                if follow_through_quality is not None
                else estimate_follow_through_quality(shot.form)
            )
            miss_proximity = shot.evidence.get("miss_proximity")
            if miss_proximity is None and shot.evidence.get("crossing_offset_rim") is not None:
                miss_proximity = clamp(
                    1.0 - float(shot.evidence["crossing_offset_rim"]) / 2.45,
                    0.0,
                    1.0,
                )
                shot.evidence["miss_proximity"] = round(miss_proximity, 3)
            if shot.shot_mode == "jump_shot":
                shot.evidence["mechanics_quality"] = None
                shot.evidence["follow_through_quality"] = None
                shot.evidence["trajectory_quality"] = None
                shot.evidence["shot_quality"] = None
            else:
                shot.evidence["mechanics_quality"] = mechanics
                shot.evidence["follow_through_quality"] = follow_through
                shot.evidence["trajectory_quality"] = trajectory
                shot.evidence["shot_quality"] = combine_shot_quality(mechanics, follow_through, trajectory)
            shot.evidence.pop("predicted_ft_pct", None)
            shot.evidence.pop("session_consistency_score", None)
            shot.evidence["prediction_status"] = (
                "legacy_heuristic_unvalidated" if legacy_prediction else PREDICTION_STATUS
            )
            shot.evidence["shot_mode"] = shot.shot_mode
            if shot.shot_mode == "jump_shot":
                calibration = session_context.get("court_calibration")
                if isinstance(calibration, dict):
                    takeoff = shot.evidence.get("takeoff_image")
                    rim_image = shot.evidence.get("rim_image")
                    if isinstance(takeoff, list) and len(takeoff) == 2 and isinstance(rim_image, list) and len(rim_image) == 2:
                        shot.evidence["distance"] = distance_from_calibration(
                            calibration,
                            (float(takeoff[0]), float(takeoff[1])),
                            (float(rim_image[0]), float(rim_image[1])),
                        )
                        shot.evidence["shot_type"] = shot.evidence["distance"].get("shot_type", "unknown")
                shot.evidence.setdefault("predictions", {
                    "release": {"status": "unavailable_unvalidated", "probability": None, "cutoff": "release", "cutoff_ms_after_release": 0, "cutoff_frame": shot.release_frame},
                    "release_plus_200ms": {"status": "unavailable_unvalidated", "probability": None, "cutoff": "release_plus_200ms", "cutoff_ms_after_release": 200, "cutoff_frame": shot.release_frame},
                })
                predictions = shot.evidence.get("predictions")
                if isinstance(predictions, dict):
                    fps = float(payload.get("session", {}).get("fps") or 0.0)
                    if isinstance(predictions.get("release"), dict):
                        predictions["release"].setdefault("cutoff_frame", shot.release_frame)
                    if isinstance(predictions.get("release_plus_200ms"), dict):
                        predictions["release_plus_200ms"].setdefault(
                            "cutoff_frame", shot.release_frame + round(fps * 0.2) if fps > 0 else shot.release_frame
                        )
            # Preserve the stored observation confidence. Refreshing an old
            # session is a read operation and must not re-grade its evidence.
            shot.observation_confidence = shot.observation_confidence or shot.confidence
        attach_coaching(shots, payload.get("quality") or {})
    payload["shot_mode"] = shot_mode
    payload["summary"] = summarize_session(shots, shot_mode=shot_mode)
    if legacy_prediction:
        payload["summary"]["prediction_status"] = "legacy_heuristic_unvalidated"
    payload.setdefault("analysis_version", "1.0.0-legacy")
    payload.setdefault("processing_mode", "normal")
    payload["prediction"] = {
        "status": "legacy_heuristic_unvalidated" if legacy_prediction else PREDICTION_STATUS,
        "model": None,
        "cutoff": None,
        "sample_size": 0,
    }
    payload["jump_predictions"] = {
        "status": "unavailable_unvalidated" if shot_mode == "jump_shot" else "not_applicable",
        "models": None,
        "cutoffs": ["release", "release_plus_200ms"] if shot_mode == "jump_shot" else [],
    }
    payload["context"] = {
        key: session_context[key]
        for key in ("court_calibration", "player_heights", "shot_mode")
        if session_context.get(key) is not None
    }
    payload["corrections"] = {
        "count": len(corrections) + len(manual_shots),
        "source": "local_user" if corrections or manual_shots else None,
    }
    payload["shots"] = [shot.to_public_dict() for shot in shots]
    return payload


def summarize_session(shots: list[ShotAnalysis], shot_mode: str = "free_throw") -> dict:
    excluded = [
        shot for shot in shots
        if shot_mode == "jump_shot" and (shot.evidence.get("statistics_eligibility") or {}).get("status") == "excluded"
    ]
    excluded_ids = {id(shot) for shot in excluded}
    stats_shots = [shot for shot in shots if id(shot) not in excluded_ids]
    decided = [shot for shot in stats_shots if shot.outcome in {"make", "miss"}]
    makes = sum(shot.outcome == "make" for shot in decided)
    streak = best = 0
    for shot in stats_shots:
        if shot.outcome == "make":
            streak += 1
            best = max(best, streak)
        elif shot.outcome == "miss":
            streak = 0
    summary = {
        "attempts": len(stats_shots),
        "makes": makes,
        "misses": sum(shot.outcome == "miss" for shot in stats_shots),
        "review": sum(shot.outcome == "review" for shot in stats_shots),
        "fg_pct": round(makes / len(decided) * 100, 1) if decided else None,
        # Keep the old field for exports, but give free-throw consumers an
        # explicit name that distinguishes observed history from prediction.
        "observed_ft_pct": round(makes / len(decided) * 100, 1) if decided else None,
        "predicted_ft_pct": predict_ft_percentage(shots),
        "prediction_status": PREDICTION_STATUS,
        "prediction_model": None,
        "prediction_sample_size": 0,
        "best_streak": best,
        "average_confidence": round(float(np.mean([shot.confidence for shot in stats_shots])) * 100, 1) if stats_shots else 0.0,
    }
    if shot_mode == "jump_shot":
        summary.update({
            "detected_attempts": len(shots),
            "excluded_attempts": len(excluded),
            "observed_fg_pct": summary["fg_pct"],
            "observed_three_pct": round(
                sum(shot.outcome == "make" for shot in stats_shots if shot.evidence.get("shot_type") == "three_pointer")
                / max(1, sum(shot.outcome in {"make", "miss"} and shot.evidence.get("shot_type") == "three_pointer" for shot in stats_shots))
                * 100,
                1,
            ) if any(shot.evidence.get("shot_type") == "three_pointer" for shot in stats_shots) else None,
            "prediction_status": "unavailable_unvalidated",
        })
    return summary


def build_footage_quality_report(
    evidence: list[FrameDetections], rims: list[BoundingBox | None], meta: VideoMetadata
) -> dict:
    total = max(1, len(evidence))
    rim_coverage = sum(rim is not None for rim in rims) / total
    pose_coverage = sum(bool(item.poses) for item in evidence) / total
    model_ball_coverage = sum(
        any(candidate.source == "model" for candidate in item.balls) for item in evidence
    ) / total
    any_ball_coverage = sum(bool(item.balls) for item in evidence) / total
    blur_score = float(np.median([item.sharpness for item in evidence])) if evidence else 0.0
    visible_rims = [rim for rim in rims if rim is not None]
    camera_motion = 0.0
    if len(visible_rims) >= 3:
        # A replay can put the same basket at a different image location. Do
        # not call that camera motion; measure movement within each continuous
        # edit segment and keep the worst segment as the reliability signal.
        segment_centers: list[tuple[float, float]] = []
        segments: list[list[tuple[float, float]]] = []
        for index, rim in enumerate(rims):
            if index < len(evidence) and evidence[index].scene_cut:
                if segment_centers:
                    segments.append(segment_centers)
                segment_centers = []
            if rim is not None:
                segment_centers.append(rim.center)
        if segment_centers:
            segments.append(segment_centers)
        for centers_list in segments:
            if len(centers_list) < 3:
                continue
            centers = np.asarray(centers_list, dtype=float)
            camera_motion = max(
                camera_motion,
                float(max(np.ptp(centers[:, 0]) / max(1, meta.width), np.ptp(centers[:, 1]) / max(1, meta.height))),
            )
    scene_cut_count = sum(item.scene_cut for item in evidence)
    duplicate_frame_count = sum(item.duplicate_frame for item in evidence)

    score = (
        clamp(rim_coverage / 0.7, 0, 1) * 0.42
        + clamp(pose_coverage / 0.55, 0, 1) * 0.25
        + clamp(max(model_ball_coverage, any_ball_coverage * 0.35) / 0.08, 0, 1) * 0.23
        + clamp(1.0 - camera_motion / 0.18, 0, 1) * 0.10
    )
    tier = "good" if score >= 0.78 else "limited" if score >= 0.48 else "insufficient"
    messages: list[str] = []
    if rim_coverage < 0.35:
        messages.append("Keep the rim unobstructed and large enough to see throughout each attempt")
    if pose_coverage < 0.35:
        messages.append("Keep the shooter's full body visible for reliable joint angles")
    if max(model_ball_coverage, any_ball_coverage) < 0.025:
        messages.append("The ball is rarely visible; move the camera closer or use a higher-resolution clip")
    if camera_motion > 0.10:
        messages.append("The camera moves substantially; physical measurements are lower-confidence estimates")
    if blur_score < 0.22:
        messages.append("Motion blur is substantial; temporal tracking was widened and release timing is estimated")
    if meta.fps < 24:
        messages.append("Frame rate is below 24 fps, which reduces release and occlusion timing precision")
    if scene_cut_count:
        messages.append(f"{scene_cut_count} scene cut or replay boundary detected; tracking was reset there")
    if duplicate_frame_count:
        messages.append(f"{duplicate_frame_count} duplicate playback frame(s) were excluded from observed evidence")
    if not meta.timing_preserved or meta.slow_motion_unknown:
        messages.append("Source timing or slow-motion timing is unknown; speed metrics are unavailable")
    orientation = "portrait" if meta.height > meta.width * 1.08 else "landscape" if meta.width > meta.height * 1.08 else "square"
    return {
        "tier": tier,
        "score": round(score, 3),
        "orientation": orientation,
        "normalized": True,
        "rim_coverage": round(rim_coverage, 3),
        "pose_coverage": round(pose_coverage, 3),
        "model_ball_coverage": round(model_ball_coverage, 3),
        "ball_candidate_coverage": round(any_ball_coverage, 3),
        "camera_motion": round(camera_motion, 3),
        "blur_score": round(blur_score, 3),
        "scene_cut_count": scene_cut_count,
        "duplicate_frame_count": duplicate_frame_count,
        "timing_preserved": meta.timing_preserved,
        "source_fps": meta.source_fps,
        "source_frame_count": meta.source_frame_count,
        "messages": messages,
    }


def analyze_video(
    source: Path,
    session_dir: Path | None = None,
    progress: Progress | None = None,
    display_name: str | None = None,
    processing_mode: str = "normal",
    shot_mode: str = "free_throw",
    court_calibration: dict[str, Any] | None = None,
) -> dict:
    from backend.analysis.video_rendering import render_outputs

    source = source.resolve()
    shot_mode = shot_mode if shot_mode in {"free_throw", "jump_shot"} else "free_throw"
    filename = display_name or source.name
    if session_dir is None:
        session_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        session_dir = ANALYSIS_SESSIONS_DIR / session_id
    else:
        session_id = session_dir.name
    session_dir.mkdir(parents=True, exist_ok=True)
    uploaded_source = session_dir / f"upload{source.suffix.lower()}"
    if source != uploaded_source.resolve():
        shutil.copy2(source, uploaded_source)
    else:
        uploaded_source = source
    try:
        source_meta = probe_video(uploaded_source)
    except ValueError:
        source_meta = None
    if progress:
        progress("Normalizing rotation, codec, and frame timing", 0, 0)
    local_source = normalize_video(uploaded_source, session_dir / "original.mp4")
    meta = probe_video(local_source)
    if source_meta is not None:
        meta.source_fps = source_meta.fps
        meta.source_frame_count = source_meta.frame_count
        meta.timing_preserved = (
            abs(meta.fps - source_meta.fps) < 0.51
            and meta.frame_count == source_meta.frame_count
        )
        meta.slow_motion_unknown = False
    if progress:
        progress("Loading local vision models", 0, meta.frame_count)
    evidence = collect_evidence(local_source, meta, progress, processing_mode=processing_mode)
    if progress:
        progress("Stabilizing rim geometry", meta.frame_count, meta.frame_count)
    rim_candidates = [item.hoops for item in evidence]
    rims = select_rim_track(
        rim_candidates,
        (meta.width, meta.height),
        [item.scene_cut for item in evidence],
    )
    shots = find_shots(evidence, rims, meta)
    player_tracks, frame_tracks = assign_player_tracks(evidence)
    for shot in shots:
        shot.shot_mode = shot_mode
        shot.evidence["shot_mode"] = shot_mode
    if shot_mode == "jump_shot":
        for shot in shots:
            jump = analyze_jump_shot(
                shot=shot,
                evidence=evidence,
                frame_tracks=frame_tracks,
                meta=meta,
                rims=rims,
                calibration=court_calibration,
            )
            shot.evidence.update(jump)
            # Free-throw form ranges are not a validated jump-shot grade.
            # Keep descriptive motion components and clear legacy aggregates.
            for legacy_key in ("mechanics_quality", "follow_through_quality", "trajectory_quality", "shot_quality"):
                shot.evidence.pop(legacy_key, None)
            shot.evidence["player_tracks"] = player_tracks
            shot.evidence["prediction_status"] = "unavailable_unvalidated"
    quality = build_footage_quality_report(evidence, rims, meta)
    attach_coaching(shots, quality)
    warnings: list[str] = []
    if not any(rim is not None for rim in rims):
        warnings.append("No stable rim track was found; use a clearer side-on clip")
    if not shots:
        warnings.append("No complete shot trajectory was found. Keep the ball, shooter, and rim visible")
    if shot_mode == "jump_shot":
        warnings.append("Jump-shot probabilities remain unavailable until the validated jump model is installed")
    warnings.extend(quality["messages"])
    if progress:
        progress("Rendering review videos", 0, meta.frame_count)
    artifacts = render_outputs(
        local_source,
        session_dir,
        meta,
        shots,
        rims,
        evidence,
        progress,
        original_source=uploaded_source,
    )
    payload = {
        "analysis_version": ANALYSIS_VERSION,
        "models": {
            "ball_rim_detector": "ebard-yolov8n.pt",
            "pose": "yolo11n-pose.pt",
            "player_tracker": "temporal_pose_tracks_v1",
            "jump_prediction": JUMP_MODEL_VERSION if shot_mode == "jump_shot" else "not_applicable",
        },
        "processing_mode": processing_mode if processing_mode in {"normal", "deep"} else "normal",
        "shot_mode": shot_mode,
        "prediction": {
            "status": PREDICTION_STATUS,
            "model": None,
            "cutoff": None,
            "sample_size": 0,
        },
        "jump_predictions": {
            "status": "unavailable_unvalidated" if shot_mode == "jump_shot" else "not_applicable",
            "models": None,
            "cutoffs": ["release", "release_plus_200ms"] if shot_mode == "jump_shot" else [],
        },
        "context": {"court_calibration": court_calibration} if court_calibration else {},
        "session": {
            "id": session_id,
            "filename": filename,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "width": meta.width,
            "height": meta.height,
            "fps": meta.fps,
            "frame_count": meta.frame_count,
            "duration": round(meta.duration, 3),
            "local_only": True,
            "source_fps": meta.source_fps,
            "source_frame_count": meta.source_frame_count,
            "timing_preserved": meta.timing_preserved,
            "slow_motion_unknown": meta.slow_motion_unknown,
            "source_timing": {
                "kind": "presentation_frame_index",
                "mapping": "source_frame_index_to_source_pts",
                "fps": meta.source_fps or meta.fps,
                "frame_count": meta.source_frame_count or meta.frame_count,
                "unknown": bool(meta.slow_motion_unknown or not meta.timing_preserved),
            },
        },
        "summary": summarize_session(shots, shot_mode=shot_mode),
        "players": player_tracks,
        "quality": quality,
        "shots": [shot.to_public_dict() for shot in shots],
        "warnings": warnings,
        "artifacts": artifacts,
    }
    (session_dir / "analysis.json").write_text(json.dumps(payload, indent=2))
    with (session_dir / "shots.jsonl").open("w") as stream:
        for shot in shots:
            stream.write(json.dumps(shot.to_public_dict()) + "\n")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze a basketball video locally")
    parser.add_argument("video", type=Path)
    parser.add_argument("--session-dir", type=Path)
    parser.add_argument("--shot-mode", choices=("free_throw", "jump_shot"), default="free_throw")
    args = parser.parse_args()

    def report(stage: str, done: int, total: int) -> None:
        percent = int(done / total * 100) if total else 0
        print(f"[{percent:3d}%] {stage}", flush=True)

    result = analyze_video(args.video, args.session_dir, report, shot_mode=args.shot_mode)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
