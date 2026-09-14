from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.analysis.pipeline import analyze_video, probe_video, refresh_saved_analysis
from backend.config import (
    ANALYSIS_SESSIONS_DIR,
    EXAMPLE_VIDEOS_DIR,
    FRONTEND_DIST_DIR,
    MODEL_WEIGHTS_DIR,
)


ALLOWED_SUFFIXES = {
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".flv",
    ".mpeg", ".mpg", ".3gp", ".m2ts", ".mts", ".ts", ".ogv", ".asf",
}

# These are deliberately kept as local project assets so the landing page can
# offer real, repeatable examples without requiring a cloud bucket or a
# second upload step.  The UUID-style names are preserved because they are the
# filenames the user supplied; the UI adds a stable, readable example number.
EXAMPLE_FILES = (
    "9d07df92-9175-9d5f-0b91-5ded80044c3e_1280x720.mp4",
    "70b413a5-8796-119b-f09d-a60370eff456_1280x720.mp4",
    "195d59e5-bee1-0f97-3f5d-25144f1dba0e_1280x720.mp4",
    "500ed956-1d96-21c6-0901-2444bace171d_1280x720.mp4",
    "5927dc9e-af89-0ed3-ab1f-8a0acdfdf7be_1280x720.mp4",
    "6780e35b-0ddf-cba1-a979-1c2634c51eea_1280x720.mp4",
    "a9dbfe7f-11d3-b580-fefc-dc310cdd9e0d_1280x720.mp4",
    "a090504f-62b8-9820-fb69-58fecfd5fe12_1280x720.mp4",
    "aa7dbd16-c28f-b2a5-9a73-264418c65c4b_1280x720.mp4",
    "YTDown.com_Shorts_This-free-throw_Media_Sq5yS3L56Ek_001_1080p.mp4",
    "YTDown.com_YouTube_Kevin-Durant-shooting-free-throws_Media_-qySIh0H1Ug_001_720p.mp4",
    "YTDown.com_YouTube_LeBron-Jokes-After-Steph-Misses-Free-Thr_Media_welHDbZ0KBY_001_720p.mp4",
)

app = FastAPI(title="ARC Local Shot Analysis", version="3.0.0")
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
job_cancel_events: dict[str, threading.Event] = {}
job_futures: dict[str, Future] = {}
job_session_dirs: dict[str, Path] = {}
try:
    ANALYSIS_WORKERS = max(1, min(4, int(os.environ.get("ARC_WORKERS", "2"))))
except ValueError:
    ANALYSIS_WORKERS = 2
executor = ThreadPoolExecutor(max_workers=ANALYSIS_WORKERS, thread_name_prefix="arc-analysis")


def update_analysis_job(job_id: str, **values) -> None:
    with jobs_lock:
        if job_id not in jobs:
            return
        jobs[job_id].update(values, updated_at=time.time())


class AnalysisCancelled(Exception):
    """Internal signal used to stop a running local analysis cleanly."""


def run_analysis_job(
    job_id: str,
    source: Path,
    session_dir: Path,
    display_name: str,
    processing_mode: str = "normal",
    shot_mode: str = "free_throw",
    court_calibration: dict | None = None,
) -> None:
    cancel_event = job_cancel_events[job_id]
    try:
        if cancel_event.is_set():
            raise AnalysisCancelled
        depth_label = "Deep" if processing_mode == "deep" else "Normal"
        update_analysis_job(job_id, status="processing", stage=f"{depth_label} analysis · loading local vision models")

        def progress(stage: str, done: int, total: int) -> None:
            if cancel_event.is_set():
                raise AnalysisCancelled
            update_analysis_job(job_id, stage=stage, frames_done=done, frames_total=total)

        result = analyze_video(
            source,
            session_dir,
            progress,
            display_name=display_name,
            processing_mode=processing_mode,
            shot_mode=shot_mode,
            court_calibration=court_calibration,
        )
        if cancel_event.is_set():
            raise AnalysisCancelled
        update_analysis_job(job_id, status="done", stage="Analysis complete", result=result)
    except AnalysisCancelled:
        # A cancelled run is disposable local working data. Remove the
        # partial session so a stopped video never looks like a completed one.
        shutil.rmtree(session_dir, ignore_errors=True)
        update_analysis_job(job_id, status="cancelled", stage="Analysis stopped", error=None, result=None)
    except Exception as error:  # surfaced to the local UI
        if cancel_event.is_set():
            shutil.rmtree(session_dir, ignore_errors=True)
            update_analysis_job(job_id, status="cancelled", stage="Analysis stopped", error=None, result=None)
        else:
            update_analysis_job(job_id, status="error", stage="Analysis failed", error=str(error))
