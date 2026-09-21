import json

from fastapi.testclient import TestClient

import backend.analysis.pipeline as pipeline
import backend.api.app as api_module
from backend.api.app import ANALYSIS_WORKERS, app


def test_health_reports_local_models() -> None:
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "local_only": True, "models_ready": True}


def test_analysis_executor_uses_a_predictable_local_worker() -> None:
    assert ANALYSIS_WORKERS >= 1


def test_upload_rejects_unsupported_extension() -> None:
    response = TestClient(app).post(
        "/api/jobs",
        files={"file": ("notes.txt", b"not a video", "text/plain")},
    )
    assert response.status_code == 400
    assert "MP4" in response.json()["detail"]


def test_media_route_rejects_path_traversal() -> None:
    response = TestClient(app).get("/media/not-valid!/analysis.json")
    assert response.status_code == 400


def test_examples_manifest_contains_bundled_clips() -> None:
    response = TestClient(app).get("/api/examples")
    assert response.status_code == 200
    examples = response.json()
    assert len(examples) >= 12
    assert all(item["filename"] != "20.0-26.0.mp4" for item in examples)
    assert examples[0]["id"] == "example-1"
    assert examples[0]["url"].startswith("/examples/")
    assert any("LeBron-Jokes-After-Steph" in item["filename"] for item in examples)


def test_example_job_rejects_unknown_clip() -> None:
    response = TestClient(app).post("/api/examples/example-999/jobs")
    assert response.status_code == 404


def test_analysis_mode_is_explicit() -> None:
    response = TestClient(app).post("/api/examples/example-1/jobs?mode=unsupported")
    assert response.status_code == 400
    assert "normal or deep" in response.json()["detail"]


def test_persisted_job_status_can_be_reopened_without_memory(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "persisted-job"
    session_dir.mkdir()
    status = {
        "id": "persisted-job",
        "filename": "clip.mp4",
        "status": "done",
        "stage": "Analysis complete",
        "frames_done": 12,
        "frames_total": 12,
        "updated_at": 1.0,
        "error": None,
        "result": {"session": {"id": "persisted-job"}, "shots": [], "summary": {}},
    }
    status_path = session_dir / "job.json"
    status_path.write_text(json.dumps(status))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)

    response = TestClient(app).get("/api/jobs/persisted-job")

    assert response.status_code == 200
    assert response.json()["status"] == "done"


def test_unreadable_persisted_job_is_left_untouched(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "broken-job"
    session_dir.mkdir()
    status_path = session_dir / "job.json"
    original = "{not json"
    status_path.write_text(original)
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)

    response = TestClient(app).get("/api/jobs/broken-job")

    assert response.status_code == 500
    assert status_path.read_text() == original


def test_shot_mode_is_explicit() -> None:
    response = TestClient(app).post("/api/examples/example-1/jobs?shot_mode=unsupported")
    assert response.status_code == 400
    assert "free_throw or jump_shot" in response.json()["detail"]


def test_context_requires_four_court_landmarks(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "session-context"
    session_dir.mkdir()
    (session_dir / "analysis.json").write_text(json.dumps({
        "shot_mode": "jump_shot",
        "session": {"id": "session-context", "fps": 30},
        "summary": {},
        "shots": [],
    }))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)

    response = TestClient(app).patch("/api/sessions/session-context/context", json={
        "court_calibration": {"preset": "nba", "image_points": [[0, 0]], "world_points": [[0, 0]]},
    })

    assert response.status_code == 400
    assert "four image points" in response.json()["detail"]


def test_shot_correction_is_separate_from_model_evidence(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "session-1"
    session_dir.mkdir()
    payload = {
        "analysis_version": "2.0.0",
        "session": {"id": "session-1", "fps": 30},
        "quality": {"tier": "limited", "camera_motion": 0.0, "blur_score": 0.8, "pose_coverage": 0.8},
        "shots": [{
            "id": 1,
            "outcome": "review",
            "confidence": 0.55,
            "release_frame": 30,
            "release_time": 1.0,
            "end_frame": 60,
            "release_speed_ms": None,
            "release_height_m": None,
            "entry_angle_deg": None,
            "arc_peak_m": None,
            "form": {"elbow": None, "knee": None, "shoulder": None, "hip": None},
            "flags": [],
            "evidence": {"rim_track_confidence": 0.0, "pose_confidence": 0.7},
        }],
    }
    (session_dir / "analysis.json").write_text(json.dumps(payload))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)

    response = TestClient(app).patch("/api/sessions/session-1/shots/1", json={"outcome": "miss"})

    assert response.status_code == 200
    assert response.json()["shots"][0]["outcome"] == "miss"
    correction = json.loads((session_dir / "corrections.json").read_text())
    assert correction["shots"]["1"]["outcome"] == "miss"
    assert json.loads((session_dir / "analysis.json").read_text())["shots"][0]["outcome"] == "review"


def test_manual_attempt_is_stored_as_user_evidence(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "session-2"
    session_dir.mkdir()
    payload = {
        "analysis_version": "2.0.0",
        "session": {"id": "session-2", "fps": 30},
        "quality": {"tier": "limited", "camera_motion": 0.0, "blur_score": 0.8, "pose_coverage": 0.8},
        "shots": [],
    }
    (session_dir / "analysis.json").write_text(json.dumps(payload))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)

    response = TestClient(app).post("/api/sessions/session-2/shots", json={"outcome": "miss", "release_frame": 45})

    assert response.status_code == 200
    assert response.json()["shots"][0]["evidence"]["manual"] is True
    stored = json.loads((session_dir / "corrections.json").read_text())
    assert stored["manual_shots"][0]["id"] == 1


def test_manual_attempt_can_be_corrected_without_rewriting_analysis(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "session-3"
    session_dir.mkdir()
    payload = {
        "analysis_version": "2.0.0",
        "session": {"id": "session-3", "fps": 30},
        "quality": {"tier": "limited", "camera_motion": 0.0, "blur_score": 0.8, "pose_coverage": 0.8},
        "shots": [],
    }
    original = json.dumps(payload)
    (session_dir / "analysis.json").write_text(original)
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)
    client = TestClient(app)

    assert client.post("/api/sessions/session-3/shots", json={"outcome": "miss", "release_frame": 45}).status_code == 200
    corrected = client.patch("/api/sessions/session-3/shots/1", json={"outcome": "make", "shooter_id": "player-1"})

    assert corrected.status_code == 200
    assert corrected.json()["shots"][0]["outcome"] == "make"
    assert corrected.json()["shots"][0]["evidence"]["shooter_id"] == "player-1"
    assert (session_dir / "analysis.json").read_text() == original
