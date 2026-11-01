"""Real native correction-cache parity check; no publication or saved media."""

from copy import deepcopy
import json
from pathlib import Path
import shutil
import tempfile
import time
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import torch
from sam2.sam2_video_predictor import SAM2VideoPredictor
from ultralytics import YOLO
from backend import config
from backend.jumper import pipeline

source = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/jumper-regression-short.mp4")
device = sys.argv[2] if len(sys.argv) > 2 else "cpu"
torch.set_num_threads(4)
if device == "mps":
    torch.mps.set_per_process_memory_fraction(0.5)
counts = {"vision": 0, "detection": 0, "prompts": 0}
forward, predict, prompt = (
    SAM2VideoPredictor.forward_image,
    YOLO.predict,
    SAM2VideoPredictor.add_new_points_or_box,
)


def vision(self, *args, **kwargs):
    counts["vision"] += 1
    return forward(self, *args, **kwargs)


def detect(self, *args, **kwargs):
    counts["detection"] += 1
    return predict(self, *args, **kwargs)


def points(self, *args, **kwargs):
    counts["prompts"] += 1
    return prompt(self, *args, **kwargs)


(
    SAM2VideoPredictor.forward_image,
    YOLO.predict,
    SAM2VideoPredictor.add_new_points_or_box,
) = vision, detect, points
with tempfile.TemporaryDirectory(prefix="arc-jumper-cache-") as temporary:
    root = Path(temporary)
    config.PROJECT_ROOT = root
    frames = pipeline.extract(source, root / "frames", 0, 0.3)
    job = dict(
        start=0,
        end=0.3,
        target_id=1,
        auto_detect_others=True,
        presentation="silhouette",
        objects=[
            dict(id=1, prompts=[dict(frame=0, points=[[0.485, 0.482]], labels=[1])])
        ],
    )
    checkpoint = config.MODEL_WEIGHTS_DIR / "sam2.1_hiera_tiny.pt"
    results = []
    cases = [("cold", False), ("warm", False)]
    if device == "cpu":
        cases += [("corrected-warm", True), ("corrected-cold", True)]
    for name, corrected in cases:
        if name == "corrected-cold":
            shutil.rmtree(root / "jumper-media")
        value = deepcopy(job)
        if corrected:
            value["objects"][0]["prompts"].append(
                dict(frame=3, points=[[0.45, 0.482]], labels=[0])
            )
        for key in counts:
            counts[key] = 0
        started = time.monotonic()
        warnings = pipeline.track(
            frames, root / name, value, checkpoint, device, cache_source=source
        )
        masks = [
            np.load(p, allow_pickle=False) for p in sorted((root / name).glob("*.npy"))
        ]
        item = dict(
            name=name,
            seconds=time.monotonic() - started,
            counts=dict(counts),
            warnings=warnings,
        )
        print(json.dumps(item), flush=True)
        results.append((item, masks))
    assert results[0][0]["counts"]["vision"] > 0
    assert results[1][0]["counts"]["detection"] == 0, "Detection cache missed"
    for a, b in zip(results[0][1], results[1][1]):
        np.testing.assert_array_equal(a, b)
    if device == "cpu":
        assert results[1][0]["counts"]["vision"] == 0, "Encoder cache missed"
        assert results[2][0]["counts"]["vision"] == 0
        assert results[2][0]["counts"]["detection"] == 0
        assert results[2][0]["counts"]["prompts"] > results[1][0]["counts"]["prompts"]
        for a, b in zip(results[2][1], results[3][1]):
            np.testing.assert_array_equal(a, b)
        assert any(
            not np.array_equal(a, b) for a, b in zip(results[0][1], results[2][1])
        ), "Correction did not affect masks"
    else:
        assert results[1][0]["counts"]["vision"] > 0, (
            "Unverified native GPU encoder was reused"
        )
    print(
        "PASS native cold/warm parity, verified encoder/detector reuse, tracking rebuilt; private temporary cache cleaned"
    )
