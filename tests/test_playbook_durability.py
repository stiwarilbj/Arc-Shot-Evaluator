import errno
import json
import os
import stat

import pytest
from fastapi.testclient import TestClient

import backend.api.playbooks as api
from backend.api.app import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "PLAYBOOKS_DIR", tmp_path)
    return TestClient(app)


def payload(name="Durable drawing"):
    return {"name": name, "players": [], "defenders": [], "arrows": [], "ball": None}


def assert_uncertain(response, operation):
    assert response.status_code == 503
    assert response.headers["X-ARC-Playbook-Outcome"] == "uncertain"
    assert f"may have been {operation}" in response.json()["detail"]


def test_save_flushes_and_syncs_complete_json_before_replacing(client, tmp_path, monkeypatch):
    events = []
    fsync, replace, sync_directory = os.fsync, os.replace, api._sync_directory

    def sync(descriptor):
        if stat.S_ISREG(os.fstat(descriptor).st_mode):
            temporary, = tmp_path.glob(".playbook-*")
            assert temporary.read_bytes().endswith(b"\n")
            assert json.loads(temporary.read_text())["name"] == "Durable drawing"
            events.append("file")
        return fsync(descriptor)

    def replacing(source, destination):
        assert events == ["file"]
        events.append("replace")
        replace(source, destination)

    def directory(path):
        events.append("directory")
        sync_directory(path)

    monkeypatch.setattr(os, "fsync", sync)
    monkeypatch.setattr(os, "replace", replacing)
    monkeypatch.setattr(api, "_sync_directory", directory)
    response = client.post("/api/playbooks", json=payload())
    assert response.status_code == 200
    assert events == ["file", "replace", "directory"]
    assert not list(tmp_path.glob(".playbook-*"))


def test_file_sync_failure_preserves_previous_drawing_and_cleans_temporary(client, tmp_path, monkeypatch):
    saved = client.post("/api/playbooks", json=payload()).json()
    path = tmp_path / f"{saved['id']}.json"
    before = path.read_bytes()

    def failed_sync(_):
        raise OSError(errno.EIO, "Disk sync failed")

    def forbidden_replace(*_):
        pytest.fail("Unsynchronized bytes must not replace the drawing")

    monkeypatch.setattr(os, "fsync", failed_sync)
    monkeypatch.setattr(os, "replace", forbidden_replace)
    response = client.put(f"/api/playbooks/{saved['id']}", json=payload("New drawing"), headers={"If-Match": f'"{saved["revision"]}"'})
    assert response.status_code == 500
    assert "X-ARC-Playbook-Outcome" not in response.headers
    assert path.read_bytes() == before
    assert not list(tmp_path.glob(".playbook-*"))


def test_failed_directory_sync_after_update_is_explicitly_uncertain(client, tmp_path, monkeypatch):
    saved = client.post("/api/playbooks", json=payload()).json()

    def failed_sync(_):
        raise OSError(errno.EIO, "Directory sync failed")

    monkeypatch.setattr(api, "_sync_directory", failed_sync)
    response = client.put(f"/api/playbooks/{saved['id']}", json=payload("Possibly saved"), headers={"If-Match": f'"{saved["revision"]}"'})
    assert_uncertain(response, "saved")
    stored = client.get(f"/api/playbooks/{saved['id']}").json()
    assert stored["name"] == "Possibly saved"
    assert stored["revision"] != saved["revision"]
    assert not list(tmp_path.glob(".playbook-*"))


@pytest.mark.parametrize("moved", [False, True])
def test_replace_errors_preserve_uncertainty_even_if_replacement_completed(client, tmp_path, monkeypatch, moved):
    saved = client.post("/api/playbooks", json=payload()).json()
    replace = os.replace

    def failed_replace(source, destination):
        if moved:
            replace(source, destination)
        raise OSError(errno.EIO, "Ambiguous replace failure")

    monkeypatch.setattr(os, "replace", failed_replace)
    response = client.put(f"/api/playbooks/{saved['id']}", json=payload("Replacement"), headers={"If-Match": f'"{saved["revision"]}"'})
    assert_uncertain(response, "saved")
    assert client.get(f"/api/playbooks/{saved['id']}").json()["name"] == ("Replacement" if moved else saved["name"])
    assert not list(tmp_path.glob(".playbook-*"))


