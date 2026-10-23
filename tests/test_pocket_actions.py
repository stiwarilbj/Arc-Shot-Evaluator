from __future__ import annotations

import copy
import json

import pytest
from fastapi.testclient import TestClient

import backend.api.pocket_actions as api
from backend.api.app import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "POCKET_ACTIONS_DIR", tmp_path)
    return TestClient(app)


def pocket_document(name="Give and go"):
    return {
        "version": 1,
        "id": "pocket-give-and-go",
        "revision": "revision-original",
        "name": name,
        "createdAt": "2026-10-22T12:00:00.000Z",
        "updatedAt": "2026-10-22T12:00:00.000Z",
        "roles": [
            {"id": "role-handler", "label": "Ball handler", "entry": {"x": 50, "y": 77}, "sourcePlayerId": 1},
            {"id": "role-wing", "label": "Wing receiver", "entry": {"x": 25, "y": 56}, "sourcePlayerId": 2},
        ],
        "requiredBallRole": "role-handler",
        "actions": [
            {
                "id": "pact-entry-pass",
                "arrow": {"id": "pact-entry-pass", "kind": "pass", "start": {"x": 50, "y": 77}, "end": {"x": 25, "y": 56}, "sequence": 1, "path": "straight", "timing": 0.9},
                "participants": {"actor": "role-handler", "recipient": "role-wing"},
                "startAtMs": 0,
                "durationMs": 900,
                "waits": [],
            },
            {
                "id": "pact-cut",
                "arrow": {"id": "pact-cut", "kind": "movement", "start": {"x": 50, "y": 77}, "control": {"x": 42, "y": 60}, "end": {"x": 52, "y": 44}, "sequence": 2, "path": "curve", "timing": 1.2},
                "participants": {"actor": "role-handler"},
                "startAtMs": 900,
                "durationMs": 1200,
                "waits": [{"id": "wait-entry-catch", "sourceAction": "pact-entry-pass", "event": "catch"}],
            },
        ],
    }


def test_create_read_update_and_delete_round_trip_with_revisions(client, tmp_path):
    created = client.post("/api/pocket-actions", json=pocket_document())
    assert created.status_code == 201
    saved = created.json()
    assert saved["revision"] != "revision-original"
    assert client.get("/api/pocket-actions").json() == [saved]
    assert client.get(f"/api/pocket-actions/{saved['id']}").json() == saved

    retry = pocket_document()
    retry["createdAt"] = "2026-10-23T00:00:00Z"
    assert client.post("/api/pocket-actions", json=retry).json() == saved
    assert len(list(tmp_path.glob("pocket-*.json"))) == 1

    changed = copy.deepcopy(saved)
    changed["name"] = "Give and go · edited"
    updated = client.put(f"/api/pocket-actions/{saved['id']}", json=changed, headers={"If-Match": f'"{saved["revision"]}"'})
    assert updated.status_code == 200
    assert updated.json()["name"] == changed["name"]
    assert updated.json()["revision"] != saved["revision"]

    stale = client.put(f"/api/pocket-actions/{saved['id']}", json=saved, headers={"If-Match": f'"{saved["revision"]}"'})
    assert stale.status_code == 409
    assert client.get(f"/api/pocket-actions/{saved['id']}").json() == updated.json()
    assert client.delete(f"/api/pocket-actions/{saved['id']}").json() == {"deleted": True, "id": saved["id"]}
    assert client.get(f"/api/pocket-actions/{saved['id']}").status_code == 404


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value["roles"].append({"id": "role-bad", "label": "Bad", "entry": {"x": 101, "y": 20}}),
        lambda value: value["actions"][1]["participants"].update(actor="role-missing"),
        lambda value: value["actions"][1]["waits"][0].update(sourceAction=["invalid"]),
        lambda value: value["actions"][1]["waits"][0].update(event=[]),
        lambda value: value["actions"][1]["waits"][0].update(event="cycle"),
        lambda value: value["actions"][0]["arrow"].update(end={"x": float("nan"), "y": 20}),
        lambda value: value["actions"][1]["arrow"].pop("control"),
        lambda value: value.update(unused="extra"),
        lambda value: value.update(createdAt="not a date"),
    ],
)
def test_invalid_documents_are_rejected_without_overwriting(client, tmp_path, change):
    created = client.post("/api/pocket-actions", json=pocket_document())
    assert created.status_code == 201
    before = (tmp_path / "pocket-give-and-go.json").read_bytes()
    invalid = pocket_document()
    change(invalid)
    response = client.put(
        "/api/pocket-actions/pocket-give-and-go",
        content=json.dumps(invalid, allow_nan=True),
        headers={"If-Match": f'"{created.json()["revision"]}"'},
    )
    assert response.status_code == 400
    assert (tmp_path / "pocket-give-and-go.json").read_bytes() == before


def test_unbounded_body_and_unknown_identity_are_rejected(client, tmp_path):
    too_large = b'{"unused":"' + b"x" * api.MAX_BYTES + b'"}'
    assert client.post("/api/pocket-actions", content=too_large).status_code == 413
    assert client.get("/api/pocket-actions/not-an-id").status_code == 400
    assert not list(tmp_path.glob("pocket-*.json"))


def test_invalid_revision_and_wrong_update_identity_preserve_document(client, tmp_path):
    created = client.post("/api/pocket-actions", json=pocket_document())
    saved = created.json()
    path = tmp_path / f"{saved['id']}.json"
    before = path.read_bytes()
    changed = copy.deepcopy(saved)
    changed["name"] = "Should not win"
    assert client.put(f"/api/pocket-actions/{saved['id']}", json=changed, headers={"If-Match": '"wrong"'}).status_code == 409
    changed["id"] = "pocket-another-identity"
    assert client.put(f"/api/pocket-actions/{saved['id']}", json=changed, headers={"If-Match": f'"{saved["revision"]}"'}).status_code == 400
    assert path.read_bytes() == before


def test_cycles_and_conflicting_pinned_owners_are_rejected(client):
    cycle = pocket_document()
    cycle["actions"][0]["waits"] = [{"id": "wait-cycle-a", "sourceAction": "pact-cut", "event": "complete"}]
    cycle["actions"][1]["waits"][0]["event"] = "catch"
    assert client.post("/api/pocket-actions", json=cycle).status_code == 400

    conflict = pocket_document()
    conflict["actions"][1]["syncGroup"] = "sync-test"
    conflict["actions"].append({
        "id": "pact-conflict",
        "arrow": {"id": "pact-conflict", "kind": "movement", "start": {"x": 50, "y": 77}, "end": {"x": 40, "y": 60}, "sequence": 2, "path": "straight", "timing": 1},
        "participants": {"actor": "role-handler"}, "startAtMs": 900, "durationMs": 1000, "syncGroup": "sync-test", "waits": [],
    })
    assert client.post("/api/pocket-actions", json=conflict).status_code == 400


def test_unreadable_library_entry_is_reported_and_preserved(client, tmp_path):
    broken = tmp_path / "pocket-broken-entry.json"
    broken.write_text("{ damaged", encoding="utf-8")
    response = client.get("/api/pocket-actions")
    assert response.status_code == 503
    assert broken.read_text(encoding="utf-8") == "{ damaged"
