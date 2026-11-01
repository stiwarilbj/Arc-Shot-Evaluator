"""Neutral edge filtering must remain source-free and export-compatible."""
import cv2
import numpy as np
import pytest

from backend.jumper.neutral_edges import neutral_edges
from backend.jumper.pipeline import encoder, silhouette_pixels
from backend.jumper.video_validation import silhouette_proof, validate_finished_video, validate_neutral_pixels


def test_edges_encode_decode_and_restore_validation(tmp_path):
    y, x = np.indices((96, 128))
    labels = np.where(x < y, 1, np.where(x < y + 25, 2, 0)).astype(np.uint8)
    original = labels.copy()
    hard = silhouette_pixels(labels, 1, True)
    smooth = neutral_edges(hard)
    np.testing.assert_array_equal(labels, original)
    assert np.any(smooth != hard)
    assert np.all(smooth[..., 0] == smooth[..., 1])
    assert smooth[40, 10, 0] == 0
    assert smooth[10, 120, 0] == 224
    validate_neutral_pixels(smooth)
    output = tmp_path / "neutral.mp4"
    with encoder(output, 128, 96) as stream:
        for _ in range(6):
            stream.write(smooth.tobytes())
    validate_finished_video(output, 128, 96, 6, [silhouette_proof(smooth)] * 6, neutral=True, profile="palette")
    cap = cv2.VideoCapture(str(output))
    try:
        ok, decoded = cap.read()
        assert ok
        assert np.max(decoded.max(axis=2).astype(int) - decoded.min(axis=2)) <= 8
    finally:
        cap.release()


@pytest.mark.parametrize("value", [0, 64, 128, 200, 224])
def test_constant_and_single_pixel(value):
    image = np.full((1, 1, 3), value, np.uint8)
    np.testing.assert_array_equal(neutral_edges(image), image)


def test_invalid_geometry():
    with pytest.raises(ValueError, match="geometry"):
        neutral_edges(np.zeros((0, 2, 3), np.uint8))
