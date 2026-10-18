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

from .floor_attachments import FloorAttachments
from .shooter_visibility import ShooterVisibility
from .memory_quality import MemoryQualityGate
from .correction_check import check_corrections
from .model_outputs import tracking_masks
from .overlap_palette import OverlapPalette
from .neutral_edges import neutral_edges
from .camera_cuts import CameraCuts
from .mask_quality import MaskQuality
from .mask_joins import MaskJoins
from .mask_ownership import MaskOwnership
from .compression_quality import detail_proof, SilhouetteCompressionError
from .video_validation import (
    validate_composite,
    silhouette_proof,
    validate_finished_video,
)

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
    if "auto_detect_others" in job and type(job["auto_detect_others"]) is not bool:
        raise ValueError("Invalid automatic discovery flag")
    if ("refine_small_players" in job
            and type(job["refine_small_players"]) is not bool):
        raise ValueError("Invalid small-player refinement flag")
    if "verify_shooter" in job and type(job["verify_shooter"]) is not bool:
        raise ValueError("Invalid shooter verification flag")
    if (
        "shooter_selection_resolved" in job
        and type(job["shooter_selection_resolved"]) is not bool
    ):
        raise ValueError("Invalid resolved shooter selection flag")
    if "presentation" in job and job["presentation"] not in (
        "silhouette",
        "silhouette-palette-v1",
    ):
        raise ValueError("Invalid presentation")
    from .source_frames import frame_count
    start, end = job.get("start"), job.get("end")
    if (
        not number(start)
        or not number(end)
        or start < 0
        or not 2 / FPS <= end - start <= MAX_SECONDS
    ):
        raise ValueError("Select a finite segment of at most 15 seconds")
    if "frame_map" in job:
        from .source_frames import valid_frame_map
        if not valid_frame_map(job["frame_map"], start, end):
            raise ValueError("Invalid source-frame map")
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
        if "ignored" in obj and type(obj["ignored"]) is not bool:
            raise ValueError("Invalid ignored track")
        if obj["id"] == job["target_id"] and obj.get("ignored"):
            raise ValueError("The selected player cannot be ignored")
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
                or not 0 <= prompt["frame"] < frame_count(start, end)
            ):
                raise ValueError("Prompt frame is outside the selected segment")
            if ("anchor" in prompt and type(prompt["anchor"]) is not bool) or (
                prompt.get("anchor") is True and (
                    obj["id"] != job["target_id"] or prompt["frame"] == 0 or
                    not (prompt.get("box") or (isinstance(prompt.get("labels"), list) and 1 in prompt["labels"]))
                )
            ):
                raise ValueError("A tracking anchor needs a later Include selection on the shooter")
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


def silhouette_pixels(
    labels: np.ndarray, target_id: int, palette: bool = False, shades=None
) -> np.ndarray:
    """Render from labels alone: source colors/text can never enter this path."""
    if labels.dtype != np.uint8 or labels.ndim != 2:
        raise ValueError("Expected an 8-bit foreground label map")
    if type(target_id) is not int or not 1 <= target_id <= 255:
        raise ValueError("Invalid target identity")
    shades = np.array(shades, dtype=np.uint8, copy=True) if palette and shades is not None else (
        (64 + ((np.arange(256, dtype=np.int32) - 1) * 47 % 137)).astype(np.uint8)
        if palette
        else np.full(256, OTHER_PLAYER, np.uint8)
    )
    shades[0], shades[target_id] = BACKGROUND, 0
    return np.repeat(shades[labels][..., None], 3, axis=2)


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
    quiz = silhouette_pixels(labels, target_id)
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


class MappedFrames(list):
    """Image paths plus the exact timing used by every tracking/correction pass."""
    frame_map: dict


