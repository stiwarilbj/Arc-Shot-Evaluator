"""Shared native foreground pipeline; imported without loading models."""

from __future__ import annotations
import hashlib
import math
import shutil
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
import cv2
import imageio_ffmpeg
import numpy as np

SAM_CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"
BACKGROUND = 224
OTHER_PLAYER = 128
FPS = 30
MAX_SECONDS = 15


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def validate_job(job: object) -> dict:
    if not isinstance(job, dict) or job.get("version") != 1:
        raise ValueError("Expected a version-1 preparation job")
    for key in ("source", "event_id", "player_id", "player_name", "identity_evidence"):
        if not isinstance(job.get(key), str) or not job[key].strip():
            raise ValueError(f"Missing {key}")
    start, end = job.get("start"), job.get("end")
    if (
        not number(start)
        or not number(end)
        or start < 0
        or not 2 / FPS <= end - start <= MAX_SECONDS
    ):
        raise ValueError("Select a finite segment of at most 15 seconds")
    objects = job.get("objects")
    if not isinstance(objects, list) or not 1 <= len(objects) <= 20:
        raise ValueError("Select between one and twenty foreground people")
    if (
        sum(
            len(obj.get("prompts", []))
            for obj in objects
            if isinstance(obj, dict) and isinstance(obj.get("prompts"), list)
        )
        > 128
    ):
        raise ValueError("Use at most 128 correction frames per clip")
    ids = [obj.get("id") for obj in objects if isinstance(obj, dict)]
    if (
        len(ids) != len(objects)
        or any(type(i) is not int or not 1 <= i <= 255 for i in ids)
        or len(set(ids)) != len(ids)
    ):
        raise ValueError("Object IDs must be unique integers from 1 to 255")
    if type(job.get("target_id")) is not int or job["target_id"] not in ids:
        raise ValueError("Target must be a selected foreground person")
    for obj in objects:
        prompts = obj.get("prompts")
        if (
            not isinstance(prompts, list)
            or not prompts
            or len(prompts) > 32
            or not isinstance(prompts[0], dict)
        ):
            raise ValueError("Every selected person needs an initial prompt")
        frames = []
        for prompt in prompts:
            if (
                not isinstance(prompt, dict)
                or type(prompt.get("frame")) is not int
                or not 0 <= prompt["frame"] < math.ceil((end - start) * FPS)
            ):
                raise ValueError("Prompt frame is outside the selected segment")
            frames.append(prompt["frame"])
            box, points, labels = (
                prompt.get("box"),
                prompt.get("points"),
                prompt.get("labels"),
            )
            if box is None and points is None:
                raise ValueError("A prompt needs a box or corrective points")
            if box is not None and (
                not isinstance(box, list)
                or len(box) != 4
                or any(not number(n) or not 0 <= n <= 1 for n in box)
                or box[0] >= box[2]
                or box[1] >= box[3]
            ):
                raise ValueError("Boxes must use normalized x1,y1,x2,y2 coordinates")
            if points is not None and (
                not isinstance(points, list)
                or not points
                or len(points) > 64
                or not isinstance(labels, list)
                or len(labels) != len(points)
                or any(type(n) is not int or n not in (0, 1) for n in labels)
                or any(
                    not isinstance(p, list)
                    or len(p) != 2
                    or any(not number(n) or not 0 <= n <= 1 for n in p)
                    for p in points
                )
            ):
                raise ValueError(
                    "Corrective points need normalized coordinates and binary labels"
                )
        if frames != sorted(set(frames)):
            raise ValueError("Prompt frames must be unique and increasing per person")
    if (
        next(obj for obj in objects if obj["id"] == job["target_id"])["prompts"][0][
            "frame"
        ]
        != 0
    ):
        raise ValueError("The named player needs a frame-zero prompt")
    return job


