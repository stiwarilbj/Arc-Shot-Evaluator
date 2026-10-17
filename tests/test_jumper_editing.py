import copy
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import cv2
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.api import jumper
from backend.jumper.editing import (
    validate_project,
    frame_state,
    render,
    draw_frame,
    length,
    PROFILE,
)
from backend.jumper.pipeline import encoder, silhouette_pixels
from backend.jumper.backup import metadata, export_archive, import_archive


def project():
    framing = dict(zoom=1, x=0.5, y=0.5)
    return dict(
        version=1,
        baseFrames=12,
        baseMime="video/mp4",
        baseProfile="palette",
        pieces=[
            dict(
                id="a",
                start=0,
                end=6,
                speed=0.5,
                freeze=0,
                **{"from": framing.copy(), "to": framing.copy()},
            ),
            dict(
                id="freeze",
                start=6,
                end=7,
                speed=1,
                freeze=15,
                **{"from": framing.copy(), "to": framing.copy()},
            ),
            dict(
                id="b",
                start=6,
                end=12,
                speed=2,
                freeze=0,
                **{"from": framing.copy(), "to": framing.copy()},
            ),
        ],
        captions=[
            dict(
                id="text",
                text="Footwork",
                start=2,
                end=15,
                size="medium",
                position="top",
            )
        ],
        fadeIn=True,
        fadeOut=True,
    )


def base_video(path):
    with encoder(path, 128, 96) as stream:
        for frame in range(12):
            labels = np.zeros((96, 128), np.uint8)
            labels[25:80, 10 + frame : 24 + frame] = 1
            labels[30:85, 70:85] = 2
            stream.write(silhouette_pixels(labels, 1, palette=True).tobytes())


def test_legacy_codec_chroma_is_neutralized_before_encoding():
    image = np.full((96, 128, 3), (120, 122, 121), dtype=np.uint8)
    output = draw_frame(image, project(), 4, clean=True)
    assert np.all(output == 121)


def test_native_render_and_clean_quiz_round_trip(tmp_path, monkeypatch):
    p = project()
    validate_project(p)
    base = tmp_path / "base.mp4"
    base_video(base)
    out = tmp_path / "out"
    out.mkdir()
    progress = []
    render(base, p, out, threading.Event(), progress.append)
    assert progress[-1] == 1
    viewing = cv2.VideoCapture(str(out / "highlight.mp4"))
    clean = cv2.VideoCapture(str(out / "clean.mp4"))
    try:
        assert (
            viewing.get(cv2.CAP_PROP_FRAME_COUNT)
            == clean.get(cv2.CAP_PROP_FRAME_COUNT)
            == length(p)
            == 30
        )
        _, v = viewing.read()
        _, q = clean.read()
        assert v.min() > 180 and q.min() < 10  # fade affects viewing only
        for i in range(5):
            _, v = viewing.read()
            _, q = clean.read()
        assert (
            np.abs(v.astype(float) - q.astype(float)).mean() > 2
        )  # caption is absent from quiz
    finally:
        viewing.release()
        clean.release()
    identity = str(uuid.uuid4())
    value = dict(
        version=1,
        id=identity,
        player=dict(id=identity, name="Private shooter", aliases=[]),
        duration=1,
        createdAt="2026-10-17T00:00:00Z",
        mime="video/mp4",
        quiz=True,
        presentation=PROFILE,
        project=p,
    )
    root = tmp_path / "storage"
    monkeypatch.setattr(jumper, "ROOT", root)
    app = FastAPI()
    app.include_router(jumper.router)
    files = {
        kind: (
            kind + ".mp4",
            (
                base
                if kind == "base"
                else out
                / ("clean.mp4" if kind in ("quiz", "reveal") else "highlight.mp4")
            ).read_bytes(),
            "video/mp4",
        )
        for kind in ("highlight", "quiz", "reveal", "base")
    }
    with TestClient(app) as client:
        assert (
            client.post(
                "/api/jumper-lab/media",
                data={"metadata": json.dumps(value)},
                files={k: v for k, v in files.items() if k != "base"},
            ).status_code
            == 400
        )
        response = client.post(
            "/api/jumper-lab/media", data={"metadata": json.dumps(value)}, files=files
        )
        assert response.status_code == 200, response.text
        assert response.json()["project"] == p
        assert (
            client.get(f"/api/jumper-lab/media/{identity}/base").content
            == base.read_bytes()
        )
        assert client.get("/api/jumper-lab/media").json()[0]["project"] == p
        assert (
            len(
                client.post(
                    "/api/jumper-lab/media",
                    data={"metadata": json.dumps(value)},
                    files=files,
                ).json()["id"]
            )
            == 36
        )
    archive = tmp_path / "backup.zip"
    export_archive(root, archive)
    restored = tmp_path / "restored"
    assert import_archive(restored, archive, threading.RLock())["added"] == 1
    saved = restored / "saved" / identity
    assert json.loads((saved / "clip.json").read_text())["project"] == p
    assert (saved / "base.mp4").read_bytes() == base.read_bytes()
    assert import_archive(restored, archive, threading.RLock())["skipped"] == 1


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(pieces=[]),
        lambda p: p["pieces"][0].update(speed=0.25),
        lambda p: p["pieces"][0]["from"].update(zoom=2.01),
        lambda p: p["pieces"][1].update(freeze=91),
        lambda p: p["pieces"][0].update(start=-1),
        lambda p: p["captions"][0].update(end=999),
        lambda p: p.update(version=True),
        lambda p: p.update(baseFrames=float("nan")),
    ],
)
def test_invalid_projects(mutate):
    p = project()
    mutate(p)
    with pytest.raises(ValueError):
        validate_project(p)


