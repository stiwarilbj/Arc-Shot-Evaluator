from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from backend.analysis.geometry import clamp, distance
from backend.domain.models import BoundingBox, BallCandidate, FrameDetections, PlayerPose


COCO_LINKS = (
    (5, 7), (7, 9), (6, 8), (8, 10), (5, 6),
    (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
)


class BasketballVisionModels:
    """Thin adapter around two local Ultralytics checkpoints."""

    def __init__(self, detector_path: Path, pose_path: Path):
        from ultralytics import YOLO
        import torch

        self.detector = YOLO(str(detector_path))
        self.pose = YOLO(str(pose_path))
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"

    def infer_detector(self, frames: list[np.ndarray]) -> list[FrameDetections]:
        results = self.detector.predict(
            frames,
            conf=0.07,
            iou=0.45,
            imgsz=960,
            device=self.device,
            verbose=False,
        )
        evidence: list[FrameDetections] = []
        for frame, result in zip(frames, results, strict=True):
            item = FrameDetections()
            if result.boxes is not None:
                boxes = result.boxes.xyxy.cpu().numpy()
                confidences = result.boxes.conf.cpu().numpy()
                classes = result.boxes.cls.cpu().numpy().astype(int)
                for raw, confidence, class_id in zip(boxes, confidences, classes, strict=True):
                    x1, y1, x2, y2 = map(float, raw)
                    name = result.names[int(class_id)]
                    if name == "basketball":
                        size = math.sqrt(max(1.0, (x2 - x1) * (y2 - y1)))
                        if 4 <= size <= max(frame.shape[:2]) * 0.11:
                            item.balls.append(
                                BallCandidate(
                                    (x1 + x2) / 2,
                                    (y1 + y2) / 2,
                                    float(confidence),
                                    size,
                                    "model",
                                )
                            )
                    elif name == "hoop":
                        item.hoops.append(BoundingBox(x1, y1, x2, y2, float(confidence), "model"))
            evidence.append(item)
        return evidence

    def infer_pose(self, frames: list[np.ndarray]) -> list[list[PlayerPose]]:
        results = self.pose.predict(
            frames,
            conf=0.18,
            imgsz=768,
            device=self.device,
            verbose=False,
        )
        output: list[list[PlayerPose]] = []
        for result in results:
            poses: list[PlayerPose] = []
            if result.boxes is None or result.keypoints is None:
                output.append(poses)
                continue
            boxes = result.boxes.xyxy.cpu().numpy()
            box_conf = result.boxes.conf.cpu().numpy()
            xy = result.keypoints.xy.cpu().numpy()
            kp_conf = result.keypoints.conf
            conf = kp_conf.cpu().numpy() if kp_conf is not None else np.ones(xy.shape[:2])
            for raw_box, person_conf, points, scores in zip(boxes, box_conf, xy, conf, strict=True):
                x1, y1, x2, y2 = map(float, raw_box)
                keypoints = [
                    (float(x), float(y), float(score))
                    for (x, y), score in zip(points, scores, strict=True)
                ]
                poses.append(
                    PlayerPose(BoundingBox(x1, y1, x2, y2, float(person_conf), "pose"), keypoints, float(person_conf))
                )
            output.append(poses)
        return output


def _orange_mask(frame: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    warm = cv2.inRange(hsv, (0, 85, 65), (27, 255, 255))
    return warm


def frame_sharpness(frame: np.ndarray) -> float:
    """Return a resolution-independent-ish sharpness confidence for a frame.

    Motion-blurred broadcast frames still contain useful color and model
    detections, but their Laplacian energy drops sharply. The value is a
    routing signal, not a hard quality gate: the analyzer uses it to allow a
    longer prediction bridge and surfaces the limitation in the report.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if max(gray.shape) > 640:
        scale = 640 / max(gray.shape)
        gray = cv2.resize(gray, (max(2, round(gray.shape[1] * scale)), max(2, round(gray.shape[0] * scale))))
    variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    # Log compression keeps resolution/content differences from dominating;
    # values below ~0.22 are typically the visibly smeared frames. The
    # baseline is calibrated after the 640px resize above, not at source
    # resolution (where Laplacian variance is not comparable).
    return clamp((math.log1p(variance) - 6.5) / 2.6, 0.0, 1.0)


def color_ball_candidates(frame: np.ndarray) -> list[BallCandidate]:
    mask = _orange_mask(frame)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_scale = max(frame.shape[:2])
    candidates: list[BallCandidate] = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        size = math.sqrt(width * height)
        if size < max(4, frame_scale * 0.004) or size > frame_scale * 0.055:
            continue
        aspect = width / max(1.0, height)
        if not 0.48 <= aspect <= 1.9:
            continue
        area = float(cv2.contourArea(contour))
        fill = area / max(1.0, width * height)
        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * math.pi * area / max(1.0, perimeter * perimeter)
        if fill < 0.2 or circularity < 0.12:
            continue
        shape = math.exp(-abs(math.log(max(aspect, 1e-3))))
        confidence = clamp(0.05 + 0.18 * fill + 0.16 * circularity + 0.08 * shape, 0.05, 0.48)
        candidates.append(BallCandidate(x + width / 2, y + height / 2, confidence, size, "color"))
    return sorted(candidates, key=lambda item: item.confidence, reverse=True)[:64]


def _net_evidence(frame: np.ndarray, box: tuple[int, int, int, int]) -> float:
    x, y, width, height = box
    frame_h, frame_w = frame.shape[:2]
    x1 = max(0, x - width // 8)
    x2 = min(frame_w, x + width + width // 8)
    y1 = max(0, y + max(2, height // 3))
    y2 = min(frame_h, y + height + int(width * 1.05))
    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return 0.0
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, (0, 0, 135), (179, 105, 255))
    edges = cv2.Canny(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), 70, 170)
    white_density = float(np.count_nonzero(white)) / white.size
    edge_density = float(np.count_nonzero(edges)) / edges.size
    return clamp(white_density * 2.3 + edge_density * 2.0, 0.0, 1.0)


def color_rim_candidates(frame: np.ndarray) -> list[BoundingBox]:
    """Find horizontally orange, net-supported rim proposals.

    This is a fallback for hoops that are too small for the learned detector.
    It intentionally produces proposals; temporal selection happens later.
    """
    frame_h, frame_w = frame.shape[:2]
    mask = _orange_mask(frame)
    # Do not assume a landscape, side-on composition.  Portrait clips and
    # close-up/low-angle cameras can place the rim well below the upper half;
    # temporal selection and net evidence reject the additional proposals.
    mask[int(frame_h * 0.90) :, :] = 0
    closed = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3)),
    )
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    proposals: list[BoundingBox] = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        aspect = width / max(1.0, height)
        if not (frame_w * 0.008 <= width <= frame_w * 0.28):
            continue
        if not 1.45 <= aspect <= 7.0 or height > frame_h * 0.08:
            continue
        area = float(cv2.contourArea(contour))
        density = area / max(1.0, width * height)
        if density < 0.1:
            continue
        net = _net_evidence(frame, (x, y, width, height))
        aspect_score = math.exp(-abs(aspect - 2.9) / 2.2)
        upper_score = clamp(1.0 - y / (frame_h * 0.90), 0.0, 1.0)
        confidence = clamp(
            0.10 + 0.22 * density + 0.24 * aspect_score + 0.34 * net + 0.10 * upper_score,
            0.08,
            0.94,
        )
        # Normalize the contour into a regulation-rim-shaped bracket. The
        # color contour often includes a little support or backboard trim.
        rim_height = max(6.0, min(height, width * 0.30))
        center_y = y + min(height * 0.58, rim_height)
        proposals.append(
            BoundingBox(float(x), float(center_y - rim_height / 2), float(x + width), float(center_y + rim_height / 2), confidence, "color")
        )
    return sorted(proposals, key=lambda box: box.confidence, reverse=True)[:18]


def merge_ball_candidates(model: list[BallCandidate], color: list[BallCandidate]) -> list[BallCandidate]:
    merged = list(model)
    for candidate in color:
        match = next(
            (
                existing
                for existing in merged
                if distance((candidate.x, candidate.y), (existing.x, existing.y))
                <= max(9.0, 0.65 * (candidate.size + existing.size))
            ),
            None,
        )
        if match is None:
            merged.append(candidate)
        elif match.source == "model":
            match.confidence = clamp(match.confidence + candidate.confidence * 0.25, 0.0, 1.0)
            match.x = match.x * 0.75 + candidate.x * 0.25
            match.y = match.y * 0.75 + candidate.y * 0.25
    return sorted(merged, key=lambda item: item.confidence, reverse=True)[:72]


@dataclass
class RimTrackCandidate:
    observations: list[tuple[int, BoundingBox]] = field(default_factory=list)
    last_frame: int = -1
    velocity: tuple[float, float] = (0.0, 0.0)

    def predict(self, frame: int) -> tuple[float, float]:
        cx, cy = self.observations[-1][1].center
        gap = frame - self.last_frame
        return cx + self.velocity[0] * gap, cy + self.velocity[1] * gap

    def append(self, frame: int, box: BoundingBox) -> None:
        if self.observations:
            previous_frame, previous = self.observations[-1]
            gap = max(1, frame - previous_frame)
            vx = (box.center[0] - previous.center[0]) / gap
            vy = (box.center[1] - previous.center[1]) / gap
            self.velocity = (0.65 * self.velocity[0] + 0.35 * vx, 0.65 * self.velocity[1] + 0.35 * vy)
        self.observations.append((frame, box))
        self.last_frame = frame


def select_rim_track(all_candidates: list[list[BoundingBox]], frame_size: tuple[int, int]) -> list[BoundingBox | None]:
    frame_w, frame_h = frame_size
    diagonal = math.hypot(frame_w, frame_h)
    tracks: list[RimTrackCandidate] = []
    for frame_index, candidates in enumerate(all_candidates):
        available = sorted(candidates, key=lambda box: box.confidence, reverse=True)[:18]
        claimed: set[int] = set()
        # Keep tracks alive across short detector gaps. This matters at 60 fps
        # when a physical rim alternates between a learned backboard box and
        # a thin orange-cylinder proposal; five frames was short enough to
        # split one basket into several competing tracks.
        active = [track for track in tracks if frame_index - track.last_frame <= 24]
        for track in sorted(active, key=lambda value: len(value.observations), reverse=True):
            predicted = track.predict(frame_index)
            last_box = track.observations[-1][1]
            best_index = None
            best_cost = float("inf")
            for index, box in enumerate(available):
                if index in claimed:
                    continue
                ratio = box.width / max(1.0, last_box.width)
                source_shift = last_box.source in {"model", "hybrid"} or box.source in {"model", "hybrid"}
                if (
                    box.source == "color"
                    and box.width < frame_w * 0.022
                    and last_box.width >= frame_w * 0.022
                ):
                    # Never shrink an established physical rim track into a
                    # sub-floor orange edge fragment, regardless of whether
                    # the preceding observation was already a color proposal.
                    continue
                if source_shift:
                    if (
                        box.source == "color"
                        and box.width < frame_w * 0.022
                        and last_box.width >= frame_w * 0.04
                    ):
                        # In portrait broadcasts the rim detector sometimes
                        # returns a tiny orange edge fragment. Do not let that
                        # fragment replace a learned/backboard anchor and
                        # drag the physical rim plane down by a dozen pixels.
                        continue
                    # Learned hoop boxes can cover the backboard while the
                    # color proposal isolates only the cylinder. Keep those
                    # two observations in one track so a rim is not lost for
                    # a few frames when the orange edge is occluded.
                    if not 0.34 <= ratio <= 2.8:
                        continue
                    learned_box = last_box if last_box.source in {"model", "hybrid"} else box
                    color_box = box if box.source == "color" else last_box if last_box.source == "color" else None
                    if color_box is not None:
                        # A color proposal may refine the learned backboard
                        # box, but it must remain near that learned anchor.
                        # Without this gate a persistent orange court marking
                        # can hijack the track during a broadcast pan.
                        x_margin = max(learned_box.width * 0.55, 28.0)
                        y_margin = max(learned_box.height * 0.80, 28.0)
                        if (
                            abs(color_box.center[0] - learned_box.center[0]) > x_margin
                            or abs(color_box.center[1] - learned_box.center[1]) > y_margin
                        ):
                            continue
                elif not 0.68 <= ratio <= 1.55:
                    continue
                center_cost = distance(predicted, box.center)
                max_distance = max(diagonal * (0.075 if source_shift else 0.045), last_box.width * (2.4 if source_shift else 1.6))
                if center_cost > max_distance:
                    continue
                # A single bad proposal must not fling the track across the
                # frame. Real broadcast pans are smooth at video cadence.
                last_distance = distance(last_box.center, box.center)
                frame_gap = max(1, frame_index - track.last_frame)
                max_last_distance = max(30.0 * frame_gap, last_box.width * 0.58)
                if source_shift:
                    max_last_distance = max(max_last_distance, last_box.height * 0.78, last_box.width * 2.0)
                if last_distance > max_last_distance:
                    continue
                cost = center_cost / max_distance + abs(math.log(ratio)) * 0.35 - box.confidence * 0.22
                if cost < best_cost:
                    best_cost, best_index = cost, index
            if best_index is not None:
                track.append(frame_index, available[best_index])
                claimed.add(best_index)
        for index, box in enumerate(available):
            if index not in claimed:
                track = RimTrackCandidate()
                track.append(frame_index, box)
                tracks.append(track)

    minimum = max(8, len(all_candidates) // 18)
    viable = [track for track in tracks if len(track.observations) >= minimum]
    if not viable:
        return [None] * len(all_candidates)

    supported = [
        track
        for track in viable
        if sum(box.source in {"model", "hybrid"} for _, box in track.observations) >= 3
    ]
    # If the learned detector has a sustained hoop hypothesis, do not let a
    # long orange court/jersey edge win simply because it appears in more
    # frames. Geometry-only proposals remain the fallback for clips where the
    # learned model never sees a usable basket.
    if supported:
        viable = supported

    def score(track: RimTrackCandidate) -> float:
        boxes = [box for _, box in track.observations]
        coverage = len(boxes) / max(1, len(all_candidates))
        confidence = float(np.median([box.confidence for box in boxes]))
        learned_support = sum(box.source in {"model", "hybrid"} for box in boxes) / max(1, len(boxes))
        upper = 1.0 - float(np.median([box.center[1] for box in boxes])) / frame_h
        median_width = float(np.median([box.width for box in boxes]))
        width_target = frame_w * 0.075
        size_score = math.exp(-abs(math.log(max(1.0, median_width) / width_target)))
        median_x = float(np.median([box.center[0] for box in boxes]))
        edge_penalty = 2.2 if median_x < frame_w * 0.028 or median_x > frame_w * 0.972 else 0.0
        centers = np.asarray([box.center for box in boxes], dtype=float)
        if len(centers) >= 3:
            steps = np.linalg.norm(np.diff(centers, axis=0), axis=1)
            regularity = 1.0 / (1.0 + float(np.median(steps)) / 12.0)
        else:
            regularity = 0.0
        # A broadcast frame can contain many persistent orange court/jersey
        # edges.  When the learned hoop detector corroborates a track, prefer
        # that physical basket over a higher-confidence color-only decoy.  The
        # support is additive rather than mandatory so clips where the model
        # misses a tiny rim still fall back to the geometry proposals.
        return (
            coverage * 1.6
            + confidence * 1.85
            + learned_support * 3.4
            + upper * 0.42
            + regularity * 0.62
            + size_score * 0.85
            - edge_penalty
        )

    best = max(viable, key=score)
    frames = np.asarray([frame for frame, _ in best.observations], dtype=float)
    values = np.asarray([[box.x1, box.y1, box.x2, box.y2, box.confidence] for _, box in best.observations])
    output: list[BoundingBox | None] = []
    # Keep a short-lived rim visible through detector dropouts. A broadcast
    # cut or net occlusion can hide the edge for a meaningful fraction of a
    # 30/60 fps clip; nine percent ended the track before the descending ball
    # reached the cylinder in several portrait examples.
    max_bridge = max(12, int(len(all_candidates) * 0.20))
    for frame_index in range(len(all_candidates)):
        nearest = int(np.min(np.abs(frames - frame_index)))
        if nearest > max_bridge:
            output.append(None)
            continue
        coords = [float(np.interp(frame_index, frames, values[:, column])) for column in range(5)]
        tracked = BoundingBox(*coords[:4], clamp(coords[4], 0.0, 1.0), "tracked")
        if tracked.height > tracked.width * 0.60:
            # The learned detector can be the only stable temporal anchor,
            # but its box may include the backboard. If a physical orange rim
            # proposal is available in the same frame, use that tighter box
            # for calibration and drawing while retaining track continuity.
            physical = [
                candidate
                for candidate in all_candidates[frame_index]
                if candidate.source in {"color", "hybrid"}
                # Keep tiny orange edge fragments from collapsing a stable
                # backboard/rim track into a 15–20 px strip, which is common
                # in portrait clips when the camera is zoomed out.  The
                # absolute frame-width floor keeps the physical calibration
                # scale stable while still allowing genuinely small rims.
                and candidate.width >= max(tracked.width * 0.32, frame_w * 0.022)
                and abs(candidate.center[0] - tracked.center[0]) <= max(tracked.width * 0.60, 30.0)
                and abs(candidate.center[1] - tracked.center[1]) <= max(tracked.height * 0.52, 26.0)
            ]
            if physical:
                best_physical = max(physical, key=lambda candidate: candidate.confidence)
                tracked = BoundingBox(
                    best_physical.x1,
                    best_physical.y1,
                    best_physical.x2,
                    best_physical.y2,
                    max(tracked.confidence, best_physical.confidence),
                    "tracked",
                )
        output.append(tracked)
    return output


def add_model_hoops(color: list[BoundingBox], model: list[BoundingBox]) -> list[BoundingBox]:
    output = list(color)
    for learned in model:
        # Some basketball detectors label the whole backboard/support as
        # ``hoop``.  That box is useful for finding the basket, but it is a
        # poor calibration primitive: its vertical center can be more than a
        # rim diameter away from the actual cylinder.  When a color/geometry
        # proposal lies inside such a tall learned box, use the proposal as
        # the physical rim and retain the learned confidence as corroborating
        # evidence instead of allowing the oversized box to win tracking.
        if learned.height > learned.width * 0.60:
            contained = [
                proposal
                for proposal in color
                if proposal.x1 >= learned.x1 - learned.width * 0.30
                and proposal.x2 <= learned.x2 + learned.width * 0.30
                and proposal.y1 >= learned.y1 - learned.height * 0.15
                and proposal.y2 <= learned.y2 + learned.height * 0.15
                and proposal.width >= learned.width * 0.35
            ]
            if contained:
                best = max(contained, key=lambda proposal: proposal.confidence)
                best.confidence = clamp(max(best.confidence, learned.confidence * 0.78), 0.0, 1.0)
                best.source = "hybrid"
                continue
        corroborated = any(
            distance(learned.center, proposal.center) <= max(learned.width, proposal.width) * 1.4
            for proposal in color
        )
        confidence = learned.confidence * (1.0 if corroborated else 0.48)
        output.append(BoundingBox(learned.x1, learned.y1, learned.x2, learned.y2, confidence, "model"))
    return sorted(output, key=lambda box: box.confidence, reverse=True)[:20]
