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
        "arrows": [
            {"id": "arrow-one", "kind": "movement", "sequence": 2, "path": "curve", "control": {"x": 54, "y": 62}, "timing": 1.7, "start": {"x": 50, "y": 70}, "end": {"x": 50, "y": 55}},
            {"id": "arrow-two", "kind": "handoff", "sequence": 1, "path": "straight", "timing": 0.9, "start": {"x": 50, "y": 70}, "end": {"x": 29, "y": 56}},
        ],
    }


def test_playbook_crud_is_local_and_versioned(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)

    created = client.post("/api/playbooks", json=_payload())
    assert created.status_code == 200
    value = created.json()
    assert value["version"] == 1
    assert value["id"].startswith("play-")
    assert value["arrows"][0]["sequence"] == 2
    assert value["arrows"][0]["path"] == "curve"
    assert value["arrows"][0]["timing"] == 1.7
    assert value["arrows"][0]["control"] == {"x": 54.0, "y": 62.0}
    assert value["arrows"][1]["kind"] == "handoff"
    assert value["arrows"][1]["sequence"] == 1
    assert value["arrows"][1]["timing"] == 0.9
    assert json.loads((tmp_path / f"{value['id']}.json").read_text())["name"] == "Pick and roll"

    reopened = client.get(f"/api/playbooks/{value['id']}")
    assert reopened.status_code == 200
    assert reopened.json()["arrows"] == value["arrows"]

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


