from backend.analysis.pipeline import find_pose_nearest_ball
from backend.domain.models import BoundingBox, BallCandidate, FrameDetections, PlayerPose


def _pose(box: BoundingBox, wrist: tuple[float, float]) -> PlayerPose:
    points = [(box.center[0], box.center[1], 0.9)] * 17
    points[9] = (*wrist, 0.95)
    points[10] = (*wrist, 0.9)
    return PlayerPose(box, points, 0.9)


def test_ball_association_prefers_containing_shooter_over_low_foreground_person() -> None:
    shooter = _pose(BoundingBox(700, 180, 850, 600), (790, 300))
    foreground = _pose(BoundingBox(80, 300, 340, 900), (150, 500))
    evidence = [FrameDetections(poses=[foreground, shooter])]

    selected = find_pose_nearest_ball(evidence, 0, BallCandidate(790, 300, 0.9, 40, "model"))

    assert selected is shooter
