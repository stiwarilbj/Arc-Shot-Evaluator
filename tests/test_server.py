import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

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
    assert "fast, normal, or deep" in response.json()["detail"]


def test_fast_analysis_mode_is_accepted_for_example_jobs(tmp_path, monkeypatch) -> None:
    (tmp_path / "sample.mp4").touch()
    monkeypatch.setattr(api_module, "EXAMPLE_FILES", ["sample.mp4"])
    monkeypatch.setattr(api_module, "EXAMPLE_VIDEOS_DIR", tmp_path)
    received = {}

    def capture_job(source, filename, processing_mode, shot_mode):
        received.update(source=source, filename=filename, processing_mode=processing_mode, shot_mode=shot_mode)
        return "queued-fast-job"

    monkeypatch.setattr(api_module, "queue_analysis_job", capture_job)
    response = TestClient(app).post("/api/examples/example-1/jobs?mode=fast")

    assert response.status_code == 200
    assert response.json() == {"job_id": "queued-fast-job"}
    assert received == {
        "source": tmp_path / "sample.mp4",
        "filename": "sample.mp4",
        "processing_mode": "fast",
        "shot_mode": "free_throw",
    }


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


def test_shot_review_checks_clip_frame_bounds_before_saving(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "review-bounds"
    session_dir.mkdir()
    (session_dir / "analysis.json").write_text(json.dumps({
        "session": {"id": session_dir.name, "fps": 30, "frame_count": 60},
        "shots": [{"id": 1, "outcome": "review", "release_frame": 10, "end_frame": 45}],
    }))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)
    original_result = json.loads((session_dir / "analysis.json").read_text())
    original_export = json.dumps(original_result["shots"][0]) + "\n"
    export_path = session_dir / "shots.jsonl"
    export_path.write_text(original_export)
    job = {"id": session_dir.name, "status": "done", "result": original_result}
    (session_dir / "job.json").write_text(json.dumps(job))
    monkeypatch.setitem(api_module.jobs, job["id"], job)
    client = TestClient(app)
    shots_url = f"/api/sessions/{session_dir.name}/shots"
    export_url = f"/media/{session_dir.name}/shots.jsonl"
    uncorrected = client.get(export_url)
    assert uncorrected.text == original_export
    assert uncorrected.headers["cache-control"] == "no-store"

    for invalid in (-1, 0.5, True, 60, 999999):
        assert client.patch(f"{shots_url}/1", json={"release_frame": invalid}).status_code == 400
        assert client.post(shots_url, json={"release_frame": invalid}).status_code == 400
    assert not (session_dir / "corrections.json").exists()

    corrected = client.patch(f"{shots_url}/1", json={"release_frame": 59})
    assert corrected.status_code == 200
    shot = corrected.json()["shots"][0]
    assert shot["release_frame"] == shot["end_frame"] == 59
    added = client.post(shots_url, json={"outcome": "miss", "release_frame": 0})
    assert added.status_code == 200
    assert next(shot for shot in added.json()["shots"] if shot["id"] == 2)["release_frame"] == 0
    exported = client.get(export_url)
    assert exported.status_code == 200
    assert [json.loads(line) for line in exported.text.splitlines()] == added.json()["shots"]
    assert exported.headers["cache-control"] == "no-store"
    assert export_path.read_text() == original_export
    job_url = f"/api/jobs/{session_dir.name}"
    assert client.get(job_url).json()["result"]["shots"] == added.json()["shots"]
    assert job["result"]["shots"] == original_result["shots"]
    monkeypatch.delitem(api_module.jobs, job["id"])
    assert client.get(job_url).json()["result"]["shots"] == added.json()["shots"]


