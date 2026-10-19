"""Expiry candidates are deleted only after live directory ownership is rechecked."""
import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import uuid

import pytest
from backend.api import jumper


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(jumper, "ROOT", tmp_path)
    monkeypatch.setattr(jumper, "JOBS", {})
    monkeypatch.setattr(jumper, "OWNERS", {})


def job(kind=None):
    identity = str(uuid.uuid4())
    directory = jumper.ROOT / "jobs" / identity
    directory.mkdir(parents=True)
    (directory / "source").write_bytes(b"private")
    value = dict(id=identity, directory=directory, last_seen=0,
                 status="uploaded", cancel=threading.Event())
    if kind:
        value.update(kind=kind, done=True)
    jumper.JOBS[identity] = value
    return identity, value


def test_expired_unowned_job_deleted_but_active_owner_preserved():
    active_id, active = job()
    abandoned_id, abandoned = job()
    finish = jumper.retain_directory(active["directory"], "export retry")
    jumper.expire_jobs(1000)
    assert active_id in jumper.JOBS and active["directory"].exists()
    assert not active["cancel"].is_set()
    assert abandoned_id not in jumper.JOBS and not abandoned["directory"].exists()
    finish()
    jumper.expire_jobs(1000)
    assert active_id not in jumper.JOBS and not active["directory"].exists()


def test_cleanup_rechecks_current_owner_and_last_access():
    identity, value = job()
    # A stale candidate list cannot authorize removal after a request claimed it.
    with jumper.own_job(identity, "processing request"):
        value["last_seen"] = 0
        jumper.expire_jobs(1000)
        assert identity in jumper.JOBS
    now = time.monotonic()
    jumper.expire_jobs(now + 179)
    assert identity in jumper.JOBS
    jumper.expire_jobs(now + 181)
    assert identity not in jumper.JOBS


@pytest.mark.parametrize("purpose", ["pending save", "processing/export retry", "media response"])
def test_multiple_owners_and_idempotent_release(purpose):
    _, value = job()
    first = jumper.retain_directory(value["directory"], purpose)
    second = jumper.retain_directory(value["directory"], purpose)
    assert len(jumper.OWNERS[value["directory"]]) == 2
    assert not jumper.discard_directory(value["directory"])
    first(); first()
    assert not jumper.discard_directory(value["directory"])
    second()
    assert jumper.discard_directory(value["directory"])
    assert not jumper.OWNERS


def test_queued_and_slow_work_retains_files_without_polling(monkeypatch):
    identity, value = job()
    entered, complete = threading.Event(), threading.Event()
    with ThreadPoolExecutor(1) as executor:
        monkeypatch.setattr(jumper, "EXECUTOR", executor)
        def slow():
            entered.set()
            assert complete.wait(3)
        future = jumper.submit_owned(value, "export retry", slow)
        try:
            assert entered.wait(2)
            value["last_seen"] = 0
            jumper.expire_jobs(1000)
            assert identity in jumper.JOBS and value["directory"].exists()
        finally:
            complete.set()
        future.result(3)
    assert not jumper.OWNERS
    assert value["last_seen"] > 0
    jumper.expire_jobs(value["last_seen"] + 181)
    assert identity not in jumper.JOBS


def test_submit_failure_releases_ownership(monkeypatch):
    _, value = job()
    with ThreadPoolExecutor(1) as executor:
        pass
    monkeypatch.setattr(jumper, "EXECUTOR", executor)
    with pytest.raises(RuntimeError):
        jumper.submit_owned(value, "queue", lambda: None)
    assert not jumper.OWNERS


def test_manual_release_waits_for_edit_and_response_owners():
    identity, value = job("edit")
    finish = jumper.retain_directory(value["directory"], "edit/export retry")
    jumper.release(identity)
    assert identity not in jumper.JOBS
    assert value["directory"].exists()
    finish()
    for _ in range(100):
        if not value["directory"].exists():
            break
        time.sleep(.01)
    assert not value["directory"].exists()


def test_response_failure_releases_lease():
    _, value = job()
    response = jumper.owned_response(value, value["directory"] / "missing.mp4")
    assert jumper.OWNERS
    with pytest.raises(RuntimeError):
        asyncio.run(response({"type": "http", "method": "GET", "headers": [], "extensions": {}}, None, None))
    assert not jumper.OWNERS


def test_stale_status_without_live_owner_does_not_keep_abandoned_files():
    identity, value = job()
    value["status"] = "processing"
    jumper.expire_jobs(1000)
    assert identity not in jumper.JOBS
    assert not value["directory"].exists()