@pytest.mark.parametrize("retained", [False, True])
def test_delete_synchronizes_every_changed_directory(client, tmp_path, monkeypatch, retained):
    headers = {"X-ARC-Create-ID": "play-" + "a" * 32} if retained else {}
    saved = client.post("/api/playbooks", json=payload(), headers=headers).json()
    path = tmp_path / f"{saved['id']}.json"
    events = []
    sync_file, sync_directory = api._sync_file, api._sync_directory

    def file_sync(file):
        assert file == path and file.is_file()
        events.append("file")
        sync_file(file)

    def directory_sync(directory):
        assert not path.exists(), "directory barrier must follow deletion"
        events.append(directory.name if directory != tmp_path else "root")
        sync_directory(directory)

    monkeypatch.setattr(api, "_sync_file", file_sync)
    monkeypatch.setattr(api, "_sync_directory", directory_sync)
    response = client.delete(f"/api/playbooks/{saved['id']}")
    assert response.status_code == 200
    assert events == (["file", ".deleted", "root"] if retained else ["root"])
    assert (tmp_path / ".deleted" / path.name).is_file() == retained


@pytest.mark.parametrize("stage", ["unlink", "destination", "source"])
def test_post_delete_sync_failure_is_uncertain_and_preserves_receipts(client, tmp_path, monkeypatch, stage):
    headers = {"X-ARC-Create-ID": "play-" + "b" * 32} if stage != "unlink" else {}
    saved = client.post("/api/playbooks", json=payload(), headers=headers).json()
    path = tmp_path / f"{saved['id']}.json"
    before = path.read_bytes()
    sync_directory = api._sync_directory

    def failing_sync(directory):
        if stage == "destination" and directory.name != ".deleted":
            return sync_directory(directory)
        if stage == "source" and directory != tmp_path:
            return sync_directory(directory)
        raise OSError(errno.EIO, "Directory barrier failed")

    monkeypatch.setattr(api, "_sync_directory", failing_sync)
    assert_uncertain(client.delete(f"/api/playbooks/{saved['id']}"), "deleted")
    assert not path.exists()
    if stage != "unlink":
        tombstone = tmp_path / ".deleted" / path.name
        assert tombstone.read_bytes() == before
        assert_uncertain(client.post("/api/playbooks", json=payload(), headers=headers), "saved")
        monkeypatch.setattr(api, "_sync_directory", sync_directory)
        assert client.post("/api/playbooks", json=payload(), headers=headers).json() == saved
        assert tombstone.read_bytes() == before and not path.exists()


def test_receipt_sync_failure_leaves_deletion_unstarted(client, tmp_path, monkeypatch):
    headers = {"X-ARC-Create-ID": "play-" + "d" * 32}
    saved = client.post("/api/playbooks", json=payload(), headers=headers).json()
    path = tmp_path / f"{saved['id']}.json"
    before = path.read_bytes()

    def failed_sync(_):
        raise OSError(errno.EIO, "Receipt sync failed")

    monkeypatch.setattr(api, "_sync_file", failed_sync)
    response = client.delete(f"/api/playbooks/{saved['id']}")
    assert response.status_code == 500
    assert "X-ARC-Playbook-Outcome" not in response.headers
    assert path.read_bytes() == before
    assert not (tmp_path / ".deleted").exists()


def test_create_retry_rechecks_durability_without_duplicate_or_rewrite(client, tmp_path, monkeypatch):
    headers = {"X-ARC-Create-ID": "play-" + "c" * 32}
    sync_directory = api._sync_directory

    def failed_sync(_):
        raise OSError(errno.EIO, "Directory sync failed")

    monkeypatch.setattr(api, "_sync_directory", failed_sync)
    assert_uncertain(client.post("/api/playbooks", json=payload(), headers=headers), "saved")
    path, = tmp_path.glob("*.json")
    before = path.read_bytes()
    # Replaying a receipt must not bypass the failing barrier.
    assert_uncertain(client.post("/api/playbooks", json=payload(), headers=headers), "saved")
    monkeypatch.setattr(api, "_sync_directory", sync_directory)
    replay = client.post("/api/playbooks", json=payload(), headers=headers)
    assert replay.status_code == 200
    assert replay.json() == json.loads(before)["_creation"]["result"]
    assert path.read_bytes() == before and len(list(tmp_path.glob("*.json"))) == 1


@pytest.mark.skipif(os.name == "nt", reason="Directory fsync is unavailable through Python's Windows file API")
@pytest.mark.parametrize("error_number", [errno.EINVAL, errno.ENOTSUP, errno.ENOSYS, errno.EIO])
def test_directory_sync_skips_only_unsupported_operations_and_always_closes(tmp_path, monkeypatch, error_number):
    descriptors = []

    def failed_sync(descriptor):
        descriptors.append(descriptor)
        raise OSError(error_number, "Injected directory sync failure")

    monkeypatch.setattr(os, "fsync", failed_sync)
    if error_number == errno.EIO:
        with pytest.raises(OSError):
            api._sync_directory(tmp_path)
    else:
        api._sync_directory(tmp_path)
    assert len(descriptors) == 1
    with pytest.raises(OSError) as error:
        os.fstat(descriptors[0])
    assert error.value.errno == errno.EBADF
