from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

import numpy as np

from backend.analysis.geometry import clamp, distance
from backend.domain.models import BoundingBox, FrameDetections, PlayerPose
from backend.prediction.jump_models import EARLY_FLIGHT_CUTOFF, build_jump_predictions, cutoff_frame


COURT_PRESETS: dict[str, dict[str, float | str]] = {
    "nba": {"three_point_radius_m": 7.24, "three_point_line_width_m": 0.0762, "units": "m"},
    "wnba": {"three_point_radius_m": 7.24, "three_point_line_width_m": 0.0762, "units": "m"},
    "ncaa": {"three_point_radius_m": 6.75, "three_point_line_width_m": 0.0762, "units": "m"},
    "fiba": {"three_point_radius_m": 6.75, "three_point_line_width_m": 0.05, "units": "m"},
    "high_school": {"three_point_radius_m": 6.32, "three_point_line_width_m": 0.05, "units": "m"},
}


def _point(pose: PlayerPose, index: int, minimum: float = 0.18) -> tuple[float, float] | None:
    if index >= len(pose.keypoints):
        return None
    x, y, confidence = pose.keypoints[index]
    return (x, y) if confidence >= minimum else None


def pose_center(pose: PlayerPose) -> tuple[float, float]:
    return pose.box.center


def foot_point(pose: PlayerPose) -> tuple[float, float]:
    feet = [point for index in (15, 16) if (point := _point(pose, index)) is not None]
    if feet:
        return (float(np.mean([point[0] for point in feet])), float(np.mean([point[1] for point in feet])))
    return ((pose.box.x1 + pose.box.x2) / 2.0, pose.box.y2)


def assign_player_tracks(evidence: list[FrameDetections]) -> tuple[list[dict[str, Any]], list[list[tuple[str, PlayerPose]]]]:
    """Track every visible person within each continuous camera segment.

    This is intentionally a deterministic association layer above pose
    detection. It keeps multiple players alive, uses position and scale
    consistency, and resets across cuts. A future appearance embedding can be
    added without changing the exported track contract.
    """
    active: dict[str, dict[str, Any]] = {}
    tracks: dict[str, dict[str, Any]] = {}
    frame_tracks: list[list[tuple[str, PlayerPose]]] = []
    next_id = 1
    for frame, item in enumerate(evidence):
        if item.scene_cut:
            active = {}
        assignments: list[tuple[str, PlayerPose]] = []
        unmatched = set(active)
        proposals = sorted(item.poses, key=lambda pose: pose.confidence, reverse=True)
        for pose in proposals:
            center = pose_center(pose)
            height = max(1.0, pose.box.height)
            best_id: str | None = None
            best_cost = float("inf")
            for track_id in unmatched:
                previous = active[track_id]
                elapsed = max(1, frame - int(previous["frame"]))
                predicted = previous["center"]
                candidate_distance = distance(center, predicted) / height
                scale_cost = abs(math.log(max(1e-3, pose.box.height / previous["height"])))
                cost = candidate_distance / elapsed + scale_cost * 0.25
                if cost < best_cost:
                    best_id, best_cost = track_id, cost
            if best_id is None or best_cost > 1.8:
                best_id = f"player-{next_id}"
                next_id += 1
                tracks[best_id] = {"id": best_id, "frames": [], "confidence": []}
            unmatched.discard(best_id)
            pose.track_id = best_id
            active[best_id] = {"frame": frame, "center": center, "height": height, "pose": pose}
            tracks.setdefault(best_id, {"id": best_id, "frames": [], "confidence": []})
            tracks[best_id]["frames"].append(frame)
            tracks[best_id]["confidence"].append(float(pose.confidence))
            assignments.append((best_id, pose))
        frame_tracks.append(assignments)
    summaries: list[dict[str, Any]] = []
    for track in tracks.values():
        frames = track["frames"]
        summaries.append({
            "id": track["id"],
            "frame_start": min(frames) if frames else None,
            "frame_end": max(frames) if frames else None,
            "frames": len(frames),
            "confidence": round(float(np.mean(track["confidence"])) if track["confidence"] else 0.0, 3),
        })
    return summaries, frame_tracks


