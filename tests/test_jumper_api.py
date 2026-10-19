import json
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import numpy as np
from backend.api import jumper
from backend.jumper.pipeline import encoder, silhouette_pixels


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(jumper, "ROOT", tmp_path)
    jumper.JOBS.clear()
    app = FastAPI()
    app.include_router(jumper.router)
    with TestClient(app) as client:
        yield client


def metadata():
    identity = str(uuid.uuid4())
    return dict(
        version=1,
        id=identity,
        player=dict(id=identity, name="Test Shooter", aliases=[]),
        duration=3,
        createdAt="2026-10-16T00:00:00Z",
        mime="video/mp4",
        quiz=True,
    )


def save(client, value, missing=None, videos=None):
    return client.post(
        "/api/jumper-lab/media",
        data={"metadata": json.dumps(value)},
        files={
            kind: (kind + ".mp4", (videos or {}).get(kind, b"test video"), "video/mp4")
            for kind in ["highlight", "quiz", "reveal"]
            if kind != missing
        },
    )


def test_atomic_save_reload_delete_and_idempotency(client):
    value = metadata()
    assert save(client, value).status_code == 200
    assert save(client, value).json() == value
    assert client.get("/api/jumper-lab/media").json() == [value]
    assert (
        client.get(f"/api/jumper-lab/media/{value['id']}/quiz").content == b"test video"
    )
    assert client.delete(f"/api/jumper-lab/media/{value['id']}").status_code == 200
    assert client.get("/api/jumper-lab/media").json() == []


@pytest.mark.parametrize(
    "change",
    [
        {"duration": 0},
        {"duration": 16},
        {"quiz": "yes"},
        {"version": 2},
        {"version": True},
        {"duration": True},
        {"duration": float("nan")},
        {"createdAt": "bad"},
        {"player": None},
        {"id": "../escape"},
    ],
)
def test_invalid_metadata(client, change):
    assert save(client, {**metadata(), **change}).status_code == 400
    assert client.get("/api/jumper-lab/media").json() == []


def test_incomplete_save_not_published(client):
    assert save(client, metadata(), missing="reveal").status_code == 400
    assert client.get("/api/jumper-lab/media").json() == []


def test_empty_upload_and_invalid_job(client):
    assert (
        client.post(
            "/api/jumper-lab/jobs", files={"file": ("empty.mp4", b"")}
        ).status_code
        == 400
    )
    assert client.get("/api/jumper-lab/jobs/not-an-id").status_code == 400
    identity = client.post(
        "/api/jumper-lab/jobs", files={"file": ("private.mp4", b"bytes")}
    ).json()["id"]
    assert (
        client.post(f"/api/jumper-lab/jobs/{identity}/process", json={}).status_code
        == 400
    )
    assert client.post(f"/api/jumper-lab/jobs/{identity}/cancel").status_code == 200
    assert (
        client.get(f"/api/jumper-lab/jobs/{identity}").json()["status"] == "cancelled"
    )
    assert client.delete(f"/api/jumper-lab/jobs/{identity}").status_code == 200


def encoded_video(tmp_path, colored=False):
    labels = np.zeros((48, 64), np.uint8)
    labels[8:40, 16:32] = 1
    labels[8:40, 40:56] = 2
    pixels = silhouette_pixels(labels, 1)
    if colored:
        pixels[8:40, 16:32] = (255, 0, 0)
    path = tmp_path / ("colored.mp4" if colored else "neutral.mp4")
    with encoder(path, 64, 48) as stream:
        for _ in range(3):
            stream.write(pixels.tobytes())
    return path.read_bytes()


def test_silhouette_metadata_survives_reload(client, tmp_path):
    value = {**metadata(), "presentation": "silhouette", "duration": 0.1}
    video = encoded_video(tmp_path)
    videos = dict.fromkeys(("highlight", "quiz", "reveal"), video)
    assert save(client, value, videos=videos).json() == value
    assert client.get("/api/jumper-lab/media").json() == [value]
    assert save(client, {**metadata(), "presentation": "original"}).status_code == 400


