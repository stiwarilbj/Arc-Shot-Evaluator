from backend.domain.models import BoundingBox
from backend.analysis.vision_models import add_model_hoops, select_rim_track


def test_rim_track_rejects_persistent_edge_decoy() -> None:
    frames: list[list[BoundingBox]] = []
    for frame in range(60):
        actual_x = 90 + frame * 0.4
        frames.append(
            [
                BoundingBox(actual_x, 130, actual_x + 108, 160, 0.84, "color"),
                BoundingBox(1242, 205, 1279, 216, 0.76, "color"),
            ]
        )
    selected = select_rim_track(frames, (1280, 720))
    assert selected[30] is not None
    assert selected[30].center[0] < 300
    assert selected[30].width > 90


def test_tall_learned_hoop_uses_contained_physical_rim_proposal() -> None:
    learned = BoundingBox(220, 675, 316, 801, 0.88, "model")
    physical = BoundingBox(203, 711, 276, 733, 0.68, "color")

    merged = add_model_hoops([physical], [learned])

    assert len(merged) == 1
    assert merged[0].source == "hybrid"
    assert merged[0].width == physical.width
    assert merged[0].height == physical.height


def test_learned_rim_support_beats_persistent_orange_decoy() -> None:
    frames: list[list[BoundingBox]] = []
    for frame in range(54):
        actual_x = 420 + frame * 0.35
        frames.append(
            [
                BoundingBox(actual_x, 138, actual_x + 32, 148, 0.78, "hybrid" if frame % 3 else "model"),
                BoundingBox(680 + frame * 0.1, 445, 700 + frame * 0.1, 453, 0.88, "color"),
            ]
        )
    selected = select_rim_track(frames, (1280, 720))
    assert selected[30] is not None
    assert selected[30].center[0] < 500


def test_portrait_rim_track_ignores_tiny_orange_edge_fragments() -> None:
    frames: list[list[BoundingBox]] = []
    for frame in range(48):
        frames.append(
            [
                BoundingBox(205, 675, 320, 801, 0.88, "model"),
                BoundingBox(252, 708, 302, 720, 0.72, "color"),
                BoundingBox(264, 724, 284, 730, 0.91, "color"),
            ]
        )

    selected = select_rim_track(frames, (1080, 1920))
    assert selected[30] is not None
    assert selected[30].width >= 45
    assert selected[30].center[1] < 720
