"""Validate export integrity; tracking accuracy still requires human review."""

import re
import subprocess
import tempfile
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np

BLOCK = 8
CHROMA_TOLERANCE = 8
LUMA_TOLERANCE = 16


def validate_composite(image, labels, target, kind):
    if image.dtype != np.uint8 or image.shape != (*labels.shape, 3):
        raise ValueError("Invalid output frame size")
    expected = np.where(labels == 0, 224, np.where(labels == target, 0, 128))
    checked = np.ones(labels.shape, dtype=bool)
    if kind == "reveal":
        checked = labels == 0
    elif kind == "highlight":
        checked = labels != target
        expected = np.where(labels == 0, 224, 128)
    if np.any(image[checked] != expected[checked, None]):
        raise ValueError("Output frame contains an incorrect silhouette color")


def silhouette_proof(image):
    height, width = image.shape[:2]
    proof = np.full(
        ((height + BLOCK - 1) // BLOCK, (width + BLOCK - 1) // BLOCK), 255, np.uint8
    )
    for by in range(proof.shape[0]):
        for bx in range(proof.shape[1]):
            x, y = bx * BLOCK, by * BLOCK
            value = image[y, x, 0]
            region = image[
                max(0, y - 2) : min(height, y + BLOCK + 2),
                max(0, x - 2) : min(width, x + BLOCK + 2),
                0,
            ]
            if np.all(region == value):
                proof[by, bx] = value
    return proof


def validate_decoded_pixels(image, proof):
    height, width = image.shape[:2]
    if proof.shape != ((height + BLOCK - 1) // BLOCK, (width + BLOCK - 1) // BLOCK):
        raise ValueError("Invalid decoded output size")
    low = image.min(axis=2).astype(np.int16)
    high = image.max(axis=2).astype(np.int16)
    expected = (
        proof.repeat(BLOCK, axis=0)
        .repeat(BLOCK, axis=1)[:height, :width]
        .astype(np.int16)
    )
    if np.any(high - low > CHROMA_TOLERANCE) or np.any(
        (expected != 255)
        & (np.maximum(abs(high - expected), abs(low - expected)) > LUMA_TOLERANCE)
    ):
        raise ValueError("Encoded video changed the silhouette colors")


def validate_finished_video(
    path: Path, width: int, height: int, count: int, proofs=None
):
    if not (
        2 <= width <= 1280
        and 2 <= height <= 720
        and width % 2 == height % 2 == 0
        and 2 <= count <= 450
    ):
        raise ValueError("Invalid finished-video geometry or frame count")
    if proofs is not None and len(proofs) != count:
        raise ValueError("Missing output color checks")
    # Bundled FFmpeg independently decodes all streams. -xerror prevents corrupt
    # packets being silently concealed. No dependency on a system ffprobe.
    with tempfile.TemporaryFile() as errors:
        try:
            result = subprocess.run(
                [
                    imageio_ffmpeg.get_ffmpeg_exe(),
                    "-nostdin",
                    "-hide_banner",
                    "-xerror",
                    "-err_detect",
                    "explode",
                    "-i",
                    str(path),
                    "-map",
                    "0",
                    "-f",
                    "null",
                    "-",
                ],
                stdout=subprocess.DEVNULL,
                stderr=errors,
                timeout=120,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError("Finished-video decoding timed out") from error
        errors.seek(0)
        metadata = errors.read().decode(errors="replace")
    if result.returncode or re.search(r"Stream #.*Audio:", metadata):
        raise ValueError("Export has audio or cannot be independently decoded")
    if len(re.findall(r"Stream #.*Video:", metadata.split("Output #")[0])) != 1:
        raise ValueError("Export must contain one video track")
    if any(
        abs(float(angle)) > 0.001
        for angle in re.findall(r"rotation of ([\d.+-]+)", metadata)
    ):
        raise ValueError("Export orientation changed")
    duration = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", metadata)
    if (
        not duration
        or abs(
            int(duration[1]) * 3600
            + int(duration[2]) * 60
            + float(duration[3])
            - count / 30
        )
        > 0.011
    ):
        raise ValueError("Export duration changed")
    capture = cv2.VideoCapture(str(path))
    try:
        if (
            not capture.isOpened()
            or abs(capture.get(cv2.CAP_PROP_FPS) - 30) > 0.001
            or capture.get(cv2.CAP_PROP_FRAME_WIDTH) != width
            or capture.get(cv2.CAP_PROP_FRAME_HEIGHT) != height
        ):
            raise ValueError("Export dimensions, orientation or frame rate changed")
        index = 0
        while True:
            ok, image = capture.read()
            if not ok:
                break
            if index >= count or image.shape != (height, width, 3):
                raise ValueError("Export contains unexpected frames")
            timestamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000
            if not np.isfinite(timestamp) or abs(timestamp - index / 30) > 0.002:
                raise ValueError("Encoded video has an incorrect frame timeline")
            if proofs is not None:
                validate_decoded_pixels(image, proofs[index])
            index += 1
        if index != count:
            raise ValueError("Export contains missing or undecodable frames")
    finally:
        capture.release()
