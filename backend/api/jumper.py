"""Private local Jumper jobs and media; never used by GitHub Pages."""

from __future__ import annotations
from datetime import datetime
from contextlib import asynccontextmanager
import importlib.util
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from backend.config import PROJECT_ROOT, MODEL_WEIGHTS_DIR
from backend.jumper.pipeline import validate_job, run_ffmpeg, propose_people


@asynccontextmanager
async def lifespan(app):
    stopped = threading.Event()

    def sweep():
        while not stopped.wait(30):
            now = time.monotonic()
            with LOCK:
                expired = [
                    identity
                    for identity, job in JOBS.items()
                    if now - job.get("last_seen", now) > 180
                ]
            for identity in expired:
                try:
                    release(identity)
                except HTTPException:
                    pass

    thread = threading.Thread(target=sweep, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        with LOCK:
            for job in JOBS.values():
                job["cancel"].set()


router = APIRouter(prefix="/api/jumper-lab", tags=["jumper-lab"], lifespan=lifespan)
ROOT = PROJECT_ROOT / "jumper-media"
LOCK = threading.RLock()
PROCESS_LOCK = threading.Lock()
JOBS: dict[str, dict] = {}
EXECUTOR = None
MAX_BYTES = 100 * 1024 * 1024


def configure(executor):
    global EXECUTOR
    EXECUTOR = executor


def identifier(value: str) -> str:
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
    except ValueError:
        raise HTTPException(400, "Invalid identity")
    return value


def job_for(identity):
    identifier(identity)
    with LOCK:
        if identity not in JOBS:
            raise HTTPException(404, "Job expired; upload again")
        JOBS[identity]["last_seen"] = time.monotonic()
        return JOBS[identity]


def atomic(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, allow_nan=False))
    tmp.replace(path)


@router.get("/capabilities")
def capabilities():
    return {
        "native": importlib.util.find_spec("sam2") is not None,
        "max_bytes": MAX_BYTES,
        "max_seconds": 15,
    }


@router.post("/jobs")
async def upload(file: UploadFile):
    identity = str(uuid.uuid4())
    directory = ROOT / "jobs" / identity
    directory.mkdir(parents=True)
    try:
        size = 0
        with (directory / "source").open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413, "Files must be at most 100 MB")
                out.write(chunk)
        if not size:
            raise HTTPException(400, "Empty video")
        with LOCK:
            JOBS[identity] = {
                "id": identity,
                "status": "uploaded",
                "directory": directory,
                "generation": 0,
                "cancel": threading.Event(),
                "created": time.time(),
                "last_seen": time.monotonic(),
            }
        return {"id": identity}
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    finally:
        await file.close()


@router.get("/jobs/{identity}/frame")
def frame(identity: str, time: float = 0):
    job = job_for(identity)
    if not math.isfinite(time) or time < 0:
        raise HTTPException(400, "Invalid preview timestamp")
    destination = job["directory"] / f"preview-{time:.3f}.jpg"
    try:
        if not destination.exists():
            run_ffmpeg(
                [
                    "-ss",
                    str(time),
                    "-i",
                    str(job["directory"] / "source"),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
                    str(destination),
                ]
            )
        if not destination.is_file():
            raise ValueError("No frame at this timestamp")
        return FileResponse(destination, media_type="image/jpeg")
    except Exception as error:
        raise HTTPException(400, str(error))


@router.get("/jobs/{identity}/people")
def people(identity: str, time: float = 0):
    job = job_for(identity)
    frame(identity, time)
    return {
        "boxes": propose_people(
            job["directory"] / f"preview-{time:.3f}.jpg",
            MODEL_WEIGHTS_DIR / "yolo11n-pose.pt",
        )
    }


