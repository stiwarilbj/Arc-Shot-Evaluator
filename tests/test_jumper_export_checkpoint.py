from contextlib import contextmanager
from copy import deepcopy

import cv2
import numpy as np
import pytest

from backend.jumper.export_checkpoint import TTL, render_with_retry, seal, valid


def fixture(tmp_path):
    frames, masks = tmp_path / "frames", tmp_path / "masks"
    frames.mkdir()
    masks.mkdir()
    for i in range(3):
        cv2.imwrite(str(frames / f"{i}.png"), np.full((4, 8, 3), 99, np.uint8))
        np.save(masks / f"{i:06d}.npy", np.full((4, 8), i, np.uint8))
    return sorted(frames.glob("*")), masks


def test_checkpoint_boundaries_and_corruption(tmp_path):
    frames, masks = fixture(tmp_path)
    item = seal(frames, masks, 1, 1.25, now=100)
    assert valid(item, frames, masks, 1, 1.25, now=100 + TTL)
    assert not valid(item, frames, masks, 1, 1.25, now=101 + TTL)
    assert not valid(item, frames, masks, 2, 1.25, now=100)
    assert not valid(item, frames, masks, 1, 0, now=100)
    assert seal(frames, masks, 1, 0, limit=1) is None
    changed = deepcopy(item)
    changed["version"] = 2
    assert not valid(changed, frames, masks, 1, 1.25, now=100)
    np.save(masks / "000001.npy", np.full((4, 8), 42, np.uint8))
    assert not valid(item, frames, masks, 1, 1.25, now=100)
    (masks / "000002.npy").unlink()
    assert seal(frames, masks, 1, 0) is None


def test_export_only_retry_is_bounded(tmp_path):
    frames, masks = fixture(tmp_path)
    calls, stages = [], []

    def render(*args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            raise RuntimeError("encoder failed")
        return {"ready": True}

    result = render_with_retry(
        render,
        frames,
        masks,
        tmp_path,
        1,
        "job",
        start=0,
        silhouette=True,
        progress=lambda *args: stages.append(args),
    )
    assert result == {"ready": True}
    assert len(calls) == 2
    assert calls[0] == calls[1]
    assert any("Retrying export" in stage[0] for stage in stages)
    calls.clear()

    def fails(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("still broken")

    with pytest.raises(RuntimeError, match="still broken"):
        render_with_retry(
            fails,
            frames,
            masks,
            tmp_path,
            1,
            "job",
            start=0,
            silhouette=True,
            progress=lambda *args: None,
        )
    assert len(calls) == 2


def test_real_encoder_failure_restarts_from_unchanged_masks(tmp_path, monkeypatch):
    from backend.jumper import pipeline

    frames, masks = fixture(tmp_path)
    original = pipeline.encoder
    attempts = []

    @contextmanager
    def flaky(*args, **kwargs):
        attempts.append(1)
        with original(*args, **kwargs) as stream:
            yield stream
        if len(attempts) == 1:
            raise RuntimeError("injected finalization failure")

    monkeypatch.setattr(pipeline, "encoder", flaky)
    paths = render_with_retry(
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
    assert len(attempts) == 2
    assert paths["quiz"] == paths["highlight"] == paths["reveal"]
    video = cv2.VideoCapture(str(tmp_path / "out" / paths["quiz"]["file"]))
    try:
        assert video.get(cv2.CAP_PROP_FRAME_COUNT) == 3
        ok, frame = video.read()
        assert ok
        assert np.max(np.abs(frame[:, :, 0].astype(int) - frame[:, :, 1])) <= 1
    finally:
        video.release()