def register_job(job_id: str, value: dict, session_dir: Path) -> None:
    with jobs_lock:
        jobs[job_id] = value
        job_cancel_events[job_id] = threading.Event()
        job_session_dirs[job_id] = session_dir
        if len(jobs) > 100:
            finished = [key for key, item in jobs.items() if item["status"] in {"done", "error", "cancelled"}]
            for old_id in finished[: len(jobs) - 100]:
                jobs.pop(old_id, None)
                job_cancel_events.pop(old_id, None)
                job_futures.pop(old_id, None)
                job_session_dirs.pop(old_id, None)


def submit_analysis_job(
    job_id: str,
    source: Path,
    session_dir: Path,
    display_name: str,
    processing_mode: str = "normal",
    shot_mode: str = "free_throw",
    court_calibration: dict | None = None,
) -> None:
    job_futures[job_id] = executor.submit(
        run_analysis_job,
        job_id,
        source,
        session_dir,
        display_name,
        processing_mode,
        shot_mode,
        court_calibration,
    )


def queue_analysis_job(
    source: Path,
    display_name: str,
    processing_mode: str = "normal",
    shot_mode: str = "free_throw",
    court_calibration: dict | None = None,
) -> str:
    """Create a queued analysis job for an uploaded file or bundled example."""
    processing_mode = processing_mode if processing_mode in {"normal", "deep"} else "normal"
    shot_mode = shot_mode if shot_mode in {"free_throw", "jump_shot"} else "free_throw"
    job_id = uuid.uuid4().hex[:12]
    session_dir = ANALYSIS_SESSIONS_DIR / job_id
    session_dir.mkdir(parents=True, exist_ok=False)
    value = {
        "id": job_id,
        "filename": display_name,
        "status": "queued",
        "stage": "Queued for local analysis",
        "frames_done": 0,
        "frames_total": 0,
        "updated_at": time.time(),
        "error": None,
        "result": None,
        "processing_mode": processing_mode,
        "shot_mode": shot_mode,
    }
    register_job(job_id, value, session_dir)
    submit_analysis_job(job_id, source, session_dir, display_name, processing_mode, shot_mode, court_calibration)
    return job_id


