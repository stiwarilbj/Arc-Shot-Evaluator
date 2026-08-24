from backend.analysis.pipeline import BallTrackCandidate, predict_ball_with_camera_motion, track_ball_from_release_candidate
from backend.domain.models import BoundingBox, BallCandidate, FrameDetections, BallTrackPoint


def test_ball_prediction_is_relative_to_a_moving_rim_anchor() -> None:
    rims = [BoundingBox(100 + frame * 4, 100, 120 + frame * 4, 110, 0.9) for frame in range(8)]
    beam = BallTrackCandidate(
        [BallTrackPoint(0, 210, 300, 0.9), BallTrackPoint(1, 214, 298, 0.9)],
        score=1.0,
    )

    predicted_x, predicted_y, vx, vy = predict_ball_with_camera_motion(beam, 5, rims)

    assert round(predicted_x, 3) == 230.0
    assert round(predicted_y, 3) == 290.0
    assert round(vx, 3) == 0.0
    assert round(vy, 3) == -2.0


def test_blur_aware_tracking_bridges_a_long_detection_gap() -> None:
    rims = [BoundingBox(100, 100, 120, 110, 0.9) for _ in range(16)]
    evidence = [FrameDetections(sharpness=0.12) for _ in range(16)]
    evidence[0].balls = [BallCandidate(220, 350, 0.9, 12, "model")]
    evidence[9].balls = [BallCandidate(220, 250, 0.72, 12, "color")]

    trace = track_ball_from_release_candidate(evidence, 0, evidence[0].balls[0], 30.0, rims, (1280, 720))
    observed_frames = {point.frame for point in trace if point.observed}

    assert 9 in observed_frames
