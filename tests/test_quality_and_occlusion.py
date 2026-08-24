from backend.analysis.pipeline import (
    VideoMetadata,
    adjust_shot_confidence,
    build_footage_quality_report,
    estimate_mechanics_quality,
    estimate_shot_quality,
    evaluate_net_occlusion,
    refresh_saved_analysis,
    summarize_session,
)
from backend.domain.models import BoundingBox, BallCandidate, FrameDetections, PlayerPose, BallTrackPoint, ShotAnalysis


def test_quality_report_distinguishes_usable_and_empty_footage() -> None:
    meta = VideoMetadata(1280, 720, 30, 100, 3.333)
    pose = PlayerPose(BoundingBox(700, 180, 930, 700, 0.9), [(0.0, 0.0, 0.9)] * 17, 0.9)
    good_evidence = [
        FrameDetections(
            balls=[BallCandidate(800, 260, 0.8, 12, "model")] if frame % 8 == 0 else [],
            poses=[pose],
        )
        for frame in range(100)
    ]
    good_rims = [BoundingBox(120, 170, 230, 205, 0.82) for _ in range(100)]

    assert build_footage_quality_report(good_evidence, good_rims, meta)["tier"] == "good"
    empty = build_footage_quality_report([FrameDetections() for _ in range(100)], [None] * 100, meta)
    assert empty["tier"] == "insufficient"
    assert len(empty["messages"]) >= 3


def test_net_occlusion_evidence_separates_drag_from_freefall_like_drop() -> None:
    rim = BoundingBox(50, 95, 150, 120, 0.9)
    before = [
        BallTrackPoint(7, 100, 70, 0.9),
        BallTrackPoint(8, 100, 80, 0.9),
        BallTrackPoint(9, 100, 90, 0.9),
        BallTrackPoint(10, 100, 100, 0.9),
    ]
    dragged = evaluate_net_occlusion(before + [BallTrackPoint(13, 100, 112, 0.8)], before[-1], rim, 30)
    freefall_like = evaluate_net_occlusion(before + [BallTrackPoint(13, 100, 154, 0.8)], before[-1], rim, 30)

    assert dragged["net_drag_confirmed"] is True
    assert freefall_like["net_drag_confirmed"] is False
    assert float(freefall_like["net_slowdown_ratio"]) > 1.05


def test_confidence_respects_mechanics_quality_and_outcome() -> None:
    good_form = {"elbow": 165.0, "knee": 160.0, "shoulder": 120.0, "hip": 170.0}
    rough_form = {"elbow": 130.0, "knee": 133.0, "shoulder": 107.0, "hip": 142.0}

    good_quality = estimate_mechanics_quality(good_form)
    rough_quality = estimate_mechanics_quality(rough_form)
    assert good_quality is not None and rough_quality is not None
    assert good_quality > rough_quality

    good_make = adjust_shot_confidence(0.78, "make", good_quality, outcome_supported=True)
    rough_make = adjust_shot_confidence(0.88, "make", rough_quality)
    miss = adjust_shot_confidence(0.88, "miss", good_quality)
    assert good_make >= 0.84
    assert rough_make < good_make
    assert miss < good_make
    assert rough_make <= 0.78


def test_confidence_separates_far_poor_misses_from_close_clean_misses() -> None:
    close_clean = adjust_shot_confidence(
        0.88,
        "miss",
        1.0,
        trajectory_quality=0.92,
        follow_through_quality=0.98,
        miss_proximity=0.84,
    )
    far_off = adjust_shot_confidence(
        0.88,
        "miss",
        0.25,
        trajectory_quality=0.22,
        follow_through_quality=0.25,
        miss_proximity=0.04,
    )

    assert close_clean >= 0.84
    assert far_off <= 0.35
    assert close_clean > far_off


def test_very_poor_mechanics_lower_confidence_even_when_make_is_supported() -> None:
    confidence = adjust_shot_confidence(
        0.92,
        "make",
        0.25,
        outcome_supported=True,
        trajectory_quality=0.24,
        follow_through_quality=0.22,
    )

    assert confidence <= 0.35


def test_ft_projection_rewards_clean_form_and_penalizes_rough_release() -> None:
    clean = ShotAnalysis(
        id=1,
        outcome="miss",
        confidence=0.88,
        release_frame=100,
        release_time=3.0,
        end_frame=130,
        release_speed_ms=7.0,
        release_height_m=2.3,
        entry_angle_deg=50.0,
        arc_peak_m=3.7,
        form={"elbow": 165.0, "knee": 160.0, "shoulder": 120.0, "hip": 170.0},
        flags=[],
        evidence={"miss_proximity": 0.82},
        trace=[],
    )
    rough = ShotAnalysis(
        id=2,
        outcome="make",
        confidence=0.88,
        release_frame=140,
        release_time=4.0,
        end_frame=170,
        release_speed_ms=2.0,
        release_height_m=1.3,
        entry_angle_deg=25.0,
        arc_peak_m=2.55,
        form={"elbow": 55.0, "knee": 70.0, "shoulder": 25.0, "hip": 80.0},
        flags=[],
        evidence={},
        trace=[],
    )

    summary = summarize_session([clean, rough])

    assert summary["predicted_ft_pct"] is not None
    assert clean.evidence["predicted_ft_pct"] > rough.evidence["predicted_ft_pct"]
    assert rough.evidence["predicted_ft_pct"] < 60
    assert estimate_shot_quality(clean.form, 7.0, 2.3, 50.0, 3.7) > estimate_shot_quality(
        rough.form, 2.0, 1.3, 25.0, 2.55
    )


def test_saved_sessions_backfill_predicted_ft_and_clean_coach_copy() -> None:
    payload = {
        "quality": {"tier": "good", "camera_motion": 0.02, "blur_score": 0.8, "pose_coverage": 0.8},
        "shots": [
            {
                "id": 1,
                "outcome": "make",
                "confidence": 0.78,
                "release_frame": 100,
                "release_time": 3.0,
                "end_frame": 130,
                "release_speed_ms": None,
                "release_height_m": None,
                "entry_angle_deg": 51.0,
                "arc_peak_m": None,
                "form": {"elbow": 166.0, "knee": 160.0, "shoulder": 120.0, "hip": 170.0},
                "flags": [],
                "evidence": {"rim_track_confidence": 0.9, "pose_confidence": 0.9},
            }
        ],
    }

    refreshed = refresh_saved_analysis(payload)

    assert refreshed["summary"]["predicted_ft_pct"] is not None
    assert refreshed["shots"][0]["evidence"]["predicted_ft_pct"] is not None
    assert refreshed["shots"][0]["confidence"] > 0.78
    assert not refreshed["shots"][0]["coaching"]["intro"].endswith(".")
