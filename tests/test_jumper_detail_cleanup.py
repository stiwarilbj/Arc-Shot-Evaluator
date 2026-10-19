"""Detail frames end with tracking; regular frames/masks survive export retries."""
import hashlib
import json

import cv2
import numpy as np
import pytest
import torch

from backend import config
from backend.jumper import runner


@pytest.mark.parametrize("refine", [False, True])
@pytest.mark.parametrize("device_path,export_failures", [
    ("cpu", 0), ("gpu", 0), ("fallback", 1), ("fallback", 2), ("tracking_failure", 0),
])
def test_detail_frame_lifetime(tmp_path, monkeypatch, refine, device_path, export_failures):
    monkeypatch.setattr(runner, "check_resources", lambda *args, **kwargs: None)
    monkeypatch.setenv("ARCADE_JUMPER_CPU_FALLBACK", "1" if device_path == "cpu" else "0")
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True)
    monkeypatch.setattr(torch.mps, "set_per_process_memory_fraction", lambda _: None)
    monkeypatch.setattr(torch.mps, "empty_cache", lambda: None)
    weights = tmp_path / "weights"
    weights.mkdir()
    checkpoint = weights / "sam2.1_hiera_tiny.pt"
    checkpoint.write_bytes(b"checkpoint")
    monkeypatch.setattr(config, "MODEL_WEIGHTS_DIR", weights)
    monkeypatch.setattr(runner, "CHECKPOINT_SHA", hashlib.sha256(checkpoint.read_bytes()).hexdigest())
    job = dict(start=0, end=0.1, target_id=1, objects=[dict(id=1, prompts=[dict(frame=0, points=[[0.5, 0.5]], labels=[1])])],
               presentation="silhouette", refine_small_players=refine)
    (tmp_path / "request.json").write_text(json.dumps(job))
    detail = tmp_path / "detail-frames"
    original_frames = []
    mask_bytes = {}

    def extract(source, directory, *args, **kwargs):
        directory.mkdir()
        frames = []
        for index in range(3):
            path = directory / f"{index:06d}.jpg"
            assert cv2.imwrite(str(path), np.full((4, 8, 3), 100, np.uint8))
            frames.append(path)
        if directory.name == "frames":
            original_frames.extend(frames)
        return frames

    monkeypatch.setattr(runner, "extract", extract)
    attempts = []
    warnings = [{"frame": 1, "kind": "tracking_unstable"}]

    def track(frames, masks, job, checkpoint, device, progress, **kwargs):
        attempts.append(device)
        assert frames == original_frames
        assert all(path.exists() for path in frames)
        assert detail.exists() == refine
        if refine:
            assert all(path.exists() for path in kwargs["refinement_frames"])
        else:
            assert "refinement_frames" not in kwargs
        if device_path == "tracking_failure" or (device_path == "fallback" and device == "mps"):
            raise RuntimeError("tracking failed")
        masks.mkdir(exist_ok=True)
        for index in range(3):
            path = masks / f"{index:06d}.npy"
            np.save(path, np.ones((4, 8), np.uint8))
            mask_bytes[path] = path.read_bytes()
        return warnings

    monkeypatch.setattr(runner, "track", track)
    renders = []

    def render(frames, masks, *args, **kwargs):
        renders.append(True)
        assert not detail.exists(), "Detail files must be gone before the first encoding attempt"
        assert frames == original_frames
        assert all(path.exists() for path in frames)
        assert mask_bytes and all(path.read_bytes() == value for path, value in mask_bytes.items())
        if len(renders) <= export_failures:
            raise RuntimeError("encoding failed")
        return {"quiz": {"file": "masked.mp4"}}

    monkeypatch.setattr(runner, "render", render)
    if device_path == "tracking_failure" or export_failures == 2:
        with pytest.raises(RuntimeError, match="tracking failed" if device_path == "tracking_failure" else "encoding failed"):
            runner.run(tmp_path)
        assert (tmp_path / "error.json").exists()
        assert not (tmp_path / "result.json").exists()
    else:
        runner.run(tmp_path)
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["warnings"] == warnings
        assert result["duration"] == 0.1
        assert result["outputs"] == {"quiz": {"file": "masked.mp4"}}
    assert attempts == (["cpu"] if device_path == "cpu" else
                        ["mps", "cpu"] if device_path in ("fallback", "tracking_failure") else ["mps"])
    assert len(renders) == (0 if device_path == "tracking_failure" else min(export_failures + 1, 2))
    assert detail.exists() == (refine and device_path == "tracking_failure")
    assert all(path.exists() for path in original_frames)
    assert all(path.read_bytes() == value for path, value in mask_bytes.items())