def extract(
    source: Path, directory: Path, start: float, end: float, maximum=(1280, 720),
    frame_map=None,
) -> list[Path]:
    from .source_frames import resolve_source, decode_selected
    mapping, timeline = resolve_source(source, start, end, frame_map)
    if not 2 <= len(mapping["frames"]) <= MAX_SECONDS * FPS:
        raise ValueError("Video is too short or the selected segment cannot be decoded")
    directory.mkdir()
    decoded = decode_selected(source, directory, mapping, timeline, maximum)
    frames = MappedFrames()
    for index, entry in enumerate(mapping["frames"]):
        destination = directory / f"{index:06d}.jpg"
        try:
            destination.hardlink_to(decoded[entry["source_index"]])
        except OSError:
            shutil.copyfile(decoded[entry["source_index"]], destination)
        frames.append(destination)
    for path in decoded.values():
        path.unlink()
    frames.frame_map = mapping
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


def check_device_mask_area(device, previous, current, pixels):
    # MPS can produce a near-full-frame mask immediately after a valid small
    # person mask. Retry from untouched selections on CPU for this numerical
    # failure. Real camera cuts still receive warnings on the CPU retry.
    if (
        device == "mps"
        and previous is not None
        and previous < pixels * 0.2
        and current > pixels * 0.8
    ):
        raise RuntimeError(
            "MPS tracking mask expanded into the background; retry on CPU"
        )


def check_device_tracking(device, kind):
    # MPS numerical drift can erase any player or expand their mask. Retry
    # once on CPU; genuine occlusion/cut warnings must survive that retry.
    if device == "mps" and kind in {"target_lost", "player_lost", "tracking_unstable"}:
        raise RuntimeError(f"MPS {kind}; retry on CPU")


