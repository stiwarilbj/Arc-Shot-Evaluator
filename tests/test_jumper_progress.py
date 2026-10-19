"""Progress coalescing must not delay stage boundaries or terminal status."""
import json

import pytest

from backend.jumper import runner


@pytest.fixture
def progress(tmp_path, monkeypatch):
    clock = [100.0]
    writes = []
    original = runner.write

    def recording(path, value):
        writes.append(dict(value))
        original(path, value)

    monkeypatch.setattr(runner.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(runner, "write", recording)
    writer = runner.ProgressWriter(tmp_path / "progress.json")
    return writer, clock, writes


def test_small_increases_accumulate_from_last_publication(progress):
    writer, _, writes = progress
    writer("Tracking", 0, 1000)
    for done in range(1, 10):
        writer("Tracking", done, 1000)
    assert len(writes) == 1
    writer("Tracking", 10, 1000)
    assert len(writes) == 2
    assert writes[-1]["progress"] == 0.01
    assert json.loads(writer.path.read_text()) == writes[-1]
    assert not writer.path.with_suffix(".tmp").exists()


def test_elapsed_interval_publishes_latest_small_change(progress):
    writer, clock, writes = progress
    writer("Tracking")
    clock[0] += 0.249
    writer("Tracking", 1, 1000)
    assert len(writes) == 1
    clock[0] = 100.25
    writer("Tracking", 2, 1000)
    assert len(writes) == 2
    assert writes[-1]["progress"] == 0.002


def test_stage_reset_and_subthreshold_completion_publish_immediately(progress):
    writer, _, writes = progress
    writer("Tracking", 995, 1000)
    writer("Tracking", 1000, 1000)
    writer("Rendering")
    writer("Ready for review", 1)
    assert writes == [
        {"stage": "Tracking", "progress": 0.995},
        {"stage": "Tracking", "progress": 1},
        {"stage": "Rendering", "progress": 0},
        {"stage": "Ready for review", "progress": 1},
    ]


def test_identical_callbacks_do_not_rewrite_even_after_interval(progress):
    writer, clock, writes = progress
    writer("Download", 10, 0)
    for _ in range(50):
        clock[0] += 1
        writer("Download", 10, 0)
    writer.flush()
    assert len(writes) == 1


def test_failed_write_does_not_advance_publication_state(progress, monkeypatch):
    writer, _, writes = progress
    writer("Tracking")
    original = runner.write

    def fail(*args):
        raise OSError("disk unavailable")

    monkeypatch.setattr(runner, "write", fail)
    with pytest.raises(OSError):
        writer("Rendering")
    assert writer.published == writes[0]
    monkeypatch.setattr(runner, "write", original)
    writer("Rendering")
    assert writes[-1]["stage"] == "Rendering"


def test_writers_have_independent_stage_and_clock_state(progress, tmp_path):
    writer, _, writes = progress
    writer("Tracking")
    other = runner.ProgressWriter(tmp_path / "other.json")
    other("Tracking", 1, 1000)
    assert len(writes) == 2
    assert other.published["progress"] == 0.001
    assert writer.published["progress"] == 0


@pytest.mark.parametrize("flush_fails", [False, True])
def test_error_file_is_immediate_and_pending_status_is_flushed(
    tmp_path, monkeypatch, flush_fails
):
    (tmp_path / "request.json").write_text("{}")
    monkeypatch.setattr(runner.time, "monotonic", lambda: 100)
    publisher = runner.ProgressWriter(tmp_path / "progress.json")
    monkeypatch.setattr(runner, "ProgressWriter", lambda _: publisher)
    original = runner.write

    def writing(path, value):
        if path.name == "progress.json" and value["progress"] > 0:
            assert (tmp_path / "error.json").exists()
            if flush_fails:
                raise OSError("status disk error")
        original(path, value)

    monkeypatch.setattr(runner, "write", writing)

    def fail(*args, **kwargs):
        publisher("Checking device resources", 1, 1000)
        raise RuntimeError("processing failure")

    monkeypatch.setattr(runner, "estimate_resources", fail)
    with pytest.raises(RuntimeError, match="processing failure"):
        runner.run(tmp_path)
    assert json.loads((tmp_path / "error.json").read_text()) == {"error": "processing failure"}
    assert json.loads(publisher.path.read_text())["progress"] == (0 if flush_fails else 0.001)
    assert not (tmp_path / "result.json").exists()