def execute(identity, generation):
    with LOCK:
        job = JOBS.get(identity)
        if job is None:
            return
        if job["generation"] != generation or job["cancel"].is_set():
            return
        job["status"] = "processing"
    directory = job["directory"]
    while not PROCESS_LOCK.acquire(timeout=0.1):
        if job["cancel"].is_set():
            return
    try:
        with LOCK:
            if job["cancel"].is_set():
                return
            process = subprocess.Popen(
                [sys.executable, "-m", "backend.jumper.runner", str(directory)],
                cwd=PROJECT_ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            job["process"] = process
        while process.poll() is None:
            if job["cancel"].wait(0.1):
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                break
        with LOCK:
            if job["cancel"].is_set():
                job["status"] = "cancelled"
            elif process.returncode != 0:
                job["status"] = "error"
                path = directory / "error.json"
                job["error"] = (
                    json.loads(path.read_text())["error"]
                    if path.exists()
                    else f"Local masking process stopped (exit {process.returncode}). Retry a shorter clip or restart the downloaded app."
                )
            else:
                job["status"] = "done"
    except Exception as error:
        with LOCK:
            job.update(status="error", error=str(error))
    finally:
        with LOCK:
            job.pop("process", None)
        PROCESS_LOCK.release()


@router.post("/jobs/{identity}/process")
async def process(identity: str, request: Request):
    job = job_for(identity)
    try:
        payload = await request.json()
        payload = validate_job(
            {
                **payload,
                "version": 1,
                "source": str(job["directory"] / "source"),
                "event_id": identity,
                "player_id": identity,
                "player_name": "Personal player",
                "identity_evidence": "User selected track",
            }
        )
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))
    if not capabilities()["native"]:
        raise HTTPException(503, "Run setup again to install the local masking engine")
    with LOCK:
        if job["status"] in ("queued", "processing"):
            raise HTTPException(409, "Cancel the current processing job first")
        if EXECUTOR is None:
            raise HTTPException(503, "Local processing queue is unavailable")
        for name in ("frames", "masks", "output"):
            shutil.rmtree(job["directory"] / name, ignore_errors=True)
        for name in ("progress.json", "result.json", "error.json"):
            (job["directory"] / name).unlink(missing_ok=True)
        atomic(job["directory"] / "request.json", payload)
        job.update(
            status="queued",
            error=None,
            cancel=threading.Event(),
            generation=job["generation"] + 1,
        )
        EXECUTOR.submit(execute, identity, job["generation"])
    return {"id": identity, "status": "queued"}


@router.get("/jobs/{identity}")
def status(identity: str):
    job = job_for(identity)
    with LOCK:
        value = {
            "id": identity,
            "status": job["status"],
            "stage": "Waiting for local processing",
            "progress": 0,
            "error": job.get("error"),
        }
        if (job["directory"] / "progress.json").exists():
            value.update(json.loads((job["directory"] / "progress.json").read_text()))
        if job["status"] == "done":
            value["result"] = json.loads((job["directory"] / "result.json").read_text())
        return value


@router.post("/jobs/{identity}/cancel")
def cancel(identity: str):
    job = job_for(identity)
    with LOCK:
        job["cancel"].set()
        if job["status"] in ("uploaded", "queued"):
            job["status"] = "cancelled"
    return {"id": identity, "status": "cancelled"}


@router.get("/jobs/{identity}/output/{kind}")
def output(identity: str, kind: str):
    job = job_for(identity)
    if job["status"] != "done":
        raise HTTPException(409, "Video is not ready")
    result = json.loads((job["directory"] / "result.json").read_text())
    if kind not in result["outputs"]:
        raise HTTPException(404, "Unknown video")
    return FileResponse(job["directory"] / "output" / result["outputs"][kind]["file"])


@router.delete("/jobs/{identity}")
def release(identity: str):
    job = job_for(identity)
    cancel(identity)

    # Running subprocess cleanup is deferred until it exits; it never owns saved media.
    def cleanup():
        while job.get("process") is not None:
            time.sleep(0.05)
        with LOCK:
            JOBS.pop(identity, None)
            shutil.rmtree(job["directory"], ignore_errors=True)

    threading.Thread(target=cleanup, daemon=True).start()
    return {"deleted": True}


