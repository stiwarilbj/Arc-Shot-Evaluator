"""Run real native segmentation once, inject export failure, verify export-only retry."""

import json
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.jumper import runner
from backend import config

source = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/jumper-regression-short.mp4")
tracking, rendering = runner.track, runner.render
calls = {"tracking": 0, "rendering": 0}


def track(*args, **kwargs):
    calls["tracking"] += 1
    args = list(args)
    args[4] = "cpu"  # deterministic integration fixture, including real detection
    return tracking(*args, **kwargs)


def render(*args, **kwargs):
    calls["rendering"] += 1
    result = rendering(*args, **kwargs)
    if calls["rendering"] == 1:
        raise RuntimeError("injected export finalization failure")
    assert calls["tracking"] == 1
    return result


runner.track, runner.render = track, render
with tempfile.TemporaryDirectory(prefix="arc-jumper-export-") as temporary:
    directory = Path(temporary)
    shutil.copyfile(source, directory / "source")
    # Keep fixture cache private to this test, with installed weights unchanged.
    config.PROJECT_ROOT = directory
    request = dict(
        start=0,
        end=0.3,
        target_id=1,
        auto_detect_others=True,
        presentation="silhouette",
        objects=[
            dict(id=1, prompts=[dict(frame=0, points=[[0.485, 0.482]], labels=[1])])
        ],
    )
    (directory / "request.json").write_text(json.dumps(request))
    runner.run(directory)
    result = json.loads((directory / "result.json").read_text())
    assert calls == {"tracking": 1, "rendering": 2}
    assert result["duration"] == 0.3
    assert result["warnings"] == []
    assert result["outputs"]["quiz"] == result["outputs"]["reveal"]
    shutil.copyfile(
        directory / "output" / result["outputs"]["quiz"]["file"],
        "/tmp/jumper-export-native.mp4",
    )
    print(
        json.dumps(
            dict(calls=calls, duration=result["duration"], warnings=result["warnings"])
        )
    )
print(
    "PASS real native masks reused after injected export failure; temporary checkpoint cleaned"
)