def track(
    frames: list[Path],
    destination: Path,
    job: dict,
    checkpoint: Path,
    device: str,
    progress=None,
    cache_source=None,
    refinement_frames=None,
) -> list[dict]:
    """Use native SAM 2.1 video tracking memory and per-frame corrections."""
    from backend.jumper.resources import (
        check_resources,
        estimate_resources,
        resident_memory,
    )

    height, width = cv2.imread(str(frames[0])).shape[:2]
    initial_estimate = estimate_resources(job, width, height)
    check_resources(initial_estimate, previous_bytes=resident_memory())
    import torch
    from sam2.build_sam import build_sam2_video_predictor
    from backend.jumper.frames import bounded_state, prune_tracking
    from backend.jumper.tracking_check import (
        confirmed_shooter_frame, tracking_check_segments, ShooterTrackingCheck,
    )

    from backend.jumper.tracking_anchors import reset_shooter_memory
    recovery_anchors = any(p.get("anchor") is True for obj in job["objects"]
                           if obj["id"] == job["target_id"] for p in obj["prompts"])
    job.pop("_tracking_check", None)
    anchor = (
        confirmed_shooter_frame(job["objects"], job["target_id"])
        if job.get("verify_shooter") else None
    )
    tracking_check = (
        ShooterTrackingCheck(anchor, job["target_id"])
        if anchor is not None else None
    )

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
    from backend.jumper.cache import FrameCache, cache_backbone, identity
    from backend.config import PROJECT_ROOT

    cache = None
    try:
        cache = FrameCache(
            PROJECT_ROOT / "jumper-media" / "calculation-cache",
            identity(cache_source, job, checkpoint, device, frames),
        )
        cache_backbone(predictor, cache, device=device)
    except Exception:
        pass
    warnings = []
    rejected_memories = set()
    def memory_warning(frame, identity):
        key = (frame, identity)
        if key not in rejected_memories:
            rejected_memories.add(key)
            warnings.append(dict(frame=frame, kind="memory_rejected",
                                 **({"track_ids": [identity]} if identity is not None else {})))
    refiner = None
    if job.get("refine_small_players"):
        from backend.jumper.small_player import SmallPlayerRefiner, small_player_crop
        if refinement_frames is not None and len(refinement_frames) != len(frames):
            raise ValueError("Refinement frames do not match the tracking timeline")
        refiner = SmallPlayerRefiner(predictor)
    detector = None
    if job.get("auto_detect_others"):
        from ultralytics import YOLO
        from backend.config import MODEL_WEIGHTS_DIR

        detector_path = MODEL_WEIGHTS_DIR / "yolo11n-pose.pt"
        if not detector_path.is_file():
            raise ValueError(
                "Local person detector is missing. Run the downloaded app setup again."
            )
        detector = YOLO(str(detector_path))
        from importlib.metadata import version

        detector_key = digest(detector_path) + version("ultralytics")

    def detect(index):
        key = f"people:{detector_key}:{index}"
        cached = cache.get(key) if cache else None
        if cached is not None:
            boxes = cached.get("boxes")
            if (
                isinstance(boxes, np.ndarray)
                and np.issubdtype(boxes.dtype, np.floating)
                and boxes.ndim == 2
                and boxes.shape[1] == 4
                and len(boxes) <= 20
                and np.isfinite(boxes).all()
                and np.all((boxes >= 0) & (boxes <= 1))
                and np.all(boxes[:, 0] < boxes[:, 2])
                and np.all(boxes[:, 1] < boxes[:, 3])
            ):
                return boxes.tolist()
        detections = detector.predict(
            cv2.imread(str(frames[index])),
            classes=[0],
            conf=0.25,
            iou=0.45,
            imgsz=640,
            rect=False,
            device="cpu",
            verbose=False,
        )[0]
        boxes = detections.boxes.xyxy.cpu().numpy() / [width, height, width, height]
        if len(boxes) > 20:
            raise ValueError(
                "More than 20 people detected. Trim to a closer view or use manual selection."
            )
        if cache:
            cache.put(key, {"boxes": boxes})
        return boxes.tolist()

    if detector is not None:
        from backend.jumper.discovery import require_shooter_box

        initial = next(o for o in job["objects"] if o["id"] == job["target_id"])[
            "prompts"
        ][0]
        point = next(
            (
                p
                for p, label in zip(
                    initial.get("points", []), initial.get("labels", [])
                )
                if label == 1
            ),
            None,
        )
        if initial["frame"] == 0 and "box" not in initial and point is not None:
            boxes = detect(0)
            initial["box"] = require_shooter_box(
                boxes, initial["points"], initial["labels"]
            )
    from .selection_stability import check_opening_selection
    initial = next(o for o in job["objects"] if o["id"] == job["target_id"])["prompts"][0]
    if initial.get("box") and 1 in initial.get("labels", []):
        check_opening_selection(predictor, frames, initial, job["target_id"], width, height)
    with MemoryQualityGate(
        predictor, memory_warning, (obj["id"] for obj in job["objects"] if obj.get("ignored")),
        target_id=job["target_id"]
    ) as memory_gate, torch.inference_mode():
        state = bounded_state(predictor, frames)
        try:
            # Seed every identity before propagation. Additional prompts at
            # later frames condition the same object's tracking memory.
            prompts = sorted(
                (p["frame"], obj["id"], p)
                for obj in job["objects"]
                if not obj.get("ignored") or job.get("auto_detect_others")
                for p in obj["prompts"]
            )

            def apply_prompt(state, index, obj_id, prompt):
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

            for index, obj_id, prompt in prompts:
                # A future confirmation must not bias the independent forward pass.
                if (tracking_check or recovery_anchors) and obj_id == job["target_id"] and index > 0:
                    continue
                apply_prompt(state, index, obj_id, prompt)
            camera_cuts = CameraCuts()
            quality = MaskQuality()
            joins = MaskJoins(width, height)
            floor_attachments = FloorAttachments(width, height)
            visibility = ShooterVisibility()
            ownership = MaskOwnership(width, height)
            previous_areas = {}
            frame_boxes = []
            shooter_ambiguous = False

            def propagation():
                nonlocal frame_boxes, shooter_ambiguous
                if detector is None and tracking_check is None and not recovery_anchors:
                    yield from predictor.propagate_in_video(state, start_frame_idx=0)
                    return
                from backend.jumper.discovery import PeopleDiscovery

                discovery = PeopleDiscovery()

                for index in range(len(frames)):
                    if tracking_check or recovery_anchors:
                        for at, identity, prompt in prompts:
                            if at == index and at > 0 and identity == job["target_id"]:
                                if prompt.get("anchor") is True:
                                    reset_shooter_memory(state, identity)
                                    memory_gate.reset_object(state, identity)
                                apply_prompt(state, at, identity, prompt)
                    _, ids, logits = next(
                        predictor.propagate_in_video(
                            state, start_frame_idx=index, max_frame_num_to_track=0
                        )
                    )
                    if detector is None:
                        yield index, ids, logits
                        continue
                    values = tracking_masks(logits, ids, height, width)
                    for row, identity in enumerate(ids):
                        if index < next(
                            o["prompts"][0]["frame"]
                            for o in job["objects"]
                            if o["id"] == identity
                        ):
                            values[row] = -1024
                    owners = np.zeros((height, width), dtype=np.uint8)
                    valid = values.max(axis=0) > 0
                    owners[valid] = np.asarray(ids, dtype=np.uint8)[
                        values.argmax(axis=0)[valid]
                    ]
                    boxes = detect(index)
                    frame_boxes = boxes
                    resolution = discovery.resolve(index, boxes, owners, job["objects"])
                    shooter_ambiguous = job["target_id"] in resolution["ambiguous_tracks"]
                    if resolution["ambiguous"]:
                        warning = {"frame": index, "kind": "ambiguous_players"}
                        if resolution["ambiguous_tracks"]:
                            warning["track_ids"] = resolution["ambiguous_tracks"]
                        warnings.append(warning)
                    additions = resolution["unmatched"]
                    for box in additions:
                        if len(job["objects"]) >= 20:
                            raise ValueError(
                                "More than 20 tracks needed. Remove spectators or use manual selection."
                            )
                        identity = max(o["id"] for o in job["objects"]) + 1
                        if identity > 255:
                            raise ValueError(
                                "Too many selections. Start a fresh selection."
                            )
                        prompt = {"frame": index, "box": box}
                        job["objects"].append({"id": identity, "prompts": [prompt]})
                        check_resources(
                            estimate_resources(job, width, height),
                            previous_bytes=initial_estimate["bytes"],
                        )
                        predictor.add_new_points_or_box(
                            state,
                            frame_idx=index,
                            obj_id=identity,
                            box=np.array(box, dtype=np.float32)
                            * [width, height, width, height],
                        )
                    if additions:
                        _, ids, logits = next(
                            predictor.propagate_in_video(
                                state, start_frame_idx=index, max_frame_num_to_track=0
                            )
                        )
                    yield index, ids, logits

            for index, ids, logits in propagation():
                if progress:
                    progress(index, len(frames))
                values = tracking_masks(logits, ids, height, width)
                starts = {
                    obj["id"]: obj["prompts"][0]["frame"] for obj in job["objects"]
                }
                for row, identity in enumerate(ids):
                    if index < starts[identity]:
                        values[row] = -1024
                    area = int(np.count_nonzero(values[row] > 0))
                    check_device_mask_area(
                        device, previous_areas.get(identity), area, height * width
                    )
                    previous_areas[identity] = area
                target_row = list(ids).index(job["target_id"])
                target = values[target_row]
                current = None
                if memory_gate.originals:
                    # Pinned native SAM exposes presence scores in compact outputs;
                    # lightweight fixture predictors expose only their masks.
                    outputs = state["output_dict_per_obj"][state["obj_id_to_idx"][job["target_id"]]]
                    current = outputs["cond_frame_outputs"].get(index)
                    if current is None:
                        current = outputs["non_cond_frame_outputs"].get(index)
                score = (float(current["object_score_logits"].reshape(-1)[0].item())
                         if current is not None and "object_score_logits" in current else 1)
                if current is not None and not current.get('_jumper_reliable', True):
                    score = 0
                confirmed = any(p["frame"] == index and (p.get("box") or 1 in p.get("labels", []))
                                for o in job["objects"]
                                if o["id"] == job["target_id"] for p in o["prompts"])
                seen = visibility.inspect(index, target,
                    [v for row, v in enumerate(values) if row != target_row], score, confirmed, shooter_ambiguous)
                if seen["warning"]:
                    warnings.append(dict(frame=index, kind=seen["warning"], track_ids=[job["target_id"]]))
                if not seen["visible"]:
                    target.fill(-1024)
                    if current is not None:
                        current['_jumper_reliable'] = False
                if tracking_check:
                    tracking_check.record(index, target)
                if refiner is not None:
                    # Temporal tracking/discovery and backward checks retain their
                    # original scores. Crop refinement affects visible output only.
                    raw_owners = np.zeros((height, width), dtype=np.uint8)
                    valid = values.max(axis=0) > 0
                    raw_owners[valid] = np.asarray(ids, dtype=np.uint8)[
                        values.argmax(axis=0)[valid]
                    ]
                    refined_values = values.copy()
                    fine_image = None
                    for row, identity in enumerate(ids):
                        obj = next(
                            o for o in job["objects"] if o["id"] == identity
                        )
                        if obj.get("ignored") or index < starts[identity] or (identity == job["target_id"] and not seen["visible"]):
                            continue
                        prompt = next(
                            (p for p in obj["prompts"] if p["frame"] == index), None
                        )
                        crop = small_player_crop(values[row], prompt)
                        if crop is None:
                            continue
                        if progress:
                            progress(
                                index, len(frames),
                                f"Refining small player {identity} · frame {index + 1} / {len(frames)}"
                            )
                        refined = None
                        if not crop["unusable"]:
                            if fine_image is None:
                                fine_image = cv2.cvtColor(
                                    cv2.imread(str((refinement_frames or frames)[index])),
                                    cv2.COLOR_BGR2RGB,
                                )
                            refined = refiner.refine(
                                fine_image, values[row], crop, raw_owners, identity
                            )
                        if refined is None:
                            warnings.append(dict(
                                frame=index, kind="refinement_uncertain", track_ids=[identity]
                            ))
                        else:
                            refined_values[row] = refined
                    values = refined_values
                current = cv2.cvtColor(
                    cv2.resize(cv2.imread(str(frames[index])), (64, 36)),
                    cv2.COLOR_BGR2RGB,
                )
                transition = camera_cuts.inspect(index, current)
                cut = transition["reset"]
                warnings.extend(
                    {"frame": at, "kind": "possible_camera_cut"}
                    for at in transition["cuts"]
                )
                # Discovery and SAM memory keep raw scores. Apply bounded
                # consistency only to the final, mutually exclusive output.
                labels = ownership.resolve(
                    ids,
                    values,
                    excluded={o["id"] for o in job["objects"] if o.get("ignored")},
                    reset=cut
                    or any(
                        p["frame"] == index
                        for o in job["objects"]
                        for p in o["prompts"]
                    ),
                )
                warnings.extend(check_corrections(index, labels, job["objects"]))
                warnings.extend(floor_attachments.inspect(index, labels, job["objects"], frame_boxes, reset=cut))
                joins.begin()
                for row, identity in enumerate(ids):
                    joins.add(identity, values[row])
                warnings.extend(joins.inspect(index, labels, job["objects"], frame_boxes, reset=cut))
                np.save(destination / f"{index:06d}.npy", labels, allow_pickle=False)
                frame_warnings = quality.inspect(
                    index, labels, job["objects"], job["target_id"], reset=cut,
                    invisible=() if seen["visible"] else (job["target_id"],)
                )
                for warning in frame_warnings:
                    check_device_tracking(device, warning["kind"])
                warnings.extend(frame_warnings)
                prune_tracking(state, index)
                if device == "mps":
                    torch.mps.synchronize()
                    torch.mps.empty_cache()
                    if (
                        torch.mps.driver_allocated_memory()
                        > torch.mps.recommended_max_memory() * 0.55
                    ):
                        raise RuntimeError(
                            "MPS working set exceeds the safe memory budget"
                        )
        finally:
            predictor.reset_state(state)
            memory_gate.clear()
        if tracking_check:
            # Each confirmed section starts with independent reverse memory.
            # Additional Include points shorten a difficult section on retry.
            checked_frames = 0
            for segment in tracking_check_segments(job["objects"], job["target_id"]):
                state = bounded_state(predictor, frames)
                try:
                    prompt = next(
                        p for at, identity, p in prompts
                        if at == segment["anchor"] and identity == job["target_id"]
                    )
                    apply_prompt(state, segment["anchor"], job["target_id"], prompt)
                    for index, ids, logits in predictor.propagate_in_video(
                        state,
                        start_frame_idx=segment["anchor"],
                        max_frame_num_to_track=segment["anchor"] - segment["first"],
                        reverse=True,
                    ):
                        if progress:
                            progress(
                                checked_frames, anchor + 1, "Checking shooter backward"
                            )
                        values = tracking_masks(logits, ids, height, width)
                        tracking_check.compare(index, values[list(ids).index(job["target_id"])])
                        prune_tracking(state, index, reverse=True)
                        checked_frames += 1
                        if device == "mps":
                            torch.mps.synchronize()
                            torch.mps.empty_cache()
                finally:
                    predictor.reset_state(state)
                    memory_gate.clear()
            checked = tracking_check.finish()
            warnings.extend(checked["warnings"])
            job["_tracking_check"] = checked["tracking_check"]
    del state, predictor
    if device == "mps":
        torch.mps.empty_cache()
    if len(list(destination.glob("*.npy"))) != len(frames):
        raise RuntimeError("Incomplete mask propagation")
    warnings.extend(
        {"frame": at, "kind": "possible_camera_cut"} for at in camera_cuts.finish()
    )
    return warnings


