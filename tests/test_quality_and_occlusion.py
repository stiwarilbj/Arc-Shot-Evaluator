from backend.analysis.pipeline import (
    VideoMetadata,
    adjust_shot_confidence,
    build_footage_quality_report,
    estimate_mechanics_quality,
    evaluate_net_occlusion,
)
from backend.domain.models import BoundingBox, BallCandidate, FrameDetections, PlayerPose, BallTrackPoint


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

    good_make = adjust_shot_confidence(0.88, "make", good_quality)
    rough_make = adjust_shot_confidence(0.88, "make", rough_quality)
    miss = adjust_shot_confidence(0.88, "miss", good_quality)
    assert good_make >= 0.88
    assert rough_make < good_make
    assert miss < good_make
    assert rough_make <= 0.78
