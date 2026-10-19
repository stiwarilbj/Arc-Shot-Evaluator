"""Native model installation is atomic and coordinated across app processes."""
from contextlib import contextmanager
import hashlib
import io
from pathlib import Path
import subprocess
import sys

import pytest

from backend.jumper import model_install
from backend.jumper.checkpoint_verification import CheckpointVerificationError

DATA = b"verified local model"
SHA = hashlib.sha256(DATA).hexdigest()


class Response(io.BytesIO):
    headers = {"Content-Length": str(len(DATA))}


@pytest.mark.parametrize("failure", ["network", "checksum", "size", "progress"])
def test_failed_attempt_cleans_only_its_own_unique_temporary_file(tmp_path, monkeypatch, failure):
    checkpoint = tmp_path / "model.pt"
    checkpoint.write_bytes(b"old corrupt model")
    unrelated = tmp_path / ".model.pt-another-job.download"
    unrelated.write_bytes(b"another job")
    names = []

    def opening(*args, **kwargs):
        names.extend(p.name for p in tmp_path.glob("*.download") if p != unrelated)
        if failure == "network":
            raise OSError("network unavailable")
        return Response(b"wrong checksum" if failure == "checksum" else DATA)

    monkeypatch.setattr(model_install.urllib.request, "urlopen", opening)
    if failure == "size":
        monkeypatch.setattr(model_install, "MAX_MODEL_BYTES", len(DATA) - 1)

    def progress(stage, *args):
        if failure == "progress" and args:
            raise RuntimeError("interrupted callback")

    for _ in range(2):
        with pytest.raises((OSError, CheckpointVerificationError, ValueError, RuntimeError)):
            model_install.ensure_checkpoint(checkpoint, "unused", SHA, progress)
        assert checkpoint.read_bytes() == b"old corrupt model"
        assert list(tmp_path.glob("*.download")) == [unrelated]
    assert len(names) == len(set(names)) == 2
    assert unrelated.read_bytes() == b"another job"
    # A failed attempt releases the installation lock for a later retry.
    monkeypatch.setattr(model_install.urllib.request, "urlopen", lambda *a, **k: Response(DATA))
    monkeypatch.setattr(model_install, "MAX_MODEL_BYTES", 1024)
    assert model_install.ensure_checkpoint(checkpoint, "unused", SHA, lambda *a: None).fingerprint(checkpoint) == SHA


def test_valid_checkpoint_never_takes_installation_lock(tmp_path, monkeypatch):
    checkpoint = tmp_path / "model.pt"
    checkpoint.write_bytes(DATA)

    def forbidden(*args, **kwargs):
        pytest.fail("Unchanged verified models must not lock or download")

    monkeypatch.setattr(model_install, "installation_lock", forbidden)
    monkeypatch.setattr(model_install.urllib.request, "urlopen", forbidden)
    verified = model_install.ensure_checkpoint(checkpoint, "unused", SHA, forbidden)
    assert verified.fingerprint(checkpoint) == SHA


def test_waiter_independently_verifies_model_installed_by_other_job(tmp_path, monkeypatch):
    checkpoint = tmp_path / "model.pt"
    stages = []

    @contextmanager
    def installed_while_waiting(path):
        path.write_bytes(DATA)
        yield

    monkeypatch.setattr(model_install, "installation_lock", installed_while_waiting)
    monkeypatch.setattr(model_install.urllib.request, "urlopen", lambda *a, **k: pytest.fail("duplicate download"))
    verified = model_install.ensure_checkpoint(checkpoint, "unused", SHA, lambda *args: stages.append(args[0]))
    assert verified.fingerprint(checkpoint) == SHA
    assert stages == ["Waiting for local masking model installation"]
    # The waiter's verification still detects a later replacement.
    checkpoint.write_bytes(b"different")
    with pytest.raises(CheckpointVerificationError):
        verified.fingerprint(checkpoint)


def test_parallel_processes_download_once_and_install_verified_model(tmp_path):
    script = r'''
import hashlib, io, pathlib, sys, time
from backend.jumper import model_install
root = pathlib.Path(sys.argv[1])
data = b"verified local model"
class Response(io.BytesIO):
    headers = {}
def opening(*args, **kwargs):
    with (root / "downloads.log").open("a") as log:
        log.write("download\n")
    time.sleep(0.2)
    return Response(data)
model_install.urllib.request.urlopen = opening
path = root / "model.pt"
sha = hashlib.sha256(data).hexdigest()
verified = model_install.ensure_checkpoint(path, "unused", sha, lambda *args: None)
assert verified.fingerprint(path) == sha
print("verified")
'''
    processes = [subprocess.Popen([sys.executable, "-c", script, str(tmp_path)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                 for _ in range(3)]
    try:
        for process in processes:
            stdout, stderr = process.communicate(timeout=15)
            assert process.returncode == 0, stderr
            assert stdout.strip() == "verified"
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.communicate()
    assert (tmp_path / "downloads.log").read_text().splitlines() == ["download"]
    assert (tmp_path / "model.pt").read_bytes() == DATA
    assert not list(tmp_path.glob("*.download"))


def test_different_models_do_not_share_a_lock_and_process_exit_releases_it(tmp_path):
    first, second = tmp_path / "one.pt", tmp_path / "two.pt"
    with model_install.installation_lock(first):
        script = '''
from pathlib import Path
import sys
from backend.jumper.model_install import installation_lock
with installation_lock(Path(sys.argv[1])):
    pass
'''
        subprocess.run([sys.executable, "-c", script, str(second)], check=True, timeout=5)
    # An abruptly stopped process must not leave a permanent ownership flag.
    script = '''
import os, sys
from pathlib import Path
from backend.jumper.model_install import installation_lock
with installation_lock(Path(sys.argv[1])):
    os._exit(0)
'''
    subprocess.run([sys.executable, "-c", script, str(first)], check=True, timeout=5)
    with model_install.installation_lock(first):
        assert first.with_name("one.pt.lock").exists()