def _nearest_pose(
    frame_tracks: list[list[tuple[str, PlayerPose]]],
    frame: int,
    anchor: PlayerPose,
    track_id: str | None = None,
) -> tuple[str, PlayerPose] | None:
    for delta in (0, -1, 1, -2, 2, -3, 3):
        index = frame + delta
        if not 0 <= index < len(frame_tracks):
            continue
        candidates = frame_tracks[index]
        if track_id:
            exact = [item for item in candidates if item[0] == track_id]
            if exact:
                return exact[0]
        if candidates:
            ax, ay = anchor.box.center
            ah = max(1.0, anchor.box.height)
            return min(
                candidates,
                key=lambda item: distance(item[1].box.center, (ax, ay)) / ah
                + abs(math.log(max(1e-3, item[1].box.height / ah))) * 0.25,
            )
    return None


def _trajectory_events(
    frame_tracks: list[list[tuple[str, PlayerPose]]],
    release_frame: int,
    shooter_id: str | None,
    fps: float,
    frame_height: int,
    timing_available: bool = True,
) -> dict[str, Any]:
    if shooter_id is None:
        return {
            "timing_available": timing_available,
            "gather_frame": None,
            "loading_frame": None,
            "takeoff_frame": None,
            "release_frame": release_frame,
            "landing_frame": None,
            "follow_through_end_frame": None,
            "follow_through_duration_ms": None,
            "release_after_takeoff_ms": None,
            "jump_height_projected_px": None,
            "motion_type": "unknown",
            "uncertainty_frames": None,
        }
    samples: list[tuple[int, float, float]] = []
    for frame in range(max(0, release_frame - 48), min(len(frame_tracks), release_frame + 90)):
        hit = next((pose for tid, pose in frame_tracks[frame] if tid == shooter_id), None)
        if hit is None:
            continue
        x, y = foot_point(hit)
        samples.append((frame, x, y))
    if not samples:
        return {
            "timing_available": timing_available,
            "gather_frame": None,
            "loading_frame": None,
            "takeoff_frame": None,
            "release_frame": release_frame,
            "landing_frame": None,
            "follow_through_end_frame": None,
            "follow_through_duration_ms": None,
            "release_after_takeoff_ms": None,
            "jump_height_projected_px": None,
            "motion_type": "unknown",
            "uncertainty_frames": None,
        }
    before = [sample for sample in samples if sample[0] < release_frame]
    baseline = float(np.median([sample[2] for sample in before[: max(1, len(before) // 3)] or before]))
    threshold = max(5.0, frame_height * 0.012)
    takeoff_sample = next((sample for sample in before if baseline - sample[2] >= threshold), None)
    takeoff = takeoff_sample[0] if takeoff_sample else None
    landing = None
    if takeoff is not None:
        for sample in samples:
            if sample[0] > release_frame + 8 and abs(sample[2] - baseline) <= threshold * 1.35:
                landing = sample[0]
                break
    gather = before[max(0, len(before) - 20)][0] if before else None
    loading = max(gather or release_frame, (takeoff - 3) if takeoff is not None else release_frame)
    min_feet = min((sample[2] for sample in samples if takeoff is not None and takeoff <= sample[0] <= (landing or release_frame + 36)), default=None)
    jump_px = round(max(0.0, baseline - min_feet), 1) if min_feet is not None else None
    lateral = 0.0
    if len(before) >= 3:
        lateral = abs(before[-1][1] - before[0][1]) / max(1.0, frame_height)
    motion_type = "catch_and_shoot" if lateral < 0.06 else "pull_up"
    if len(before) >= 2 and before[-1][1] - before[-2][1] > frame_height * 0.025:
        motion_type = "step_back"
    elif lateral > 0.10 and len(before) >= 3 and before[-1][2] - before[0][2] > frame_height * 0.02:
        motion_type = "fadeaway"
    return {
        "timing_available": timing_available,
        "gather_frame": gather,
        "loading_frame": loading,
        "takeoff_frame": takeoff,
        "release_frame": release_frame,
        "landing_frame": landing,
        "follow_through_end_frame": landing,
        "follow_through_duration_ms": round((landing - release_frame) / max(1.0, fps) * 1000.0, 1) if landing is not None and timing_available else None,
        "release_after_takeoff_ms": round((release_frame - takeoff) / max(1.0, fps) * 1000.0, 1) if takeoff is not None and timing_available else None,
        "jump_height_projected_px": jump_px,
        "motion_type": motion_type,
        "uncertainty_frames": 2 if takeoff is not None else None,
    }


def _homography_point(image_points: Iterable[Iterable[float]], world_points: Iterable[Iterable[float]], point: tuple[float, float]) -> tuple[float, float] | None:
    try:
        image = np.asarray(list(image_points), dtype=float)
        world = np.asarray(list(world_points), dtype=float)
    except (TypeError, ValueError):
        return None
    if image.shape != (4, 2) or world.shape != (4, 2):
        return None
    if not np.isfinite(image).all() or not np.isfinite(world).all():
        return None
    matrix = []
    for (x, y), (u, v) in zip(image, world, strict=True):
        matrix.extend([[-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]])
    matrix_array = np.asarray(matrix, dtype=float)
    if np.linalg.matrix_rank(matrix_array) < 8:
        return None
    _, _, vh = np.linalg.svd(matrix_array)
    h = vh[-1].reshape(3, 3)
    mapped = h @ np.asarray([point[0], point[1], 1.0])
    if not np.isfinite(mapped).all() or abs(mapped[2]) < 1e-6:
        return None
    return (float(mapped[0] / mapped[2]), float(mapped[1] / mapped[2]))


def distance_from_calibration(
    calibration: dict[str, Any] | None,
    takeoff_image: tuple[float, float] | None,
    rim_image: tuple[float, float] | None,
) -> dict[str, Any]:
    base = {
        "value": None,
        "units": "m",
        "availability": False,
        "method": "court_calibration_required",
        "uncertainty": None,
        "shot_type": "unknown",
        "coordinate_space": "court_plane",
        "floor_contact_basis": "unavailable",
    }
    if not calibration or takeoff_image is None or rim_image is None:
        return base
    marked_basket = calibration.get("basket_ground_image")
    basket_projection = rim_image
    basket_basis = "rim_center_assumption_review"
    if isinstance(marked_basket, (list, tuple)) and len(marked_basket) == 2:
        try:
            basket_projection = (float(marked_basket[0]), float(marked_basket[1]))
            basket_basis = "manual_basket_ground_projection"
        except (TypeError, ValueError):
            basket_projection = rim_image
    takeoff = _homography_point(calibration.get("image_points", []), calibration.get("world_points", []), takeoff_image)
    rim = _homography_point(calibration.get("image_points", []), calibration.get("world_points", []), basket_projection)
    if takeoff is None or rim is None:
        return {**base, "method": "invalid_court_calibration"}
    value = round(math.hypot(takeoff[0] - rim[0], takeoff[1] - rim[1]), 2)
    preset = str(calibration.get("preset", "custom"))
    rule = COURT_PRESETS.get(preset, {})
    line = float(calibration.get("three_point_radius_m", rule.get("three_point_radius_m", 0.0)) or 0.0)
    width = float(calibration.get("three_point_line_width_m", rule.get("three_point_line_width_m", 0.0762)) or 0.0762)
    margin = max(width, float(calibration.get("uncertainty_m", 0.25) or 0.25))
    if line > 0 and abs(value - line) <= margin:
        shot_type = "near_three_point_line_review"
    elif line > 0 and value >= line + margin:
        shot_type = "three_pointer"
    else:
        shot_type = "mid_range"
    units = str(calibration.get("units", "m"))
    display_value = value * 3.280839895 if units == "ft" else value
    display_uncertainty = max(0.05, float(calibration.get("uncertainty_m", 0.25) or 0.25))
    if units == "ft":
        display_uncertainty *= 3.280839895
    return {
        "value": round(display_value, 2),
        "units": units,
        "availability": True,
        "method": "court_plane_homography",
        "uncertainty": round(display_uncertainty, 2),
        "shot_type": shot_type,
        "calibration_id": calibration.get("id"),
        "coordinate_space": "court_plane",
        "floor_contact_basis": "last_visible_shoe_or_foot_before_release",
        "basket_projection_basis": basket_basis,
        "calibration_quality": "manual_ground_projection" if basket_basis == "manual_basket_ground_projection" else "projected_basket_assumption_review",
        "line_uncertainty_m": round(margin, 2),
    }


def defender_context(
    frame_tracks: list[list[tuple[str, PlayerPose]]],
    shooter_id: str | None,
    release_frame: int,
    fps: float,
    release_point: tuple[float, float] | None = None,
    timing_available: bool = True,
) -> list[dict[str, Any]]:
    if shooter_id is None or not 0 <= release_frame < len(frame_tracks):
        return []
    shooter_item = next((item for item in frame_tracks[release_frame] if item[0] == shooter_id), None)
    if shooter_item is None:
        return []
    shooter = shooter_item[1]
    shooter_center = pose_center(shooter)
    shooter_scale = max(1.0, shooter.box.height)
    result: list[dict[str, Any]] = []
    for defender_id, defender in frame_tracks[release_frame]:
        if defender_id == shooter_id:
            continue
        separation_px = distance(shooter_center, pose_center(defender))
        previous = next((pose for tid, pose in frame_tracks[max(0, release_frame - 3)] if tid == defender_id), None)
        previous_sep = distance(shooter_center, pose_center(previous)) if previous is not None else None
        closing_px_s = ((previous_sep - separation_px) / max(1e-3, 3 / fps)) if previous_sep is not None and timing_available else None
        shoulder = [_point(defender, index) for index in (5, 6)]
        wrists = [_point(defender, index) for index in (9, 10)]
        shoulder_y = float(np.mean([point[1] for point in shoulder if point is not None])) if any(shoulder) else None
        hand_y = float(np.mean([point[1] for point in wrists if point is not None])) if any(wrists) else None
        arm_extension = None
        if shoulder_y is not None and hand_y is not None:
            arm_extension = round(clamp((shoulder_y - hand_y) / shooter_scale, -1.0, 1.5), 3)
        body_orientation = None
        if shoulder[0] is not None and shoulder[1] is not None:
            body_orientation = round(math.degrees(math.atan2(shoulder[1][1] - shoulder[0][1], shoulder[1][0] - shoulder[0][0])), 1)
        hand_position = "unknown"
        if release_point is not None and hand_y is not None:
            hand_x = float(np.mean([point[0] for point in wrists if point is not None])) if any(wrists) else None
            if hand_x is not None:
                horizontal = "left" if hand_x < release_point[0] - shooter_scale * 0.08 else "right" if hand_x > release_point[0] + shooter_scale * 0.08 else "over_release"
                vertical = "above_release" if hand_y < release_point[1] else "below_release"
                hand_position = f"{vertical}_{horizontal}"
        result.append({
            "id": defender_id,
            "role": "unresolved_opponent",
            "separation": {"value": round(separation_px, 1), "units": "px", "availability": True, "method": "pose_projection", "uncertainty": round(shooter_scale * 0.12, 1)},
            "closing_speed": {"value": round(closing_px_s, 1) if closing_px_s is not None else None, "units": "px/s", "availability": closing_px_s is not None, "method": "pose_projection", "uncertainty": None},
            "approach_direction_deg": round(math.degrees(math.atan2(pose_center(defender)[1] - pose_center(previous)[1], pose_center(defender)[0] - pose_center(previous)[0])), 1) if previous is not None else None,
            "body_orientation_deg": body_orientation,
            "arm_extension": arm_extension,
            "hand_elevation_relative": round((shooter_center[1] - hand_y) / shooter_scale, 3) if hand_y is not None else None,
            "hand_position_relative": hand_position,
            "timing_available": timing_available,
            "evidence_frames": [max(0, release_frame - 3), release_frame],
            "uncertainty": "team identity and world units require review",
        })
    return sorted(result, key=lambda item: float(item["separation"]["value"]))


def analyze_jump_shot(
    *,
    shot: Any,
    evidence: list[FrameDetections],
    frame_tracks: list[list[tuple[str, PlayerPose]]],
    meta: Any,
    rims: list[BoundingBox | None],
    calibration: dict[str, Any] | None = None,
) -> dict[str, Any]:
    anchor = None
    shooter_id: str | None = None
    shooter_association_confidence = 0.0
    release_point = min(
        (point for point in getattr(shot, "trace", []) if point.observed),
        key=lambda point: abs(point.frame - shot.release_frame),
        default=None,
    )
    release_xy = (release_point.x, release_point.y) if release_point is not None else None
    if 0 <= shot.release_frame < len(frame_tracks):
        candidates = frame_tracks[shot.release_frame]
        if release_point is not None:
            def hand_distance(item: tuple[str, PlayerPose]) -> float:
                pose = item[1]
                wrists = [_point(pose, index) for index in (9, 10)]
                return min(
                    (distance((release_point.x, release_point.y), wrist) for wrist in wrists if wrist is not None),
                    default=distance((release_point.x, release_point.y), pose_center(pose)),
                )
            candidate = min(candidates, key=hand_distance, default=(None, None))
            if candidate[1] is not None:
                candidate_distance = hand_distance(candidate)
                association_limit = max(80.0, candidate[1].box.height * 0.35)
                if candidate_distance <= association_limit:
                    shooter_id, anchor = candidate
                    shooter_association_confidence = clamp(1.0 - candidate_distance / association_limit, 0.0, 1.0)
        elif candidates:
            shooter_id, anchor = max(candidates, key=lambda item: item[1].confidence)
            shooter_association_confidence = float(anchor.confidence) if anchor is not None else 0.0
    timing_available = bool(getattr(meta, "timing_preserved", True) and not getattr(meta, "slow_motion_unknown", False))
    events = _trajectory_events(frame_tracks, shot.release_frame, shooter_id, meta.fps, meta.height, timing_available)
    takeoff_frame = events.get("takeoff_frame") if events.get("takeoff_frame") is not None else shot.release_frame
    takeoff_item = _nearest_pose(frame_tracks, int(takeoff_frame), anchor, shooter_id) if anchor is not None else None
    takeoff_image = foot_point(takeoff_item[1]) if takeoff_item is not None else (foot_point(anchor) if anchor is not None else None)
    rim = rims[shot.release_frame] if 0 <= shot.release_frame < len(rims) else next((item for item in rims if item is not None), None)
    distance_record = distance_from_calibration(calibration, takeoff_image, rim.center if rim else None)
    type_label = distance_record.get("shot_type", "unknown")
    shooting_hand = "unknown"
    if anchor is not None and release_xy is not None:
        wrists = [(index, _point(anchor, index)) for index in (9, 10)]
        visible_wrists = [(index, point) for index, point in wrists if point is not None]
        if visible_wrists:
            closest_index = min(visible_wrists, key=lambda item: distance(release_xy, item[1]))[0]
            shooting_hand = "left" if closest_index == 9 else "right"
    defenders = defender_context(frame_tracks, shooter_id, shot.release_frame, meta.fps, release_xy, timing_available)
    features = {
        "distance_m": distance_record.get("value"),
        "shot_type": type_label,
        "statistics_eligibility": {
            "status": "review" if type_label == "unknown" else "eligible_pending_validation",
            "reason": "court calibration and shot subtype review are required before jump-shot summaries",
        },
        "shooting_hand": shooting_hand,
        "shooter_association_confidence": round(shooter_association_confidence, 3),
        "motion_type": events.get("motion_type"),
        "defender_count": len(defenders),
        "closest_defender_px": defenders[0]["separation"]["value"] if defenders else None,
    }
    early_cutoff = cutoff_frame(shot.release_frame, meta.fps, EARLY_FLIGHT_CUTOFF)
    early_points = [
        point
        for point in getattr(shot, "trace", [])
        if point.observed and shot.release_frame <= point.frame <= early_cutoff
    ]
    early_features = {
        **features,
        "ball_flight_observed_200ms": len(early_points) >= 2,
        "ball_flight_displacement_px": round(
            distance((early_points[0].x, early_points[0].y), (early_points[-1].x, early_points[-1].y)),
            1,
        ) if len(early_points) >= 2 else None,
        "ball_flight_cutoff_frame": early_cutoff,
    }
    mechanics = {
        "status": "descriptive_unvalidated",
        "overall": None,
        "components": {
            "release_after_takeoff_ms": events.get("release_after_takeoff_ms"),
            "jump_height_projected_px": events.get("jump_height_projected_px"),
            "landing_drift_px": None,
            "follow_through_duration_ms": events.get("follow_through_duration_ms"),
            "motion_type": events.get("motion_type"),
        },
        "uncertainty": events.get("uncertainty_frames"),
    }
    predictions = build_jump_predictions(features_at_release=features, features_after_200ms=early_features)
    predictions["release"]["cutoff_frame"] = shot.release_frame
    predictions["release_plus_200ms"]["cutoff_frame"] = early_cutoff
    return {
        "shot_type": type_label,
        "motion_events": events,
        "distance": distance_record,
        "defenders": defenders,
        "mechanics_assessment": mechanics,
        "predictions": predictions,
        "track_ids": {"shooter": shooter_id, "shooter_confidence": round(shooter_association_confidence, 3), "defenders": [item["id"] for item in defenders]},
        "takeoff_image": list(takeoff_image) if takeoff_image else None,
        "rim_image": list(rim.center) if rim else None,
        "prediction_features": features,
    }
