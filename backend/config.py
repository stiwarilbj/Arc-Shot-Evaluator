"""Shared filesystem locations for the local ARCade Hoops application."""

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST_DIR = PROJECT_ROOT / "frontend" / "dist"
EXAMPLE_VIDEOS_DIR = PROJECT_ROOT / "examples"
MODEL_WEIGHTS_DIR = PROJECT_ROOT / "models"
VISION_MODEL_CHECKPOINTS = {
    "ball_rim_detector": MODEL_WEIGHTS_DIR / "ebard-yolov8n.pt",
    "pose": MODEL_WEIGHTS_DIR / "yolo11n-pose.pt",
}
ANALYSIS_SESSIONS_DIR = PROJECT_ROOT / "sessions"
PLAYBOOKS_DIR = PROJECT_ROOT / "playbooks"
POCKET_ACTIONS_DIR = PROJECT_ROOT / "pocket-actions"
