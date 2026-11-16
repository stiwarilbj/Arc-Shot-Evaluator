from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

# Import before FastAPI, NumPy, OpenCV, or PyTorch so native libraries inherit
# the same process-wide worker and thread budget.
from backend.runtime import ANALYSIS_WORKERS

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.analysis.diagnostics import AnalysisTimingTrace
from backend.analysis.pipeline import analyze_video, probe_video, refresh_saved_analysis
from backend.api.playbooks import router as playbooks_router
from backend.api.pocket_actions import router as pocket_actions_router
from backend.api import jumper as jumper_api
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

app = FastAPI(title="ARCade Hoops Local Shot Analysis", version="3.1.0")
app.include_router(playbooks_router)
app.include_router(pocket_actions_router)
app.include_router(jumper_api.router)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
review_write_lock = threading.Lock()
job_cancel_events: dict[str, threading.Event] = {}
job_futures: dict[str, Future] = {}
job_session_dirs: dict[str, Path] = {}
executor = ThreadPoolExecutor(max_workers=ANALYSIS_WORKERS, thread_name_prefix="arc-analysis")
jumper_api.configure(executor)
logger = logging.getLogger(__name__)


def _job_state_path(session_dir: Path) -> Path:
    return session_dir / "job.json"


def _persist_job_locked(value: dict, session_dir: Path) -> None:
    """Write a small atomic status record so a browser can reconnect safely."""
    session_dir.mkdir(parents=True, exist_ok=True)
    target = _job_state_path(session_dir)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, indent=2))
    os.replace(temporary, target)


def update_analysis_job(job_id: str, **values) -> None:
    with jobs_lock:
        if job_id not in jobs:
            return
        jobs[job_id].update(values, updated_at=time.time())
        session_dir = job_session_dirs.get(job_id)
        if session_dir is not None:
            _persist_job_locked(jobs[job_id], session_dir)


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
    timing_trace = AnalysisTimingTrace()

    def persist_timing_trace() -> None:
        try:
            timing_trace.write(session_dir, job_id)
        except Exception:
            # Diagnostics must never turn a completed analysis into a failed
            # one, or hide the original analysis error.
            logger.exception("Could not persist private analysis timing trace")

    try:
        if cancel_event.is_set():
            raise AnalysisCancelled
        depth_label = "Fast" if processing_mode == "fast" else "Deep" if processing_mode == "deep" else "Normal"
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
            timing_trace=timing_trace,
        )
        if cancel_event.is_set():
            raise AnalysisCancelled
        timing_trace.finish("completed")
        persist_timing_trace()
        update_analysis_job(job_id, status="done", stage="Analysis complete", result=result)
    except AnalysisCancelled:
        # A cancelled run is disposable local working data. Remove the
        # partial session so a stopped video never looks like a completed one.
        shutil.rmtree(session_dir, ignore_errors=True)
        timing_trace.finish("cancelled")
        persist_timing_trace()
        update_analysis_job(job_id, status="cancelled", stage="Analysis stopped", error=None, result=None)
    except Exception as error:  # surfaced to the local UI
        if cancel_event.is_set():
            shutil.rmtree(session_dir, ignore_errors=True)
            timing_trace.finish("cancelled")
            persist_timing_trace()
            update_analysis_job(job_id, status="cancelled", stage="Analysis stopped", error=None, result=None)
        else:
            timing_trace.finish("failed", error)
            persist_timing_trace()
            update_analysis_job(job_id, status="error", stage="Analysis failed", error=str(error))
def register_job(job_id: str, value: dict, session_dir: Path) -> None:
    with jobs_lock:
        jobs[job_id] = value
        job_cancel_events[job_id] = threading.Event()
        job_session_dirs[job_id] = session_dir
        _persist_job_locked(value, session_dir)
        if len(jobs) > 100:
            finished = [key for key, item in jobs.items() if item["status"] in {"done", "error", "cancelled"}]
            for old_id in finished[: len(jobs) - 100]:
                jobs.pop(old_id, None)
                job_cancel_events.pop(old_id, None)
                job_futures.pop(old_id, None)
                job_session_dirs.pop(old_id, None)


