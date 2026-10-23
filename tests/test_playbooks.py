import json

from fastapi.testclient import TestClient

import backend.api.playbooks as playbooks_module
from backend.api.app import app


def _match(play):
    return f'"{play.get("revision", "legacy")}"'


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

    updated = client.put(f"/api/playbooks/{value['id']}", json=_payload("Updated play"), headers={"If-Match": _match(value)})
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


def test_defender_badges_default_validate_and_round_trip(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Defender badges")
    payload["defenders"] = [{"id": 1, "x": 55, "y": 60, "badges": ["lockdown", "helper"]}]
    created = client.post("/api/playbooks", json=payload)
    assert created.status_code == 200
    play = created.json()
    assert play["defenders"][0]["badges"] == ["lockdown", "helper"]
    assert client.get(f"/api/playbooks/{play['id']}").json()["defenders"][0]["badges"] == ["lockdown", "helper"]

    legacy = _payload("Legacy defenders")
    legacy["defenders"] = [{"id": 1, "x": 55, "y": 60}]
    saved_legacy = client.post("/api/playbooks", json=legacy).json()
    assert saved_legacy["defenders"][0]["badges"] == []

    for badges in ("helper", ["not-a-defender-badge"], ["lockdown", "lockdown"], [1], None, ["playmaker"]):
        invalid = _payload("Invalid defender badges")
        invalid["defenders"] = [{"id": 1, "x": 55, "y": 60, "badges": badges}]
        assert client.post("/api/playbooks", json=invalid).status_code == 400


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
        {
            "id": "saved-slip-screen",
            "kind": "slip-screen",
            "sequence": 6,
            "start": {"x": 38, "y": 62},
            "end": {"x": 44, "y": 66},
            "screener_id": 2,
            "handler_id": 1,
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
    assert value["arrows"][5]["kind"] == "slip-screen"
    assert value["arrows"][5]["screener_id"] == 2
    assert value["arrows"][5]["handler_id"] == 1
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


def test_partial_library_classifies_invalid_and_unavailable_files_and_recovers(tmp_path, monkeypatch):
    from pathlib import Path

    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    saved = [client.post("/api/playbooks", json=_payload(f"Play {index}")).json() for index in range(4)]
    complete = client.get("/api/playbooks")
    assert complete.headers["X-ARC-Playbook-Status"] == "complete"
    assert "X-ARC-Playbook-Warnings" not in complete.headers
    bad = tmp_path / f"{saved[-1]['id']}.json"
    original = bad.read_bytes()
    open_file = Path.open
    for problem in ("invalid-json", "invalid-document", "invalid-encoding", "unavailable"):
        bad.write_bytes(original)
        if problem == "invalid-json":
            bad.write_text("{broken JSON")
        elif problem == "invalid-document":
            bad.write_text(json.dumps({**saved[-1], "players": "invalid roster"}))
        elif problem == "invalid-encoding":
            bad.write_bytes(b"\xff\xfeinvalid")
        before = {path.name: path.read_bytes() for path in tmp_path.glob("*.json")}
        with monkeypatch.context() as patch:
            if problem == "unavailable":
                def unavailable(path, *args, **kwargs):
                    if path == bad:
                        raise PermissionError("Temporarily unavailable")
                    return open_file(path, *args, **kwargs)
                patch.setattr(Path, "open", unavailable)
            response = client.get("/api/playbooks")
            assert response.status_code == 200
            assert {play["id"] for play in response.json()} == {play["id"] for play in saved[:-1]}
            assert response.headers["X-ARC-Playbook-Status"] == "partial"
            assert response.headers["X-ARC-Playbook-Warnings"] == bad.name
            assert json.loads(response.headers["X-ARC-Playbook-Issues"]) == [{
                "file": bad.name, "kind": "unavailable" if problem == "unavailable" else "invalid",
            }]
            assert client.get(f"/api/playbooks/{saved[-1]['id']}").status_code == (503 if problem == "unavailable" else 500)
        assert {path.name: path.read_bytes() for path in tmp_path.glob("*.json")} == before
    bad.write_bytes(original)
    recovered = client.get("/api/playbooks")
    assert recovered.headers["X-ARC-Playbook-Status"] == "complete"
    assert "X-ARC-Playbook-Issues" not in recovered.headers
    assert recovered.json() == complete.json()


def test_library_storage_failures_never_look_like_an_empty_complete_library(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from pathlib import Path
    from fastapi import HTTPException

    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    saved = [client.post("/api/playbooks", json=_payload(f"Play {index}")).json() for index in range(3)]
    before = {path.name: path.read_bytes() for path in tmp_path.glob("*.json")}
    original_lock = playbooks_module._playbook_lock

    @contextmanager
    def failing_lock(path):
        if path.stem == saved[-1]["id"]:
            raise HTTPException(503, "Storage busy")
        with original_lock(path):
            yield

    with monkeypatch.context() as patch:
        patch.setattr(playbooks_module, "_playbook_lock", failing_lock)
        response = client.get("/api/playbooks")
        assert response.headers["X-ARC-Playbook-Status"] == "partial"
        assert len(response.json()) == 2
        assert json.loads(response.headers["X-ARC-Playbook-Issues"])[0]["kind"] == "unavailable"

    original_iterdir = Path.iterdir

    def unavailable_directory(path):
        if path == tmp_path:
            raise OSError("Storage disconnected")
        return original_iterdir(path)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "iterdir", unavailable_directory)
        response = client.get("/api/playbooks")
        assert response.status_code == 503
        assert "temporarily unavailable" in response.json()["detail"]
    assert {path.name: path.read_bytes() for path in tmp_path.glob("*.json")} == before


def test_explicit_action_participants_round_trip_without_version_migration(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Explicit participants")
    payload["players"].append({"id": 2, "x": 28, "y": 55})
    payload["arrows"][0]["actor_id"] = 1
    payload["arrows"][1].update({"actor_id": 1, "recipient_id": 2})
    response = client.post("/api/playbooks", json=payload)
    assert response.status_code == 200
    saved = response.json()
    assert saved["version"] == 1
    assert saved["arrows"][0]["actor_id"] == 1
    assert saved["arrows"][1]["recipient_id"] == 2
    assert client.get(f"/api/playbooks/{saved['id']}").json()["arrows"] == saved["arrows"]
    for field, value in [("actor_id", 99), ("recipient_id", 99), ("recipient_id", 1), ("actor_id", True)]:
        invalid = json.loads(json.dumps(payload))
        invalid["arrows"][1][field] = value
        assert client.post("/api/playbooks", json=invalid).status_code == 400


def test_shared_document_validation_contract(tmp_path, monkeypatch) -> None:
    from pathlib import Path
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    examples = json.loads((Path(__file__).parent / "fixtures/playbook-documents.json").read_text())
    client = TestClient(app)
    for example in examples:
        response = client.post("/api/playbooks", json=example["document"])
        assert response.status_code == (200 if example["valid"] else 400), example["name"]
        if example["valid"]:
            saved = response.json()
            assert client.put(f"/api/playbooks/{saved['id']}", json=example["document"], headers={"If-Match": _match(saved)}).status_code == 200
            assert client.get(f"/api/playbooks/{saved['id']}").status_code == 200


def test_nonfinite_coordinates_and_damaged_stored_documents(tmp_path, monkeypatch) -> None:
    import pytest
    from fastapi import HTTPException
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    for coordinate in (float("nan"), float("inf"), float("-inf"), True):
        payload = _payload()
        payload["players"][0]["x"] = coordinate
        with pytest.raises(HTTPException) as error:
            playbooks_module._document(payload, playbook_id="play-invalid01")
        assert error.value.status_code == 400
    payload = _payload()
    payload.update(id="play-damaged01", version=1)
    payload["players"][0]["badges"] = ["unknown"]
    path = tmp_path / "play-damaged01.json"
    original = json.dumps(payload)
    path.write_text(original)
    client = TestClient(app)
    assert client.get("/api/playbooks/play-damaged01").status_code == 500
    assert client.get("/api/playbooks").json() == []
    assert path.read_text() == original


def test_shared_persistence_precision(tmp_path, monkeypatch) -> None:
    from pathlib import Path
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    examples = json.loads((Path(__file__).parent / "fixtures/playbook-precision.json").read_text())
    for example in examples:
        if example["field"] == "coordinate":
            point = playbooks_module._point({"x": example["value"], "y": example["value"]}, "Shared coordinate")
            assert point == {"x": example["expected"], "y": example["expected"]}
        else:
            payload = _payload()
            payload["arrows"][0]["timing"] = example["value"]
            saved = playbooks_module._document(payload, playbook_id="play-precision")
            assert saved["arrows"][0]["timing"] == example["expected"]
    payload = _payload()
    payload["players"][0].update(x=12.3456789, y=99.99995)
    payload["defenders"][0].update(x=1.23445, y=1.23455)
    payload["ball"] = {"x": 2.675, "y": 0.00015}
    payload["arrows"][0].update(start={"x": 12.3456789, "y": 1.23445}, end={"x": 1.23455, "y": 99.99995}, control={"x": .00005, "y": .00015}, exit_target={"x": 12.3456789, "y": 1.23445}, timing=2.675)
    # Required exit targets also go through the same four-decimal point policy.
    payload["arrows"][0].update(kind="pick-pop", screener_id=1, handler_id=2)
    payload["players"].append({"id": 2, "x": 35.1234567, "y": 60.7654321})
    client = TestClient(app)
    saved = client.post("/api/playbooks", json=payload).json()
    assert saved["players"][0]["x"] == 12.3457
    assert saved["arrows"][0]["exit_target"]["x"] == 12.3457
    assert saved["arrows"][0]["timing"] == 2.67
    for _ in range(5):
        reopened = client.get(f"/api/playbooks/{saved['id']}").json()
        updated = client.put(f"/api/playbooks/{saved['id']}", json=reopened, headers={"If-Match": _match(reopened)}).json()
        for field in ("players", "defenders", "ball", "arrows"):
            assert updated[field] == saved[field]


def _hold_playbook_lock(path, entered, release):
    # Top-level target so Windows/macOS spawn tests use a separate interpreter.
    with playbooks_module._playbook_lock(path):
        entered.set()
        if not release.wait(10):
            raise TimeoutError("Lock test did not release")


def _attempt_contended_playbook_update(directory, saved, outcome):
    # A separate server interpreter must time out while the holder is still alive.
    playbooks_module.PLAYBOOKS_DIR = directory
    playbooks_module.PLAYBOOK_LOCK_TIMEOUT_SECONDS = 0.2
    response = TestClient(app).put(f"/api/playbooks/{saved['id']}", json=_payload("Expired update"), headers={"If-Match": _match(saved)})
    outcome.put({"status": response.status_code, "body": response.json()})


def test_expired_lock_waiter_in_separate_server_process_never_updates_later(tmp_path, monkeypatch):
    import multiprocessing

    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    saved = playbooks_module.create_playbook(_payload("Original drawing"))
    path = tmp_path / f"{saved['id']}.json"
    before = path.read_bytes()
    context = multiprocessing.get_context("spawn")
    entered, release, outcome = context.Event(), context.Event(), context.Queue()
    holder = context.Process(target=_hold_playbook_lock, args=(path, entered, release))
    waiter = context.Process(target=_attempt_contended_playbook_update, args=(tmp_path, saved, outcome))
    holder.start()
    try:
        assert entered.wait(10)
        waiter.start()
        result = outcome.get(timeout=8)
        assert result["status"] == 503
        assert result["body"]["detail"] == "Playbook storage is busy or unavailable; retry"
        waiter.join(timeout=3)
        assert waiter.exitcode == 0, "expired request finishes before the holder releases"
        assert path.read_bytes() == before
    finally:
        release.set()
        for process in (holder, waiter):
            if process.pid is not None:
                process.join(timeout=5)
                if process.is_alive():
                    process.terminate()
                    process.join()
        outcome.close()
        outcome.join_thread()
    assert holder.exitcode == 0
    assert path.read_bytes() == before, "release cannot resurrect the expired update"
    assert playbooks_module.get_playbook(saved["id"]) == saved
    retried = playbooks_module.update_playbook(saved["id"], _payload("Explicit fresh retry"), _match(saved))
    assert retried["name"] == "Explicit fresh retry"


def test_lock_deadline_does_not_interrupt_an_acquired_write(tmp_path, monkeypatch):
    import time

    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    monkeypatch.setattr(playbooks_module, "PLAYBOOK_LOCK_TIMEOUT_SECONDS", 0.05)
    saved = playbooks_module.create_playbook(_payload())
    original_write = playbooks_module._write

    def slow_write(path, value):
        time.sleep(0.1)  # Only acquisition is bounded; an owned write completes.
        original_write(path, value)

    monkeypatch.setattr(playbooks_module, "_write", slow_write)
    updated = playbooks_module.update_playbook(saved["id"], _payload("Completed write"), _match(saved))
    assert updated["name"] == "Completed write"
    assert playbooks_module.get_playbook(saved["id"]) == updated


def test_lock_deadline_rechecks_after_acquisition_and_releases_expired_ownership(tmp_path, monkeypatch):
    import os
    import pytest
    from fastapi import HTTPException
    from types import SimpleNamespace

    if os.name == "nt":
        pytest.skip("POSIX acquisition boundary; separate-process coverage is cross-platform")
    import fcntl
    original_flock = fcntl.flock
    calls = []
    clock = iter([0.0, 0.0, 2.0])
    monkeypatch.setattr(playbooks_module, "time", SimpleNamespace(monotonic=lambda: next(clock)))

    def recorded_flock(descriptor, operation):
        calls.append(operation)
        return original_flock(descriptor, operation)

    monkeypatch.setattr(fcntl, "flock", recorded_flock)
    with pytest.raises(HTTPException) as error:
        with playbooks_module._playbook_lock(tmp_path / "play-expired.json"):
            pytest.fail("Expired acquisition entered the transaction")
    assert error.value.status_code == 503
    assert calls == [fcntl.LOCK_EX | fcntl.LOCK_NB, fcntl.LOCK_UN]
    # Closing/releasing expired ownership leaves the same lock inode usable.
    monkeypatch.setattr(playbooks_module, "time", __import__("time"))
    with playbooks_module._playbook_lock(tmp_path / "play-expired.json"):
        pass


def test_playbook_lock_coordinates_processes_and_independent_ids(tmp_path, monkeypatch):
    import multiprocessing
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    from pathlib import Path
    import pytest

    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    saved = playbooks_module.create_playbook(_payload())
    context = multiprocessing.get_context("spawn")
    entered, release = context.Event(), context.Event()
    process = context.Process(target=_hold_playbook_lock, args=(Path(tmp_path / f"{saved['id']}.json"), entered, release))
    process.start()
    try:
        assert entered.wait(10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            waiting = pool.submit(playbooks_module.update_playbook, saved["id"], _payload("After lock"), _match(saved))
            try:
                with pytest.raises(TimeoutError):
                    waiting.result(timeout=0.15)
                # A different document does not wait for the first document's lock.
                independent = pool.submit(playbooks_module.create_playbook, _payload("Other play"))
                assert independent.result(timeout=3)["name"] == "Other play"
            finally:
                release.set()
            assert waiting.result(timeout=5)["name"] == "After lock"
    finally:
        release.set()
        process.join(timeout=10)
        if process.is_alive():
            process.terminate()
            process.join()
    assert process.exitcode == 0


def test_concurrent_update_and_delete_cannot_recreate_play(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    import pytest
    from fastapi import HTTPException

    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    saved = playbooks_module.create_playbook(_payload())
    entered, release = threading.Event(), threading.Event()
    original_write = playbooks_module._write

    def delayed_write(path, value):
        if value.get("name") == "Pending update":
            entered.set()
            assert release.wait(5)
        return original_write(path, value)

    monkeypatch.setattr(playbooks_module, "_write", delayed_write)
    with ThreadPoolExecutor(max_workers=2) as pool:
        updating = pool.submit(playbooks_module.update_playbook, saved["id"], _payload("Pending update"), _match(saved))
        try:
            assert entered.wait(3)
            deleting = pool.submit(playbooks_module.delete_playbook, saved["id"])
            with pytest.raises(TimeoutError):
                deleting.result(timeout=0.15)
        finally:
            release.set()
        assert updating.result(timeout=3)["name"] == "Pending update"
        assert deleting.result(timeout=3)["deleted"]
    with pytest.raises(HTTPException) as missing:
        playbooks_module.update_playbook(saved["id"], _payload("Late update"))
    assert missing.value.status_code == 404
    assert not (tmp_path / f"{saved['id']}.json").exists()
    # Failed validation also releases the lock and keeps existing content intact.
    other = playbooks_module.create_playbook(_payload("Retained"))
    with pytest.raises(HTTPException):
        playbooks_module.update_playbook(other["id"], {"players": [False]}, _match(other))
    assert playbooks_module.get_playbook(other["id"])["name"] == "Retained"
    assert playbooks_module.delete_playbook(other["id"])["deleted"]


def test_create_identity_allows_read_only_outcome_check_without_overwrite(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    identity = "play-" + "a" * 32
    headers = {"X-ARC-Create-ID": identity}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda name: client.post("/api/playbooks", json=_payload(name), headers=headers), ["First client", "Other client"]))
    assert sorted(response.status_code for response in results) == [200, 409]
    accepted = next(response.json() for response in results if response.status_code == 200)
    assert accepted["id"] == identity
    assert client.get(f"/api/playbooks/{identity}").json() == accepted
    assert len(list(tmp_path.glob("*.json"))) == 1
    for bad in ["../escape", "draft-" + "a" * 32, "play-short", "play-" + "A" * 32]:
        assert client.post("/api/playbooks", json=_payload(), headers={"X-ARC-Create-ID": bad}).status_code == 400
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_idempotent_creation_replays_original_through_edits_deletion_and_restart(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    identity = "play-" + "b" * 32
    headers = {"X-ARC-Create-ID": identity}
    client = TestClient(app)
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post("/api/playbooks", json=_payload(), headers=headers), range(4)))
    assert all(response.status_code == 200 for response in responses)
    original = responses[0].json()
    assert all(response.json() == original for response in responses)
    assert "_creation" not in original
    assert len(list(tmp_path.glob("*.json"))) == 1
    assert client.put(f"/api/playbooks/{identity}", json=_payload("Later rename"), headers={"If-Match": _match(original)}).status_code == 200
    fresh_client = TestClient(app)  # Receipts come from disk, not a client/session cache.
    assert fresh_client.post("/api/playbooks", json=_payload(), headers=headers).json() == original
    mismatch = fresh_client.post("/api/playbooks", json=_payload("Different request"), headers=headers)
    assert mismatch.status_code == 409
    assert fresh_client.get(f"/api/playbooks/{identity}").json()["name"] == "Later rename"
    assert fresh_client.delete(f"/api/playbooks/{identity}").status_code == 200
    assert fresh_client.post("/api/playbooks", json=_payload(), headers=headers).json() == original
    assert fresh_client.get(f"/api/playbooks/{identity}").status_code == 404
    assert fresh_client.get("/api/playbooks").json() == []
    assert (tmp_path / ".deleted" / f"{identity}.json").exists()


def test_failed_idempotent_create_leaves_no_receipt(tmp_path, monkeypatch):
    import pytest
    from fastapi import HTTPException
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    original_write = playbooks_module._write
    def fail_write(*_):
        raise HTTPException(500, "Disk failure")

    monkeypatch.setattr(playbooks_module, "_write", fail_write)
    identity = "play-" + "c" * 32
    with pytest.raises(HTTPException):
        playbooks_module.create_playbook(_payload(), identity)
    assert not list(tmp_path.glob("*.json"))
    monkeypatch.setattr(playbooks_module, "_write", original_write)
    result = playbooks_module.create_playbook(_payload(), identity)
    assert result["id"] == identity
    assert playbooks_module.create_playbook(_payload(), identity) == result


def test_corrupt_creation_receipt_is_preserved_instead_of_replayed(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    identity = "play-" + "d" * 32
    headers = {"X-ARC-Create-ID": identity}
    assert client.post("/api/playbooks", json=_payload(), headers=headers).status_code == 200
    path = tmp_path / f"{identity}.json"
    value = json.loads(path.read_text())
    value["_creation"]["result"]["name"] = "Damaged receipt"
    raw = json.dumps(value)
    path.write_text(raw)
    assert client.post("/api/playbooks", json=_payload(), headers=headers).status_code == 500
    assert path.read_text() == raw
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_library_order_uses_instants_with_stable_ties_and_invalid_fallback(tmp_path, monkeypatch) -> None:
    from pathlib import Path

    fixture = json.loads((Path(__file__).parent / "fixtures/playbook-order.json").read_text())
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    for entry in reversed(fixture["entries"]):
        document = {"version": 1, **_payload(entry["id"]), **entry}
        (tmp_path / f"{entry['id']}.json").write_text(json.dumps(document))
    before = {path.name: path.read_bytes() for path in tmp_path.glob("*.json")}
    for _ in range(3):
        response = client.get("/api/playbooks")
        assert response.status_code == 200
        assert [play["id"] for play in response.json()] == fixture["expected"]
    assert {path.name: path.read_bytes() for path in tmp_path.glob("*.json")} == before


def test_mismatched_file_identity_rejects_reads_and_mutations_without_rewriting(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    healthy = client.post("/api/playbooks", json=_payload("Healthy")).json()
    # Otherwise valid content must not alias the healthy document from another file.
    path = tmp_path / "play-wrong-file.json"
    path.write_text(json.dumps(healthy, indent=4) + "\n")
    before = {file.name: file.read_bytes() for file in tmp_path.glob("*.json")}
    response = client.get("/api/playbooks")
    assert response.json() == [healthy]
    assert response.headers["X-ARC-Playbook-Warnings"] == path.name
    assert client.get("/api/playbooks/play-wrong-file").status_code == 500
    assert client.put("/api/playbooks/play-wrong-file", json=_payload("Overwrite"), headers={"If-Match": _match(healthy)}).status_code == 500
    assert client.delete("/api/playbooks/play-wrong-file").status_code == 500
    assert client.get(f"/api/playbooks/{healthy['id']}").json() == healthy
    assert {file.name: file.read_bytes() for file in tmp_path.glob("*.json")} == before
    assert not (tmp_path / ".deleted").exists()


def test_creation_retries_preserve_mismatched_live_and_deleted_documents(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    for deleted in (False, True):
        identity = "play-" + ("b" if deleted else "a") * 32
        headers = {"X-ARC-Create-ID": identity}
        assert client.post("/api/playbooks", json=_payload(), headers=headers).status_code == 200
        path = tmp_path / f"{identity}.json"
        if deleted:
            assert client.delete(f"/api/playbooks/{identity}").status_code == 200
            path = tmp_path / ".deleted" / path.name
        value = json.loads(path.read_text())
        value["id"] = "play-other-identity"
        path.write_text(json.dumps(value, indent=4) + "\n")
        before = path.read_bytes()
        assert client.post("/api/playbooks", json=_payload(), headers=headers).status_code == 500
        assert path.read_bytes() == before
        assert not (tmp_path / "play-other-identity.json").exists()
        if deleted:
            assert not (tmp_path / f"{identity}.json").exists()


def test_save_revision_rejects_stale_clients_inside_transaction(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    clients = [TestClient(app), TestClient(app)]
    saved = clients[0].post("/api/playbooks", json=_payload()).json()
    snapshots = [client.get(f"/api/playbooks/{saved['id']}").json() for client in clients]
    assert snapshots[0] == snapshots[1] == saved
    gate = Barrier(2)

    def update(index):
        draft = snapshots[index]
        draft["players"][0]["x"] = 20 + index * 40
        draft["name"] = f"Client {index}"
        gate.wait(timeout=5)
        return clients[index].put(f"/api/playbooks/{saved['id']}", json=draft, headers={"If-Match": _match(draft)})

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(update, range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    winner = next(response.json() for response in responses if response.status_code == 200)
    assert winner["revision"] != saved["revision"]
    assert clients[0].get(f"/api/playbooks/{saved['id']}").json() == winner
    path = tmp_path / f"{saved['id']}.json"
    before = path.read_bytes()
    for client in clients:
        rejected = client.put(f"/api/playbooks/{saved['id']}", json=_payload("Stale retry"), headers={"If-Match": _match(saved)})
        assert rejected.status_code == 409
        assert "draft is still in memory" in rejected.json()["detail"]
    assert path.read_bytes() == before
    latest = clients[1].get(f"/api/playbooks/{saved['id']}").json()
    latest["name"] = "Freshly loaded edit"
    accepted = clients[1].put(f"/api/playbooks/{saved['id']}", json=latest, headers={"If-Match": _match(latest)})
    assert accepted.status_code == 200
    assert accepted.json()["revision"] not in [saved["revision"], winner["revision"]]
    assert accepted.json()["created_at"] == saved["created_at"]


def test_revision_preconditions_and_legacy_upgrade_preserve_files(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    legacy = {**_payload("Legacy"), "version": 1, "id": "play-revision-legacy"}
    path = tmp_path / f"{legacy['id']}.json"
    path.write_text(json.dumps(legacy))
    raw = path.read_bytes()
    assert client.get(f"/api/playbooks/{legacy['id']}").json() == legacy
    for headers, status in [({}, 428), ({"If-Match": "*"}, 400), ({"If-Match": '"bad"'}, 400), ({"If-Match": '"' + "a" * 32 + '"'}, 409)]:
        assert client.put(f"/api/playbooks/{legacy['id']}", json=_payload(), headers=headers).status_code == status
        assert path.read_bytes() == raw
    first = client.put(f"/api/playbooks/{legacy['id']}", json=legacy, headers={"If-Match": '"legacy"'})
    assert first.status_code == 200
    assert len(first.json()["revision"]) == 32
    assert client.put(f"/api/playbooks/{legacy['id']}", json=legacy, headers={"If-Match": '"legacy"'}).status_code == 409
    # Every accepted save gets a token even at identical timestamp precision.
    monkeypatch.setattr(playbooks_module, "_now", lambda: "2026-10-19T00:00:00+0000")
    second = client.put(f"/api/playbooks/{legacy['id']}", json=first.json(), headers={"If-Match": _match(first.json())}).json()
    third = client.put(f"/api/playbooks/{legacy['id']}", json=second, headers={"If-Match": _match(second)}).json()
    assert second["updated_at"] == third["updated_at"]
    assert second["revision"] != third["revision"]


def test_branch_documents_require_and_preserve_branch_aware_local_writes(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Branch family")
    payload["branches"] = [{
        "id": "ending-1",
        "label": "Slip",
        "fork": {"actionIds": ["arrow-one"], "sequence": 2},
        "continuation": [payload["arrows"][0]],
    }]

    assert client.get("/api/playbooks").headers["X-ARC-Playbook-Extensions"] == "branches-v1,timing-v1,read-coach-v1,role-rehearsal-v1"
    refused = client.post("/api/playbooks", json=payload)
    assert refused.status_code == 409

    created = client.post("/api/playbooks", json=payload, headers={"X-ARC-Playbook-Extensions": "branches-v1"})
    assert created.status_code == 200
    saved = created.json()
    assert saved["branches"][0]["label"] == "Slip"
    assert client.get(f"/api/playbooks/{saved['id']}").json()["branches"] == saved["branches"]

    stale_client = {key: value for key, value in saved.items() if key not in {"id", "created_at", "updated_at", "revision", "branches"}}
    refused_update = client.put(f"/api/playbooks/{saved['id']}", json=stale_client, headers={"If-Match": _match(saved)})
    assert refused_update.status_code == 409
    assert client.get(f"/api/playbooks/{saved['id']}").json()["branches"] == saved["branches"]

    updated_payload = {**stale_client, "name": "Branch family revised", "branches": saved["branches"]}
    updated = client.put(f"/api/playbooks/{saved['id']}", json=updated_payload, headers={
        "If-Match": _match(saved),
        "X-ARC-Playbook-Extensions": "branches-v1",
    })
    assert updated.status_code == 200
    assert updated.json()["name"] == "Branch family revised"
    assert updated.json()["branches"] == saved["branches"]

    cleared = {**stale_client, "name": "Endings intentionally removed", "branches": []}
    cleared_response = client.put(f"/api/playbooks/{saved['id']}", json=cleared, headers={
        "If-Match": _match(updated.json()),
        "X-ARC-Playbook-Extensions": "branches-v1",
    })
    assert cleared_response.status_code == 200
    assert "branches" not in cleared_response.json()

    invalid = {**updated_payload, "branches": [{**saved["branches"][0], "label": "x" * 41}]}
    rejected = client.put(f"/api/playbooks/{saved['id']}", json=invalid, headers={
        "If-Match": _match(cleared_response.json()),
        "X-ARC-Playbook-Extensions": "branches-v1",
    })
    assert rejected.status_code == 400
    assert client.get(f"/api/playbooks/{saved['id']}").json() == cleared_response.json()


def test_timing_documents_require_and_preserve_timing_aware_local_writes(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Timed actions")
    payload["players"].append({"id": 2, "x": 38, "y": 64})
    payload["players"].append({"id": 3, "x": 62, "y": 64})
    payload["arrows"][0]["actor_id"] = 3
    payload["arrows"][0]["timingPlan"] = {"startAtMs": 300, "syncId": "pin-a"}
    payload["arrows"][1]["actor_id"] = 1
    payload["arrows"][1]["recipient_id"] = 2
    payload["arrows"][1]["timingPlan"] = {"startAtMs": 300, "syncId": "pin-a"}
    assert client.post("/api/playbooks", json=payload).status_code == 409
    created = client.post("/api/playbooks", json=payload, headers={"X-ARC-Playbook-Extensions": "timing-v1"})
    assert created.status_code == 200
    saved = created.json()
    assert saved["arrows"][0]["timingPlan"] == {"startAtMs": 300, "syncId": "pin-a"}
    assert client.get(f"/api/playbooks/{saved['id']}").json()["arrows"] == saved["arrows"]
    stale = {key: value for key, value in saved.items() if key not in {"revision", "id", "created_at", "updated_at"}}
    stale["arrows"] = [{key: value for key, value in arrow.items() if key != "timingPlan"} for arrow in stale["arrows"]]
    refused = client.put(f"/api/playbooks/{saved['id']}", json=stale, headers={"If-Match": _match(saved)})
    assert refused.status_code == 409
    assert client.get(f"/api/playbooks/{saved['id']}").json()["arrows"] == saved["arrows"]
    updated = client.put(f"/api/playbooks/{saved['id']}", json=saved, headers={
        "If-Match": _match(saved), "X-ARC-Playbook-Extensions": "timing-v1",
    })
    assert updated.status_code == 200
    assert updated.json()["arrows"] == saved["arrows"]


def test_timing_wait_graph_and_pin_validation(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Timing validation")
    payload["players"].append({"id": 2, "x": 38, "y": 64})
    payload["arrows"][0]["actor_id"] = 1
    payload["arrows"][1].update(actor_id=1, recipient_id=2)
    payload["arrows"][0]["timingPlan"] = {"startAtMs": 1000, "waits": [{"id": "wait-a", "actionId": "arrow-two", "event": "catch"}]}
    payload["arrows"][1]["timingPlan"] = {"startAtMs": 0, "waits": [{"id": "wait-b", "actionId": "arrow-one", "event": "start"}]}
    cyclic = client.post("/api/playbooks", json=payload, headers={"X-ARC-Playbook-Extensions": "timing-v1"})
    assert cyclic.status_code == 400
    assert "cycle" in cyclic.json()["detail"].lower()

    through_pin = _payload("Timing cycle through pin")
    through_pin["players"].extend([{"id": 2, "x": 38, "y": 64}, {"id": 3, "x": 62, "y": 64}])
    through_pin["arrows"] = [
        {"id": "pinned-a", "kind": "movement", "sequence": 1, "actor_id": 1, "start": {"x": 20, "y": 70}, "end": {"x": 24, "y": 64}, "timingPlan": {"startAtMs": 0, "syncId": "same-pin", "waits": [{"id": "wait-x", "actionId": "outside-pin", "event": "start"}]}},
        {"id": "pinned-b", "kind": "movement", "sequence": 1, "actor_id": 2, "start": {"x": 35, "y": 70}, "end": {"x": 38, "y": 64}, "timingPlan": {"startAtMs": 0, "syncId": "same-pin"}},
        {"id": "outside-pin", "kind": "movement", "sequence": 2, "actor_id": 3, "start": {"x": 50, "y": 70}, "end": {"x": 54, "y": 64}, "timingPlan": {"startAtMs": 0, "waits": [{"id": "wait-b", "actionId": "pinned-b", "event": "start"}]}},
    ]
    grouped_cycle = client.post("/api/playbooks", json=through_pin, headers={"X-ARC-Playbook-Extensions": "timing-v1"})
    assert grouped_cycle.status_code == 400
    assert "cycle" in grouped_cycle.json()["detail"].lower()

    payload = _payload("Pinned transfers")
    payload["players"].append({"id": 2, "x": 38, "y": 64})
    payload["arrows"][0].update(actor_id=1, timingPlan={"startAtMs": 0, "syncId": "same"})
    payload["arrows"][1].update(actor_id=1, recipient_id=2, timingPlan={"startAtMs": 0, "syncId": "same"})
    conflict = client.post("/api/playbooks", json=payload, headers={"X-ARC-Playbook-Extensions": "timing-v1"})
    assert conflict.status_code == 400
    assert "movement owner" in conflict.json()["detail"]

    valid = _payload("Route wait")
    valid["players"].append({"id": 2, "x": 38, "y": 64})
    valid["arrows"][0].update(actor_id=1, timingPlan={"startAtMs": 0})
    valid["arrows"][1].update(actor_id=1, recipient_id=2, timingPlan={"startAtMs": 0, "waits": [{"id": "route-a", "actionId": "arrow-one", "event": "route-point", "playerId": 1, "routePhase": "main", "routeSegment": 20, "progress": 0.55556}]})
    stored = client.post("/api/playbooks", json=valid, headers={"X-ARC-Playbook-Extensions": "timing-v1"})
    assert stored.status_code == 200
    assert stored.json()["arrows"][1]["timingPlan"]["waits"][0]["progress"] == 0.5556


def test_timing_waits_require_retarget_when_source_routes_change(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Retarget route waits")
    payload["players"].append({"id": 2, "x": 38, "y": 64})
    payload["arrows"][0].update(actor_id=2, timingPlan={"startAtMs": 0})
    payload["arrows"][1].update(actor_id=1, recipient_id=2, timingPlan={"startAtMs": 0, "waits": [{
        "id": "wait-route", "actionId": "arrow-one", "event": "route-point", "playerId": 2,
        "routePhase": "main", "routeSegment": 12, "progress": 0.4,
    }]})
    headers = {"X-ARC-Playbook-Extensions": "timing-v1"}
    saved = client.post("/api/playbooks", json=payload, headers=headers).json()
    changed = json.loads(json.dumps(saved))
    changed["arrows"][0]["end"] = {"x": 75, "y": 40}
    rejected = client.put(f"/api/playbooks/{saved['id']}", json=changed, headers={**headers, "If-Match": _match(saved)})
    assert rejected.status_code == 409
    assert "retarget" in rejected.json()["detail"].lower()
    assert client.get(f"/api/playbooks/{saved['id']}").json()["arrows"][0]["end"] == saved["arrows"][0]["end"]
    changed["arrows"][1]["timingPlan"]["waits"][0]["progress"] = 0.65
    retargeted = client.put(f"/api/playbooks/{saved['id']}", json=changed, headers={**headers, "If-Match": _match(saved)})
    assert retargeted.status_code == 200
    assert retargeted.json()["arrows"][0]["end"] == {"x": 75.0, "y": 40.0}


def test_read_coach_lessons_require_capability_and_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Read Coach lesson")
    default_ratings = {"threePoint": 3, "midrange": 3, "finishing": 3}
    payload["players"] = [{**payload["players"][0], "ratings": default_ratings, "badges": []},
        {"id": 2, "x": 36, "y": 60, "ratings": default_ratings, "badges": []}]
    payload["defenders"] = [{**payload["defenders"][0], "badges": []}]
    source = {key: value for key, value in payload.items() if key not in {"version", "id", "created_at", "updated_at", "revision"}}
    settings = {
        "offenseOffBall": "off", "defenseScheme": "man-to-man", "defenseStrategy": "help",
        "offBallIntensity": 70,
        "automaticActions": {"screen": False, "handoff": False, "pickRoll": False, "offBallScreen": False},
        "offenseMode": "scripted",
    }
    movement = {"id": "read-move", "kind": "movement", "sequence": 1, "actor_id": 1,
        "timing": 1.2, "start": {"x": 50, "y": 70}, "end": {"x": 48, "y": 57}}
    passed = {"id": "read-pass", "kind": "pass", "sequence": 1, "actor_id": 1, "recipient_id": 2,
        "timing": 1.2, "start": {"x": 50, "y": 70}, "end": {"x": 36, "y": 60}}
    lesson = {"version": 1, "checkpoints": [{
        "id": "read-first", "question": "What should the handler do?", "explanation": "Move the ball before the help arrives",
        "session": {"version": 1, "engineVersion": 9, "seed": 12, "initialDrawing": source,
            "initialSettings": settings, "resolvedDefenseScheme": "man-to-man", "hoop": {"x": 50, "y": 5},
            "positionMs": 0, "events": []},
        "snapshot": {"players": payload["players"], "defenders": payload["defenders"], "ball": payload["ball"], "ballHandlerId": 1, "atMs": 0},
        "choices": [{"id": "attack", "label": "Attack", "arrows": [movement]}, {"id": "pass", "label": "Pass", "arrows": [passed]}],
        "correctChoiceId": "pass",
    }]}
    payload["readCoach"] = lesson

    assert client.get("/api/playbooks").headers["X-ARC-Playbook-Extensions"] == "branches-v1,timing-v1,read-coach-v1,role-rehearsal-v1"
    refused = client.post("/api/playbooks", json=payload)
    assert refused.status_code == 409
    created = client.post("/api/playbooks", json=payload, headers={"X-ARC-Playbook-Extensions": "read-coach-v1"})
    assert created.status_code == 200
    saved = created.json()
    assert saved["readCoach"] == lesson
    assert client.get(f"/api/playbooks/{saved['id']}").json()["readCoach"] == lesson

    stale = {key: value for key, value in saved.items() if key not in {"id", "created_at", "updated_at", "revision", "readCoach"}}
    refused_update = client.put(f"/api/playbooks/{saved['id']}", json=stale, headers={"If-Match": _match(saved)})
    assert refused_update.status_code == 409
    assert client.get(f"/api/playbooks/{saved['id']}").json()["readCoach"] == lesson

    updated_payload = {**stale, "name": "Read Coach lesson revised", "readCoach": lesson}
    updated = client.put(f"/api/playbooks/{saved['id']}", json=updated_payload, headers={
        "If-Match": _match(saved), "X-ARC-Playbook-Extensions": "read-coach-v1",
    })
    assert updated.status_code == 200
    assert updated.json()["name"] == "Read Coach lesson revised"
    assert updated.json()["readCoach"] == lesson

    malformed = json.loads(json.dumps(lesson))
    malformed["checkpoints"][0]["snapshot"]["ballHandlerId"] = 999
    rejected = client.put(f"/api/playbooks/{saved['id']}", json={**updated_payload, "readCoach": malformed}, headers={
        "If-Match": _match(updated.json()), "X-ARC-Playbook-Extensions": "read-coach-v1",
    })
    assert rejected.status_code == 400
    assert client.get(f"/api/playbooks/{saved['id']}").json()["readCoach"] == lesson


def test_role_rehearsal_cues_require_capability_and_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(playbooks_module, "PLAYBOOKS_DIR", tmp_path)
    client = TestClient(app)
    payload = _payload("Role cues")
    cues = {"version": 1, "cues": [{
        "playerId": 1, "actionId": "arrow-one", "phase": "move", "scope": "shared",
        "text": "Hold the corner", "signature": "1234abcd",
    }]}
    payload["roleCues"] = cues

    capabilities = client.get("/api/playbooks")
    assert "role-rehearsal-v1" in capabilities.headers["X-ARC-Playbook-Extensions"]
    assert client.post("/api/playbooks", json=payload).status_code == 409
    created = client.post("/api/playbooks", json=payload, headers={"X-ARC-Playbook-Extensions": "role-rehearsal-v1"})
    assert created.status_code == 200
    saved = created.json()
    assert saved["roleCues"] == cues
    assert client.get(f"/api/playbooks/{saved['id']}").json()["roleCues"] == cues

    stale = {key: value for key, value in saved.items() if key not in {"id", "created_at", "updated_at", "revision", "roleCues"}}
    refused = client.put(f"/api/playbooks/{saved['id']}", json=stale, headers={"If-Match": _match(saved)})
    assert refused.status_code == 409
    updated = client.put(f"/api/playbooks/{saved['id']}", json={**stale, "roleCues": cues}, headers={
        "If-Match": _match(saved), "X-ARC-Playbook-Extensions": "role-rehearsal-v1",
    })
    assert updated.status_code == 200
    assert updated.json()["roleCues"] == cues

    for bad_cue in [
        {**cues["cues"][0], "playerId": 99},
        {**cues["cues"][0], "phase": "guess"},
        {**cues["cues"][0], "signature": "broken"},
        {**cues["cues"][0], "actionId": "missing-action"},
    ]:
        rejected = client.put(f"/api/playbooks/{saved['id']}", json={**stale, "roleCues": {"version": 1, "cues": [bad_cue]}}, headers={
            "If-Match": _match(updated.json()), "X-ARC-Playbook-Extensions": "role-rehearsal-v1",
        })
        assert rejected.status_code == 400
        assert client.get(f"/api/playbooks/{saved['id']}").json()["roleCues"] == cues

    empty_lesson = {"version": 1, "cues": []}
    omitted_clear = client.put(f"/api/playbooks/{saved['id']}", json=stale, headers={"If-Match": _match(updated.json())})
    assert omitted_clear.status_code == 409
    unsupported_clear = client.put(f"/api/playbooks/{saved['id']}", json={**stale, "roleCues": empty_lesson}, headers={
        "If-Match": _match(updated.json()),
    })
    assert unsupported_clear.status_code == 409
    cleared = client.put(f"/api/playbooks/{saved['id']}", json={**stale, "roleCues": empty_lesson}, headers={
        "If-Match": _match(updated.json()), "X-ARC-Playbook-Extensions": "role-rehearsal-v1",
    })
    assert cleared.status_code == 200
    assert cleared.json()["roleCues"] == empty_lesson
