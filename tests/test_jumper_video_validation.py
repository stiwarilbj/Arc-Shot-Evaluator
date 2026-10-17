"""Real encoder/decoder integrity regressions, without loading inference."""

from contextlib import contextmanager
import subprocess

import cv2
import imageio_ffmpeg
import numpy as np
import pytest

from backend.jumper import pipeline
from backend.jumper.export_checkpoint import render_with_retry
from backend.jumper.video_validation import (
    validate_composite,
    silhouette_proof,
    validate_decoded_pixels,
    validate_finished_video,
)


def fixture(tmp_path):
    labels = np.zeros((48, 64), np.uint8)
    labels[8:40, 16:32] = 1
    labels[8:40, 40:56] = 2
    image = pipeline.composite(
        np.full((48, 64, 3), (255, 30, 50), np.uint8), labels, 1
    )[0]
    video = tmp_path / "valid.mp4"
    with pipeline.encoder(video, 64, 48) as stream:
        for _ in range(3):
            stream.write(image.tobytes())
    return video, image, labels


def test_exact_and_lossy_colors(tmp_path):
    video, image, labels = fixture(tmp_path)
    validate_composite(image, labels, 1, "quiz")
    proofs = [silhouette_proof(image)] * 3
    validate_finished_video(video, 64, 48, 3, proofs)
    tolerant = np.minimum(image.astype(int) + 6, 255).astype(np.uint8)
    validate_decoded_pixels(tolerant, proofs[0])
    wrong = image.copy()
    wrong[0, 0] = 100
    with pytest.raises(ValueError, match="color"):
        validate_decoded_pixels(wrong, proofs[0])
    with pytest.raises(ValueError, match="color"):
        validate_composite(wrong, labels, 1, "quiz")
    wrong[0, 0] = (224, 224, 200)
    with pytest.raises(ValueError, match="color"):
        validate_decoded_pixels(wrong, proofs[0])
    # Old foreground-color outputs remain supported, but not leaked background.
    original = np.full_like(image, (255, 30, 50))
    for kind, composite in zip(
        ("quiz", "reveal", "highlight"), pipeline.composite(original, labels, 1)
    ):
        validate_composite(composite, labels, 1, kind)


@pytest.mark.parametrize(
    "geometry", [(64, 48, 2), (64, 48, 4), (48, 64, 3), (62, 48, 3), (64, 48, 0)]
)
def test_wrong_timeline_or_geometry(tmp_path, geometry):
    video, _, _ = fixture(tmp_path)
    with pytest.raises(ValueError):
        validate_finished_video(video, *geometry)


def test_corrupt_and_audio_and_rotation(tmp_path):
    video, image, _ = fixture(tmp_path)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    audio = tmp_path / "audio.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(video),
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=48000:cl=mono",
            "-shortest",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            str(audio),
        ],
        check=True,
    )
    with pytest.raises(ValueError, match="audio"):
        validate_finished_video(audio, 64, 48, 3)
    rotated = tmp_path / "rotated.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-display_rotation",
            "180",
            "-i",
            str(video),
            "-c",
            "copy",
            str(rotated),
        ],
        check=True,
    )
    with pytest.raises(ValueError, match="orientation"):
        validate_finished_video(rotated, 64, 48, 3)
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(video.read_bytes()[:100])
    with pytest.raises(ValueError, match="decoded"):
        validate_finished_video(broken, 64, 48, 3)
    colored = tmp_path / "colored.mp4"
    with pipeline.encoder(colored, 64, 48) as stream:
        for _ in range(3):
            stream.write(np.full_like(image, (255, 0, 0)).tobytes())
    with pytest.raises(ValueError, match="color"):
        validate_finished_video(colored, 64, 48, 3, [silhouette_proof(image)] * 3)


def test_failed_validation_retries_encoding_not_tracking(tmp_path, monkeypatch):
    masks = tmp_path / "masks"
    masks.mkdir()
    frames = []
    for i in range(3):
        path = tmp_path / f"{i}.png"
        cv2.imwrite(str(path), np.zeros((48, 64, 3), np.uint8))
        frames.append(path)
        np.save(masks / f"{i:06d}.npy", np.ones((48, 64), np.uint8))
    encoder = pipeline.encoder
    calls = []

    @contextmanager
    def corrupted(path, *args):
        calls.append(1)
        with encoder(path, *args) as stream:
            yield stream
        if len(calls) == 1:
            path.write_bytes(b"broken export")

    monkeypatch.setattr(pipeline, "encoder", corrupted)
    result = render_with_retry(
        pipeline.render,
        frames,
        masks,
        tmp_path / "out",
        1,
        "job",
        start=0,
        silhouette=True,
        progress=lambda *args: None,
    )
    assert len(calls) == 2
    validate_finished_video(tmp_path / "out" / result["quiz"]["file"], 64, 48, 3)

    @contextmanager
    def always_corrupt(path, *args):
        calls.append(1)
        with encoder(path, *args) as stream:
            yield stream
        path.write_bytes(b"broken export")

    monkeypatch.setattr(pipeline, "encoder", always_corrupt)
    calls.clear()
    with pytest.raises(ValueError):
        render_with_retry(
            pipeline.render,
            frames,
            masks,
            tmp_path / "out",
            1,
            "job",
            start=0,
            silhouette=True,
            progress=lambda *args: None,
        )
    assert len(calls) == 2  # no invalid ready result or unbounded retry