def test_jump_shot_review_clears_labels_and_syncs_timing(tmp_path, monkeypatch) -> None:
    session_dir = tmp_path / "review-jump"
    session_dir.mkdir()
    original = {
        "session": {"id": session_dir.name, "fps": 25, "frame_count": 60},
        "shot_mode": "jump_shot",
        "shots": [{
            "id": 1, "outcome": "review", "release_frame": 30, "end_frame": 48,
            "evidence": {
                "shooter_id": "detected-shooter",
                "motion_events": {
                    "timing_available": True, "release_frame": 30, "takeoff_frame": 25,
                    "release_after_takeoff_ms": 200, "follow_through_end_frame": 45,
                    "follow_through_duration_ms": 600, "landing_frame": 43,
                },
                "mechanics_assessment": {"components": {"release_after_takeoff_ms": 200, "motion_type": "pull_up"}},
            },
        }],
    }
    source = json.dumps(original)
    (session_dir / "analysis.json").write_text(source)
    (session_dir / "shots.jsonl").write_text(json.dumps(original["shots"][0]) + "\n")
    (session_dir / "job.json").write_text(json.dumps({"id": session_dir.name, "status": "done", "result": original}))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)
    client = TestClient(app)
    url = f"/api/sessions/{session_dir.name}/shots/1"

    for frame in (True, -1, 26.5, 31, 60):
        assert client.patch(url, json={"takeoff_frame": frame}).status_code == 400
    for height in (True, 0.49, 2.81, "1.95"):
        assert client.patch(url, json={"player_height_m": height}).status_code == 400
    assert client.patch(url, json={"team_assignments": {"guard-1": ["opponent"]}}).status_code == 400
    assert not (session_dir / "corrections.json").exists()

    saved = client.patch(url, json={"shooter_id": None, "release_frame": 28, "takeoff_frame": 23})
    assert saved.status_code == 200
    shot = saved.json()["shots"][0]
    assert shot["release_frame"] == 28
    assert shot["evidence"]["shooter_id"] is None
    events = shot["evidence"]["motion_events"]
    assert (events["release_frame"], events["takeoff_frame"], events["release_after_takeoff_ms"]) == (28, 23, 200)
    assert events["follow_through_duration_ms"] == 680
    assert events["landing_frame"] == 43
    assert shot["evidence"]["mechanics_assessment"]["components"]["motion_type"] == "pull_up"
    assert client.patch(url, json={"takeoff_frame": 29}).status_code == 400
    assert client.get(f"/api/jobs/{session_dir.name}").json()["result"]["shots"][0] == shot
    assert client.get(f"/media/{session_dir.name}/shots.jsonl").json() == shot

    same_frame = client.patch(url, json={"takeoff_frame": 28}).json()["shots"][0]["evidence"]
    assert same_frame["motion_events"]["release_after_takeoff_ms"] == 0
    assert same_frame["mechanics_assessment"]["components"]["release_after_takeoff_ms"] == 0
    cleared = client.patch(url, json={"takeoff_frame": None}).json()["shots"][0]["evidence"]
    assert cleared["motion_events"]["takeoff_frame"] is None
    assert cleared["motion_events"]["release_after_takeoff_ms"] is None
    saved_height = client.patch(url, json={"player_height_m": 1.95}).json()["shots"][0]["evidence"]
    assert saved_height["player_height_m"] == 1.95
    cleared_height = client.patch(url, json={"player_height_m": None}).json()["shots"][0]["evidence"]
    assert cleared_height["player_height_m"] is None
    assert client.get(f"/api/jobs/{session_dir.name}").json()["result"]["shots"][0]["evidence"]["player_height_m"] is None
    assert (session_dir / "analysis.json").read_text() == source


