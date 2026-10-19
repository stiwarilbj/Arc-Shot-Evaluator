"""Install native weights once across local app processes; never lock inference."""
from contextlib import contextmanager
import errno
import os
from pathlib import Path
import tempfile
import time
import urllib.request

from .checkpoint_verification import CheckpointVerificationError, VerifiedCheckpoint

MAX_MODEL_BYTES = 200 * 1024 * 1024


@contextmanager
def installation_lock(checkpoint):
    # Keep the lock inode after release so waiters and new callers use one lock.
    with checkpoint.with_name(checkpoint.name + ".lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            if os.fstat(lock.fileno()).st_size == 0:
                lock.write(b"\0")
                lock.flush()
            lock.seek(0)
            while True:
                try:
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    time.sleep(0.1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def ensure_checkpoint(checkpoint, url, sha, progress):
    checkpoint = Path(checkpoint)
    try:
        return VerifiedCheckpoint(checkpoint, sha)
    except (FileNotFoundError, CheckpointVerificationError):
        pass
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    progress("Waiting for local masking model installation")
    with installation_lock(checkpoint):
        # Another process may have installed the model while this job waited.
        try:
            return VerifiedCheckpoint(checkpoint, sha)
        except (FileNotFoundError, CheckpointVerificationError):
            pass
        temporary = None
        try:
            progress("Downloading local masking model")
            with tempfile.NamedTemporaryFile(
                dir=checkpoint.parent, prefix="." + checkpoint.name + "-",
                suffix=".download", delete=False,
            ) as out:
                temporary = Path(out.name)
                with urllib.request.urlopen(url, timeout=60) as response:
                    total = int(response.headers.get("Content-Length", 0))
                    done = 0
                    while data := response.read(1024 * 1024):
                        done += len(data)
                        if done > MAX_MODEL_BYTES:
                            raise ValueError("Model download exceeds its expected size")
                        out.write(data)
                        progress("Downloading local masking model", done, total)
            verified = VerifiedCheckpoint(temporary, sha)
            temporary.replace(checkpoint)
            verified.fingerprint(checkpoint)
            return verified
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