@pytest.mark.parametrize("failure", ["corrupt", "colored", "reveal", "duration"])
def test_unsafe_silhouette_not_published(client, tmp_path, failure):
    value = {**metadata(), "presentation": "silhouette", "duration": 0.1}
    video = encoded_video(tmp_path, colored=failure == "colored")
    if failure == "corrupt":
        video = b"invalid video"
    if failure == "duration":
        value["duration"] = 3
    videos = dict.fromkeys(("highlight", "quiz", "reveal"), video)
    if failure == "reveal":
        videos["reveal"] = encoded_video(tmp_path, colored=True)
    response = save(client, value, videos=videos)
    assert response.status_code == 400, response.text
    assert client.get("/api/jumper-lab/media").json() == []
    assert not list((jumper.ROOT / "saved").iterdir())


def uploaded_job(client):
    identity = client.post(
        "/api/jumper-lab/jobs", files={"file": ("private.mp4", b"bytes")}
    ).json()["id"]
    return identity, jumper.JOBS[identity]


def test_cancelled_waiter_cannot_take_ownership_of_retry(client, monkeypatch):
    identity, job = uploaded_job(client)
    entered = threading.Event()
    gate = threading.Lock()
    gate.acquire()

    class QueueLock:
        def acquire(self, **kwargs):
            entered.set()
            return gate.acquire(**kwargs)

        def release(self):
            gate.release()

    monkeypatch.setattr(jumper, "PROCESS_LOCK", QueueLock())
    launched = []

    def popen(*args, **kwargs):
        launched.append(threading.current_thread().name)
        return type("Completed", (), {"returncode": 0, "poll": lambda self: 0})()

    monkeypatch.setattr(jumper.subprocess, "Popen", popen)
    monkeypatch.setattr(jumper, "completed_result", lambda directory: {})
    job.update(status="queued", generation=1)
    old = threading.Thread(target=jumper.execute, args=(identity, 1), name="old")
    new = threading.Thread(target=jumper.execute, args=(identity, 2), name="new")
    old.start()
    try:
        assert entered.wait(2)
        assert job["status"] == "queued"
        with jumper.LOCK:
            job["cancel"].set()
            job.update(generation=2, cancel=threading.Event())
        new.start()
    finally:
        gate.release()
        old.join(2)
        if new.ident:
            new.join(2)
    assert not old.is_alive() and not new.is_alive()
    assert launched == ["new"]
    assert job["status"] == "done"


def test_release_permanently_rejects_late_execution(client, monkeypatch):
    identity, job = uploaded_job(client)
    job.update(generation=1, status="queued")
    assert client.delete(f"/api/jumper-lab/jobs/{identity}").status_code == 200
    monkeypatch.setattr(
        jumper.subprocess, "Popen", lambda *a, **k: pytest.fail("released job launched")
    )
    jumper.execute(identity, 1)
    assert client.get(f"/api/jumper-lab/jobs/{identity}").status_code == 404
    assert job["cancel"].is_set()


@pytest.mark.parametrize(
    "stage,cancelled,codes,expected",
    [
        ("Tracking players · MPS", False, [-9, 0], "done"),
        ("Tracking players · CUDA", False, [-15, 0], "done"),
        ("Tracking players · MPS", False, [-9, -9], "error"),
        ("Tracking players · CPU", False, [-9], "error"),
        ("Tracking players · MPS", True, [-9], "cancelled"),
    ],
)
def test_killed_accelerator_retries_cpu_once(
    client, monkeypatch, stage, cancelled, codes, expected
):
    identity, job = uploaded_job(client)
    job.update(generation=1, status="queued")
    (job["directory"] / "progress.json").write_text(json.dumps({"stage": stage}))
    launches = []

    def popen(*args, **kwargs):
        launches.append(kwargs["env"]["ARCADE_JUMPER_CPU_FALLBACK"])
        for name in ("frames", "masks", "output"):
            directory = job["directory"] / name
            assert not directory.exists()
            directory.mkdir()
            (directory / "partial").write_bytes(b"incomplete")
        assert (job["directory"] / "source").read_bytes() == b"bytes"
        if cancelled:
            job["cancel"].set()
        code = codes[len(launches) - 1]
        return type("Completed", (), {"returncode": code, "poll": lambda self: code})()

    monkeypatch.setattr(jumper.subprocess, "Popen", popen)
    monkeypatch.setattr(jumper, "completed_result", lambda directory: {})
    jumper.execute(identity, 1)
    assert launches == ["0", "1"][: len(codes)]
    assert job["status"] == expected


