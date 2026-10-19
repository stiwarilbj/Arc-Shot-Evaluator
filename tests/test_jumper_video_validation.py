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
    validate_neutral_pixels,
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
    validate_finished_video(video, 64, 48, 3, neutral=True)
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


def test_silhouette_export_never_reads_original_frames(tmp_path, monkeypatch):
    masks = tmp_path / "masks"
    masks.mkdir()
    labels = np.zeros((48, 64), np.uint8)
    labels[8:40, 16:32] = 1
    labels[8:40, 40:56] = 2
    for index in range(3):
        np.save(masks / f"{index:06d}.npy", labels)
    monkeypatch.setattr(
        pipeline.cv2,
        "imread",
        lambda *a: pytest.fail("original pixels read during silhouette export"),
    )
    monkeypatch.setattr(
        pipeline,
        "composite",
        lambda *a: pytest.fail("original-color composites created"),
    )
    result = pipeline.render(
        [tmp_path / "absent-source.png"] * 3,
        masks,
        tmp_path / "output",
        1,
        "test",
        silhouette=True,
    )
    assert result["quiz"] == result["highlight"] == result["reveal"]
    validate_finished_video(
        tmp_path / "output" / result["quiz"]["file"], 64, 48, 3, neutral=True
    )


def test_native_proof_matches_guarded_reference():
    rng = np.random.default_rng(42)
    for height, width in [(2, 2), (15, 21), (48, 64), (720, 1280)]:
        labels = rng.integers(
            0, 3, ((height + 17) // 18, (width + 17) // 18), dtype=np.uint8
        )
        labels = labels.repeat(18, axis=0).repeat(18, axis=1)[:height, :width]
        image = pipeline.silhouette_pixels(labels, 1)
        reference = np.full(((height + 7) // 8, (width + 7) // 8), 255, np.uint8)
        for by in range(reference.shape[0]):
            for bx in range(reference.shape[1]):
                x, y = bx * 8, by * 8
                value = image[y, x, 0]
                if np.all(
                    image[max(0, y - 2) : y + 10, max(0, x - 2) : x + 10, 0] == value
                ):
                    reference[by, bx] = value
        np.testing.assert_array_equal(silhouette_proof(image), reference)
    with pytest.raises(ValueError, match="color"):
        validate_neutral_pixels(np.full((48, 64, 3), 64, np.uint8))


def boundary_frames():
    images = []
    for offset in (4, 12, 20, 28, 36, 44):
        image = np.full((48, 64, 3), 224, np.uint8)
        image[8:40, offset:offset + 12] = 0
        images.append(image)
    return images


@pytest.mark.parametrize("fault,endpoint", [("repeat", "last"), ("omit_finish", "last"), ("shift", "first"), ("reverse", "first")])
def test_encoded_timeline_boundary_mismatch(tmp_path, fault, endpoint):
    from backend.jumper.video_validation import boundary_proof
    images = boundary_frames()
    wrong = {
        "repeat": [images[0]] * len(images),
        "omit_finish": images[:-1] + [images[-2]],
        "shift": images[1:] + [images[-1]],
        "reverse": images[::-1],
    }[fault]
    path = tmp_path / f"{fault}.mp4"
    with pipeline.encoder(path, 64, 48) as stream:
        for image in wrong:
            stream.write(image.tobytes())
    # Same geometry, frame count, timestamps and duration all pass without evidence.
    validate_finished_video(path, 64, 48, len(images))
    with pytest.raises(ValueError, match=f"{endpoint} frame.*intended timeline"):
        validate_finished_video(path, 64, 48, len(images),
                                boundaries=[boundary_proof(images[0]), boundary_proof(images[-1])])


def test_encoded_boundaries_and_rgb_partial_blocks(tmp_path):
    from backend.jumper.video_validation import boundary_proof, validate_boundary_pixels
    small = np.array([[[i * 10 + c for c in range(3)] for i in range(y * 6, y * 6 + 6)] for y in range(2)], np.uint8)
    assert boundary_proof(small).tolist() == [45, 46, 47, 75, 76, 77]
    images = boundary_frames()
    # Non-neutral foreground exercises the OpenCV BGR -> RGB conversion too.
    images[0][8:40, 4:16] = [180, 40, 20]
    images[-1][8:40, 44:56] = [20, 40, 180]
    path = tmp_path / "boundaries.mp4"
    with pipeline.encoder(path, 64, 48) as stream:
        for image in images:
            stream.write(image.tobytes())
    proofs = [boundary_proof(images[0]), boundary_proof(images[-1])]
    validate_finished_video(path, 64, 48, len(images), boundaries=proofs)
    validate_boundary_pixels(np.minimum(images[0].astype(int) + 3, 255).astype(np.uint8), proofs[0], "first")
    with pytest.raises(ValueError, match="boundary"):
        validate_finished_video(path, 64, 48, len(images), boundaries=[])