@contextmanager
def encoder(path: Path, width: int, height: int, high_quality=False):
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
                "8" if high_quality else "18",
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


def _render(
    frames: list[Path],
    masks: Path,
    output: Path,
    target: int,
    token: str,
    silhouette: bool = False,
    palette: bool = False,
    progress=None,
    high_quality=False,
) -> dict:
    output.mkdir(exist_ok=True)
    if silhouette:
        height, width = np.load(masks / "000000.npy", allow_pickle=False).shape
    else:
        height, width = cv2.imread(str(frames[0])).shape[:2]
    kinds = ("quiz",) if silhouette else ("quiz", "reveal", "highlight")
    paths = {
        kind: output
        / f"{hashlib.sha256(f'{token}:{kind}'.encode()).hexdigest()[:32]}.mp4"
        for kind in kinds
    }
    shades = None
    if silhouette and palette:
        graph = OverlapPalette(target)
        for index in range(len(frames)):
            labels = np.load(masks / f"{index:06d}.npy", allow_pickle=False)
            if labels.shape != (height, width):
                raise ValueError("Mask dimensions changed during palette planning")
            graph.observe(labels)
        shades = graph.finish()
    proofs = []
    details = []
    with ExitStack() as stack:
        streams = [
            stack.enter_context(encoder(path, width, height, high_quality)) for path in paths.values()
        ]
        for index, frame in enumerate(frames):
            labels = np.load(masks / f"{index:06d}.npy", allow_pickle=False)
            if labels.shape != (height, width):
                raise ValueError("Mask dimensions changed during export")
            if silhouette:
                composites = (silhouette_pixels(labels, target, palette, shades),)
            else:
                rgb = cv2.cvtColor(cv2.imread(str(frame)), cv2.COLOR_BGR2RGB)
                composites = composite(rgb, labels, target)
            for kind, image in zip(kinds, composites):
                validate_composite(image, labels, target, kind, palette=palette, shades=shades)
            if silhouette:
                composites = tuple(neutral_edges(image) for image in composites)
            proofs.append(silhouette_proof(composites[0]))
            details.append(detail_proof(composites[0]))
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
            if progress:
                progress(index + 1, len(frames))
    for kind, path in paths.items():
        validate_finished_video(
            path, width, height, len(frames), proofs if kind == "quiz" else None,
            details=details if kind == "quiz" else None,
        )
    if silhouette:
        paths["highlight"] = paths["quiz"]
        paths["reveal"] = paths["quiz"]
    paths["thumbnail"] = thumbnail
    return {
        kind: {"file": path.name, "sha256": digest(path), "bytes": path.stat().st_size}
        for kind, path in paths.items()
    }


def render(frames, masks, output, target, token, silhouette=False, palette=False, progress=None):
    # Retry only compositing/encoding from completed masks, never segmentation.
    try:
        return _render(frames, masks, output, target, token, silhouette, palette, progress)
    except SilhouetteCompressionError:
        return _render(frames, masks, output, target, token, silhouette, palette, progress, True)