def test_killed_accelerator_cannot_clear_a_new_generation(client, monkeypatch):
    identity, job = uploaded_job(client)
    job.update(generation=1, status="queued")
    (job["directory"] / "progress.json").write_text(json.dumps({"stage": "MPS"}))
    frames = job["directory"] / "frames"
    frames.mkdir()
    retained = frames / "newer-frame"
    retained.write_bytes(b"keep")
    launched = []

    def popen(*args, **kwargs):
        launched.append(1)
        job.update(generation=2, cancel=threading.Event(), status="queued")
        return type("Killed", (), {"returncode": -9, "poll": lambda self: -9})()

    monkeypatch.setattr(jumper.subprocess, "Popen", popen)
    jumper.execute(identity, 1)
    assert launched == [1]
    assert retained.read_bytes() == b"keep"
    assert job["status"] == "queued" and job["generation"] == 2


def test_submit_failure_and_bad_status_are_recoverable(client, monkeypatch):
    identity, job = uploaded_job(client)
    executor = ThreadPoolExecutor(1)
    executor.shutdown()
    monkeypatch.setattr(jumper, "EXECUTOR", executor)
    monkeypatch.setattr(jumper, "capabilities", lambda: {"native": True})
    response = client.post(
        f"/api/jumper-lab/jobs/{identity}/process",
        json={
            "start": 0,
            "end": 0.1,
            "target_id": 1,
            "objects": [
                {
                    "id": 1,
                    "prompts": [{"frame": 0, "points": [[0.5, 0.5]], "labels": [1]}],
                }
            ],
        },
    )
    assert response.status_code == 503
    assert job["status"] == "error"
    (job["directory"] / "progress.json").write_text(
        '{"status":"done","stage":"Fake","progress":0.5}'
    )
    assert client.get(f"/api/jumper-lab/jobs/{identity}").json()["status"] == "error"
    (job["directory"] / "progress.json").write_text("{")
    assert client.get(f"/api/jumper-lab/jobs/{identity}").status_code == 200
    job["status"] = "done"
    assert client.get(f"/api/jumper-lab/jobs/{identity}").json()["status"] == "error"


@pytest.mark.parametrize("resolved", [True, False])
def test_processing_preserves_resolved_shooter_prompt(client, monkeypatch, resolved):
    from concurrent.futures import Future
    from types import SimpleNamespace

    identity, job = uploaded_job(client)
    monkeypatch.setattr(jumper, "capabilities", lambda: {"native": True})
    monkeypatch.setattr(
        jumper, "EXECUTOR", SimpleNamespace(submit=lambda *args: Future())
    )
    payload = {
        "start": 2,
        "end": 5,
        "target_id": 7,
        "auto_detect_others": True,
        "shooter_selection_resolved": resolved,
        "presentation": "silhouette",
        "objects": [
            {
                "id": 7,
                "prompts": [
                    {
                        "frame": 0,
                        "box": [0.1, 0.1, 0.5, 0.9],
                        "points": [[0.3, 0.4]],
                        "labels": [1],
                    }
                ],
            }
        ],
    }
    response = client.post(f"/api/jumper-lab/jobs/{identity}/process", json=payload)
    assert response.status_code == 200
    stored = json.loads((job["directory"] / "request.json").read_text())
    assert stored["shooter_selection_resolved"] is resolved
    assert stored["objects"] == payload["objects"]
    assert stored["auto_detect_others"] is True


