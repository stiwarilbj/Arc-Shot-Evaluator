"""Atomic publication and startup inventory for job-local masks."""

from collections import Counter
from pathlib import Path
import tempfile

import numpy as np


def publish_mask(path: Path, labels):
    temporary = None
    try:
        # Same directory keeps replacement atomic. The suffix deliberately does
        # not match finished-mask readers' *.npy glob, even after a hard stop.
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix=f".{path.stem}-", suffix=".partial", delete=False
        ) as stream:
            temporary = Path(stream.name)
            # Use the open file so NumPy cannot append its own .npy suffix.
            np.save(stream, labels, allow_pickle=False)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def check_mask_inventory(directory: Path, count: int):
    """Check names against the timeline without reading any prediction arrays."""
    if count <= 0:
        raise ValueError("Cannot export an empty processing timeline. Retry processing.")
    expected = {f"{index:06d}.npy" for index in range(count)}
    entries = [path for path in directory.iterdir() if path.suffix.lower() == ".npy"]
    present = {path.name for path in entries if path.is_file()}
    numbers = Counter(int(path.stem) for path in entries
                      if path.stem.isascii() and path.stem.isdecimal())
    missing = sorted(expected - present)
    duplicates = sorted(f"{index:06d}" for index, total in numbers.items() if total > 1)
    unexpected = sorted(path.name for path in entries
                        if path.name not in expected or path.name not in present)
    if missing or duplicates or unexpected:
        details = []
        for label, values in (("missing masks", missing), ("duplicate frames", duplicates),
                              ("unexpected masks", unexpected)):
            if values:
                details.append(f"{label}: {', '.join(values[:5])}" +
                               (f" (+{len(values) - 5} more)" if len(values) > 5 else ""))
        raise ValueError("Mask inventory mismatch; " + "; ".join(details) + ". Retry processing.")
