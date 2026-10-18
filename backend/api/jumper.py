"""Private local Jumper jobs and media; never used by GitHub Pages."""

from __future__ import annotations
from datetime import datetime
from contextlib import asynccontextmanager
import importlib.util
import hashlib
import json
import os
import math
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import tempfile
import uuid

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from backend.jumper.backup import (
    export_archive,
    import_archive,
    library_contents,
    MAX_ARCHIVE,
    metadata as clean_metadata,
    kinds as media_kinds,
    suffix as media_suffix,
)
from backend.config import PROJECT_ROOT, MODEL_WEIGHTS_DIR
from backend.jumper.pipeline import validate_job, run_ffmpeg, propose_people
from backend.jumper.video_validation import validate_saved_silhouette


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
        cancelled = job["cancel"]

    def owns():
        # A retry owns a new generation AND event. Never consult its event from
        # an older queued callback, or resurrect a job after release/expiry.
        return JOBS.get(identity) is job and job["generation"] == generation

    directory = job["directory"]
    while not PROCESS_LOCK.acquire(timeout=0.1):
        with LOCK:
            if cancelled.is_set() or not owns():
                return
    process = None
    try:
        for cpu_retry in (False, True):
            with LOCK:
                if cancelled.is_set() or not owns():
                    if owns() and cancelled.is_set():
                        job["status"] = "cancelled"
                    return
                job["status"] = "processing"
                process = subprocess.Popen(
                    [sys.executable, "-m", "backend.jumper.runner", str(directory)],
                    cwd=PROJECT_ROOT,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env={
                        **os.environ,
                        "ARCADE_JUMPER_CPU_FALLBACK": "1" if cpu_retry else "0",
                    },
                )
                job["process"] = process
            while process.poll() is None:
                if cancelled.wait(0.1):
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    break
            if cpu_retry or cancelled.is_set() or process.returncode not in (-9, -15):
                break
            # An OS-terminated accelerator cannot raise Python's catchable OOM.
            # Retry once in a fresh CPU process, using the original selections.
            with LOCK:
                if cancelled.is_set() or not owns():
                    if owns() and cancelled.is_set():
                        job["status"] = "cancelled"
                    return
                try:
                    stage = json.loads((directory / "progress.json").read_text())[
                        "stage"
                    ]
                except (OSError, ValueError, KeyError):
                    break
                if not any(device in stage for device in ("MPS", "CUDA")):
                    break
                for name in ("frames", "masks", "output"):
                    shutil.rmtree(directory / name, ignore_errors=True)
                for name in ("error.json", "result.json"):
                    (directory / name).unlink(missing_ok=True)
        with LOCK:
            if not owns():
                return
            if cancelled.is_set():
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
                completed_result(directory)
                job["status"] = "done"
    except Exception as error:
        with LOCK:
            if owns():
                if cancelled.is_set():
                    job["status"] = "cancelled"
                else:
                    job.update(status="error", error=str(error))
    finally:
        with LOCK:
            if job.get("process") is process:
                job.pop("process", None)
        PROCESS_LOCK.release()


def completed_result(directory):
    """Do not announce success for an incomplete subprocess result."""
    try:
        result = json.loads((directory / "result.json").read_text())
        if (
            not isinstance(result, dict)
            or type(result.get("duration")) not in (int, float)
            or not 0 < result["duration"] <= 15
            or not isinstance(result.get("warnings"), list)
            or not isinstance(result.get("objects"), list)
            or not isinstance(result.get("outputs"), dict)
        ):
            raise ValueError()
        if "tracking_check" in result:
            from backend.jumper.tracking_check import valid_tracking_check

            if not valid_tracking_check(result):
                raise ValueError()
        for kind in ("quiz", "reveal", "highlight"):
            value = result["outputs"][kind]
            name = value["file"]
            if (
                not isinstance(name, str)
                or Path(name).name != name
                or not (directory / "output" / name).is_file()
            ):
                raise ValueError()
            if not 0 < (directory / "output" / name).stat().st_size <= MAX_BYTES:
                raise ValueError()
        return result
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise ValueError(
            "Local export is incomplete. Retry processing; no clip was saved."
        ) from error


@router.post("/jobs/{identity}/process")
async def process(identity: str, request: Request):
    job = job_for(identity)
    if job.get("kind") == "edit":
        raise HTTPException(404, "Masking job unavailable")
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
        if JOBS.get(identity) is not job:
            raise HTTPException(404, "Job expired; upload again")
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
        try:
            EXECUTOR.submit(execute, identity, job["generation"])
        except RuntimeError as error:
            job.update(
                status="error",
                error="Local processing queue is unavailable; restart the downloaded app.",
            )
            raise HTTPException(503, job["error"]) from error
    return {"id": identity, "status": "queued"}


