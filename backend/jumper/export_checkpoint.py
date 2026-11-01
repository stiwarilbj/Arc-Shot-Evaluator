"""Job-local export retry. Reuse existing temporary masks, never rerun inference."""

from __future__ import annotations

from .compression_quality import SilhouetteCompressionError

import hashlib
import time

import cv2
import numpy as np

VERSION = 1
MAX_BYTES = 512 * 1024 * 1024
TTL = 10 * 60


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def seal(frames, masks, target, start, *, limit=MAX_BYTES, now=None):
    """An unavailable checkpoint must not break an otherwise successful export."""
    try:
        if not 2 <= len(frames) <= 450 or not 1 <= target <= 255:
            return None
        image = cv2.imread(str(frames[0]))
        height, width = image.shape[:2]
        del image
        if not 2 <= width <= 1280 or not 2 <= height <= 720:
            return None
        entries, used = [], 0
        for index in range(len(frames)):
            path = masks / f"{index:06d}.npy"
            size = path.stat().st_size
            used += size
            if used > limit or size > width * height + 4096:
                return None
            values = np.load(path, allow_pickle=False)
            if values.dtype != np.uint8 or values.shape != (height, width):
                return None
            entries.append((size, digest(path)))
        return dict(
            version=VERSION,
            created=time.monotonic() if now is None else now,
            width=width,
            height=height,
            count=len(frames),
            fps=30,
            start=start,
            target=target,
            entries=entries,
            bytes=used,
        )
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def valid(checkpoint, frames, masks, target, start, *, now=None):
    try:
        if not checkpoint or checkpoint["version"] != VERSION:
            return False
        age = (time.monotonic() if now is None else now) - checkpoint["created"]
        if (
            not 0 <= age <= TTL
            or checkpoint["fps"] != 30
            or checkpoint["target"] != target
            or checkpoint["start"] != start
        ):
            return False
        if (
            checkpoint["count"] != len(frames)
            or len(checkpoint["entries"]) != len(frames)
            or checkpoint["bytes"] > MAX_BYTES
        ):
            return False
        for index, (size, sha) in enumerate(checkpoint["entries"]):
            path = masks / f"{index:06d}.npy"
            if path.stat().st_size != size or digest(path) != sha:
                return False
        return True
    except (OSError, KeyError, TypeError, ValueError):
        return False


def render_with_retry(
    render,
    frames,
    masks,
    output,
    target,
    token,
    *,
    start,
    silhouette,
    progress,
    palette=False,
):
    checkpoint = seal(frames, masks, target, start)
    try:
        try:
            return render(
                frames,
                masks,
                output,
                target,
                token,
                silhouette=silhouette,
                **({"palette": True} if palette else {}),
                progress=lambda done, total: progress(
                    "Rendering masked videos", done, total
                ),
            )
        except SilhouetteCompressionError:
            # render() already exhausted its single higher-quality attempt.
            raise
        except (OSError, RuntimeError, ValueError):
            if not valid(checkpoint, frames, masks, target, start):
                raise
            progress("Retrying export from completed masks", 0, 1)
            # render() opens fresh encoders with -y, replacing every partial output.
            return render(
                frames,
                masks,
                output,
                target,
                token,
                silhouette=silhouette,
                **({"palette": True} if palette else {}),
                progress=lambda done, total: progress(
                    "Retrying export from completed masks", done, total
                ),
            )
    finally:
        if checkpoint:
            checkpoint.clear()
        # Masks/source frames remain owned by the API job, whose release/expiry
        # removes its directory (including cancellation and failed exports).
