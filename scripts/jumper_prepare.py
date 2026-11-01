"""Offline Jumper Lab pilot preparation. Never imported by the app or Pages build.

Raw footage, model weights, prompts, masks and review materials stay outside the
site. Nothing this script produces is approved for publication automatically.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2
import imageio_ffmpeg
import numpy as np

from backend.jumper.pipeline import (
    digest,
    number,
    validate_job,
    composite,
    run_ffmpeg,
    extract,
    propose_people,
    track,
    encoder,
    render,
)

PIPELINE_VERSION = 2
SAM_CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"
BACKGROUND = 224
OTHER_PLAYER = 128
FPS = 30
MAX_SECONDS = 15
REVIEW_CHECKS = (
    "full_motion_watched",
    "identity_verified",
    "single_complete_jumpshot",
    "trim_verified",
    "all_players_masked",
    "no_missing_limbs",
    "no_mask_flicker",
    "occlusion_order_correct",
    "no_background_leakage",
    "pair_alignment_verified",
    "ball_removed_or_neutral",
    "rights_verified",
)


def write_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def artifact_hashes(directory: Path) -> dict[str, str]:
    return {p.name: digest(p) for p in sorted(directory.iterdir()) if p.is_file()}


def prepare(job_path: Path, work: Path, checkpoint: Path, device: str) -> dict:
    if work.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
        raise ValueError(
            "Keep raw processing materials in a work directory outside the source repository"
        )
    job = validate_job(json.loads(job_path.read_text()))
    source = Path(job["source"]).expanduser().resolve(strict=True)
    checkpoint = checkpoint.resolve(strict=True)
    import sam2
    import torch

    # Hash the actual implementation as well as weights and inputs. An upgraded
    # tracker cannot accidentally resume masks made by a different implementation.
    sam_root = Path(sam2.__file__).parent
    implementation_files = sorted(
        p
        for p in sam_root.rglob("*")
        if p.is_file() and p.suffix in (".py", ".yaml", ".yml")
    )
    implementation = hashlib.sha256(
        "".join(digest(p) for p in implementation_files).encode()
    ).hexdigest()
    inputs = {
        "pipeline": PIPELINE_VERSION,
        "implementation": digest(Path(__file__)),
        "shared_pipeline": digest(
            Path(__file__).resolve().parents[1] / "backend/jumper/pipeline.py"
        ),
        "rotary": digest(Path(__file__).resolve().parents[1] / "backend/jumper/mps.py"),
        "frames": digest(
            Path(__file__).resolve().parents[1] / "backend/jumper/frames.py"
        ),
        "sam": implementation,
        "source": digest(source),
        "model": digest(checkpoint),
        "torch": str(torch.__version__),
        "ffmpeg": imageio_ffmpeg.get_ffmpeg_version(),
        "job": job,
        "requested_device": device,
    }
    key = hashlib.sha256(
        json.dumps(inputs, sort_keys=True, allow_nan=False).encode()
    ).hexdigest()
    work.mkdir(parents=True, exist_ok=True)
    run = work / key
    run.mkdir(exist_ok=True)
    state_path = run / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    frame_dir, mask_dir = run / "frames", run / "masks"
    if (
        not state.get("frames")
        or not frame_dir.is_dir()
        or artifact_hashes(frame_dir) != state["frames"]
    ):
        if frame_dir.exists():
            shutil.rmtree(frame_dir)
        frames = extract(source, frame_dir, job["start"], job["end"])
        state = {"frames": artifact_hashes(frame_dir)}
        write_json(state_path, state)
    else:
        frames = sorted(frame_dir.glob("*.jpg"))
    if (
        not state.get("masks")
        or not mask_dir.is_dir()
        or artifact_hashes(mask_dir) != state["masks"]
    ):
        state.pop("outputs", None)
        actual_device = device
        if device == "auto":
            import torch

            actual_device = (
                "mps"
                if torch.backends.mps.is_available()
                else "cuda"
                if torch.cuda.is_available()
                else "cpu"
            )
        try:
            warnings = track(frames, mask_dir, job, checkpoint, actual_device)
        except RuntimeError as error:
            if actual_device not in ("mps", "cuda"):
                raise
            # Restart from frame zero with clean memory, never combine devices'
            # partial traces. Device failure remains visible in the report.
            print(f"Accelerator failed; restarting on CPU: {error}", flush=True)
            # Drop the failed tracker's traceback references before allocating a
            # second model. Otherwise a GPU failure can retain its entire state
            # throughout the CPU retry on a shared-memory machine.
            error.__traceback__ = None
            import gc

            gc.collect()
            if actual_device == "mps" and torch.backends.mps.is_available():
                torch.mps.empty_cache()
            elif torch.cuda.is_available():
                torch.cuda.empty_cache()
            warnings = track(frames, mask_dir, job, checkpoint, "cpu")
            actual_device = "cpu"
        state.update(
            masks=artifact_hashes(mask_dir), warnings=warnings, device=actual_device
        )
        write_json(state_path, state)
    output = run / "outputs"
    expected = state.get("outputs", {})
    if (
        expected
        and output.is_dir()
        and artifact_hashes(output)
        == {v["file"]: v["sha256"] for v in expected.values()}
    ):
        outputs = expected
    else:
        staging = run / "rendering"
        if staging.exists():
            shutil.rmtree(staging)
        outputs = render(frames, mask_dir, staging, job["target_id"], key)
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
        state["outputs"] = outputs
        write_json(state_path, state)
    report = {
        "version": 1,
        "status": "needs_review",
        "fingerprint": key,
        "inputs": inputs,
        "frame_count": len(frames),
        "fps": FPS,
        "duration": len(frames) / FPS,
        "device": state["device"],
        "warnings": state["warnings"],
        "outputs": outputs,
        "review_checks_required": list(REVIEW_CHECKS),
    }
    write_json(run / "report.json", report)
    print(f"Prepared for review (NOT publication): {run / 'report.json'}", flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    process = commands.add_parser("prepare")
    process.add_argument("job", type=Path)
    process.add_argument("--work", type=Path, required=True)
    process.add_argument("--checkpoint", type=Path, required=True)
    process.add_argument(
        "--device", choices=("auto", "cpu", "mps", "cuda"), default="auto"
    )
    detect = commands.add_parser("propose")
    detect.add_argument("frame", type=Path)
    detect.add_argument("--detector", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.job, args.work, args.checkpoint, args.device)
    else:
        print(json.dumps(propose_people(args.frame, args.detector), indent=2))


if __name__ == "__main__":
    main()
