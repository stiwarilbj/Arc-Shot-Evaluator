from copy import deepcopy
import os
import time

import numpy as np

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


def test_unverified_native_gpu_keeps_original_encoder_path():
    from types import SimpleNamespace
    from backend.jumper.cache import cache_backbone

    original = lambda *args: None
    predictor = SimpleNamespace(_get_image_feature=original)
    for device in ("mps", "cuda"):
        cache_backbone(predictor, None, device=device)
        assert predictor._get_image_feature is original
