"""Create compact pose tracks used by the static GitHub Pages review overlay.

The local app still runs the complete model pipeline. These tracks give the
hosted, browser-only build the same readable arm and leg projections without
shipping a Python runtime to the browser. One pose is retained per sampled
frame; the browser picks the nearest frame while the video plays.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
from ultralytics import YOLO


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
OUTPUT = EXAMPLES / "pose-data"
MODEL_PATH = ROOT / "models" / "yolo11n-pose.pt"


def choose_pose(result, width: int, height: int):
    keypoints = result.keypoints
    boxes = result.boxes
    if keypoints is None or boxes is None or len(keypoints) == 0:
        return None
    xy = keypoints.xy.cpu().numpy()
    confidence = keypoints.conf.cpu().numpy() if keypoints.conf is not None else None
    box_xyxy = boxes.xyxy.cpu().numpy()
    box_conf = boxes.conf.cpu().numpy()
    frame_area = max(1.0, float(width * height))
    candidates = []
    for index, points in enumerate(xy):
        x1, y1, x2, y2 = box_xyxy[index]
        area_score = min(1.0, max(0.0, float((x2 - x1) * (y2 - y1) / frame_area) * 8.0))
        center_score = 1.0 - min(1.0, abs(float((x1 + x2) / 2.0) / width - 0.5) * 1.5)
        detection_score = float(box_conf[index]) if index < len(box_conf) else 0.0
        candidates.append((detection_score * 0.55 + area_score * 0.3 + center_score * 0.15, index))
    _, selected = max(candidates)
    point_conf = confidence[selected] if confidence is not None else [1.0] * len(xy[selected])
    return [[round(float(point[0]), 2), round(float(point[1]), 2), round(float(score), 3)] for point, score in zip(xy[selected], point_conf, strict=True)]


def generate(path: Path, model: YOLO) -> None:
    capture = cv2.VideoCapture(str(path))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    # Thirty samples per second keeps the overlay responsive while keeping the
    # checked-in tracks small enough for a Pages artifact.
    stride = max(1, round(fps / 30.0))
    frames = []
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % stride == 0:
            result = model.predict(frame, verbose=False, device="cpu", conf=0.18, imgsz=640)[0]
            pose = choose_pose(result, width, height)
            if pose is not None:
                visible = [point[2] for point in pose if point[2] >= 0.16]
                frames.append({
                    "frame": frame_index,
                    "keypoints": pose,
                    "confidence": round(sum(visible) / len(visible), 3) if visible else 0.0,
                })
        frame_index += 1
        if frame_index % 120 == 0:
            print(f"{path.name}: {frame_index}/{frame_count}", flush=True)
    capture.release()
    output = OUTPUT / f"{path.name}.json"
    output.write_text(json.dumps({"width": width, "height": height, "fps": fps, "stride": stride, "frames": frames}, separators=(",", ":")) + "\n")
    print(f"wrote {output} ({len(frames)} poses)", flush=True)


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(MODEL_PATH))
    paths = sorted(path for path in EXAMPLES.glob("*.mp4") if path.is_file())
    if not paths:
        print("No example clips found", file=sys.stderr)
        return 1
    for path in paths:
        generate(path, model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
