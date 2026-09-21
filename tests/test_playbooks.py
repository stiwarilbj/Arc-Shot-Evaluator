import json

from fastapi.testclient import TestClient

import backend.api.playbooks as playbooks_module
from backend.api.app import app


def _payload(name: str = "Pick and roll") -> dict:
    return {
        "name": name,
        "defenders_visible": True,
        "players": [{"id": 1, "x": 50, "y": 70}],
        "defenders": [{"id": 1, "x": 55, "y": 60}],
        "ball": {"x": 50, "y": 70},
        "arrows": [{"id": "arrow-one", "kind": "movement", "path": "curve", "control": {"x": 54, "y": 62}, "timing": 1.7, "start": {"x": 50, "y": 70}, "end": {"x": 50, "y": 55}}],
    }


def test_playbook_crud_is_local_and_versioned(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)

    created = client.post("/api/playbooks", json=_payload())
    assert created.status_code == 200
    value = created.json()
    assert value["version"] == 1
    assert value["id"].startswith("play-")
    assert value["arrows"][0]["sequence"] == 1
    assert value["arrows"][0]["path"] == "curve"
    assert value["arrows"][0]["timing"] == 1.7
    assert json.loads((tmp_path / f"{value['id']}.json").read_text())["name"] == "Pick and roll"

    listed = client.get("/api/playbooks")
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == value["id"]

    updated = client.put(f"/api/playbooks/{value['id']}", json=_payload("Updated play"))
    assert updated.status_code == 200
    assert updated.json()["name"] == "Updated play"
    assert updated.json()["created_at"] == value["created_at"]

    deleted = client.delete(f"/api/playbooks/{value['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/playbooks/{value['id']}").status_code == 404


def test_playbook_rejects_out_of_bounds_or_duplicate_markers(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)

    invalid = _payload()
    invalid["players"] = [{"id": 1, "x": 101, "y": 50}]
    assert client.post("/api/playbooks", json=invalid).status_code == 400

    duplicate = _payload()
    duplicate["players"] = [{"id": 1, "x": 30, "y": 50}, {"id": 1, "x": 60, "y": 50}]
    assert client.post("/api/playbooks", json=duplicate).status_code == 400

    invalid_sequence = _payload()
    invalid_sequence["arrows"][0]["sequence"] = 0
    assert client.post("/api/playbooks", json=invalid_sequence).status_code == 400


def test_corrupt_saved_play_is_skipped_from_library(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    (tmp_path / "broken.json").write_text("not json")
    response = TestClient(app).get("/api/playbooks")
    assert response.status_code == 200
    assert response.json() == []
