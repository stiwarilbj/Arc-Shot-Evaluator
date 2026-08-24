from pathlib import Path

import cv2
import numpy as np

from backend.analysis.pipeline import probe_video
from backend.analysis.video_normalization import normalize_video, normalized_fps


def test_normalized_fps_caps_and_repairs_unusual_rates() -> None:
    assert normalized_fps(12) == 20
    assert normalized_fps(29.97) == 30
    assert normalized_fps(59.94) == 60
    assert normalized_fps(500) == 30


def test_normalize_video_creates_browser_safe_mp4(tmp_path: Path) -> None:
    source = tmp_path / "camera.avi"
    writer = cv2.VideoWriter(str(source), cv2.VideoWriter_fourcc(*"MJPG"), 12, (160, 120))
    assert writer.isOpened()
    for frame in range(24):
        image = np.zeros((120, 160, 3), dtype=np.uint8)
        cv2.circle(image, (20 + frame * 3, 50), 8, (0, 120, 240), -1)
        writer.write(image)
    writer.release()

    output = normalize_video(source, tmp_path / "original.mp4")
    meta = probe_video(output)

    assert output.is_file()
    assert (meta.width, meta.height) == (160, 120)
    assert meta.fps == 20
    assert meta.frame_count >= 38
