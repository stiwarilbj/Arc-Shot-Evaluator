"""Crash/fault boundaries for immutable revisions and authoritative tombstones."""
import errno
import json

import pytest
from fastapi.testclient import TestClient

import backend.api.playbooks as api
from backend.api.app import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "PLAYBOOKS_DIR", tmp_path)
    return TestClient(app)


def payload(name="History fixture"):
    return {"name": name, "players": [], "defenders": [], "arrows": [], "ball": None}


def update(client, saved, name):
    return client.put(f"/api/playbooks/{saved['id']}", json=payload(name), headers={"If-Match": f'"{saved["revision"]}"'})


def test_history_integrity_retention_and_public_shape(client, tmp_path):
    saved = client.post("/api/playbooks", json=payload()).json()
    first = saved
    for index in range(14):
        response = update(client, saved, f"Revision {index}")
        assert response.status_code == 200
        saved = response.json()
        assert "_history" not in saved
    history = client.get(f"/api/playbooks/{saved['id']}/history").json()
    assert history["integrity"] == "verified" and history["deleted"] is False
    assert len(history["revisions"]) == api.HISTORY_LIMIT
    assert all(revision["valid"] for revision in history["revisions"])
    assert history["revisions"][-1]["document"] == saved
    assert history["revisions"][0]["revision"] != first["revision"]
    root = json.loads((tmp_path / f"{saved['id']}.json").read_text())
    assert root["_history"]["anchor"]
    assert len(list((tmp_path / ".revisions" / saved["id"]).glob("*.json"))) == api.HISTORY_LIMIT
    assert client.get("/api/playbooks").json() == [saved]


@pytest.mark.parametrize("stage", ["revision", "verification", "head-before", "head-after"])
def test_interrupted_update_never_promotes_an_orphan(client, tmp_path, monkeypatch, stage):
    saved = client.post("/api/playbooks", json=payload()).json()
    root = tmp_path / f"{saved['id']}.json"
    before = root.read_bytes()
    write, read_revision = api._write, api._read_revision

    def failing_write(path, value):
        if stage == "revision" and path.parent.name == saved["id"]:
            # Complete revision on disk, but fail before the commit head.
            write(path, value)
            raise api.HTTPException(503, "Interrupted revision")
        if path == root and stage in {"head-before", "head-after"}:
            if stage == "head-after":
                write(path, value)
            raise api._uncertain_file_operation("saved")
        write(path, value)

    def failing_verify(play_id, reference):
        value = read_revision(play_id, reference)
        if stage == "verification" and value["document"]["name"] == "Interrupted update":
            raise api.HTTPException(500, api.HISTORY_ERROR)
        return value

    monkeypatch.setattr(api, "_write", failing_write)
    monkeypatch.setattr(api, "_read_revision", failing_verify)
    response = update(client, saved, "Interrupted update")
    assert response.status_code in {500, 503}
    monkeypatch.setattr(api, "_write", write)
    monkeypatch.setattr(api, "_read_revision", read_revision)
    current = client.get(f"/api/playbooks/{saved['id']}").json()
    assert current["name"] == ("Interrupted update" if stage == "head-after" else saved["name"])
    if stage != "head-after":
        assert root.read_bytes() == before
        evidence = client.get(f"/api/playbooks/{saved['id']}/history").json()["revisions"]
        assert [entry for entry in evidence if entry["committed"]][-1]["revision"] == saved["revision"]
        assert any(entry["committed"] is False for entry in evidence), "orphan is explicitly uncommitted"
    # A later accepted save removes valid abandoned preparations, not the current
    # head or corrupt evidence. Retained history always describes commits only.
    newer = update(client, current, "Retry succeeded")
    assert newer.status_code == 200
    history = client.get(f"/api/playbooks/{saved['id']}/history").json()
    assert history["integrity"] == "verified"
    if stage != "head-after":
        assert not any(entry.get("document", {}).get("name") == "Interrupted update" for entry in history["revisions"])


def test_corrupt_revision_is_preserved_and_other_revisions_can_be_copied(client, tmp_path):
    first = client.post("/api/playbooks", json=payload("Original")).json()
    current = update(client, first, "Latest").json()
    revision = api._revision_path(current["id"], current["revision"])
    damaged = json.loads(revision.read_text())
    damaged["document"]["name"] = "A structurally valid but corrupt drawing"
    revision.write_text(json.dumps(damaged))
    bytes_before = revision.read_bytes()
    assert client.get(f"/api/playbooks/{current['id']}").status_code == 500
    listing = client.get("/api/playbooks")
    assert listing.headers["X-ARC-Playbook-Status"] == "partial"
    assert update(client, current, "Do not overwrite damage").status_code == 500
    history = client.get(f"/api/playbooks/{current['id']}/history").json()
    assert history["integrity"] == "damaged" and history["deleted"] is None
    assert [entry["valid"] for entry in history["revisions"]] == [True, False]
    copy = client.post("/api/playbooks", json=history["revisions"][0]["document"]).json()
    assert copy["id"] != current["id"] and copy["name"] == first["name"]
    assert revision.read_bytes() == bytes_before


