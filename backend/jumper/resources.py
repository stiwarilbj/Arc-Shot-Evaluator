"""Conservative admission checks; estimates are not guarantees against exhaustion."""

from __future__ import annotations

import math

MIB = 1024 * 1024


def estimate_resources(
    job, width=1280, height=720, source_width=None, source_height=None
):
    """Keep the allowance aligned with frontend jumper/resources.ts (no cache hits)."""
    frames = math.ceil((job["end"] - job["start"]) * 30)
    tracks = [
        o
        for o in job["objects"]
        if not o.get("ignored") or job.get("auto_detect_others")
    ]
    counts = [len({p["frame"] for p in o["prompts"]}) for o in tracks]
    players = max(len(tracks), 10 if job.get("auto_detect_others") else 1)
    corrections = sum(counts) + players - len(tracks)
    maximum = max([1, *counts])
    memories = players * min(16, frames) + corrections
    amount = math.ceil(
        (1536 + 192 + 96 + (256 if job.get("auto_detect_others") else 0)) * MIB
        + memories * 2.5 * MIB
        + (maximum + 6) * 8 * MIB
        + width * height * 96
        + (source_width or width) * (source_height or height) * 16
        + frames * width * height * 0.25
        + (frames * 128 * 128 if job.get("verify_shooter") else 0)
    )
    return {
        "bytes": amount,
        "players": players,
        "correctionFrames": corrections,
        "largestBufferBytes": max(16 * MIB, (maximum + 6) * MIB),
    }


def available_memory():
    # psutil handles macOS/Linux/Windows without importing torch or loading weights.
    try:
        import psutil

        value = psutil.virtual_memory().available
        return value if value > 0 else None
    except (ImportError, OSError, RuntimeError, AttributeError):
        return None


def resident_memory():
    """The subprocess's existing resident allocations are already paid for."""
    try:
        import psutil

        return max(0, psutil.Process().memory_info().rss)
    except (ImportError, OSError, RuntimeError, AttributeError):
        return 0


def check_resources(estimate, available=None, previous_bytes=0):
    """After allocation, compare only growth against remaining available memory."""
    available = available_memory() if available is None else available
    required = max(0, estimate["bytes"] - previous_bytes)
    if available is not None and required + 512 * MIB > available:
        raise ValueError(
            f"This clip needs an estimated {estimate['bytes'] / 1024**3:.1f} GB of working memory; "
            "there is not enough available memory to process it safely. "
            "Close other applications, shorten the segment, or remove unnecessary tracks "
            "or correction frames in Corrections, then retry."
        )
