"""Shared filesystem locations for the local ARC application."""

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST_DIR = PROJECT_ROOT / "frontend" / "dist"
EXAMPLE_VIDEOS_DIR = PROJECT_ROOT / "examples"
MODEL_WEIGHTS_DIR = PROJECT_ROOT / "models"
ANALYSIS_SESSIONS_DIR = PROJECT_ROOT / "sessions"
