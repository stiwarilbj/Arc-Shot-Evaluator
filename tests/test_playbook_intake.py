import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

import backend.api.playbooks as api
from backend.api.app import app

MAXIMUM = Path(__file__).parent / "fixtures/playbook-intake-maximum.json"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "PLAYBOOKS_DIR", tmp_path)
    return TestClient(app)


def test_full_rosters_attributes_and_thirty_curved_actions_fit_budget(client):
    content = MAXIMUM.read_bytes()
    assert len(content) < api.MAX_DOCUMENT_BYTES // 4
    saved = client.post("/api/playbooks", content=content)
    assert saved.status_code == 200
    play = saved.json()
    assert len(play["players"]) == len(play["defenders"]) == 5
    assert len(play["arrows"]) == 30
    updated = client.put(f'/api/playbooks/{play["id"]}', content=content, headers={"If-Match": f'"{play["revision"]}"'})
    assert updated.status_code == 200
    assert updated.json()["arrows"] == play["arrows"]


@pytest.mark.parametrize("declared", [None, "1", "999999999"])
def test_actual_received_bytes_control_post_and_put_limits(client, tmp_path, declared):
    saved = client.post("/api/playbooks", json={"name": "Keep drawing"}).json()
    path = tmp_path / f'{saved["id"]}.json'
    before = path.read_bytes()
    content = b'{"unused":"' + b"x" * api.MAX_DOCUMENT_BYTES + b'"}'
    headers = {"Content-Length": declared} if declared is not None else {}
    for method, url in [("POST", "/api/playbooks"), ("PUT", f'/api/playbooks/{saved["id"]}')]:
        response = client.request(method, url, content=iter([content[:100], content[100:]]), headers={**headers, "If-Match": f'"{saved["revision"]}"'})
        assert response.status_code == 413
        assert path.read_bytes() == before
        assert len(list(tmp_path.glob("*.json"))) == 1


@pytest.mark.parametrize("length, status", [(256 * 1024, 200), (256 * 1024 + 1, 413)])
def test_exact_byte_boundary_and_unicode(client, length, status):
    base = json.dumps({"name": "é🏀", "unused": "é" * 100}, ensure_ascii=False).encode()
    response = client.post("/api/playbooks", content=base + b" " * (length - len(base)))
    assert response.status_code == status


def test_declared_size_does_not_override_received_bytes(client):
    response = client.post("/api/playbooks", content=b'{"name":"Small drawing"}', headers={"Content-Length": "999999999"})
    assert response.status_code == 200


def test_deep_put_and_invalid_structure_preserve_saved_drawing(client, tmp_path):
    saved = client.post("/api/playbooks", json={"name": "Keep drawing"}).json()
    path = tmp_path / f'{saved["id"]}.json'
    before = path.read_bytes()
    for content in ('{"unused":' + '[' * 2000 + '0' + ']' * 2000 + '}', '{"players":[false]}'):
        response = client.put(f'/api/playbooks/{saved["id"]}', content=content, headers={"If-Match": f'"{saved["revision"]}"'})
        assert response.status_code == 400
        assert path.read_bytes() == before


@pytest.mark.parametrize("depth, status", [(31, 200), (32, 200), (33, 400), (2000, 400)])
def test_nesting_limit_precedes_json_parser(client, depth, status):
    content = '{"unused":' + '[' * (depth - 1) + '0' + ']' * (depth - 1) + '}'
    assert client.post("/api/playbooks", content=content).status_code == status


def test_escaped_brackets_quotes_and_backslashes_do_not_count_as_nesting(client):
    content = json.dumps({"unused": '[{"quoted":"' * 1000 + '\\"' * 50})
    assert client.post("/api/playbooks", content=content).status_code == 200
    for content in (b"{broken", b"\xff", b"[]", b"null"):
        assert client.post("/api/playbooks", content=content).status_code == 400
    assert client.post("/api/playbooks", json={"players": [False]}).status_code == 400


@pytest.mark.parametrize("problem", ["bytes", "nesting"])
def test_rejected_intake_does_not_parse_or_read_remaining_chunks(monkeypatch, problem):
    calls = []
    chunks = [b" " * api.MAX_DOCUMENT_BYTES, b" ", b"must not read"] if problem == "bytes" else [b"[" * 2000]

    async def receive():
        index = len(calls)
        calls.append(index)
        return {"type": "http.request", "body": chunks[index], "more_body": index < len(chunks) - 1}

    def forbidden_parse(*args, **kwargs):
        pytest.fail("Rejected input must not reach json.loads")

    monkeypatch.setattr(api.json, "loads", forbidden_parse)
    with pytest.raises(HTTPException) as raised:
        asyncio.run(api._request_document(Request({"type": "http"}, receive)))
    assert raised.value.status_code == (413 if problem == "bytes" else 400)
    assert len(calls) == (2 if problem == "bytes" else 1)


@pytest.mark.parametrize("content", [b" " * (1024 * 1024 + 1), b"[" * 2000])
def test_bad_saved_files_are_preserved_and_reported_as_partial(client, tmp_path, content):
    saved = client.post("/api/playbooks", json={"name": "Healthy"}).json()
    path = tmp_path / "play-corrupt01.json"
    path.write_bytes(content)
    response = client.get("/api/playbooks")
    assert response.status_code == 200
    assert response.headers["X-ARC-Playbook-Status"] == "partial"
    assert [play["id"] for play in response.json()] == [saved["id"]]
    assert client.get("/api/playbooks/play-corrupt01").status_code == 500
    assert path.read_bytes() == content