@router.get("/jobs/{identity}")
def status(identity: str):
    job = job_for(identity)
    if job.get("kind") == "edit":
        raise HTTPException(404, "Masking job unavailable")
    with LOCK:
        value = {
            "id": identity,
            "status": job["status"],
            "stage": "Waiting for local processing",
            "progress": 0,
            "error": job.get("error"),
        }
        if (job["directory"] / "progress.json").exists():
            try:
                progress = json.loads((job["directory"] / "progress.json").read_text())
                if (
                    isinstance(progress.get("stage"), str)
                    and type(progress.get("progress")) in (int, float)
                    and 0 <= progress["progress"] <= 1
                ):
                    value.update(stage=progress["stage"], progress=progress["progress"])
            except (OSError, ValueError, AttributeError):
                pass  # A missing progress update must not destroy a running job.
        if job["status"] == "done":
            try:
                value["result"] = completed_result(job["directory"])
            except ValueError as error:
                job.update(status="error", error=str(error))
                value.update(status="error", error=str(error))
        return value


@router.post("/jobs/{identity}/cancel")
def cancel(identity: str):
    job = job_for(identity)
    if job.get("kind") == "edit":
        raise HTTPException(404, "Masking job unavailable")
    with LOCK:
        job["cancel"].set()
        if job["status"] in ("uploaded", "queued"):
            job["status"] = "cancelled"
    return {"id": identity, "status": "cancelled"}


@router.get("/jobs/{identity}/output/{kind}")
def output(identity: str, kind: str):
    job = job_for(identity)
    if job.get("kind") == "edit":
        raise HTTPException(404, "Masking job unavailable")
    if job["status"] != "done":
        raise HTTPException(409, "Video is not ready")
    if kind not in ("quiz", "reveal", "highlight"):
        raise HTTPException(404, "Unknown video")
    try:
        result = completed_result(job["directory"])
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return FileResponse(job["directory"] / "output" / result["outputs"][kind]["file"])


@router.delete("/jobs/{identity}")
def release(identity: str):
    job = job_for(identity)
    with LOCK:
        job["cancel"].set()
        # Permanent removal happens before cleanup. Queued callbacks cannot
        # launch a process while their directory is being deleted.
        JOBS.pop(identity, None)
        process = job.get("process")

    # Running subprocess cleanup is deferred until it exits; it never owns saved media.
    def cleanup():
        if process is not None:
            process.wait()
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
        metadata = clean_metadata(json.loads(str(form.get("metadata"))))
        identity = identifier(metadata["id"])
        identifier(metadata["player"]["id"])
        kinds = media_kinds(metadata)
        staging = ROOT / "saved" / ("." + identity)
        final = ROOT / "saved" / identity
        with LOCK:
            if final.exists():
                return json.loads((final / "clip.json").read_text())
            if staging.exists():
                raise HTTPException(409, "Save is already pending")
            staging.mkdir(parents=True)
        try:
            checksums = []
            for kind in kinds:
                upload = form.get(kind)
                if upload is None or not hasattr(upload, "read"):
                    raise ValueError("Missing video")
                suffix = media_suffix(metadata, kind)
                total = 0
                checksum = hashlib.sha256()
                with (staging / (kind + suffix)).open("wb") as out:
                    while data := await upload.read(1024 * 1024):
                        total += len(data)
                        if total > MAX_BYTES:
                            raise ValueError("Export exceeds storage limit")
                        out.write(data)
                        checksum.update(data)
                if total == 0:
                    raise ValueError("Empty export")
                checksums.append(checksum.digest())
            presentation = metadata.get("presentation")
            if (
                presentation in ("silhouette", "silhouette-palette-v1")
                and len(set(checksums)) != 1
            ):
                raise ValueError("Silhouette variants must use the same masked video")
            if presentation and presentation.startswith("silhouette"):
                for kind in kinds:
                    project = metadata.get("project")
                    duration = (
                        project["baseFrames"] / 30
                        if kind == "base"
                        else metadata["duration"]
                    )
                    profile = (
                        project["baseProfile"]
                        if kind == "base"
                        else (
                            "edited"
                            if project
                            else (
                                "palette"
                                if presentation == "silhouette-palette-v1"
                                else "legacy"
                            )
                        )
                    )
                    if kind == "base" and duration > 15:
                        profile = "edited"
                    await run_in_threadpool(
                        validate_saved_silhouette,
                        staging / (kind + media_suffix(metadata, kind)),
                        duration,
                        profile,
                    )
                if project and metadata["quiz"] and checksums[1] != checksums[2]:
                    raise ValueError(
                        "Quiz and reveal must share the same clean timeline"
                    )
            clean = metadata
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
    if kind not in ("highlight", "quiz", "reveal", "base"):
        raise HTTPException(404, "Unknown variant")
    directory = ROOT / "saved" / identity
    if not (directory / "clip.json").exists():
        raise HTTPException(404, "Clip not found")
    metadata = json.loads((directory / "clip.json").read_text())
    if kind not in media_kinds(metadata):
        raise HTTPException(404, "Variant not found")
    path = directory / (kind + media_suffix(metadata, kind))
    if not path.exists():
        raise HTTPException(404, "Variant not found")
    return FileResponse(path)


