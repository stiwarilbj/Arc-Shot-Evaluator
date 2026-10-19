import hashlib
import os
from pathlib import Path

import pytest

from backend.jumper.checkpoint_verification import VerifiedCheckpoint, CheckpointVerificationError


def checkpoint(tmp_path):
    path = tmp_path / 'weights.pt'
    path.write_bytes(b'verified checkpoint')
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def counted_hashes(monkeypatch):
    original = hashlib.file_digest
    calls = []
    def digest(stream, algorithm):
        calls.append(Path(stream.name))
        return original(stream, algorithm)
    monkeypatch.setattr(hashlib, 'file_digest', digest)
    return calls


def test_one_hash_per_unchanged_job_and_identical_cache_identity(tmp_path, monkeypatch):
    from backend.jumper.cache import identity
    path, sha = checkpoint(tmp_path)
    calls = counted_hashes(monkeypatch)
    first_job = VerifiedCheckpoint(path, sha)
    for _ in range(3):
        assert first_job.fingerprint(path) == sha
    source = tmp_path / 'source'
    source.write_bytes(b'video')
    key = identity(source, dict(start=0, end=1), path, 'cpu', [source], checkpoint_verification=first_job)
    assert calls.count(path) == 1
    assert identity(source, dict(start=0, end=1), path, 'cpu', [source]) == key
    calls.clear()
    second_job = VerifiedCheckpoint(path, sha)
    assert second_job is not first_job
    assert calls == [path], 'New jobs must independently verify the checkpoint'


@pytest.mark.parametrize('change', ['touch', 'replace_same', 'replace_bad', 'modify_same_size', 'missing'])
def test_changed_checkpoint_requires_reverification(tmp_path, monkeypatch, change):
    path, sha = checkpoint(tmp_path)
    calls = counted_hashes(monkeypatch)
    verified = VerifiedCheckpoint(path, sha)
    stat = path.stat()
    if change == 'touch':
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    elif change.startswith('replace'):
        replacement = tmp_path / 'replacement'
        replacement.write_bytes(path.read_bytes() if change == 'replace_same' else b'x' * stat.st_size)
        os.utime(replacement, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        replacement.replace(path)
    elif change == 'modify_same_size':
        path.write_bytes(b'x' * stat.st_size)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    else:
        path.unlink()
    if change in ('touch', 'replace_same'):
        assert verified.fingerprint(path) == sha
        assert calls == [path, path]
        assert verified.fingerprint(path) == sha
        assert len(calls) == 2
    else:
        with pytest.raises(CheckpointVerificationError):
            verified.fingerprint(path)
        assert len(calls) == (1 if change == 'missing' else 2)


def test_reject_change_while_hashing_even_when_original_bytes_match(tmp_path, monkeypatch):
    path, sha = checkpoint(tmp_path)
    original = hashlib.file_digest
    def replace_during_hash(stream, algorithm):
        result = original(stream, algorithm)
        replacement = tmp_path / 'replacement'
        replacement.write_bytes(path.read_bytes())
        replacement.replace(path)
        return result
    monkeypatch.setattr(hashlib, 'file_digest', replace_during_hash)
    with pytest.raises(CheckpointVerificationError, match='changed during verification'):
        VerifiedCheckpoint(path, sha)


def test_moved_download_reverified_at_final_path(tmp_path, monkeypatch):
    path, sha = checkpoint(tmp_path)
    calls = counted_hashes(monkeypatch)
    verified = VerifiedCheckpoint(path, sha)
    destination = tmp_path / 'installed.pt'
    path.replace(destination)
    assert verified.fingerprint(destination) == sha
    assert calls == [path, destination]


def test_bad_pin_is_rejected(tmp_path):
    path, _ = checkpoint(tmp_path)
    with pytest.raises(CheckpointVerificationError, match='checksum'):
        VerifiedCheckpoint(path, '0' * 64)


@pytest.mark.parametrize('when', ['before_load', 'during_load', 'during_identity'])
def test_tracking_integrity_failure_is_not_swallowed_by_cache_fallback(tmp_path, monkeypatch, when):
    import cv2
    import numpy as np
    import sam2.build_sam
    from backend.jumper import pipeline, resources, cache

    path, sha = checkpoint(tmp_path)
    verified = VerifiedCheckpoint(path, sha)
    frame = tmp_path / 'frame.png'
    cv2.imwrite(str(frame), np.zeros((20, 32, 3), np.uint8))
    monkeypatch.setattr(resources, 'check_resources', lambda *a, **k: None)
    builds = []
    def build(*args, **kwargs):
        builds.append(True)
        if when == 'during_load':
            path.write_bytes(b'changed during loading')
        return object()
    monkeypatch.setattr(sam2.build_sam, 'build_sam2_video_predictor', build)
    def identity(*args, checkpoint_verification, **kwargs):
        if when == 'during_identity':
            path.write_bytes(b'changed during cache setup')
        return checkpoint_verification.fingerprint(path)
    monkeypatch.setattr(cache, 'identity', identity)
    if when == 'before_load':
        path.write_bytes(b'changed before loading')
    job = dict(objects=[dict(id=1, prompts=[dict(frame=0, box=[0, 0, 1, 1])])], target_id=1, start=0, end=1/30)
    with pytest.raises(CheckpointVerificationError):
        pipeline.track([frame], tmp_path / 'masks', job, path, 'cpu', checkpoint_verification=verified)
    assert len(builds) == (0 if when == 'before_load' else 1)
