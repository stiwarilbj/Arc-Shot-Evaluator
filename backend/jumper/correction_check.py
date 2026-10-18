"""Verify explicit points against final visible track labels, not raw logits."""
import math


def check_corrections(frame, owners, tracks):
    height, width = owners.shape
    warnings = []
    for track in tracks:
        if track.get("ignored"):
            continue
        include_missed = exclude_failed = False
        for prompt in track["prompts"]:
            if prompt["frame"] != frame:
                continue
            for index, point in enumerate(prompt.get("points", [])):
                x = min(width - 1, math.floor(point[0] * width))
                y = min(height - 1, math.floor(point[1] * height))
                belongs = owners[y, x] == track["id"]
                label = prompt["labels"][index]
                if label == 1 and not belongs:
                    include_missed = True
                if label == 0 and belongs:
                    exclude_failed = True
        for failed, kind in ((include_missed, "correction_include_missed"),
                             (exclude_failed, "correction_exclude_failed")):
            if failed:
                warnings.append(dict(frame=frame, kind=kind, track_ids=[track["id"]]))
    return warnings