def composite(
    frame: np.ndarray, labels: np.ndarray, target_id: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Copy original pixels ONLY inside an approved foreground label mask.

    Labels are disjoint visible surfaces, not full reconstructed bodies. The
    caller owns mask approval; segmentation alone cannot prove foreground truth.
    Approved masks must exclude the ball (including a held ball); negative
    corrective prompts can remove it. This requires a separate review check.
    """
    if frame.dtype != np.uint8 or frame.ndim != 3 or frame.shape[2] != 3:
        raise ValueError("Expected an 8-bit RGB frame")
    if labels.dtype != np.uint8 or labels.shape != frame.shape[:2]:
        raise ValueError("Expected a matching 8-bit foreground label map")
    foreground, target = labels != 0, labels == target_id
    quiz = np.full_like(frame, BACKGROUND)
    quiz[foreground] = OTHER_PLAYER
    quiz[target] = 0
    reveal = np.full_like(frame, BACKGROUND)
    reveal[foreground] = frame[foreground]
    highlight = np.full_like(frame, BACKGROUND)
    highlight[foreground] = OTHER_PLAYER
    highlight[target] = frame[target]
    return quiz, reveal, highlight


def run_ffmpeg(arguments: list[str]) -> None:
    result = subprocess.run(
        [
            imageio_ffmpeg.get_ffmpeg_exe(),
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            *arguments,
        ],
        capture_output=True,
        timeout=120,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace")[-2000:])


def extract(source: Path, directory: Path, start: float, end: float) -> list[Path]:
    directory.mkdir()
    # FFmpeg applies rotation before scaling, timestamps VFR input to one common
    # timeline, and decodes only the selected segment. No source audio is read.
    # Decode a bounded extra second for delayed/B frames; trim in the filter
    # instead of stopping the output encoder before its last frame is flushed.
    run_ffmpeg(
        [
            "-ss",
            str(start),
            "-t",
            str(end - start + 1),
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            f"trim=duration={end - start},setpts=PTS-STARTPTS,fps=30:start_time=0,scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-c:v",
            "png",
            "-start_number",
            "0",
            str(directory / "%06d.jpg"),
        ]
    )
    # Lossless PNG payloads retain SAM's required numeric .jpg cache names.
    # PIL/OpenCV detect the payload format; avoiding JPEG loss matches browser RGB.
    frames = sorted(directory.glob("*.jpg"))
    if not 2 <= len(frames) <= MAX_SECONDS * FPS:
        raise ValueError("Video is too short or the selected segment cannot be decoded")
    if abs(len(frames) / FPS - (end - start)) > 2 / FPS:
        raise ValueError("Selected segment extends beyond the available video")
    return frames


def propose_people(frame: Path, detector: Path) -> list[list[float]]:
    """Propose boxes; a human selects court participants before segmentation.

    Never automatically include spectators or treat a detector as an identity
    recognizer. Detector checkpoints are supplied explicitly, not downloaded.
    """
    from ultralytics import YOLO

    image = cv2.imread(str(frame))
    if image is None:
        raise ValueError("Cannot decode preview")
    height, width = image.shape[:2]
    result = YOLO(str(detector)).predict(
        image, classes=[0], conf=0.25, device="cpu", verbose=False
    )[0]
    return (result.boxes.xyxy.cpu().numpy() / [width, height, width, height]).tolist()


def track(
    frames: list[Path],
    destination: Path,
    job: dict,
    checkpoint: Path,
    device: str,
    progress=None,
) -> list[dict]:
    """Use native SAM 2.1 video tracking memory and per-frame corrections."""
    import torch
    from sam2.build_sam import build_sam2_video_predictor
    from backend.jumper.frames import bounded_state, prune_tracking

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir()
    predictor = build_sam2_video_predictor(
        SAM_CONFIG,
        str(checkpoint),
        device=device,
        hydra_overrides_extra=["++model.non_overlap_masks=false"],
        apply_postprocessing=False,
    )
    if device == "mps":
        from backend.jumper.mps import enable_real_rotary

        enable_real_rotary(predictor)
    warnings = []
    height, width = cv2.imread(str(frames[0])).shape[:2]
    with torch.inference_mode():
        state = bounded_state(predictor, frames)
        try:
            # Seed every identity before propagation. Additional prompts at
            # later frames condition the same object's tracking memory.
            prompts = sorted(
                (p["frame"], obj["id"], p)
                for obj in job["objects"]
                for p in obj["prompts"]
            )
            for index, obj_id, prompt in prompts:
                if index >= len(frames):
                    raise ValueError("Correction frame is beyond decoded input")
                kwargs = {}
                if "box" in prompt:
                    kwargs["box"] = np.array(prompt["box"], dtype=np.float32) * [
                        width,
                        height,
                        width,
                        height,
                    ]
                if "points" in prompt:
                    kwargs["points"] = np.array(prompt["points"], dtype=np.float32) * [
                        width,
                        height,
                    ]
                    kwargs["labels"] = np.array(prompt["labels"], dtype=np.int32)
                predictor.add_new_points_or_box(
                    state, frame_idx=index, obj_id=obj_id, **kwargs
                )
            previous = None
            previous_extent = None
            for index, ids, logits in predictor.propagate_in_video(
                state, start_frame_idx=0
            ):
                if progress:
                    progress(index, len(frames))
                values = logits[:, 0].float().cpu().numpy()
                starts = {
                    obj["id"]: obj["prompts"][0]["frame"] for obj in job["objects"]
                }
                for row, identity in enumerate(ids):
                    if index < starts[identity]:
                        values[row] = -1024
                # Exactly one visible owner per pixel. Negative logits stay
                # background; no expansion or generated body pixels are used.
                owners = np.argmax(values, axis=0)
                labels = np.zeros((height, width), dtype=np.uint8)
                valid = np.max(values, axis=0) > 0
                labels[valid] = np.asarray(ids, dtype=np.uint8)[owners[valid]]
                np.save(destination / f"{index:06d}.npy", labels, allow_pickle=False)
                if not np.any(labels == job["target_id"]):
                    warnings.append({"frame": index, "kind": "target_lost"})
                ys, xs = np.nonzero(labels == job["target_id"])
                if len(xs):
                    extent = (
                        len(xs),
                        float(xs.mean() / width),
                        float(ys.mean() / height),
                    )
                    if previous_extent and (
                        extent[0] / previous_extent[0] < 0.35
                        or extent[0] / previous_extent[0] > 2.8
                        or math.hypot(
                            extent[1] - previous_extent[1],
                            extent[2] - previous_extent[2],
                        )
                        > 0.2
                    ):
                        warnings.append({"frame": index, "kind": "tracking_unstable"})
                    previous_extent = extent
                else:
                    previous_extent = None
                current = cv2.resize(cv2.imread(str(frames[index])), (64, 36))
                if (
                    previous is not None
                    and np.abs(current.astype(float) - previous).mean() > 55
                ):
                    warnings.append({"frame": index, "kind": "possible_camera_cut"})
                previous = current.astype(float)
                prune_tracking(state, index)
        finally:
            predictor.reset_state(state)
    del state, predictor
    if device == "mps":
        torch.mps.empty_cache()
    if len(list(destination.glob("*.npy"))) != len(frames):
        raise RuntimeError("Incomplete mask propagation")
    return warnings


@contextmanager
def encoder(path: Path, width: int, height: int):
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(
            [
                imageio_ffmpeg.get_ffmpeg_exe(),
                "-nostdin",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-s",
                f"{width}x{height}",
                "-r",
                str(FPS),
                "-i",
                "pipe:0",
                "-an",
                "-map_metadata",
                "-1",
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-preset",
                "fast",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(path),
            ],
            stdin=subprocess.PIPE,
            stderr=errors,
        )
        try:
            yield process.stdin
            process.stdin.close()
            if process.wait(timeout=120) != 0:
                errors.seek(0)
                raise RuntimeError(errors.read().decode(errors="replace")[-2000:])
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdin.close()


def render(
    frames: list[Path], masks: Path, output: Path, target: int, token: str
) -> dict:
    output.mkdir(exist_ok=True)
    height, width = cv2.imread(str(frames[0])).shape[:2]
    kinds = ("quiz", "reveal", "highlight")
    paths = {
        kind: output
        / f"{hashlib.sha256(f'{token}:{kind}'.encode()).hexdigest()[:32]}.mp4"
        for kind in kinds
    }
    with ExitStack() as stack:
        streams = [
            stack.enter_context(encoder(path, width, height)) for path in paths.values()
        ]
        for index, frame in enumerate(frames):
            labels = np.load(masks / f"{index:06d}.npy", allow_pickle=False)
            rgb = cv2.cvtColor(cv2.imread(str(frame)), cv2.COLOR_BGR2RGB)
            composites = composite(rgb, labels, target)
            if index == 0:
                thumbnail = (
                    output
                    / f"{hashlib.sha256(f'{token}:thumbnail'.encode()).hexdigest()[:32]}.png"
                )
                if not cv2.imwrite(
                    str(thumbnail), cv2.cvtColor(composites[0], cv2.COLOR_RGB2BGR)
                ):
                    raise RuntimeError("Could not write the neutral thumbnail")
            for stream, image in zip(streams, composites):
                stream.write(image.tobytes())
    paths["thumbnail"] = thumbnail
    return {
        kind: {"file": path.name, "sha256": digest(path), "bytes": path.stat().st_size}
        for kind, path in paths.items()
    }