@pytest.mark.parametrize("removed_frame", [0, 2, 4])
def test_reprocessing_removes_deleted_prompt_and_all_prediction_artifacts(client, monkeypatch, removed_frame):
    from concurrent.futures import Future
    from types import SimpleNamespace

    identity, job = uploaded_job(client)
    monkeypatch.setattr(jumper, "capabilities", lambda: {"native": True})
    submissions = []
    monkeypatch.setattr(jumper, "EXECUTOR", SimpleNamespace(
        submit=lambda *args: submissions.append(args) or Future()))
    prompts = [dict(frame=0, box=[0.1, 0.1, 0.5, 0.9], points=[[0.3, 0.4]], labels=[1]),
               dict(frame=2, points=[[0.3, 0.4], [0.8, 0.6]], labels=[1, 0], anchor=True),
               dict(frame=4, points=[[0.4, 0.5]], labels=[1])]
    payload = dict(start=0, end=0.2, target_id=7,
                   objects=[dict(id=7, prompts=prompts)], presentation="silhouette")
    url = f"/api/jumper-lab/jobs/{identity}/process"
    assert client.post(url, json=payload).status_code == 200
    generation = job["generation"]
    job["status"] = "done"
    # Seed real filesystem artifacts from the preceding run, including frames
    # before the removed correction: bidirectional dependencies are job-local.
    for name in ("frames", "detail-frames", "masks", "output"):
        directory = job["directory"] / name
        directory.mkdir()
        for frame in (0, 2, 4):
            (directory / str(frame)).write_bytes(b"old prediction")
    for name in ("progress.json", "result.json", "error.json"):
        (job["directory"] / name).write_text("{}")
    cache = jumper.ROOT / "calculation-cache"
    cache.mkdir()
    evidence = cache / "unchanged-frame.npz"
    evidence.write_bytes(b"prompt-independent image features")
    # Removing only the points on frame zero keeps the detector box usable.
    remaining = [({"frame": 0, "box": prompt["box"]} if removed_frame == 0 and prompt["frame"] == 0 else prompt)
                 for prompt in prompts if prompt["frame"] != removed_frame or removed_frame == 0]
    payload["objects"][0]["prompts"] = remaining
    assert client.post(url, json=payload).status_code == 200
    stored = json.loads((job["directory"] / "request.json").read_text())
    assert stored["objects"][0]["prompts"] == remaining
    assert job["generation"] == generation + 1
    assert len(submissions) == 2
    for name in ("frames", "detail-frames", "masks", "output", "progress.json", "result.json", "error.json"):
        assert not (job["directory"] / name).exists()
    assert evidence.read_bytes() == b"prompt-independent image features"


@pytest.mark.parametrize("code,reported,expected", [(0, False, "interrupted"), (1, False, "interrupted"), (1, True, "failed")])
def test_worker_exit_has_explicit_reason_and_never_becomes_cancellation(client, monkeypatch, code, reported, expected):
    identity, job = uploaded_job(client)
    job.update(generation=1, status="queued")
    if reported:
        (job["directory"] / "error.json").write_text(json.dumps({"error": "Tracking failed"}))
    process = type("Exited", (), {"returncode": code, "poll": lambda self: code})()
    monkeypatch.setattr(jumper.subprocess, "Popen", lambda *a, **k: process)
    jumper.execute(identity, 1)
    state = client.get(f"/api/jumper-lab/jobs/{identity}").json()
    assert state["status"] == "error"
    assert state["termination_reason"] == expected
    assert not job["cancel"].is_set()
    assert "process" not in job
    assert jumper.PROCESS_LOCK.acquire(blocking=False)
    jumper.PROCESS_LOCK.release()
    # Neither Cancel nor a stale polling callback may turn this into cancellation.
    late = client.post(f"/api/jumper-lab/jobs/{identity}/cancel").json()
    assert late["termination_reason"] == expected
    assert late["status"] == "error"


def test_cancel_waits_for_running_worker_exit(client, monkeypatch):
    identity, job = uploaded_job(client)
    class Process:
        returncode = None
        def poll(self): return self.returncode
        def terminate(self): self.returncode = -15
        def wait(self, **kwargs): return self.returncode
    process = Process()
    job.update(status="processing", generation=1, process=process)
    response = client.post(f"/api/jumper-lab/jobs/{identity}/cancel").json()
    assert response["status"] == "processing"
    assert response["termination_reason"] == "cancel_requested"
    # Run the real executor cancellation loop, rather than claiming that the
    # signal alone establishes a completed handshake.
    job["cancel"] = threading.Event()
    def launch(*a, **k):
        job["cancel"].set()
        return process
    monkeypatch.setattr(jumper.subprocess, "Popen", launch)
    jumper.execute(identity, 1)
    assert process.returncode == -15
    assert job["termination_reason"] == "cancelled"
    assert job["status"] == "cancelled" and "process" not in job


def test_cancel_racing_an_unexpected_exit_does_not_claim_success(client):
    identity, job = uploaded_job(client)
    job.update(status="processing", process=type("Exited", (), {"poll": lambda self: 1})())
    response = client.post(f"/api/jumper-lab/jobs/{identity}/cancel").json()
    assert response["status"] == "processing"
    assert not job["cancel"].is_set()