def find_saved_analysis_files() -> list[Path]:
    if not ANALYSIS_SESSIONS_DIR.exists():
        return []
    return sorted(
        ANALYSIS_SESSIONS_DIR.glob("*/analysis.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


@app.get("/api/health")
def get_health_status() -> dict:
    return {
        "ok": True,
        "local_only": True,
        "models_ready": (MODEL_WEIGHTS_DIR / "ebard-yolov8n.pt").is_file()
        and (MODEL_WEIGHTS_DIR / "yolo11n-pose.pt").is_file(),
    }


@app.get("/api/sessions/latest")
def get_latest_session():
    files = find_saved_analysis_files()
    if not files:
        return JSONResponse(status_code=404, content={"detail": "No analysis sessions yet"})
    return refresh_saved_analysis(json.loads(files[0].read_text()))


@app.get("/api/sessions/{session_id}")
def get_session_by_id(session_id: str):
    if not session_id.replace("-", "").isalnum():
        raise HTTPException(400, "Invalid session id")
    path = ANALYSIS_SESSIONS_DIR / session_id / "analysis.json"
    if not path.is_file():
        raise HTTPException(404, "Session not found")
    return refresh_saved_analysis(json.loads(path.read_text()))


def build_example_video_metadata(example_id: str, filename: str, path: Path) -> dict:
    meta = probe_video(path)
    return {
        "id": example_id,
        "label": f"Example {int(example_id.rsplit('-', 1)[-1]):02d}",
        "filename": filename,
        "url": f"/examples/{filename}",
        "duration": round(meta.duration, 3),
        "width": meta.width,
        "height": meta.height,
        "fps": meta.fps,
        # Examples are intentionally analyzable in either mode. The selected
        # mode is captured when queued; the result still marks unsupported or
        # unresolved shot types for review instead of guessing from filename.
        "supported_modes": ["free_throw", "jump_shot"],
    }


@app.get("/api/examples")
def list_example_videos() -> list[dict]:
    result: list[dict] = []
    for index, filename in enumerate(EXAMPLE_FILES, start=1):
        path = EXAMPLE_VIDEOS_DIR / filename
        if not path.is_file():
            continue
        result.append(build_example_video_metadata(f"example-{index}", filename, path))
    return result


@app.post("/api/jobs")
async def create_uploaded_video_job(
    file: UploadFile,
    mode: str = "normal",
    shot_mode: str = "free_throw",
) -> dict:
    if mode not in {"normal", "deep"}:
        raise HTTPException(400, "Analysis mode must be normal or deep")
    if shot_mode not in {"free_throw", "jump_shot"}:
        raise HTTPException(400, "Shot mode must be free_throw or jump_shot")
    display_name = Path(file.filename or "clip.mp4").name
    suffix = Path(display_name).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(400, "Use a common video file such as MP4, MOV, M4V, AVI, MKV, WebM, or MPEG")
    job_id = uuid.uuid4().hex[:12]
    session_dir = ANALYSIS_SESSIONS_DIR / job_id
    session_dir.mkdir(parents=True, exist_ok=False)
    source = session_dir / f"upload{suffix}"
    total_bytes = 0
    try:
        with source.open("wb") as stream:
            while chunk := await file.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > 3 * 1024**3:
                    raise HTTPException(413, "Video is larger than the 3 GB local limit")
                stream.write(chunk)
    except Exception:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
    value = {
        "id": job_id,
        "filename": display_name,
        "status": "queued",
        "stage": "Queued for local analysis",
        "frames_done": 0,
        "frames_total": 0,
        "updated_at": time.time(),
        "error": None,
        "result": None,
        "processing_mode": mode,
        "shot_mode": shot_mode,
    }
    register_job(job_id, value, session_dir)
    submit_analysis_job(job_id, source, session_dir, display_name, mode, shot_mode)
    return {"job_id": job_id}


@app.post("/api/examples/{example_id}/jobs")
def create_example_video_job(
    example_id: str,
    mode: str = "normal",
    shot_mode: str = "free_throw",
) -> dict:
    if mode not in {"normal", "deep"}:
        raise HTTPException(400, "Analysis mode must be normal or deep")
    if shot_mode not in {"free_throw", "jump_shot"}:
        raise HTTPException(400, "Shot mode must be free_throw or jump_shot")
    if not example_id.startswith("example-"):
        raise HTTPException(400, "Invalid example id")
    try:
        index = int(example_id.rsplit("-", 1)[-1])
    except ValueError as error:
        raise HTTPException(400, "Invalid example id") from error
    if not 1 <= index <= len(EXAMPLE_FILES):
        raise HTTPException(404, "Example not found")
    filename = EXAMPLE_FILES[index - 1]
    source = EXAMPLE_VIDEOS_DIR / filename
    if not source.is_file():
        raise HTTPException(404, "Example media is not installed")
    return {"job_id": queue_analysis_job(source, filename, mode, shot_mode)}


@app.get("/api/jobs/{job_id}")
def get_analysis_job(job_id: str) -> dict:
    with jobs_lock:
        value = jobs.get(job_id)
        if value is None:
            raise HTTPException(404, "Job not found")
        return dict(value)


@app.delete("/api/jobs/{job_id}")
def cancel_analysis_job(job_id: str) -> dict:
    """Request a cooperative stop for a queued or running local analysis."""
    with jobs_lock:
        value = jobs.get(job_id)
        if value is None:
            raise HTTPException(404, "Job not found")
        if value["status"] in {"done", "error", "cancelled"}:
            return dict(value)
        event = job_cancel_events.get(job_id)
        if event:
            event.set()
        future = job_futures.get(job_id)
        if future and future.cancel():
            shutil.rmtree(job_session_dirs.get(job_id), ignore_errors=True)
            value.update(status="cancelled", stage="Analysis stopped", error=None, result=None, updated_at=time.time())
        else:
            value.update(stage="Stopping analysis", updated_at=time.time())
        return dict(value)


@app.patch("/api/sessions/{session_id}/shots/{shot_id}")
def correct_saved_shot(session_id: str, shot_id: int, correction: dict) -> dict:
    """Persist a user correction without overwriting model evidence."""
    if not session_id.replace("-", "").isalnum() or shot_id < 1:
        raise HTTPException(400, "Invalid session or shot id")
    analysis_path = ANALYSIS_SESSIONS_DIR / session_id / "analysis.json"
    if not analysis_path.is_file():
        raise HTTPException(404, "Session not found")
    allowed = {
        "outcome", "release_frame", "shooter_id", "shooting_hand", "shot_type",
        "takeoff_frame", "defender_ids", "team_assignments", "player_height_m", "comment",
    }
    unknown = set(correction) - allowed
    if unknown:
        raise HTTPException(400, f"Unsupported correction fields: {sorted(unknown)}")
    if "outcome" in correction and correction["outcome"] not in {"make", "miss", "review"}:
        raise HTTPException(400, "Outcome must be make, miss, or review")
    if "release_frame" in correction and (
        not isinstance(correction["release_frame"], int) or correction["release_frame"] < 0
    ):
        raise HTTPException(400, "Release frame must be a non-negative integer")
    if "takeoff_frame" in correction and (
        not isinstance(correction["takeoff_frame"], int) or correction["takeoff_frame"] < 0
    ):
        raise HTTPException(400, "Takeoff frame must be a non-negative integer")
    if "shooting_hand" in correction and correction["shooting_hand"] not in {"left", "right", "unknown"}:
        raise HTTPException(400, "Shooting hand must be left, right, or unknown")
    if "shot_type" in correction and correction["shot_type"] not in {
        "three_pointer", "mid_range", "near_three_point_line_review", "layup", "dunk", "pass", "pump_fake", "unknown",
    }:
        raise HTTPException(400, "Unsupported shot type")
    if "defender_ids" in correction and (
        not isinstance(correction["defender_ids"], list) or any(not isinstance(item, str) for item in correction["defender_ids"])
    ):
        raise HTTPException(400, "defender_ids must be a list of text labels")
    if "team_assignments" in correction and (
        not isinstance(correction["team_assignments"], dict)
        or any(
            not isinstance(track_id, str)
            or role not in {"shooter", "teammate", "opponent", "official", "unknown"}
            for track_id, role in correction["team_assignments"].items()
        )
    ):
        raise HTTPException(400, "team_assignments must map track labels to shooter, teammate, opponent, official, or unknown")
    if "player_height_m" in correction and (
        not isinstance(correction["player_height_m"], (int, float)) or not 0.5 <= float(correction["player_height_m"]) <= 2.8
    ):
        raise HTTPException(400, "player_height_m must be between 0.5 and 2.8")
    for field in ("shooter_id", "shooting_hand", "shot_type", "comment"):
        if field in correction and correction[field] is not None and not isinstance(correction[field], str):
            raise HTTPException(400, f"{field} must be text")
    payload = json.loads(analysis_path.read_text())
    correction_path = ANALYSIS_SESSIONS_DIR / session_id / "corrections.json"
    stored: dict = {"version": 1, "shots": {}}
    if correction_path.is_file():
        try:
            loaded = json.loads(correction_path.read_text())
            if isinstance(loaded, dict):
                stored.update(loaded)
        except (OSError, ValueError, TypeError):
            pass
    original_ids = {int(shot.get("id", -1)) for shot in payload.get("shots", [])}
    raw_manual = stored.get("manual_shots", [])
    manual_ids = {
        int(shot.get("id", -1))
        for shot in (raw_manual if isinstance(raw_manual, list) else [])
        if isinstance(shot, dict)
    }
    if shot_id not in original_ids and shot_id not in manual_ids:
        raise HTTPException(404, "Shot not found")
    shots = stored.setdefault("shots", {})
    if not isinstance(shots, dict):
        shots = {}
        stored["shots"] = shots
    existing = shots.get(str(shot_id), {})
    if not isinstance(existing, dict):
        existing = {}
    existing.update(correction)
    existing["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    shots[str(shot_id)] = existing
    correction_path.write_text(json.dumps(stored, indent=2))
    return refresh_saved_analysis(payload)


@app.post("/api/sessions/{session_id}/shots")
def add_manual_shot(session_id: str, attempt: dict) -> dict:
    """Add an attempt the detector missed, retaining it as user evidence."""
    if not session_id.replace("-", "").isalnum():
        raise HTTPException(400, "Invalid session id")
    analysis_path = ANALYSIS_SESSIONS_DIR / session_id / "analysis.json"
    if not analysis_path.is_file():
        raise HTTPException(404, "Session not found")
    outcome = attempt.get("outcome", "review")
    release_frame = attempt.get("release_frame")
    if outcome not in {"make", "miss", "review"}:
        raise HTTPException(400, "Outcome must be make, miss, or review")
    if not isinstance(release_frame, int) or release_frame < 0:
        raise HTTPException(400, "Release frame must be a non-negative integer")
    allowed = {"outcome", "release_frame", "shooter_id", "comment"}
    unknown = set(attempt) - allowed
    if unknown:
        raise HTTPException(400, f"Unsupported attempt fields: {sorted(unknown)}")
    for field in ("shooter_id", "comment"):
        if field in attempt and attempt[field] is not None and not isinstance(attempt[field], str):
            raise HTTPException(400, f"{field} must be text")
    payload = json.loads(analysis_path.read_text())
    existing_ids = [int(shot.get("id", 0)) for shot in payload.get("shots", [])]
    correction_path = ANALYSIS_SESSIONS_DIR / session_id / "corrections.json"
    stored: dict = {"version": 1, "shots": {}, "manual_shots": []}
    if correction_path.is_file():
        try:
            loaded = json.loads(correction_path.read_text())
            if isinstance(loaded, dict):
                stored.update(loaded)
        except (OSError, ValueError, TypeError):
            pass
    manual_shots = stored.setdefault("manual_shots", [])
    if not isinstance(manual_shots, list):
        manual_shots = []
        stored["manual_shots"] = manual_shots
    for manual in manual_shots:
        if isinstance(manual, dict):
            existing_ids.append(int(manual.get("id", 0)))
    shot_id = max(existing_ids, default=0) + 1
    fps = float(payload.get("session", {}).get("fps") or 0.0)
    manual_shots.append({
        "id": shot_id,
        "outcome": outcome,
        "confidence": 1.0,
        "observation_confidence": 1.0,
        "release_frame": release_frame,
        "release_time": round(release_frame / fps, 3) if fps > 0 else 0.0,
        "end_frame": release_frame,
        "release_speed_ms": None,
        "release_height_m": None,
        "entry_angle_deg": None,
        "arc_peak_m": None,
        "form": {"elbow": None, "knee": None, "shoulder": None, "hip": None},
        "flags": ["manually added attempt; no model trace is available"],
        "evidence": {
            "manual": True,
            "outcome_basis": "user-added attempt",
            **({"shooter_id": attempt["shooter_id"]} if attempt.get("shooter_id") else {}),
            "prediction_status": "unavailable_unvalidated",
            "metric_availability": {},
            "metric_uncertainty": {},
        },
        "correction": {
            "source": "local_user",
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "fields": ["manual_attempt"],
            **({"comment": attempt["comment"]} if attempt.get("comment") else {}),
        },
        "shot_mode": payload.get("shot_mode", "free_throw"),
    })
    correction_path.write_text(json.dumps(stored, indent=2))
    return refresh_saved_analysis(payload)


@app.patch("/api/sessions/{session_id}/context")
def update_session_context(session_id: str, context: dict) -> dict:
    """Persist court/player context separately from detector evidence."""
    if not session_id.replace("-", "").isalnum():
        raise HTTPException(400, "Invalid session id")
    analysis_path = ANALYSIS_SESSIONS_DIR / session_id / "analysis.json"
    if not analysis_path.is_file():
        raise HTTPException(404, "Session not found")
    allowed = {"court_calibration", "player_heights", "shot_mode"}
    unknown = set(context) - allowed
    if unknown:
        raise HTTPException(400, f"Unsupported context fields: {sorted(unknown)}")
    if "shot_mode" in context and context["shot_mode"] not in {"free_throw", "jump_shot"}:
        raise HTTPException(400, "Shot mode must be free_throw or jump_shot")
    calibration = context.get("court_calibration")
    if calibration is not None:
        if not isinstance(calibration, dict):
            raise HTTPException(400, "court_calibration must be an object")
        preset = calibration.get("preset", "custom")
        if preset not in {"nba", "wnba", "ncaa", "fiba", "high_school", "custom", "unknown"}:
            raise HTTPException(400, "Unknown court calibration preset")
        image_points = calibration.get("image_points")
        world_points = calibration.get("world_points")
        if not isinstance(image_points, list) or not isinstance(world_points, list) or len(image_points) != 4 or len(world_points) != 4:
            raise HTTPException(400, "Court calibration requires four image points and four court points")
        if any(
            not isinstance(point, list)
            or len(point) != 2
            or any(not isinstance(value, (int, float)) for value in point)
            for point in image_points + world_points
        ):
            raise HTTPException(400, "Court calibration points must be [x, y] pairs")
        basket_ground = calibration.get("basket_ground_image")
        if basket_ground is not None and (
            not isinstance(basket_ground, list)
            or len(basket_ground) != 2
            or any(not isinstance(value, (int, float)) for value in basket_ground)
        ):
            raise HTTPException(400, "basket_ground_image must be a [x, y] pair")
    heights = context.get("player_heights")
    if heights is not None and not isinstance(heights, dict):
        raise HTTPException(400, "player_heights must be an object")
    if isinstance(heights, dict) and any(
        not isinstance(key, str)
        or not isinstance(value, (int, float))
        or not 0.5 <= float(value) <= 2.8
        for key, value in heights.items()
    ):
        raise HTTPException(400, "player_heights values must be between 0.5 and 2.8 metres")
    correction_path = ANALYSIS_SESSIONS_DIR / session_id / "corrections.json"
    stored: dict = {"version": 2, "shots": {}, "manual_shots": [], "session_context": {}}
    if correction_path.is_file():
        try:
            loaded = json.loads(correction_path.read_text())
            if isinstance(loaded, dict):
                stored.update(loaded)
        except (OSError, ValueError, TypeError):
            pass
    session_context = stored.setdefault("session_context", {})
    if not isinstance(session_context, dict):
        session_context = {}
        stored["session_context"] = session_context
    for field in allowed:
        if field in context:
            session_context[field] = context[field]
    session_context["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    correction_path.write_text(json.dumps(stored, indent=2))
    return refresh_saved_analysis(json.loads(analysis_path.read_text()))


@app.post("/api/sessions/{session_id}/reanalysis")
def reanalyze_saved_session(session_id: str, mode: str = "normal", shot_mode: str | None = None) -> dict:
    """Queue a fresh analysis after a reviewed context correction."""
    if not session_id.replace("-", "").isalnum():
        raise HTTPException(400, "Invalid session id")
    if mode not in {"normal", "deep"}:
        raise HTTPException(400, "Analysis mode must be normal or deep")
    session_dir = ANALYSIS_SESSIONS_DIR / session_id
    analysis_path = session_dir / "analysis.json"
    if not analysis_path.is_file():
        raise HTTPException(404, "Session not found")
    payload = json.loads(analysis_path.read_text())
    selected_shot_mode = shot_mode or payload.get("shot_mode", "free_throw")
    if selected_shot_mode not in {"free_throw", "jump_shot"}:
        raise HTTPException(400, "Shot mode must be free_throw or jump_shot")
    sources = sorted(path for path in session_dir.glob("upload.*") if path.is_file())
    if not sources:
        raise HTTPException(409, "Original upload is unavailable for reanalysis")
    court_calibration = None
    correction_path = session_dir / "corrections.json"
    if correction_path.is_file():
        try:
            stored = json.loads(correction_path.read_text())
            if isinstance(stored, dict) and isinstance(stored.get("session_context"), dict):
                candidate = stored["session_context"].get("court_calibration")
                if isinstance(candidate, dict):
                    court_calibration = candidate
        except (OSError, ValueError, TypeError):
            court_calibration = None
    return {"job_id": queue_analysis_job(sources[0], str(payload.get("session", {}).get("filename", sources[0].name)), mode, selected_shot_mode, court_calibration)}


@app.get("/media/{session_id}/{filename}")
def serve_session_artifact(session_id: str, filename: str) -> FileResponse:
    if not session_id.replace("-", "").isalnum() or Path(filename).name != filename:
        raise HTTPException(400, "Invalid media path")
    path = ANALYSIS_SESSIONS_DIR / session_id / filename
    if not path.is_file():
        raise HTTPException(404, "Media not found")
    suffix = path.suffix.lower()
    media_type = (
        "video/mp4"
        if suffix in {".mp4", ".mov", ".m4v"}
        else "video/x-msvideo"
        if suffix == ".avi"
        else "video/x-matroska"
        if suffix == ".mkv"
        else "image/jpeg"
        if suffix in {".jpg", ".jpeg"}
        else "application/jsonl"
        if suffix == ".jsonl"
        else "application/json"
    )
    return FileResponse(path, media_type=media_type, filename=None)


frontend_assets_dir = FRONTEND_DIST_DIR / "assets"
if frontend_assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=frontend_assets_dir), name="assets")

if EXAMPLE_VIDEOS_DIR.is_dir():
    app.mount("/examples", StaticFiles(directory=EXAMPLE_VIDEOS_DIR), name="examples")


@app.get("/{path:path}")
def serve_frontend_app(path: str):
    index = FRONTEND_DIST_DIR / "index.html"
    if not index.is_file():
        return JSONResponse(
            status_code=503,
            content={"detail": "Frontend is not built. Run pnpm --dir frontend build."},
        )
    return FileResponse(index)


def run_local_server() -> None:
    """Run ARC on the local-only development port."""
    import uvicorn

    port = int(os.environ.get("ARC_PORT", "7888"))
    uvicorn.run("backend.api.app:app", host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    run_local_server()