def test_palette_stable_independent_of_other_players():
    labels = np.array([[0, 1, 2, 3]], np.uint8)
    pixels = silhouette_pixels(labels, 1, palette=True)
    assert pixels[0, :, 0].tolist() == [224, 0, 111, 158]
    assert np.array_equal(
        pixels[0, 2],
        silhouette_pixels(np.array([[2]], np.uint8), 1, palette=True)[0, 0],
    )
    assert silhouette_pixels(labels, 1)[0, 2, 0] == 128


def test_edit_queue_cancellation_and_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(jumper, "ROOT", tmp_path / "media")
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(jumper, "EXECUTOR", executor)
    base = tmp_path / "base.mp4"
    base_video(base)
    app = FastAPI()
    app.include_router(jumper.router)
    with TestClient(app) as client:
        response = client.post(
            "/api/jumper-lab/edits",
            data={"project": json.dumps(project())},
            files={"base": ("base.mp4", base.read_bytes(), "video/mp4")},
        )
        assert response.status_code == 200, response.text
        identity = response.json()["id"]
        for _ in range(200):
            state = client.get(f"/api/jumper-lab/edits/{identity}").json()
            if state["done"] or state["error"]:
                break
            time.sleep(0.05)
        assert state["done"], state
        assert client.get(f"/api/jumper-lab/edits/{identity}/clean").status_code == 200
        assert client.delete(f"/api/jumper-lab/edits/{identity}").status_code == 200
        assert client.get(f"/api/jumper-lab/edits/{identity}").status_code == 404
    executor.shutdown(wait=True)


def test_cancelled_edit_cannot_publish_late_results(tmp_path, monkeypatch):
    import backend.jumper.editing as editing

    root = tmp_path / "media"
    monkeypatch.setattr(jumper, "ROOT", root)
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(jumper, "EXECUTOR", executor)
    started, finished = threading.Event(), threading.Event()

    def slow_render(base, project, directory, cancel, progress):
        started.set()
        assert cancel.wait(5)
        progress(1)  # Simulate a late codec callback after release.
        finished.set()

    monkeypatch.setattr(editing, "render", slow_render)
    app = FastAPI()
    app.include_router(jumper.router)
    with TestClient(app) as client:
        response = client.post(
            "/api/jumper-lab/edits",
            data={"project": json.dumps(project())},
            files={"base": ("base.mp4", b"test", "video/mp4")},
        )
        identity = response.json()["id"]
        assert started.wait(5)
        assert client.delete(f"/api/jumper-lab/edits/{identity}").status_code == 200
        assert finished.wait(5)
        assert client.get(f"/api/jumper-lab/edits/{identity}").status_code == 404
        assert client.get(f"/api/jumper-lab/edits/{identity}/clean").status_code == 404
    executor.shutdown(wait=True)
    assert identity not in jumper.JOBS
    assert not (root / "jobs" / identity).exists()


def test_unavailable_edit_queue_cleans_uploaded_base(tmp_path, monkeypatch):
    root = tmp_path / "media"
    monkeypatch.setattr(jumper, "ROOT", root)
    executor = ThreadPoolExecutor(max_workers=1)
    executor.shutdown()
    monkeypatch.setattr(jumper, "EXECUTOR", executor)
    before = set(jumper.JOBS)
    app = FastAPI()
    app.include_router(jumper.router)
    with TestClient(app) as client:
        response = client.post(
            "/api/jumper-lab/edits",
            data={"project": json.dumps(project())},
            files={"base": ("base.mp4", b"test", "video/mp4")},
        )
        assert response.status_code == 503
    assert set(jumper.JOBS) == before
    assert not list((root / "jobs").iterdir())