def restore_persisted_jobs() -> None:
    """Restore completed jobs and surface interrupted jobs after a restart."""
    if not ANALYSIS_SESSIONS_DIR.exists():
        return
    for status_path in ANALYSIS_SESSIONS_DIR.glob("*/job.json"):
        try:
            value = json.loads(status_path.read_text())
            if not isinstance(value, dict) or not isinstance(value.get("id"), str):
                continue
            session_dir = status_path.parent
            analysis_path = session_dir / "analysis.json"
            if value.get("status") in {"queued", "processing"}:
                value.update(
                    status="error",
                    stage="Analysis interrupted before completion; retry this clip",
                    error="The local worker was restarted before this analysis finished",
                    result=None,
                    updated_at=time.time(),
                )
            elif value.get("status") == "done" and value.get("result") is None and analysis_path.is_file():
                value["result"] = refresh_saved_analysis(json.loads(analysis_path.read_text()))
            register_job(value["id"], value, session_dir)
        except (OSError, ValueError, TypeError, KeyError):
            # Never overwrite an unreadable session; it can still be opened
            # through the explicit session endpoint for manual recovery.
            continue


restore_persisted_jobs()


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
    processing_mode = processing_mode if processing_mode in {"fast", "normal", "deep"} else "normal"
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
    if mode not in {"fast", "normal", "deep"}:
        raise HTTPException(400, "Analysis mode must be fast, normal, or deep")
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
    if mode not in {"fast", "normal", "deep"}:
        raise HTTPException(400, "Analysis mode must be fast, normal, or deep")
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
    if not job_id.replace("-", "").isalnum():
        raise HTTPException(400, "Invalid job id")
    with jobs_lock:
        saved_job = jobs.get(job_id)
        value = dict(saved_job) if saved_job is not None else None
    session_dir = ANALYSIS_SESSIONS_DIR / job_id
    if value is None:
        status_path = session_dir / "job.json"
        if not status_path.is_file():
            raise HTTPException(404, "Job not found")
        try:
            value = json.loads(status_path.read_text())
        except (OSError, ValueError, TypeError) as error:
            raise HTTPException(500, "Saved job status is unreadable; the session was left untouched") from error
        if not isinstance(value, dict) or value.get("id") != job_id:
            raise HTTPException(500, "Saved job status is invalid; the session was left untouched")
    if value.get("status") == "done" and (session_dir / "corrections.json").is_file():
        # Job results are snapshots from analysis completion. Reopen the
        # original evidence and layer the current corrections over it.
        value["result"] = get_session_by_id(job_id)
    return value


@app.get("/api/jobs")
def list_analysis_jobs() -> list[dict]:
    """List recent local jobs so the UI can reconnect after navigation."""
    with jobs_lock:
        values = [dict(item) for item in jobs.values()]
    values.sort(key=lambda item: float(item.get("updated_at") or 0), reverse=True)
    return values[:100]


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
            session_dir = job_session_dirs.get(job_id)
            if session_dir is not None:
                _persist_job_locked(value, session_dir)
        else:
            value.update(stage="Stopping analysis", updated_at=time.time())
        return dict(value)


def _validate_release_frame(frame: object, payload: dict) -> None:
    if type(frame) is not int or frame < 0:
        raise HTTPException(400, "Release frame must be a non-negative integer")
    frame_count = payload.get("session", {}).get("frame_count")
    if type(frame_count) is int and frame >= frame_count:
        raise HTTPException(400, f"Enter a whole release frame from 0 to {frame_count - 1}")


