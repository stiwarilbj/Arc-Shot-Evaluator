"""Job-owned checkpoint verification; never persisted or shared across runners."""
import hashlib
import os
from pathlib import Path


class CheckpointVerificationError(ValueError):
    pass


def _stamp(stat):
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


class VerifiedCheckpoint:
    def __init__(self, path: Path, expected_sha: str):
        self._expected_sha = expected_sha
        self._verify(path)

    def _verify(self, path):
        path = Path(path).absolute()
        with path.open("rb") as stream:
            before = _stamp(os.fstat(stream.fileno()))
            sha = hashlib.file_digest(stream, "sha256").hexdigest()
            after = _stamp(os.fstat(stream.fileno()))
        if before != after or after != _stamp(path.stat()):
            raise CheckpointVerificationError("Masking model changed during verification; retry processing")
        if sha != self._expected_sha:
            raise CheckpointVerificationError("Model checksum failed; retry the download")
        self._path, self._stamp, self._sha = path, after, sha
        return sha

    def fingerprint(self, path: Path):
        path = Path(path).absolute()
        try:
            if path == self._path and _stamp(path.stat()) == self._stamp:
                return self._sha
            return self._verify(path)
        except OSError as error:
            raise CheckpointVerificationError("Verified masking model is unavailable; retry processing") from error
