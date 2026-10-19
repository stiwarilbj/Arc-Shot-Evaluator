from copy import deepcopy
import os
import time

import numpy as np
import pytest

from backend.jumper.cache import FrameCache, identity


def test_cache_is_lossless_independent_and_private(tmp_path):
    cache = FrameCache(tmp_path / "cache", "a")
    values = {"x": np.array([1.123456789, -2], np.float64)}
    cache.put("features:0", values)
    first = cache.get("features:0")
    np.testing.assert_array_equal(first["x"], values["x"])
    first["x"][0] = 0
    np.testing.assert_array_equal(cache.get("features:0")["x"], values["x"])
    assert cache.get("features:1") is None
    assert FrameCache(cache.root, "other").get("features:0") is None
    assert cache.path("features:0").stat().st_mode & 0o777 == 0o600


def test_cache_expiry_corruption_and_storage_failure(tmp_path):
    cache = FrameCache(tmp_path / "cache", "a", ttl=1)
    cache.put("x", {"a": np.ones(4)})
    path = cache.path("x")
    os.utime(path, (time.time() - 2, time.time() - 2))
    assert cache.get("x") is None
    path.write_bytes(b"broken archive")
    assert cache.get("x") is None
    # A denied/unusable cache never prevents normal computation.
    blocked = tmp_path / "blocked"
    blocked.write_bytes(b"not a directory")
    unavailable = FrameCache(blocked, "a")
    unavailable.put("x", {"a": np.ones(4)})
    assert unavailable.get("x") is None
    assert not unavailable.can_put(1)


def test_bounded_cache_keeps_early_frames_and_evicts_other_clips(tmp_path):
    root = tmp_path / "cache"
    cache = FrameCache(root, "a", limit=20000)
    # Incompressible payload prevents this assertion depending on compression.
    data = np.random.default_rng(2).normal(size=1024)
    for i in range(20):
        cache.put(str(i), {"a": data})
    assert sum(p.stat().st_size for p in root.glob("*.npz")) <= 20000
    assert cache.get("0") is not None
    other = FrameCache(root, "b", limit=20000)
    other.put("0", {"a": data})
    assert other.get("0") is not None
    assert sum(p.stat().st_size for p in root.glob("*.npz")) <= 20000
    cache.put("huge", {"a": np.ones(20000)})
    assert cache.get("huge") is None


def test_identity_ignores_corrections_but_changes_for_execution_inputs(tmp_path):
    source, checkpoint = tmp_path / "source", tmp_path / "checkpoint"
    source.write_bytes(b"video")
    checkpoint.write_bytes(b"weights")
    job = dict(start=0, end=1, target_id=1, objects=[dict(id=1, prompts=[])])
    key = identity(source, job, checkpoint, "cpu", [source])
    edited = deepcopy(job)
    edited["target_id"] = 2
    edited["objects"].append(dict(id=2, prompts=[dict(frame=3, points=[[0.1, 0.2]])]))
    assert identity(source, edited, checkpoint, "cpu", [source]) == key
    assert identity(source, job, checkpoint, "mps", [source]) != key
    assert identity(source, dict(job, start=0.1), checkpoint, "cpu", [source]) != key
    checkpoint.write_bytes(b"different weights")
    assert identity(source, job, checkpoint, "cpu", [source]) != key
    checkpoint.write_bytes(b"weights")
    source.write_bytes(b"different video")
    assert identity(source, job, checkpoint, "cpu", [source]) != key


@pytest.mark.parametrize("removed_frame", [0, 2, 4])
def test_deleted_correction_keeps_only_prompt_independent_cache_reusable(tmp_path, removed_frame):
    source, checkpoint = tmp_path / "source", tmp_path / "checkpoint"
    source.write_bytes(b"video")
    checkpoint.write_bytes(b"weights")
    job = dict(start=0, end=1, target_id=1, objects=[dict(id=1, prompts=[
        dict(frame=0, box=[0.1, 0.1, 0.5, 0.9], points=[[0.3, 0.4]], labels=[1]),
        dict(frame=2, points=[[0.3, 0.4]], labels=[1], anchor=True),
        dict(frame=4, points=[[0.8, 0.6]], labels=[0])])])
    key = identity(source, job, checkpoint, "cpu", [source])
    cache = FrameCache(tmp_path / "cache", key)
    cache.put("features:4", {"image_feature": np.array([1.25], np.float32)})
    cache.put("detection:4", {"boxes": np.array([[0.1, 0.1, 0.5, 0.9]])})
    after = deepcopy(job)
    after["objects"][0]["prompts"] = [prompt for prompt in after["objects"][0]["prompts"]
                                        if prompt["frame"] != removed_frame]
    next_key = identity(source, after, checkpoint, "cpu", [source])
    assert next_key == key
    reused = FrameCache(cache.root, next_key)
    np.testing.assert_array_equal(reused.get("features:4")["image_feature"], [1.25])
    np.testing.assert_array_equal(reused.get("detection:4")["boxes"], [[0.1, 0.1, 0.5, 0.9]])