@router.get("/media")
def library():
    directory = ROOT / "saved"
    if not directory.exists():
        return []
    with LOCK:
        return sorted(
            [
                json.loads(p.read_text())
                for p in directory.glob("*/clip.json")
                if not p.parent.name.startswith(".")
            ],
            key=lambda v: (v["createdAt"], v["id"]),
            reverse=True,
        )


@router.post("/media")
async def save(request: Request):
    form = await request.form()
    try:
        metadata = json.loads(str(form.get("metadata")))
        if not isinstance(metadata, dict) or not isinstance(
            metadata.get("player"), dict
        ):
            raise ValueError("Invalid metadata")
        identity = identifier(metadata["id"])
        if not isinstance(metadata.get("quiz"), bool):
            raise ValueError("Invalid quiz flag")
        if metadata.get("presentation") not in (None, "silhouette"):
            raise ValueError("Invalid presentation")
        datetime.fromisoformat(metadata["createdAt"].replace("Z", "+00:00"))
        name = metadata["player"]["name"]
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError("Invalid player name")
        if metadata.get("version") != 1 or not 0 < float(metadata["duration"]) <= 15:
            raise ValueError("Invalid clip")
        kinds = (
            ["highlight", "quiz", "reveal"] if metadata.get("quiz") else ["highlight"]
        )
        staging = ROOT / "saved" / ("." + identity)
        final = ROOT / "saved" / identity
        with LOCK:
            if final.exists():
                return json.loads((final / "clip.json").read_text())
            if staging.exists():
                raise HTTPException(409, "Save is already pending")
            staging.mkdir(parents=True)
        try:
            for kind in kinds:
                upload = form.get(kind)
                if upload is None or not hasattr(upload, "read"):
                    raise ValueError("Missing video")
                suffix = (
                    ".mp4"
                    if metadata["mime"] == "video/mp4"
                    else ".webm"
                    if metadata["mime"] == "video/webm"
                    else None
                )
                if suffix is None:
                    raise ValueError("Invalid video format")
                total = 0
                with (staging / (kind + suffix)).open("wb") as out:
                    while data := await upload.read(1024 * 1024):
                        total += len(data)
                        if total > MAX_BYTES:
                            raise ValueError("Export exceeds storage limit")
                        out.write(data)
                if total == 0:
                    raise ValueError("Empty export")
            clean = {
                "version": 1,
                "id": identity,
                "player": {
                    "id": identifier(metadata["player"]["id"]),
                    "name": name.strip(),
                    "aliases": [],
                },
                "duration": float(metadata["duration"]),
                "createdAt": metadata["createdAt"],
                "mime": metadata["mime"],
                "quiz": bool(metadata.get("quiz")),
                **(
                    {"presentation": "silhouette"}
                    if metadata.get("presentation") == "silhouette"
                    else {}
                ),
            }
            atomic(staging / "clip.json", clean)
            with LOCK:
                staging.rename(final)
            return clean
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise HTTPException(400, str(error))
    finally:
        await form.close()


@router.get("/media/{identity}/{kind}")
def saved_video(identity: str, kind: str):
    identifier(identity)
    if kind not in ("highlight", "quiz", "reveal"):
        raise HTTPException(404, "Unknown variant")
    directory = ROOT / "saved" / identity
    if not (directory / "clip.json").exists():
        raise HTTPException(404, "Clip not found")
    metadata = json.loads((directory / "clip.json").read_text())
    path = directory / (kind + (".mp4" if metadata["mime"] == "video/mp4" else ".webm"))
    if not path.exists():
        raise HTTPException(404, "Variant not found")
    return FileResponse(path)


@router.delete("/media/{identity}")
def delete(identity: str):
    identifier(identity)
    with LOCK:
        shutil.rmtree(ROOT / "saved" / identity, ignore_errors=True)
    return {"deleted": True}
