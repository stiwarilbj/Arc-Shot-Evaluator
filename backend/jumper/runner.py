"""Disposable native masking subprocess. No HTTP server or public publication."""

from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

from backend.jumper.pipeline import extract, render, track

CHECKPOINT_URL = (
    "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
)
CHECKPOINT_SHA = "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69"


def write(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, allow_nan=False))
    tmp.replace(path)


def run(directory: Path):
    job = json.loads((directory / "request.json").read_text())

    def progress(stage, done=0, total=1):
        write(
            directory / "progress.json",
            {"stage": stage, "progress": done / max(total, 1)},
        )

    try:
        progress("Decoding selected segment")
        frames = extract(
            directory / "source", directory / "frames", job["start"], job["end"]
        )
        import torch
        from backend.config import MODEL_WEIGHTS_DIR

        progress("Downloading local masking model")
        checkpoint = MODEL_WEIGHTS_DIR / "sam2.1_hiera_tiny.pt"
        if (
            not checkpoint.exists()
            or hashlib.file_digest(checkpoint.open("rb"), "sha256").hexdigest()
            != CHECKPOINT_SHA
        ):
            temporary = checkpoint.with_suffix(".download")
            with (
                urllib.request.urlopen(CHECKPOINT_URL, timeout=60) as response,
                temporary.open("wb") as out,
            ):
                total = int(response.headers.get("Content-Length", 1))
                done = 0
                while data := response.read(1024 * 1024):
                    out.write(data)
                    done += len(data)
                    if done > 200 * 1024 * 1024:
                        raise ValueError("Model download exceeds its expected size")
                    progress("Downloading local masking model", done, total)
            if (
                hashlib.file_digest(temporary.open("rb"), "sha256").hexdigest()
                != CHECKPOINT_SHA
            ):
                temporary.unlink(missing_ok=True)
                raise ValueError("Model checksum failed; retry the download")
            temporary.replace(checkpoint)
        device = (
            "mps"
            if torch.backends.mps.is_available()
            else "cuda"
            if torch.cuda.is_available()
            else "cpu"
        )
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        progress("Tracking players · " + device.upper())
        try:
            warnings = track(
                frames,
                directory / "masks",
                job,
                checkpoint,
                device,
                lambda done, total: progress(
                    "Tracking players · " + device.upper(), done, total
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
            progress("Restarting tracking on CPU")
            warnings = track(
                frames,
                directory / "masks",
                job,
                checkpoint,
                "cpu",
                lambda done, total: progress("Tracking players · CPU", done, total),
            )
        progress("Rendering masked videos")
        outputs = render(
            frames,
            directory / "masks",
            directory / "output",
            job["target_id"],
            directory.name,
        )
        result = {
            "duration": len(frames) / 30,
            "fps": 30,
            "warnings": warnings,
            "outputs": outputs,
        }
        write(directory / "result.json", result)
        progress("Ready for review", 1)
    except Exception as error:
        write(directory / "error.json", {"error": str(error)[:2000]})
        raise


if __name__ == "__main__":
    run(Path(sys.argv[1]))
