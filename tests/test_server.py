from fastapi.testclient import TestClient

from backend.api.app import ANALYSIS_WORKERS, app


def test_health_reports_local_models() -> None:
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "local_only": True, "models_ready": True}


def test_analysis_executor_allows_concurrent_workers() -> None:
    assert ANALYSIS_WORKERS >= 2


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