def test_jump_shot_defender_labels_reopen_separately_from_tracking_evidence(tmp_path, monkeypatch) -> None:
    session_id = "defender-review"
    session_dir = tmp_path / session_id
    session_dir.mkdir()
    tracked = {"id": "guard-2", "role": "opponent", "evidence_frames": [28]}
    original = {
        "session": {"id": session_id, "fps": 30, "frame_count": 90},
        "shot_mode": "jump_shot",
        "shots": [{"id": 1, "outcome": "review", "release_frame": 30, "evidence": {"defenders": [tracked]}}],
    }
    source = json.dumps(original)
    (session_dir / "analysis.json").write_text(source)
    (session_dir / "shots.jsonl").write_text(json.dumps(original["shots"][0]) + "\n")
    (session_dir / "job.json").write_text(json.dumps({"id": session_id, "status": "done", "result": original}))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)
    client = TestClient(app)
    url = f"/api/sessions/{session_id}/shots/1"

    def check_review(changes, labels, defenders):
        response = client.patch(url, json=changes)
        assert response.status_code == 200
        shot = response.json()["shots"][0]
        assert shot["evidence"]["defender_ids"] == labels
        assert shot["evidence"]["defenders"] == defenders
        assert client.get(f"/api/jobs/{session_id}").json()["result"]["shots"][0] == shot
        assert client.get(f"/media/{session_id}/shots.jsonl").json() == shot

    labels = ["guard-2", "guard-manual"]
    check_review({"defender_ids": labels}, labels, [tracked])
    check_review({"defender_ids": []}, [], [])
    check_review({"defender_ids": labels}, labels, [tracked])
    for role in ("official", "teammate", "opponent"):
        check_review({"team_assignments": {"guard-2": role}}, labels, [tracked] if role == "opponent" else [])
    check_review({"outcome": "miss"}, labels, [tracked])
    assert (session_dir / "analysis.json").read_text() == source


def test_jump_shot_classification_survives_calibration_and_drives_summary(tmp_path, monkeypatch) -> None:
    session_id = "classification-review"
    session_dir = tmp_path / session_id
    session_dir.mkdir()
    original = {
        "session": {"id": session_id, "fps": 30, "frame_count": 90},
        "shot_mode": "jump_shot",
        "shots": [
            {"id": 1, "outcome": "make", "release_frame": 20,
             "evidence": {"takeoff_image": [99, 50], "rim_image": [0, 0]}},
            {"id": 2, "outcome": "review", "release_frame": 45, "evidence": {"shot_type": "three_pointer"}},
        ],
    }
    source = json.dumps(original)
    (session_dir / "analysis.json").write_text(source)
    (session_dir / "shots.jsonl").write_text("".join(json.dumps(shot) + "\n" for shot in original["shots"]))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)
    client = TestClient(app)
    url = f"/api/sessions/{session_id}"
    calibration = {
        "preset": "nba", "image_points": [[0, 0], [100, 0], [100, 100], [0, 100]],
        "world_points": [[0, 0], [10, 0], [10, 10], [0, 10]], "basket_ground_image": [0, 0],
    }
    calibrated = client.patch(f"{url}/context", json={"court_calibration": calibration}).json()
    assert calibrated["shots"][0]["evidence"]["shot_type"] == "three_pointer"
    assert calibrated["summary"]["observed_three_pct"] == 100.0

    for excluded_type in ("layup", "dunk", "pass", "pump_fake"):
        reviewed = client.patch(f"{url}/shots/1", json={"shot_type": excluded_type}).json()
        assert reviewed["summary"]["attempts"] == 1
        assert reviewed["summary"]["excluded_attempts"] == 1
        assert reviewed["summary"]["best_streak"] == 0
        assert reviewed["summary"]["observed_fg_pct"] is None
        assert reviewed["summary"]["observed_three_pct"] is None
        evidence = reviewed["shots"][0]["evidence"]
        assert evidence["shot_type"] == excluded_type
        assert evidence["statistics_eligibility"]["status"] == "excluded"
        assert evidence["distance"]["shot_type"] == "three_pointer"

    calibration["world_points"] = [[0, 0], [5, 0], [5, 5], [0, 5]]
    recalibrated = client.patch(f"{url}/context", json={"court_calibration": calibration}).json()
    assert recalibrated["shots"][0]["evidence"]["shot_type"] == "pump_fake"
    assert recalibrated["shots"][0]["evidence"]["distance"]["shot_type"] == "mid_range"
    reopened = client.get(url).json()
    assert reopened["summary"] == recalibrated["summary"]
    assert [json.loads(line) for line in client.get(f"/media/{session_id}/shots.jsonl").text.splitlines()] == reopened["shots"]

    missed = client.patch(f"{url}/shots/2", json={"outcome": "miss"}).json()
    assert missed["summary"]["observed_three_pct"] == 0.0
    restored = client.patch(f"{url}/shots/1", json={"shot_type": "three_pointer"}).json()
    assert restored["summary"]["excluded_attempts"] == 0
    assert restored["summary"]["attempts"] == 2
    assert restored["summary"]["observed_three_pct"] == 50.0
    assert restored["shots"][0]["evidence"]["statistics_eligibility"]["status"] == "eligible_pending_validation"
    assert (session_dir / "analysis.json").read_text() == source