def test_player_skill_ratings_default_validate_and_round_trip(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Player ratings")
    payload["players"] = [{"id": 1, "x": 50, "y": 70, "ratings": {"threePoint": 5, "midrange": 2, "finishing": 4}}]
    created = client.post("/api/playbooks", json=payload)
    assert created.status_code == 200
    play = created.json()
    assert play["players"][0]["ratings"] == {"threePoint": 5, "midrange": 2, "finishing": 4}
    assert client.get(f"/api/playbooks/{play['id']}").json()["players"][0]["ratings"] == play["players"][0]["ratings"]
    payload["players"][0]["badges"] = ["playmaker", "deep-range", "roll-threat"]
    with_badges = client.post("/api/playbooks", json=payload).json()
    assert with_badges["players"][0]["badges"] == ["playmaker", "deep-range", "roll-threat"]
    assert client.get(f"/api/playbooks/{with_badges['id']}").json()["players"][0]["badges"] == with_badges["players"][0]["badges"]

    legacy = _payload("Legacy defaults")
    legacy["players"] = [{"id": 1, "x": 50, "y": 70}]
    saved_legacy = client.post("/api/playbooks", json=legacy).json()
    assert saved_legacy["players"][0]["ratings"] == {"threePoint": 3, "midrange": 3, "finishing": 3}
    assert saved_legacy["players"][0]["badges"] == []

    for invalid_rating in (0, 6, 3.5, True, "4"):
        invalid = _payload("Invalid rating")
        invalid["players"] = [{"id": 1, "x": 50, "y": 70, "ratings": {"threePoint": invalid_rating}}]
        assert client.post("/api/playbooks", json=invalid).status_code == 400


def test_player_badges_reject_unknown_duplicate_or_malformed_values(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    for badges in ("playmaker", ["not-a-badge"], ["playmaker", "playmaker"], [1], None):
        payload = _payload("Invalid badges")
        payload["players"] = [{"id": 1, "x": 50, "y": 70, "badges": badges}]
        assert client.post("/api/playbooks", json=payload).status_code == 400


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


def test_off_ball_screen_stores_distinct_player_references(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    payload = _payload()
    payload["players"] = [{"id": 1, "x": 50, "y": 70}, {"id": 2, "x": 34, "y": 58}]
    payload["arrows"] = [{
        "id": "offball-screen",
        "kind": "off-ball-screen",
        "sequence": 1,
        "start": {"x": 34, "y": 58},
        "end": {"x": 42, "y": 54},
        "screener_id": 2,
        "cutter_id": 1,
    }]
    client = TestClient(app)
    created = client.post("/api/playbooks", json=payload)
    assert created.status_code == 200
    arrow = created.json()["arrows"][0]
    assert arrow["kind"] == "off-ball-screen"
    assert arrow["screener_id"] == 2
    assert arrow["cutter_id"] == 1

    payload["arrows"][0]["cutter_id"] = 99
    assert client.post("/api/playbooks", json=payload).status_code == 400
    payload["arrows"][0]["cutter_id"] = 2
    assert client.post("/api/playbooks", json=payload).status_code == 400


def test_new_screen_and_cut_actions_round_trip_in_version_one(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    payload = _payload("New action types")
    payload["players"] = [
        {"id": 1, "x": 50, "y": 70},
        {"id": 2, "x": 38, "y": 62},
        {"id": 3, "x": 27, "y": 55},
    ]
    payload["arrows"] = [
        {
            "id": "saved-pick-pop",
            "kind": "pick-pop",
            "sequence": 1,
            "start": {"x": 38, "y": 62},
            "end": {"x": 44, "y": 66},
            "screener_id": 2,
            "handler_id": 1,
            "exit_target": {"x": 55, "y": 57},
        },
        {
            "id": "saved-screen",
            "kind": "screen",
            "sequence": 2,
            "start": {"x": 38, "y": 62},
            "end": {"x": 44, "y": 66},
            "screener_id": 2,
            "handler_id": 1,
        },
        {
            "id": "saved-pick-roll",
            "kind": "pick-roll",
            "sequence": 3,
            "start": {"x": 38, "y": 62},
            "end": {"x": 44, "y": 66},
            "screener_id": 2,
            "handler_id": 1,
        },
        {
            "id": "saved-pin-down",
            "kind": "pin-down",
            "sequence": 4,
            "start": {"x": 38, "y": 62},
            "end": {"x": 34, "y": 58},
            "screener_id": 2,
            "cutter_id": 3,
            "exit_target": {"x": 30, "y": 49},
        },
        {
            "id": "saved-backdoor",
            "kind": "backdoor-cut",
            "sequence": 5,
            "start": {"x": 27, "y": 55},
            "end": {"x": 49, "y": 20},
            "actor_id": 3,
        },
    ]
    client = TestClient(app)
    created = client.post("/api/playbooks", json=payload)
    assert created.status_code == 200
    value = created.json()
    assert value["version"] == 1
    assert value["arrows"][0]["screener_id"] == 2
    assert value["arrows"][0]["handler_id"] == 1
    assert value["arrows"][0]["exit_target"] == {"x": 55.0, "y": 57.0}
    assert value["arrows"][1]["screener_id"] == 2
    assert value["arrows"][1]["handler_id"] == 1
    assert value["arrows"][2]["screener_id"] == 2
    assert value["arrows"][2]["handler_id"] == 1
    assert value["arrows"][3]["cutter_id"] == 3
    assert value["arrows"][3]["exit_target"] == {"x": 30.0, "y": 49.0}
    assert value["arrows"][4]["actor_id"] == 3
    reopened = client.get(f"/api/playbooks/{value['id']}")
    assert reopened.status_code == 200
    assert reopened.json()["arrows"] == value["arrows"]


def test_new_action_validation_and_legacy_v1_play_reads(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Invalid new action")
    payload["players"] = [{"id": 1, "x": 50, "y": 70}, {"id": 2, "x": 35, "y": 60}]
    payload["arrows"] = [{
        "id": "bad-pin-down",
        "kind": "pin-down",
        "sequence": 1,
        "start": {"x": 35, "y": 60},
        "end": {"x": 40, "y": 64},
        "screener_id": 2,
        "cutter_id": 1,
    }]
    assert client.post("/api/playbooks", json=payload).status_code == 400
    payload["arrows"][0]["kind"] = "pick-pop"
    payload["arrows"][0].pop("cutter_id")
    payload["arrows"][0]["screener_id"] = 2
    payload["arrows"][0]["handler_id"] = 1
    payload["arrows"][0]["exit_target"] = {"x": 110, "y": 64}
    assert client.post("/api/playbooks", json=payload).status_code == 400
    payload["arrows"][0]["exit_target"] = {"x": 50, "y": 60}
    assert client.post("/api/playbooks", json=payload).status_code == 200
    payload["arrows"][0].pop("screener_id")
    assert client.post("/api/playbooks", json=payload).status_code == 400
    payload["arrows"][0]["screener_id"] = 2
    payload["arrows"][0].pop("handler_id")
    assert client.post("/api/playbooks", json=payload).status_code == 400

    # Version 1 diagrams saved before participant IDs remain readable as-is.
    old_play = {
        "version": 1,
        "id": "play-oldversion1",
        "name": "Old screen play",
        "created_at": "2024-01-01T00:00:00+0000",
        "updated_at": "2024-01-01T00:00:00+0000",
        "defenders_visible": False,
        "players": [{"id": 1, "x": 50, "y": 70}, {"id": 2, "x": 40, "y": 62}],
        "defenders": [],
        "ball": {"x": 50, "y": 70},
        "arrows": [{"id": "old-screen", "kind": "screen", "sequence": 1, "start": {"x": 40, "y": 62}, "end": {"x": 45, "y": 67}}],
    }
    (tmp_path / "play-oldversion1.json").write_text(json.dumps(old_play))
    response = client.get("/api/playbooks/play-oldversion1")
    assert response.status_code == 200
    assert response.json() == old_play


def test_corrupt_saved_play_is_skipped_from_library(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    (tmp_path / "broken.json").write_text("not json")
    response = TestClient(app).get("/api/playbooks")
    assert response.status_code == 200
    assert response.json() == []