@contextmanager
def _edit_saved_review(session_id: str, *, version: int = 1) -> Iterator[dict]:
    path = ANALYSIS_SESSIONS_DIR / session_id / "corrections.json"
    with review_write_lock:
        try:
            stored = json.loads(path.read_text())
        except FileNotFoundError:
            stored = {"version": version, "shots": {}}
        except ValueError as error:
            raise HTTPException(409, "Saved corrections are unreadable · The existing file was preserved") from error
        except OSError as error:
            raise HTTPException(503, "Saved corrections could not be read · Try again") from error
        if (
            not isinstance(stored, dict)
            or not isinstance(stored.get("shots", {}), dict)
            or not isinstance(stored.get("manual_shots", []), list)
            or not isinstance(stored.get("session_context", {}), dict)
        ):
            raise HTTPException(409, "Saved corrections are invalid · The existing file was preserved")
        yield stored
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(stored, indent=2))
            os.replace(temporary, path)
        except OSError as error:
            raise HTTPException(503, "Could not save the review · Try again") from error
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not clean up a temporary review file", exc_info=True)


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
    takeoff = correction.get("takeoff_frame")
    if takeoff is not None and (type(takeoff) is not int or takeoff < 0):
        raise HTTPException(400, "Takeoff frame must be a non-negative integer or null")
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
    if "release_frame" in correction:
        _validate_release_frame(correction["release_frame"], payload)
    with _edit_saved_review(session_id) as stored:
        source = next(
            (
                shot
                for collection in (payload.get("shots", []), stored.get("manual_shots", []))
                for shot in collection
                if isinstance(shot, dict) and int(shot.get("id", -1)) == shot_id
            ),
            None,
        )
        if source is None:
            raise HTTPException(404, "Shot not found")
        shots = stored.setdefault("shots", {})
        existing = shots.get(str(shot_id), {})
        if not isinstance(existing, dict):
            raise HTTPException(409, "Saved shot correction is invalid · The existing file was preserved")
        if takeoff is not None:
            release = correction.get("release_frame", existing.get("release_frame", source.get("release_frame", 0)))
            frame_count = payload.get("session", {}).get("frame_count")
            if type(release) is not int:
                raise HTTPException(409, "Saved release frame is invalid · Correct it before saving takeoff")
            if takeoff > release or (type(frame_count) is int and takeoff >= frame_count):
                raise HTTPException(400, "Takeoff must be an in-clip frame at or before release")
        existing.update(correction)
        existing["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        shots[str(shot_id)] = existing
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
    allowed = {"outcome", "release_frame", "shooter_id", "comment"}
    unknown = set(attempt) - allowed
    if unknown:
        raise HTTPException(400, f"Unsupported attempt fields: {sorted(unknown)}")
    for field in ("shooter_id", "comment"):
        if field in attempt and attempt[field] is not None and not isinstance(attempt[field], str):
            raise HTTPException(400, f"{field} must be text")
    payload = json.loads(analysis_path.read_text())
    _validate_release_frame(release_frame, payload)
    existing_ids = [int(shot.get("id", 0)) for shot in payload.get("shots", [])]
    with _edit_saved_review(session_id) as stored:
        manual_shots = stored.setdefault("manual_shots", [])
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
    with _edit_saved_review(session_id, version=2) as stored:
        session_context = stored.setdefault("session_context", {})
        for field in allowed:
            if field in context:
                session_context[field] = context[field]
        session_context["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return refresh_saved_analysis(json.loads(analysis_path.read_text()))


@app.post("/api/sessions/{session_id}/reanalysis")
def reanalyze_saved_session(session_id: str, mode: str = "normal", shot_mode: str | None = None) -> dict:
    """Queue a fresh analysis after a reviewed context correction."""
    if not session_id.replace("-", "").isalnum():
        raise HTTPException(400, "Invalid session id")
    if mode not in {"fast", "normal", "deep"}:
        raise HTTPException(400, "Analysis mode must be fast, normal, or deep")
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
def serve_session_artifact(session_id: str, filename: str) -> Response:
    if not session_id.replace("-", "").isalnum() or Path(filename).name != filename:
        raise HTTPException(400, "Invalid media path")
    path = ANALYSIS_SESSIONS_DIR / session_id / filename
    if not path.is_file():
        raise HTTPException(404, "Media not found")
    headers = None
    if filename == "shots.jsonl":
        headers = {"Cache-Control": "no-store"}
        if path.with_name("corrections.json").is_file():
            shots = get_session_by_id(session_id)["shots"]
            return Response(
                "".join(json.dumps(shot) + "\n" for shot in shots),
                media_type="application/jsonl",
                headers=headers,
            )
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
    return FileResponse(path, media_type=media_type, filename=None, headers=headers)


frontend_assets_dir = FRONTEND_DIST_DIR / "assets"
if frontend_assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=frontend_assets_dir), name="assets")

freeze_floor_assets_dir = FRONTEND_DIST_DIR / "freeze-floor"
if freeze_floor_assets_dir.is_dir():
    app.mount("/freeze-floor", StaticFiles(directory=freeze_floor_assets_dir), name="freeze-floor")

if EXAMPLE_VIDEOS_DIR.is_dir():
    app.mount("/examples", StaticFiles(directory=EXAMPLE_VIDEOS_DIR), name="examples")


@app.get("/{path:path}")
def serve_frontend_app(path: str):
    index = FRONTEND_DIST_DIR / "index.html"
    if not index.is_file():
        return JSONResponse(
            status_code=503,
            content={"detail": "Frontend is not built · Run pnpm --dir frontend build"},
        )
    return FileResponse(index)


def run_local_server() -> None:
    """Run ARCade Hoops on the local-only development port."""
    import uvicorn

    port = int(os.environ.get("ARC_PORT", "7888"))
    uvicorn.run("backend.api.app:app", host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    run_local_server()
