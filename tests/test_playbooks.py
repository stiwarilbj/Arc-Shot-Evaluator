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
            assert client.put(f"/api/playbooks/{saved['id']}", json=example["document"]).status_code == 200
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
        updated = client.put(f"/api/playbooks/{saved['id']}", json=reopened).json()
        for field in ("players", "defenders", "ball", "arrows"):
            assert updated[field] == saved[field]


def _hold_playbook_lock(path, entered, release):
    # Top-level target so Windows/macOS spawn tests use a separate interpreter.
    with playbooks_module._playbook_lock(path):
        entered.set()
        if not release.wait(10):
            raise TimeoutError("Lock test did not release")


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
            waiting = pool.submit(playbooks_module.update_playbook, saved["id"], _payload("After lock"))
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
        if value["name"] == "Pending update":
            entered.set()
            assert release.wait(5)
        return original_write(path, value)

    monkeypatch.setattr(playbooks_module, "_write", delayed_write)
    with ThreadPoolExecutor(max_workers=2) as pool:
        updating = pool.submit(playbooks_module.update_playbook, saved["id"], _payload("Pending update"))
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
        playbooks_module.update_playbook(other["id"], {"players": [False]})
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
    assert client.put(f"/api/playbooks/{identity}", json=_payload("Later rename")).status_code == 200
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
