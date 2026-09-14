from types import SimpleNamespace

import backend.analysis.pipeline as pipeline_module
from backend.analysis.jump_shot import (
    analyze_jump_shot,
    assign_player_tracks,
    defender_context,
    distance_from_calibration,
)
from backend.analysis.pipeline import refresh_saved_analysis
from backend.domain.models import BallTrackPoint, BoundingBox, FrameDetections, PlayerPose, ShotAnalysis
from backend.prediction.jump_models import EARLY_FLIGHT_CUTOFF, cutoff_frame, build_jump_predictions


def pose(x: float, y: float, confidence: float = 0.9) -> PlayerPose:
    points = [(x, y, confidence)] * 17
    # Feet and wrists are the only points these tests need to distinguish.
    points[9] = (x, y - 90, confidence)
    points[10] = (x + 8, y - 88, confidence)
    points[15] = (x - 10, y, confidence)
    points[16] = (x + 10, y, confidence)
    return PlayerPose(BoundingBox(x - 25, y - 170, x + 25, y, confidence, "pose"), points, confidence)


def test_player_tracks_keep_multiple_people_and_reset_at_cuts() -> None:
    evidence = [
        FrameDetections(poses=[pose(100, 300), pose(300, 300)]),
        FrameDetections(poses=[pose(104, 296), pose(296, 300)]),
        FrameDetections(scene_cut=True, poses=[pose(106, 294), pose(296, 300)]),
    ]

    summaries, frame_tracks = assign_player_tracks(evidence)

    assert len(summaries) >= 4
    assert len(frame_tracks[0]) == 2
    assert {item[0] for item in frame_tracks[2]}.isdisjoint({item[0] for item in frame_tracks[1]})


def test_manual_court_homography_reports_distance_and_three_point_type() -> None:
    calibration = {
        "preset": "nba",
        "image_points": [[0, 0], [100, 0], [100, 100], [0, 100]],
        "world_points": [[0, 0], [10, 0], [10, 10], [0, 10]],
        "uncertainty_m": 0.1,
    }

    record = distance_from_calibration(calibration, (99, 50), (0, 0))

    assert record["availability"] is True
    assert record["value"] == 11.09
    assert record["shot_type"] == "three_pointer"
    assert record["method"] == "court_plane_homography"


def test_defender_context_preserves_missing_world_units() -> None:
    frames = [
        [("player-1", pose(100, 300)), ("player-2", pose(150, 300))],
        [("player-1", pose(100, 300)), ("player-2", pose(142, 300))],
    ]

    defenders = defender_context(frames, "player-1", 1, 30)

    assert len(defenders) == 1
    assert defenders[0]["id"] == "player-2"
    assert defenders[0]["separation"]["units"] == "px"
    assert defenders[0]["closing_speed"]["availability"] is True
    assert defenders[0]["role"] == "unresolved_opponent"


def test_jump_prediction_cutoff_is_explicit_and_unavailable() -> None:
    predictions = build_jump_predictions(features_at_release={"distance_m": 7.5}, features_after_200ms={})

    assert cutoff_frame(100, 30, EARLY_FLIGHT_CUTOFF) == 106
    assert predictions["release"]["probability"] is None
    assert predictions["release_plus_200ms"]["status"] == "unavailable_unvalidated"


def test_jump_shot_payload_contains_motion_distance_defender_and_predictions() -> None:
    shooter = pose(100, 300)
    defender = pose(170, 300)
    evidence = [FrameDetections(poses=[shooter, defender]) for _ in range(8)]
    tracks = [[("player-1", shooter), ("player-2", defender)] for _ in range(8)]
    shot = ShotAnalysis(
        id=1,
        outcome="review",
        confidence=0.8,
        release_frame=4,
        release_time=4 / 30,
        end_frame=7,
        release_speed_ms=None,
        release_height_m=None,
        entry_angle_deg=None,
        arc_peak_m=None,
        form={"elbow": None, "knee": None, "shoulder": None, "hip": None},
        flags=[],
        evidence={},
        trace=[BallTrackPoint(4, 100, 200, 0.9)],
    )
    meta = SimpleNamespace(fps=30, height=720)
    rims = [BoundingBox(0, 0, 20, 10, 0.9, "model") for _ in range(8)]

    result = analyze_jump_shot(shot=shot, evidence=evidence, frame_tracks=tracks, meta=meta, rims=rims)

    assert "motion_events" in result
    assert result["distance"]["availability"] is False
    assert len(result["defenders"]) == 1
    assert result["predictions"]["release"]["probability"] is None


def test_saved_jump_context_recalculates_distance_without_mutating_evidence(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "jump-session"
    session_dir.mkdir()
    original = {
        "analysis_version": "3.0.0",
        "shot_mode": "jump_shot",
        "session": {"id": "jump-session", "fps": 30},
        "quality": {"tier": "limited", "camera_motion": 0.0, "blur_score": 0.8, "pose_coverage": 0.8},
        "shots": [{
            "id": 1, "outcome": "make", "confidence": 0.9, "release_frame": 20,
            "release_time": 2 / 3, "end_frame": 40, "release_speed_ms": None,
            "release_height_m": None, "entry_angle_deg": None, "arc_peak_m": None,
            "form": {"elbow": None, "knee": None, "shoulder": None, "hip": None},
            "flags": [], "evidence": {
                "shot_mode": "jump_shot", "takeoff_image": [99, 50], "rim_image": [0, 0],
                "distance": {"value": None, "availability": False},
            },
        }],
    }
    (session_dir / "analysis.json").write_text(__import__("json").dumps(original))
    (session_dir / "corrections.json").write_text(__import__("json").dumps({
        "version": 2, "shots": {}, "session_context": {"court_calibration": {
            "preset": "nba", "image_points": [[0, 0], [100, 0], [100, 100], [0, 100]],
            "world_points": [[0, 0], [10, 0], [10, 10], [0, 10]], "uncertainty_m": 0.1,
        }},
    }))
    monkeypatch.setattr(pipeline_module, "ANALYSIS_SESSIONS_DIR", tmp_path)

    refreshed = refresh_saved_analysis(original)

    assert refreshed["shots"][0]["evidence"]["distance"]["availability"] is True
    assert refreshed["shots"][0]["evidence"]["shot_type"] == "three_pointer"
    assert original["shots"][0]["evidence"]["distance"]["availability"] is False
