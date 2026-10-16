import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from backend.api import jumper


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


def save(client, value, missing=None):
    return client.post(
        "/api/jumper-lab/media",
        data={"metadata": json.dumps(value)},
        files={
            kind: (kind + ".mp4", b"test video", "video/mp4")
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
