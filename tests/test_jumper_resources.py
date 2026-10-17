from copy import deepcopy
import json

import pytest

from backend.jumper.resources import MIB, check_resources, estimate_resources


def job():
    return {
        "start": 0,
        "end": 3,
        "target_id": 1,
        "auto_detect_others": True,
        "objects": [{"id": 1, "prompts": [{"frame": 0}]}],
    }


def test_resource_boundary_and_growth(monkeypatch):
    estimate = estimate_resources(job())
    required = estimate["bytes"] + 512 * MIB
    check_resources(estimate, available=required)
    with pytest.raises(ValueError, match="shorten the segment"):
        check_resources(estimate, available=required - 1)
    check_resources(estimate, available=512 * MIB, previous_bytes=estimate["bytes"])
    larger = deepcopy(job())
    larger["objects"] *= 20
    growth = estimate_resources(larger)
    assert growth["bytes"] > estimate["bytes"]
    with pytest.raises(ValueError):
        check_resources(growth, available=512 * MIB, previous_bytes=estimate["bytes"])
    monkeypatch.setattr("backend.jumper.resources.available_memory", lambda: None)
    check_resources(estimate)  # Unknown capacity must not disable processing.


def test_resource_failure_precedes_decode_and_models(tmp_path, monkeypatch):
    from backend.jumper import runner

    (tmp_path / "request.json").write_text(json.dumps(job()))

    def reject(_, **kwargs):
        raise ValueError("Not enough memory; shorten the segment")

    monkeypatch.setattr(runner, "check_resources", reject)
    monkeypatch.setattr(
        runner, "extract", lambda *args: pytest.fail("decoded before preflight")
    )
    with pytest.raises(ValueError, match="shorten"):
        runner.run(tmp_path)
    assert "shorten" in json.loads((tmp_path / "error.json").read_text())["error"]
    assert not (tmp_path / "frames").exists()
