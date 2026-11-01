"""Interrupted mask writes must never masquerade as completed predictions."""

from pathlib import Path
import subprocess
import sys
import time

import cv2
import numpy as np
import pytest

from backend.jumper import mask_files
from backend.jumper.export_checkpoint import seal


@pytest.mark.parametrize("existing", [False, True])
def test_publish_exposes_only_closed_complete_mask(tmp_path, monkeypatch, existing):
    path = tmp_path / "000001.npy"
    old = np.zeros((8, 12), np.uint8)
    labels = np.arange(96, dtype=np.uint8).reshape(8, 12)
    if existing:
        np.save(path, old, allow_pickle=False)
    original = Path.replace
    save = mask_files.np.save
    writers = []
    def record(stream, *args, **kwargs):
        writers.append(stream)
        return save(stream, *args, **kwargs)
    monkeypatch.setattr(mask_files.np, "save", record)
    def replace(temporary, destination):
        assert destination == path
        assert writers and writers[-1].closed
        assert temporary.parent == path.parent and temporary.suffix == ".partial"
        np.testing.assert_array_equal(np.load(temporary, allow_pickle=False), labels)
        # Until replacement, readers still see the previous final, if any.
        if existing:
            np.testing.assert_array_equal(np.load(path, allow_pickle=False), old)
        else:
            assert not path.exists()
        return original(temporary, destination)
    monkeypatch.setattr(Path, "replace", replace)
    mask_files.publish_mask(path, labels)
    np.testing.assert_array_equal(np.load(path, allow_pickle=False), labels)
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize("existing", [False, True])
@pytest.mark.parametrize("failure", ["write", "rename"])
def test_failure_preserves_previous_final_and_cleans_own_partial(tmp_path, monkeypatch, existing, failure):
    path = tmp_path / "000001.npy"
    old = np.zeros((8, 12), np.uint8)
    if existing:
        np.save(path, old, allow_pickle=False)
    unrelated = tmp_path / ".other-job.partial"
    unrelated.write_bytes(b"keep")
    if failure == "write":
        def fail(stream, labels, **kwargs):
            assert kwargs == {"allow_pickle": False}
            stream.write(b"incomplete numpy header")
            assert stream.name.endswith(".partial")
            assert list(tmp_path.glob("*.npy")) == ([path] if existing else [])
            raise OSError("disk full")
        monkeypatch.setattr(mask_files.np, "save", fail)
    else:
        def fail(*args):
            raise OSError("rename unavailable")
        monkeypatch.setattr(Path, "replace", fail)
    with pytest.raises(OSError):
        mask_files.publish_mask(path, np.ones((8, 12), np.uint8))
    if existing:
        np.testing.assert_array_equal(np.load(path, allow_pickle=False), old)
    else:
        assert not path.exists()
    assert set(tmp_path.iterdir()) == ({path, unrelated} if existing else {unrelated})


@pytest.mark.parametrize("existing", [False, True])
def test_close_failure_does_not_publish(tmp_path, monkeypatch, existing):
    from contextlib import contextmanager
    path = tmp_path / "000000.npy"
    old = np.zeros((8, 12), np.uint8)
    if existing:
        np.save(path, old, allow_pickle=False)
    original = mask_files.tempfile.NamedTemporaryFile
    @contextmanager
    def failed_close(**kwargs):
        with original(**kwargs) as stream:
            yield stream
        raise OSError("close failed")
    monkeypatch.setattr(mask_files.tempfile, "NamedTemporaryFile", failed_close)
    with pytest.raises(OSError, match="close failed"):
        mask_files.publish_mask(path, np.ones((8, 12), np.uint8))
    assert list(tmp_path.iterdir()) == ([path] if existing else [])
    if existing:
        np.testing.assert_array_equal(np.load(path, allow_pickle=False), old)


def test_killed_writer_leaves_only_partial_and_checkpoint_rejects_missing_frame(tmp_path):
    frames, masks = tmp_path / "frames", tmp_path / "masks"
    frames.mkdir()
    masks.mkdir()
    for index in range(2):
        cv2.imwrite(str(frames / f"{index}.png"), np.zeros((8, 12, 3), np.uint8))
    mask_files.publish_mask(masks / "000000.npy", np.zeros((8, 12), np.uint8))
    ready = tmp_path / "ready"
    code = '''
import sys, time
from pathlib import Path
import numpy as np
from backend.jumper.mask_files import publish_mask

def interrupted(stream, *args, **kwargs):
    stream.write(b'partial numpy header')
    stream.flush()
    Path(sys.argv[2]).write_text('ready')
    time.sleep(60)
np.save = interrupted
publish_mask(Path(sys.argv[1]), np.ones((8, 12), np.uint8))
'''
    process = subprocess.Popen([sys.executable, "-c", code, str(masks / "000001.npy"), str(ready)])
    try:
        deadline = time.monotonic() + 5
        while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        assert ready.exists(), "Writer never reached the interrupted-write point"
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
    assert [path.name for path in masks.glob("*.npy")] == ["000000.npy"]
    partials = list(masks.glob("*.partial"))
    assert len(partials) == 1 and partials[0].read_bytes() == b"partial numpy header"
    assert seal(sorted(frames.glob("*.png")), masks, 1, 0) is None
    # Retry ignores the abandoned partial and publishes a usable final mask.
    mask_files.publish_mask(masks / "000001.npy", np.ones((8, 12), np.uint8))
    assert seal(sorted(frames.glob("*.png")), masks, 1, 0) is not None
    assert partials[0].exists(), "Publishing must not delete another writer's temporary file"
