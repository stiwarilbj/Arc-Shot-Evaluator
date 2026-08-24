from __future__ import annotations

import subprocess
import shutil
from pathlib import Path

import cv2
import imageio_ffmpeg


MAX_ANALYSIS_SECONDS = 20 * 60
MAX_EDGE_PIXELS = 1920


def _source_fps(path: Path) -> float:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        capture.release()
        raise ValueError("The video could not be decoded. Try exporting it as an MP4 with H.264 video.")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    capture.release()
    return fps


def normalized_fps(source_fps: float) -> int:
    """Choose a stable analysis cadence without inventing high-speed frames."""
    if not 1.0 <= source_fps <= 240.0:
        return 30
    if source_fps >= 45:
        return 60
    return max(20, min(30, round(source_fps)))


def _compatible_h264(source: Path) -> bool:
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        capture.release()
        return False
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fourcc_value = int(capture.get(cv2.CAP_PROP_FOURCC) or 0)
    capture.release()
    codec = "".join(chr((fourcc_value >> (8 * index)) & 0xFF) for index in range(4)).lower()
    duration = frames / max(1.0, fps)
    if duration > MAX_ANALYSIS_SECONDS:
        raise ValueError("Videos longer than 20 minutes must be split into smaller sessions before analysis.")
    return (
        codec in {"h264", "avc1"}
        and 15 <= fps <= 60.5
        and frames >= 2
        and 0 < width <= MAX_EDGE_PIXELS
        and 0 < height <= MAX_EDGE_PIXELS
    )


def _remux_h264(source: Path, output: Path) -> None:
    """Move compatible H.264 frames into MP4 without altering detector pixels."""
    executable = imageio_ffmpeg.get_ffmpeg_exe()
    temporary = output.with_name(f".{output.stem}-remuxing.mp4")
    temporary.unlink(missing_ok=True)
    command = [
        executable,
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(temporary),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0 or not temporary.is_file():
        temporary.unlink(missing_ok=True)
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "unknown remux error"
        raise ValueError(f"The H.264 video could not be prepared for browser playback: {detail}")
    temporary.replace(output)


def normalize_video(source: Path, output: Path) -> Path:
    """Create a browser-safe, rotation-corrected, constant-frame-rate MP4.

    ffmpeg applies container rotation metadata by default. Re-encoding also
    removes variable frame timing and codec/container differences before the
    computer-vision and browser playback paths see the file.
    """
    source = source.resolve()
    output = output.resolve()
    if source == output:
        return output

    output.parent.mkdir(parents=True, exist_ok=True)
    if _compatible_h264(source):
        if source.suffix.lower() in {".mp4", ".m4v"}:
            shutil.copy2(source, output)
        else:
            _remux_h264(source, output)
        return output

    temporary = output.with_name(f".{output.stem}-normalizing.mp4")
    temporary.unlink(missing_ok=True)
    fps = normalized_fps(_source_fps(source))
    executable = imageio_ffmpeg.get_ffmpeg_exe()
    scale = (
        f"scale='min({MAX_EDGE_PIXELS},iw)':'min({MAX_EDGE_PIXELS},ih)':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    )
    command = [
        executable,
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        scale,
        "-r",
        str(fps),
        "-fps_mode",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-map_metadata",
        "-1",
        "-max_muxing_queue_size",
        "1024",
        str(temporary),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0 or not temporary.is_file():
        temporary.unlink(missing_ok=True)
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "unknown decoder error"
        raise ValueError(f"The video could not be normalized: {detail}")

    capture = cv2.VideoCapture(str(temporary))
    opened = capture.isOpened()
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frames / max(1.0, float(capture.get(cv2.CAP_PROP_FPS) or 0.0))
    capture.release()
    if not opened or frames < 2:
        temporary.unlink(missing_ok=True)
        raise ValueError("The normalized video did not contain enough decodable frames.")
    if duration > MAX_ANALYSIS_SECONDS:
        temporary.unlink(missing_ok=True)
        raise ValueError("Videos longer than 20 minutes must be split into smaller sessions before analysis.")
    temporary.replace(output)
    return output