def test_simultaneous_review_mutations_preserve_every_change(tmp_path, monkeypatch) -> None:
    session_id = "concurrent-review"
    session_dir = tmp_path / session_id
    session_dir.mkdir()
    (session_dir / "analysis.json").write_text(json.dumps({
        "session": {"id": session_id, "fps": 30, "frame_count": 120},
        "shots": [{"id": 1, "outcome": "review", "release_frame": 10}],
    }))
    corrections = session_dir / "corrections.json"
    corrections.write_text('{"version": 1, "shots": {}}')
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)
    read_text = Path.read_text

    def slow_corrections_read(path, *args, **kwargs):
        content = read_text(path, *args, **kwargs)
        if path == corrections:
            time.sleep(0.02)
        return content

    monkeypatch.setattr(Path, "read_text", slow_corrections_read)
    calls = [
        (api_module.correct_saved_shot, (session_id, 1, {"outcome": "make"})),
        (api_module.correct_saved_shot, (session_id, 1, {"release_frame": 17})),
        (api_module.update_session_context, (session_id, {"player_heights": {"player-1": 1.9}})),
        *((api_module.add_manual_shot, (session_id, {"release_frame": frame})) for frame in (30, 60, 90)),
    ]
    start = Barrier(len(calls))

    def run(call):
        handler, args = call
        start.wait(timeout=5)
        return handler(*args)

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        list(pool.map(run, calls))

    result = api_module.get_session_by_id(session_id)
    shots = {shot["id"]: shot for shot in result["shots"]}
    assert shots[1]["outcome"] == "make"
    assert shots[1]["release_frame"] == 17
    assert set(shots) == {1, 2, 3, 4}
    assert {shot["release_frame"] for shot in shots.values()} == {17, 30, 60, 90}
    assert result["context"]["player_heights"] == {"player-1": 1.9}


def test_manual_miss_breaks_a_streak_at_its_release_frame(tmp_path, monkeypatch) -> None:
    session_id = "review-streak"
    session_dir = tmp_path / session_id
    session_dir.mkdir()
    (session_dir / "analysis.json").write_text(json.dumps({
        "session": {"id": session_id, "fps": 30, "frame_count": 120},
        "shots": [
            {"id": 1, "outcome": "make", "release_frame": 10},
            {"id": 2, "outcome": "make", "release_frame": 80},
        ],
    }))
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)
    client = TestClient(app)

    assert client.get(f"/api/sessions/{session_id}").json()["summary"]["best_streak"] == 2
    added = client.post(f"/api/sessions/{session_id}/shots", json={"outcome": "miss", "release_frame": 45})
    assert added.status_code == 200
    result = added.json()
    assert [shot["id"] for shot in result["shots"]] == [1, 2, 3]
    assert result["summary"]["best_streak"] == 1


def test_damaged_review_file_is_preserved_when_saving(tmp_path, monkeypatch) -> None:
    session_id = "damaged-review"
    session_dir = tmp_path / session_id
    session_dir.mkdir()
    (session_dir / "analysis.json").write_text(json.dumps({
        "session": {"id": session_id, "fps": 30, "frame_count": 120},
        "shots": [{"id": 1, "outcome": "review", "release_frame": 10}],
    }))
    damaged = session_dir / "corrections.json"
    damaged.write_text('{"version": 2, "shots":')
    monkeypatch.setattr(api_module, "ANALYSIS_SESSIONS_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "ANALYSIS_SESSIONS_DIR", tmp_path)

    result = TestClient(app).patch(f"/api/sessions/{session_id}/shots/1", json={"outcome": "make"})
    assert result.status_code == 409
    assert "preserved" in result.json()["detail"]
    assert damaged.read_text() == '{"version": 2, "shots":'
