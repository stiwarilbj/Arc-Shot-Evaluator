import copy
import hashlib
import json
from pathlib import Path
import threading
import uuid
import zipfile

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api import jumper
from backend.jumper.backup import export_archive, import_archive, inspect_archive
from backend.jumper.pipeline import encoder


def fixture(tmp_path, quiz=True):
    identity = str(uuid.uuid4())
    value = dict(
        version=1,
        id=identity,
        player=dict(id=identity, name="Private Shooter", aliases=["Shooter"]),
        duration=0.1,
        createdAt="2026-10-17T01:00:00Z",
        mime="video/mp4",
        quiz=quiz,
        presentation="silhouette",
    )
    root = tmp_path / "source"
    directory = root / "saved" / identity
    directory.mkdir(parents=True)
    with encoder(directory / "highlight.mp4", 64, 48) as stream:
        for _ in range(3):
            stream.write(np.full((48, 64, 3), 224, np.uint8).tobytes())
    if quiz:
        for kind in ("quiz", "reveal"):
            (directory / f"{kind}.mp4").write_bytes(
                (directory / "highlight.mp4").read_bytes()
            )
    (directory / "clip.json").write_text(json.dumps(value))
    archive = tmp_path / "library.zip"
    export_archive(root, archive)
    return root, value, archive


def rewrite(source, destination, change):
    with zipfile.ZipFile(source) as original:
        items = {name: original.read(name) for name in original.namelist()}
    change(items)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as out:
        for name, data in items.items():
            out.writestr(name, data)
    return destination


def test_roundtrip_aliases_variants_dedup_and_repeat(tmp_path):
    root, value, archive = fixture(tmp_path)
    with zipfile.ZipFile(archive) as saved:
        assert len(saved.namelist()) == 2  # Three aliases of the same finished video.
        assert not any("source" in name for name in saved.namelist())
    target = tmp_path / "restored"
    assert import_archive(target, archive, threading.RLock()) == {
        "added": 1,
        "skipped": 0,
    }
    path = target / "saved" / value["id"]
    assert json.loads((path / "clip.json").read_text()) == value
    for kind in ("highlight", "quiz", "reveal"):
        assert (path / f"{kind}.mp4").read_bytes() == (
            root / "saved" / value["id"] / f"{kind}.mp4"
        ).read_bytes()
    assert import_archive(target, archive, threading.RLock()) == {
        "added": 0,
        "skipped": 1,
    }
    assert len(list((target / "saved").iterdir())) == 1


@pytest.mark.parametrize(
    "case", ["checksum", "missing", "unsafe", "invalid", "duration", "color", "format"]
)
def test_invalid_archive_preserves_existing_library(tmp_path, case):
    root, value, archive = fixture(tmp_path)

    def change(items):
        manifest = json.loads(items["manifest.json"])
        record = manifest["clips"][0]
        media = record["files"]["highlight"]["path"]
        if case == "checksum":
            items[media] = b"not the recorded video"
        if case == "missing":
            del items[media]
        if case == "unsafe":
            items["../escape"] = b"bad"
        if case == "invalid":
            record["quiz"] = "true"
        if case == "duration":
            record["duration"] = 0.2
        if case == "format":
            record["mime"] = "video/webm"
            new = media.replace(".mp4", ".webm")
            items[new] = items.pop(media)
            for ref in record["files"].values():
                ref["path"] = new
        if case == "color":
            colored = tmp_path / "colored.mp4"
            with encoder(colored, 64, 48) as stream:
                for _ in range(3):
                    stream.write(np.full((48, 64, 3), (255, 0, 0), np.uint8).tobytes())
            data = colored.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            new = f"media/{digest}.mp4"
            items.pop(media)
            items[new] = data
            for ref in record["files"].values():
                ref.update(path=new, sha256=digest, bytes=len(data))
        items["manifest.json"] = json.dumps(manifest).encode()

    bad = rewrite(archive, tmp_path / "bad.zip", change)
    original = (root / "saved" / value["id"] / "highlight.mp4").read_bytes()
    with pytest.raises((ValueError, KeyError, zipfile.BadZipFile)):
        import_archive(root, bad, threading.RLock())
    assert (root / "saved" / value["id"] / "highlight.mp4").read_bytes() == original
    assert len(list((root / "saved").iterdir())) == 1
    assert not (tmp_path / "escape").exists()


def test_collision_never_overwrites(tmp_path):
    root, value, archive = fixture(tmp_path)
    changed = copy.deepcopy(value)
    changed["player"]["name"] = "A newer label"
    (root / "saved" / value["id"] / "clip.json").write_text(json.dumps(changed))
    with pytest.raises(FileExistsError):
        import_archive(root, archive, threading.RLock())
    assert (
        json.loads((root / "saved" / value["id"] / "clip.json").read_text()) == changed
    )


def test_atomic_rollback_after_second_rename_fails(tmp_path, monkeypatch):
    root, value, archive = fixture(tmp_path)
    second = copy.deepcopy(value)
    second["id"] = str(uuid.uuid4())

    def change(items):
        manifest = json.loads(items["manifest.json"])
        manifest["clips"].append({**second, "files": manifest["clips"][0]["files"]})
        items["manifest.json"] = json.dumps(manifest).encode()

    source = rewrite(archive, tmp_path / "two.zip", change)
    original = Path.rename
    calls = []

    def fails(self, target):
        calls.append(1)
        if len(calls) == 2:
            raise OSError("disk full")
        return original(self, target)

    monkeypatch.setattr(Path, "rename", fails)
    target = tmp_path / "target"
    with pytest.raises(OSError, match="disk full"):
        import_archive(target, source, threading.RLock())
    assert not list((target / "saved").iterdir())


def test_api_export_restore_and_temporary_cleanup(tmp_path, monkeypatch):
    root, value, archive = fixture(tmp_path)
    monkeypatch.setattr(jumper, "ROOT", root)
    app = FastAPI()
    app.include_router(jumper.router)
    with TestClient(app) as client:
        response = client.get("/api/jumper-lab/backup")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        assert not list((root / "backup-temp").iterdir())
        client.delete("/api/jumper-lab/media/" + value["id"])
        restored = client.post(
            "/api/jumper-lab/backup",
            files={"file": ("library.zip", response.content, "application/zip")},
        )
        assert restored.json() == {"added": 1, "skipped": 0}
        assert client.get("/api/jumper-lab/media").json() == [value]
        assert (
            client.post(
                "/api/jumper-lab/backup",
                files={"file": ("bad.zip", b"broken", "application/zip")},
            ).status_code
            == 400
        )
        assert not list((root / "backup-temp").iterdir())


def test_legacy_status_is_preserved(tmp_path):
    root, value, archive = fixture(tmp_path, quiz=False)

    def change(items):
        manifest = json.loads(items["manifest.json"])
        del manifest["clips"][0]["presentation"]
        items["manifest.json"] = json.dumps(manifest).encode()

    source = rewrite(archive, tmp_path / "legacy.zip", change)
    target = tmp_path / "legacy"
    import_archive(target, source, threading.RLock())
    assert "presentation" not in json.loads(
        (target / "saved" / value["id"] / "clip.json").read_text()
    )