@router.delete("/media/{identity}")
def delete(identity: str):
    identifier(identity)
    with LOCK:
        shutil.rmtree(ROOT / "saved" / identity, ignore_errors=True)
    return {"deleted": True}


@router.get("/backup")
def backup_export():
    directory = ROOT / "backup-temp"
    directory.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(suffix=".zip", dir=directory, delete=False)
    path = Path(handle.name)
    handle.close()
    try:
        with LOCK:
            export_archive(ROOT, path)
        return FileResponse(
            path,
            media_type="application/zip",
            filename="arc-jumper-library.zip",
            background=BackgroundTask(path.unlink, missing_ok=True),
        )
    except (ValueError, OSError, KeyError) as error:
        path.unlink(missing_ok=True)
        raise HTTPException(400, str(error))


@router.post("/backup")
async def backup_restore(file: UploadFile):
    directory = ROOT / "backup-temp"
    directory.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(suffix=".zip", dir=directory, delete=False)
    path = Path(handle.name)
    try:
        total = 0
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_ARCHIVE:
                raise HTTPException(413, "Backups are limited to 512 MiB")
            handle.write(chunk)
        handle.close()
        return await run_in_threadpool(import_archive, ROOT, path, LOCK)
    except FileExistsError as error:
        raise HTTPException(409, str(error))
    except Exception as error:
        if isinstance(error, HTTPException):
            raise
        raise HTTPException(400, f"Backup could not be restored: {error}")
    finally:
        handle.close()
        path.unlink(missing_ok=True)
        await file.close()


@router.get("/backup/index")
def backup_index():
    try:
        with LOCK:
            return library_contents(ROOT)[0]
    except (ValueError, OSError, KeyError) as error:
        raise HTTPException(400, str(error))


# Edit jobs share the existing bounded queue and heavy-work lock. Only masked media enters here.
@router.post("/edits")
async def create_edit(request: Request):
    from backend.jumper.editing import validate_project, render

    form = await request.form()
    directory = None
    try:
        project = validate_project(json.loads(str(form.get("project"))))
        upload = form.get("base")
        if not hasattr(upload, "read"):
            raise ValueError("A masked base video is required")
        if EXECUTOR is None:
            raise HTTPException(503, "The local work queue is unavailable")
        identity = str(uuid.uuid4())
        directory = ROOT / "jobs" / identity
        directory.mkdir(parents=True)
        base = directory / "base"
        total = 0
        with base.open("wb") as out:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError("Masked base exceeds 100 MB")
                out.write(chunk)
        if not total:
            raise ValueError("Empty masked base")
        job = {
            "directory": directory,
            "cancel": threading.Event(),
            "kind": "edit",
            "last_seen": time.monotonic(),
            "progress": 0,
            "done": False,
        }
        with LOCK:
            JOBS[identity] = job

        def work():
            acquired = False
            try:
                while not acquired:
                    if job["cancel"].is_set():
                        return
                    acquired = PROCESS_LOCK.acquire(timeout=0.1)

                def progress(value):
                    with LOCK:
                        if JOBS.get(identity) is job and not job["cancel"].is_set():
                            job["progress"] = value

                render(base, project, directory, job["cancel"], progress)
                with LOCK:
                    if JOBS.get(identity) is job and not job["cancel"].is_set():
                        job["done"] = True
            except Exception as error:
                with LOCK:
                    if JOBS.get(identity) is job:
                        job["error"] = str(error)
            finally:
                if acquired:
                    PROCESS_LOCK.release()
                if job["cancel"].is_set():
                    shutil.rmtree(directory, ignore_errors=True)

        try:
            EXECUTOR.submit(work)
        except RuntimeError:
            with LOCK:
                JOBS.pop(identity, None)
            shutil.rmtree(directory, ignore_errors=True)
            raise HTTPException(
                503, "The local work queue is unavailable; retry rendering"
            )
        return {"id": identity}
    except (ValueError, TypeError, KeyError) as error:
        if directory:
            shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(400, str(error))
    finally:
        await form.close()


@router.get("/edits/{identity}")
def edit_status(identity: str):
    job = job_for(identity)
    if job.get("kind") != "edit":
        raise HTTPException(404, "Edit job unavailable")
    return {"done": job["done"], "progress": job["progress"], "error": job.get("error")}


@router.get("/edits/{identity}/{kind}")
def edit_video(identity: str, kind: str):
    job = job_for(identity)
    if (
        job.get("kind") != "edit"
        or not job.get("done")
        or kind not in ("highlight", "clean")
    ):
        raise HTTPException(404, "Rendered video unavailable")
    return FileResponse(job["directory"] / (kind + ".mp4"), media_type="video/mp4")


@router.delete("/edits/{identity}")
def release_edit(identity: str):
    if job_for(identity).get("kind") != "edit":
        raise HTTPException(404, "Edit job unavailable")
    return release(identity)