def test_unverified_native_gpu_keeps_original_encoder_path():
    from types import SimpleNamespace
    from backend.jumper.cache import cache_backbone

    original = lambda *args: None
    predictor = SimpleNamespace(_get_image_feature=original)
    for device in ("mps", "cuda"):
        cache_backbone(predictor, None, device=device)
        assert predictor._get_image_feature is original


def test_detection_evidence_matches_browser_fixtures():
    import json
    from pathlib import Path
    from backend.jumper.cache import valid_detection_evidence

    fixtures = json.loads((Path(__file__).parent / "fixtures/jumper/detection-evidence.json").read_text())
    for fixture in fixtures:
        record = dict(boxes=np.asarray(fixture["boxes"], dtype=float).reshape(-1, 4),
                      hands=np.asarray(fixture["hands"], dtype=float).reshape(-1, 10))
        snapshot = deepcopy(record)
        assert valid_detection_evidence(record) == fixture["valid"], fixture["name"]
        for key in record:
            np.testing.assert_array_equal(record[key], snapshot[key])
    for value in (None, [], {}, dict(boxes=np.empty((0, 4)), hands=np.array(1.)),
                  dict(boxes=np.empty((0, 4)), hands=np.empty((0, 9))),
                  dict(boxes=np.array([[0., 0., 1., float("nan")]]), hands=np.empty((0, 10))),
                  dict(boxes=np.array([[0., 0., 1., 1.]]), hands=np.full((1, 10), float("inf")))):
        assert not valid_detection_evidence(value)


def test_remove_targets_only_named_frame_and_scope(tmp_path):
    cache = FrameCache(tmp_path / "cache", "a")
    other = FrameCache(cache.root, "b")
    for target in (cache, other):
        for name in ("features:0", "features:1"):
            target.put(name, {"x": np.ones(1)})
    cache.remove("features:0")
    cache.remove("missing")
    assert cache.get("features:0") is None
    assert cache.get("features:1") is not None
    assert other.get("features:0") is not None
    assert other.get("features:1") is not None
    blocked = tmp_path / "blocked"
    blocked.write_text("unavailable")
    FrameCache(blocked, "a").remove("features:0")


@pytest.mark.parametrize("invalid", ["shape", "nan", "infinity", "layout", "missing"])
def test_rejected_backbone_entry_removed_before_recompute(tmp_path, invalid):
    from types import SimpleNamespace
    from backend.jumper.cache import cache_backbone

    cache = FrameCache(tmp_path / "cache", "a")
    values = {f"backbone_fpn{i}": np.zeros(shape, np.float32) for i, shape in
              enumerate(((1, 32, 256, 256), (1, 64, 128, 128), (1, 256, 64, 64)))}
    if invalid == "shape":
        values["backbone_fpn0"] = np.zeros(1, np.float32)
    elif invalid in ("nan", "infinity"):
        values["backbone_fpn0"].flat[0] = float("nan" if invalid == "nan" else "inf")
    elif invalid == "layout":
        values["layout_backbone_fpn0"] = np.array([0, 0, 0, 0])
    else:
        values.pop("backbone_fpn0")
    cache.put("features:0", values)
    cache.put("features:1", {"valid_neighbor": np.ones(1)})
    calls = []
    def original(state, frame, batch):
        calls.append(frame)
        assert cache.get("features:0") is None, "Delete before recomputation, even if re-caching fails"
        assert cache.get("features:1") is not None
        return "recomputed"
    predictor = SimpleNamespace(_get_image_feature=original)
    cache_backbone(predictor, cache)
    for _ in range(2):
        assert predictor._get_image_feature({"cached_features": {}}, 0, 1) == "recomputed"
    assert calls == [0, 0]
    assert cache.get("features:0") is None
