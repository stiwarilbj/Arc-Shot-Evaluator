"""Independently decode an exported personal silhouette (no inference needed)."""

import argparse
import json
import subprocess
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np


def validate(path: Path):
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS)
    width, height = (
        capture.get(cv2.CAP_PROP_FRAME_WIDTH),
        capture.get(cv2.CAP_PROP_FRAME_HEIGHT),
    )
    count, chroma = 0, 0
    while True:
        ok, image = capture.read()
        if not ok:
            break
        count += 1
        chroma = max(
            chroma, int((image.max(axis=2).astype(int) - image.min(axis=2)).max())
        )
    capture.release()
    probe = subprocess.run(
        [
            imageio_ffmpeg.get_ffmpeg_exe(),
            "-hide_banner",
            "-i",
            str(path),
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
    )
    if probe.returncode or "Audio:" in probe.stderr.decode(errors="replace"):
        raise ValueError("Export has audio or cannot be independently decoded")
    if (
        not count
        or abs(fps - 30) > 0.001
        or width > 1280
        or height > 720
        or count > 450
        or chroma > 2
    ):
        raise ValueError(
            f"Invalid silhouette export: {count=} {fps=} {width=} {height=} {chroma=}"
        )
    return dict(
        frames=count,
        fps=fps,
        width=width,
        height=height,
        max_channel_difference=chroma,
        audio=False,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    print(json.dumps(validate(parser.parse_args().video), indent=2))
