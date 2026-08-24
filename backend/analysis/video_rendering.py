from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np

from backend.analysis.geometry import distance
from backend.domain.models import BoundingBox, FrameDetections, PlayerPose, ShotAnalysis, BallTrackPoint
from backend.analysis.vision_models import COCO_LINKS


ORANGE = (63, 115, 238)
GREEN = (132, 193, 102)
RED = (94, 101, 219)
AMBER = (85, 170, 224)
WHITE = (238, 238, 238)
INK = (13, 15, 16)


def _active_shot(shots: list[ShotAnalysis], frame: int) -> ShotAnalysis | None:
    return next(
        (shot for shot in shots if shot.release_frame - 12 <= frame <= shot.end_frame + 8),
        None,
    )


def _point_for_frame(shot: ShotAnalysis, frame: int) -> BallTrackPoint | None:
    candidates = [point for point in shot.trace if abs(point.frame - frame) <= 1]
    return min(candidates, key=lambda point: abs(point.frame - frame)) if candidates else None


def _pose_for_ball(item: FrameDetections, point: BallTrackPoint | None) -> PlayerPose | None:
    if not item.poses:
        return None
    if point is None:
        return max(item.poses, key=lambda pose: pose.confidence)
    containing = [
        pose
        for pose in item.poses
        if pose.box.x1 - pose.box.width * 0.15 <= point.x <= pose.box.x2 + pose.box.width * 0.15
        and pose.box.y1 - 30 <= point.y <= pose.box.y2
    ]
    pool = containing or item.poses
    return min(
        pool,
        key=lambda pose: min(
            distance((point.x, point.y), pose.keypoints[index][:2])
            for index in (9, 10)
        ),
    )


def _pose_for_frame(
    evidence: list[FrameDetections],
    frame: int,
    point: BallTrackPoint | None,
    shooter_box: list[float] | None = None,
) -> PlayerPose | None:
    if shooter_box is not None and len(shooter_box) == 4:
        x1, y1, x2, y2 = map(float, shooter_box)
        anchor_center = ((x1 + x2) / 2.0, (y1 + y2) / 2.0)
        anchor_height = max(1.0, y2 - y1)
        for index in (frame, frame - 1, frame + 1, frame - 2, frame + 2, frame - 3, frame + 3):
            if not 0 <= index < len(evidence) or not evidence[index].poses:
                continue

            def cost(pose: PlayerPose) -> tuple[float, float]:
                center_cost = distance(pose.box.center, anchor_center) / anchor_height
                scale_cost = abs(np.log(max(1e-3, pose.box.height / anchor_height)))
                return (center_cost + scale_cost * 0.35, -pose.confidence)

            return min(evidence[index].poses, key=cost)
    for index in (frame, frame - 1, frame + 1):
        if 0 <= index < len(evidence):
            pose = _pose_for_ball(evidence[index], point)
            if pose is not None:
                return pose
    return None


def _draw_rim(frame: np.ndarray, rim: BoundingBox | None) -> None:
    if rim is None:
        return
    x1, y1, x2, y2 = map(int, (rim.x1, rim.y1, rim.x2, rim.y2))
    length = max(7, int(rim.width * 0.24))
    for x, x_step in ((x1, 1), (x2, -1)):
        cv2.line(frame, (x, y1), (x + x_step * length, y1), WHITE, 2, cv2.LINE_AA)
        cv2.line(frame, (x, y1), (x, y1 + length), WHITE, 2, cv2.LINE_AA)
        cv2.line(frame, (x, y2), (x + x_step * length, y2), WHITE, 2, cv2.LINE_AA)
        cv2.line(frame, (x, y2), (x, y2 - length), WHITE, 2, cv2.LINE_AA)


def _draw_trace(frame: np.ndarray, shot: ShotAnalysis, current_frame: int) -> None:
    visible = [point for point in shot.trace if current_frame - 42 <= point.frame <= current_frame]
    if len(visible) >= 2:
        overlay = frame.copy()
        for first, second in zip(visible, visible[1:]):
            age = current_frame - second.frame
            alpha = max(0.16, 1.0 - age / 48.0)
            color = tuple(int(channel * alpha + INK[index] * (1 - alpha)) for index, channel in enumerate(ORANGE))
            cv2.line(
                overlay,
                (int(first.x), int(first.y)),
                (int(second.x), int(second.y)),
                color,
                2,
                cv2.LINE_AA,
            )
        cv2.addWeighted(overlay, 0.82, frame, 0.18, 0, frame)
    point = _point_for_frame(shot, current_frame)
    if point is not None:
        radius = max(5, int(point.confidence * 8))
        cv2.circle(frame, (int(point.x), int(point.y)), radius + 3, INK, 2, cv2.LINE_AA)
        cv2.circle(frame, (int(point.x), int(point.y)), radius, ORANGE, 2, cv2.LINE_AA)


