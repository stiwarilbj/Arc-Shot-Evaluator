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

from backend.analysis.pipeline import analyze_video, probe_video
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

app = FastAPI(title="ARC Local Shot Analysis", version="1.0.0")
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
job_cancel_events: dict[str, threading.Event] = {}
job_futures: dict[str, Future] = {}
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


def run_analysis_job(job_id: str, source: Path, session_dir: Path, display_name: str) -> None:
    cancel_event = job_cancel_events[job_id]
    try:
        if cancel_event.is_set():
            raise AnalysisCancelled
        update_analysis_job(job_id, status="processing", stage="Loading local vision models")

        def progress(stage: str, done: int, total: int) -> None:
            if cancel_event.is_set():
                raise AnalysisCancelled
            update_analysis_job(job_id, stage=stage, frames_done=done, frames_total=total)

        result = analyze_video(source, session_dir, progress, display_name=display_name)
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


class AnalysisCancelled(Exception):
    """Internal signal used to stop a running local analysis cleanly."""


def register_job(job_id: str, value: dict) -> None:
    with jobs_lock:
        jobs[job_id] = value
        job_cancel_events[job_id] = threading.Event()
        if len(jobs) > 100:
            finished = [key for key, item in jobs.items() if item["status"] in {"done", "error", "cancelled"}]
            for old_id in finished[: len(jobs) - 100]:
                jobs.pop(old_id, None)
                job_cancel_events.pop(old_id, None)
                job_futures.pop(old_id, None)


def submit_analysis_job(job_id: str, source: Path, session_dir: Path, display_name: str) -> None:
    job_futures[job_id] = executor.submit(run_analysis_job, job_id, source, session_dir, display_name)


def queue_analysis_job(source: Path, display_name: str) -> str:
    """Create a queued analysis job for an uploaded file or bundled example."""
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
    }
    register_job(job_id, value)
    submit_analysis_job(job_id, source, session_dir, display_name)
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
    return json.loads(files[0].read_text())


@app.get("/api/sessions/{session_id}")
def get_session_by_id(session_id: str):
    if not session_id.replace("-", "").isalnum():
        raise HTTPException(400, "Invalid session id")
    path = ANALYSIS_SESSIONS_DIR / session_id / "analysis.json"
    if not path.is_file():
        raise HTTPException(404, "Session not found")
    return json.loads(path.read_text())


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
async def create_uploaded_video_job(file: UploadFile) -> dict:
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
    }
    register_job(job_id, value)
    submit_analysis_job(job_id, source, session_dir, display_name)
    return {"job_id": job_id}


@app.post("/api/examples/{example_id}/jobs")
def create_example_video_job(example_id: str) -> dict:
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
    return {"job_id": queue_analysis_job(source, filename)}


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
            value.update(status="cancelled", stage="Analysis stopped", error=None, result=None, updated_at=time.time())
        else:
            value.update(stage="Stopping analysis", updated_at=time.time())
        return dict(value)


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
