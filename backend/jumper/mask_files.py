"""Publish job-local masks only after NumPy has finished and the file is closed."""

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