@pytest.mark.parametrize("cleanup_interrupted", [False, True])
def test_tombstone_prevents_resurrection_even_with_old_head_present(client, tmp_path, monkeypatch, cleanup_interrupted):
    identity = "play-" + "a" * 32
    saved = client.post("/api/playbooks", json=payload(), headers={"X-ARC-Create-ID": identity}).json()
    delete = api._delete_file
    if cleanup_interrupted:
        def fail(*_, **__):
            raise api._uncertain_file_operation("deleted")
        monkeypatch.setattr(api, "_delete_file", fail)
    response = client.delete(f"/api/playbooks/{identity}")
    assert response.status_code == (503 if cleanup_interrupted else 200)
    monkeypatch.setattr(api, "_delete_file", delete)
    assert (tmp_path / f"{identity}.json").exists() is cleanup_interrupted
    assert client.get(f"/api/playbooks/{identity}").status_code == 404
    assert client.get("/api/playbooks").json() == []
    assert update(client, saved, "Must not resurrect").status_code == 404
    assert client.delete(f"/api/playbooks/{identity}").status_code == 200
    # A late creation retry replays the receipt, never restores the old head.
    assert client.post("/api/playbooks", json=payload(), headers={"X-ARC-Create-ID": identity}).json() == saved
    assert client.get("/api/playbooks").json() == []
    history = client.get(f"/api/playbooks/{identity}/history").json()
    assert history["deleted"] is True and history["revisions"][-1]["kind"] == "delete"


def test_quota_and_legacy_migration_failure_preserve_original(client, tmp_path, monkeypatch):
    legacy = {**payload("Legacy"), "version": 1, "id": "play-history-legacy"}
    root = tmp_path / f"{legacy['id']}.json"
    root.write_text(json.dumps(legacy))
    before = root.read_bytes()
    write = api._write

    def disk_full(path, value):
        if path.parent.name == legacy["id"]:
            raise api.HTTPException(500, "Playbook could not be saved")
        write(path, value)

    monkeypatch.setattr(api, "_write", disk_full)
    failed = client.put(f"/api/playbooks/{legacy['id']}", json=legacy, headers={"If-Match": '"legacy"'})
    assert failed.status_code == 500 and root.read_bytes() == before
    monkeypatch.setattr(api, "_write", write)
    saved = client.put(f"/api/playbooks/{legacy['id']}", json=legacy, headers={"If-Match": '"legacy"'})
    assert saved.status_code == 200
    assert len(client.get(f"/api/playbooks/{legacy['id']}/history").json()["revisions"]) == 2


def test_uncertain_head_requires_durability_confirmation_on_read(client, tmp_path, monkeypatch):
    saved = client.post("/api/playbooks", json=payload()).json()
    sync = api._sync_directory

    def root_failure(path):
        if path == tmp_path:
            raise OSError(errno.EIO, "Directory barrier failed")
        sync(path)

    monkeypatch.setattr(api, "_sync_directory", root_failure)
    response = update(client, saved, "Not acknowledged")
    assert response.status_code == 503
    assert client.get(f"/api/playbooks/{saved['id']}").status_code == 503
    monkeypatch.setattr(api, "_sync_directory", sync)
    assert client.get(f"/api/playbooks/{saved['id']}").status_code == 200


def test_history_does_not_accept_broken_parent_or_head_checksums(client, tmp_path):
    first = client.post("/api/playbooks", json=payload()).json()
    saved = update(client, first, "Second").json()
    root = tmp_path / f"{saved['id']}.json"
    record = json.loads(root.read_text())
    record["_history"]["entries"].reverse()
    root.write_text(json.dumps(record))
    before = root.read_bytes()
    assert client.get(f"/api/playbooks/{saved['id']}").status_code == 500
    recovery = client.get(f"/api/playbooks/{saved['id']}/history").json()
    assert recovery["integrity"] == "damaged" and all(entry["valid"] for entry in recovery["revisions"])
    assert update(client, saved, "No replacement").status_code == 500
    assert root.read_bytes() == before


def test_unreadable_head_retains_independent_recovery_and_never_loads_it(client, tmp_path):
    saved = client.post("/api/playbooks", json=payload()).json()
    root = tmp_path / f"{saved['id']}.json"
    root.write_bytes(b'{broken head')
    assert client.get(f"/api/playbooks/{saved['id']}").status_code == 500
    history = client.get(f"/api/playbooks/{saved['id']}/history").json()
    assert history["integrity"] == "damaged" and history["deleted"] is None
    assert history["revisions"][0]["valid"] is True
    assert history["revisions"][0]["committed"] is None
    assert root.read_bytes() == b'{broken head'


def test_missing_revision_is_integrity_failure_not_an_empty_library(client, tmp_path):
    saved = client.post("/api/playbooks", json=payload()).json()
    api._revision_path(saved["id"], saved["revision"]).unlink()
    assert client.get(f"/api/playbooks/{saved['id']}").status_code == 500
    history = client.get(f"/api/playbooks/{saved['id']}/history").json()
    assert history["integrity"] == "damaged" and not history["revisions"][0]["valid"]
    assert history["revisions"][0]["committed"] is True


def test_retention_preserves_misnamed_and_corrupt_records(client, tmp_path):
    saved = client.post("/api/playbooks", json=payload()).json()
    directory = tmp_path / ".revisions" / saved["id"]
    source = api._revision_path(saved["id"], saved["revision"])
    misnamed = directory / ("e" * 32 + ".json")
    misnamed.write_bytes(source.read_bytes())
    corrupt = directory / ("f" * 32 + ".json")
    corrupt.write_bytes(b"broken revision")
    for index in range(10):
        saved = update(client, saved, f"Retained {index}").json()
    assert misnamed.is_file() and corrupt.read_bytes() == b"broken revision"
    history = client.get(f"/api/playbooks/{saved['id']}/history").json()
    assert history["integrity"] == "verified"
    assert len([entry for entry in history["revisions"] if entry["committed"]]) == api.HISTORY_LIMIT
    assert len([entry for entry in history["revisions"] if not entry["valid"]]) == 2