def _draw_pose(frame: np.ndarray, pose: PlayerPose | None) -> None:
    if pose is None:
        return
    for first, second in COCO_LINKS:
        a, b = pose.keypoints[first], pose.keypoints[second]
        if a[2] < 0.24 or b[2] < 0.24:
            continue
        cv2.line(frame, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), ORANGE, 2, cv2.LINE_AA)
    for index in (5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16):
        x, y, confidence = pose.keypoints[index]
        if confidence >= 0.24:
            cv2.circle(frame, (int(x), int(y)), 4, WHITE, -1, cv2.LINE_AA)
            cv2.circle(frame, (int(x), int(y)), 4, ORANGE, 1, cv2.LINE_AA)


def _draw_status(frame: np.ndarray, shot: ShotAnalysis | None) -> None:
    if shot is None:
        return
    label = f"SHOT {shot.id:02d}   {shot.outcome.upper()}   {shot.confidence * 100:.0f}%"
    color = GREEN if shot.outcome == "make" else RED if shot.outcome == "miss" else AMBER
    (width, height), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.48, 1)
    x, y = 18, frame.shape[0] - 22
    cv2.rectangle(frame, (x - 8, y - height - 9), (x + width + 9, y + 7), INK, -1)
    cv2.line(frame, (x - 8, y + 7), (x + width + 9, y + 7), color, 2)
    cv2.putText(frame, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.48, WHITE, 1, cv2.LINE_AA)


def _transcode(raw: Path, output: Path, audio_source: Path) -> None:
    import imageio_ffmpeg

    executable = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        executable,
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(raw),
        "-i",
        str(audio_source),
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        str(output),
    ]
    subprocess.run(command, check=True)
    raw.unlink(missing_ok=True)


def render_outputs(
    source: Path,
    session_dir: Path,
    meta,
    shots: list[ShotAnalysis],
    rims: list[BoundingBox | None],
    evidence: list[FrameDetections],
    progress=None,
) -> dict:
    annotated_raw = session_dir / "annotated-raw.mp4"
    pose_raw = session_dir / "pose-raw.mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    annotated_writer = cv2.VideoWriter(str(annotated_raw), fourcc, meta.fps, (meta.width, meta.height))
    pose_writer = cv2.VideoWriter(str(pose_raw), fourcc, meta.fps, (meta.width, meta.height))
    if not annotated_writer.isOpened() or not pose_writer.isOpened():
        raise RuntimeError("OpenCV could not initialize the local video encoder")
    capture = cv2.VideoCapture(str(source))
    thumbnail_frames = {shot.release_frame: shot for shot in shots}
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        clean = frame.copy()
        pose_frame = frame.copy()
        shot = _active_shot(shots, frame_index)
        rim = rims[frame_index] if frame_index < len(rims) else None
        _draw_rim(clean, rim)
        _draw_rim(pose_frame, rim)
        if shot is not None:
            _draw_trace(clean, shot, frame_index)
            _draw_trace(pose_frame, shot, frame_index)
            point = _point_for_frame(shot, frame_index)
            _draw_pose(
                pose_frame,
                _pose_for_frame(
                    evidence,
                    frame_index,
                    point,
                    shot.evidence.get("shooter_box"),
                ),
            )
        _draw_status(clean, shot)
        _draw_status(pose_frame, shot)
        annotated_writer.write(clean)
        pose_writer.write(pose_frame)
        if frame_index in thumbnail_frames:
            shot_info = thumbnail_frames[frame_index]
            target_width = 480
            scale = target_width / meta.width
            thumb = cv2.resize(clean, (target_width, int(meta.height * scale)), interpolation=cv2.INTER_AREA)
            cv2.imwrite(str(session_dir / f"shot-{shot_info.id:02d}.jpg"), thumb, [cv2.IMWRITE_JPEG_QUALITY, 88])
        frame_index += 1
        if progress and frame_index % 10 == 0:
            progress("Rendering review videos", frame_index, meta.frame_count)
    capture.release()
    annotated_writer.release()
    pose_writer.release()
    annotated = session_dir / "annotated.mp4"
    pose_video = session_dir / "pose.mp4"
    if progress:
        progress("Finalizing annotated review", meta.frame_count, meta.frame_count)
    _transcode(annotated_raw, annotated, source)
    if progress:
        progress("Finalizing pose review", meta.frame_count, meta.frame_count)
    _transcode(pose_raw, pose_video, source)
    session_id = session_dir.name
    return {
        "original": f"/media/{session_id}/{source.name}",
        "annotated": f"/media/{session_id}/annotated.mp4",
        "pose": f"/media/{session_id}/pose.mp4",
        "shots_jsonl": f"/media/{session_id}/shots.jsonl",
        "analysis_json": f"/media/{session_id}/analysis.json",
        "thumbnails": [f"/media/{session_id}/shot-{shot.id:02d}.jpg" for shot in shots],
    }
