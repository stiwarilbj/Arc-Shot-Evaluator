"""Disposable native masking subprocess. No HTTP server or public publication."""

from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import time

from backend.jumper.pipeline import extract, render, track
from backend.jumper.export_checkpoint import render_with_retry
from backend.jumper.model_install import ensure_checkpoint
from backend.jumper.resources import (
    check_resources,
    estimate_resources,
    resident_memory,
)

CHECKPOINT_URL = (
    "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
)
CHECKPOINT_SHA = "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69"


def write(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, allow_nan=False))
    tmp.replace(path)


class ProgressWriter:
    """Coalesce status callbacks, never tracking or rendering work."""

    def __init__(self, path):
        self.path = path
        self.latest = None
        self.published = None
        self.published_at = 0.0

    def __call__(self, stage, done=0, total=1):
        self.latest = {"stage": stage, "progress": done / total if total > 0 else 0}
        now = time.monotonic()
        previous = self.published
        if (
            previous is None
            or stage != previous["stage"]
            or self.latest["progress"] - previous["progress"] >= 0.01
            or (self.latest["progress"] >= 1 and previous["progress"] < 1)
            or now - self.published_at >= 0.25
        ):
            self.flush(now)

    def flush(self, now=None):
        if self.latest is not None and self.latest != self.published:
            write(self.path, self.latest)
            self.published = self.latest
            self.published_at = time.monotonic() if now is None else now


def run(directory: Path):
    job = json.loads((directory / "request.json").read_text())
    progress = ProgressWriter(directory / "progress.json")

    try:
        progress("Checking device resources")
        import cv2

        source = cv2.VideoCapture(str(directory / "source"))
        try:
            sw = source.get(cv2.CAP_PROP_FRAME_WIDTH)
            sh = source.get(cv2.CAP_PROP_FRAME_HEIGHT)
        finally:
            source.release()
        # Metadata may be missing for damaged files; extraction retains its own
        # decoding validation. Include source decoder surfaces, not just output.
        import math

        if not all(math.isfinite(v) and v > 0 for v in (sw, sh)):
            sw, sh = 1280, 720
        scale = min(1, 1280 / sw, 720 / sh)
        check_resources(
            estimate_resources(job, sw * scale, sh * scale, sw, sh),
            previous_bytes=resident_memory(),
        )
        progress("Decoding selected segment")
        frames = extract(
            directory / "source", directory / "frames", job["start"], job["end"],
            **({"frame_map": job["frame_map"]} if "frame_map" in job else {}),
        )
        if hasattr(frames, "frame_map"):
            job["frame_map"] = frames.frame_map
        refinement_frames = None
        if job.get("refine_small_players"):
            progress("Decoding detail frames")
            required = (
                math.ceil((job["end"] - job["start"]) * 30)
                * math.ceil(min(sw * sh, 2560 * 1440)) * 3
            )
            if shutil.disk_usage(directory).free < required + 256 * 1024 ** 2:
                raise ValueError(
                    "Not enough temporary disk space for detail frames. "
                    "Shorten the segment or free disk space and retry."
                )
            refinement_frames = extract(
                directory / "source", directory / "detail-frames",
                job["start"], job["end"], maximum=(2560, 1440), frame_map=job.get("frame_map")
            )
        import torch
        from backend.config import MODEL_WEIGHTS_DIR

        progress("Checking local masking model")
        checkpoint = MODEL_WEIGHTS_DIR / "sam2.1_hiera_tiny.pt"
        verified_checkpoint = ensure_checkpoint(
            checkpoint, CHECKPOINT_URL, CHECKPOINT_SHA, progress
        )
        device = (
            "cpu"
            if os.environ.get("ARCADE_JUMPER_CPU_FALLBACK") == "1"
            else (
                "mps"
                if torch.backends.mps.is_available()
                else "cuda" if torch.cuda.is_available() else "cpu"
            )
        )
        # MPS defaults permit allocations beyond physical RAM. Leave room for
        # the browser/OS and fail into the existing CPU retry before jetsam kills
        # the whole process (which cannot be caught as a Python exception).
        if device == "mps":
            torch.mps.set_per_process_memory_fraction(0.5)
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        progress("Tracking players · " + device.upper())
        original_objects = copy.deepcopy(job["objects"])
        try:
            warnings = track(
                frames,
                directory / "masks",
                job,
                checkpoint,
                device,
                lambda done, total, stage=None: progress(
                    (stage + " · " + device.upper()) if stage else (
                        (
                            "Detecting and tracking players · "
                            if job.get("auto_detect_others")
                            else "Tracking players · "
                        )
                        + device.upper()
                    ),
                    done,
                    total,
                ),
                cache_source=directory / "source",
                checkpoint_verification=verified_checkpoint,
                **(
                    {"refinement_frames": refinement_frames}
                    if refinement_frames is not None else {}
                ),
            )
        except (RuntimeError, NotImplementedError) as error:
            if device == "cpu":
                raise
            error.__traceback__ = None
            import gc

            gc.collect()
            if device == "mps":
                torch.mps.empty_cache()
            elif device == "cuda":
                torch.cuda.empty_cache()
            job["objects"] = original_objects
            progress("Restarting tracking on CPU")
            warnings = track(
                frames,
                directory / "masks",
                job,
                checkpoint,
                "cpu",
                lambda done, total, stage=None: progress(stage or "Tracking players · CPU", done, total),
                cache_source=directory / "source",
                checkpoint_verification=verified_checkpoint,
                **(
                    {"refinement_frames": refinement_frames}
                    if refinement_frames is not None else {}
                ),
            )
        if refinement_frames is not None:
            # Tracking and any CPU retry have finished. Export retries use only the
            # regular frames and completed masks, which remain owned by the job.
            refinement_frames = None
            shutil.rmtree(directory / "detail-frames", ignore_errors=True)
        progress("Rendering masked videos")
        outputs = render_with_retry(
            render,
            frames,
            directory / "masks",
            directory / "output",
            job["target_id"],
            directory.name,
            start=job["start"],
            silhouette=job.get("presentation", "").startswith("silhouette"),
            palette=job.get("presentation") == "silhouette-palette-v1",
            progress=progress,
        )
        result = {
            "duration": len(frames) / 30,
            "fps": 30,
            "warnings": warnings,
            "objects": job["objects"],
            "outputs": outputs,
            **({"frame_map": job["frame_map"]} if "frame_map" in job else {}),
        }
        if "_tracking_check" in job:
            result["tracking_check"] = job["_tracking_check"]
        write(directory / "result.json", result)
        progress("Ready for review", 1)
    except Exception as error:
        write(directory / "error.json", {"error": str(error)[:2000]})
        try:
            progress.flush()
        except (OSError, ValueError):
            pass  # Keep the original processing error if status cannot be written.
        raise


if __name__ == "__main__":
    run(Path(sys.argv[1]))
