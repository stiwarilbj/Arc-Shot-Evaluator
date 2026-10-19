"""Real subprocess pipe pressure, bounded diagnostics and cleanup regressions."""

import subprocess
import sys
import threading

import pytest

from backend.jumper.subprocess_output import DIAGNOSTIC_BYTES, diagnostic_process


def python(code):
    return [sys.executable, "-c", code]


def test_drains_more_than_pipe_capacity_while_sending_frames():
    # A child that logs before reading stdin deadlocks a parent that waits to
    # consume stderr until after sending all frames. The watchdog bounds failure.
    payload = b"f" * (1024 * 1024)
    with diagnostic_process(python('''
import sys
sys.stderr.buffer.write(b'x' * (5 * 1024 * 1024))
sys.stderr.buffer.flush()
data = sys.stdin.buffer.read()
sys.stderr.buffer.write(('received=' + str(len(data))).encode())
'''), stdin=subprocess.PIPE) as (process, tail):
        expired = threading.Event()
        def stop():
            expired.set()
            process.kill()
        timer = threading.Timer(5, stop)
        timer.start()
        try:
            process.stdin.write(payload)
            process.stdin.close()
            assert process.wait(timeout=5) == 0
            text = tail.finish()
            assert not expired.is_set()
            assert len(tail.data) == DIAGNOSTIC_BYTES
            assert text.endswith("received=1048576")
            assert process.stderr.closed
        finally:
            timer.cancel()
    assert not tail.reader.is_alive()


def test_keeps_final_unterminated_and_invalid_utf8_diagnostics():
    with diagnostic_process(python("import sys; sys.stderr.buffer.write(b'bad\\xff final'); sys.exit(7)")) as (process, tail):
        assert process.wait(timeout=5) == 7
        assert tail.finish() == "bad\ufffd final"
    assert not tail.reader.is_alive()


@pytest.mark.parametrize("failure", ["cancel", "timeout"])
def test_exception_kills_child_joins_reader_and_closes_streams(failure):
    error = InterruptedError if failure == "cancel" else subprocess.TimeoutExpired
    with pytest.raises(error):
        with diagnostic_process(python("import sys,time; sys.stderr.write('tracking'); sys.stderr.flush(); time.sleep(60)"),
                                stdin=subprocess.PIPE) as (process, tail):
            if failure == "cancel":
                raise InterruptedError("cancelled")
            process.wait(timeout=.1)
    assert process.poll() is not None
    assert process.stderr.closed
    assert process.stdin.closed
    assert not tail.reader.is_alive()


def test_ffmpeg_extraction_failure_retains_only_recent_diagnostics(tmp_path, monkeypatch):
    from backend.jumper import pipeline
    wrapper = tmp_path / "noisy-ffmpeg"
    wrapper.write_text(f"#!{sys.executable}\nimport sys\nsys.stderr.buffer.write(b'x' * (2 * 1024 * 1024) + b'FINAL FAILURE')\nsys.exit(1)\n")
    wrapper.chmod(0o700)
    monkeypatch.setattr(pipeline.imageio_ffmpeg, "get_ffmpeg_exe", lambda: str(wrapper))
    with pytest.raises(RuntimeError) as error:
        pipeline.run_ffmpeg([])
    assert len(str(error.value)) == 2000
    assert str(error.value).endswith("FINAL FAILURE")


def test_real_encoder_failure_contains_ffmpeg_diagnostics(tmp_path):
    from backend.jumper.pipeline import encoder
    with pytest.raises(RuntimeError) as error:
        with encoder(tmp_path / "video.unsupported-container", 64, 48) as stream:
            stream.write(bytes(64 * 48 * 3))
    assert "video.unsupported-container" in str(error.value)
    assert len(str(error.value)) <= 2000


def test_reader_start_failure_reaps_child(monkeypatch):
    from backend.jumper import subprocess_output
    launched = []
    original = subprocess.Popen
    def launch(*args, **kwargs):
        process = original(*args, **kwargs)
        launched.append(process)
        return process
    monkeypatch.setattr(subprocess_output.subprocess, "Popen", launch)
    def fail(_):
        raise RuntimeError("thread unavailable")
    monkeypatch.setattr(threading.Thread, "start", fail)
    with pytest.raises(RuntimeError, match="thread unavailable"):
        with diagnostic_process(python("import time; time.sleep(60)"), stdin=subprocess.PIPE):
            pytest.fail("must not yield")
    assert launched[0].poll() is not None
    assert launched[0].stdin.closed and launched[0].stderr.closed
