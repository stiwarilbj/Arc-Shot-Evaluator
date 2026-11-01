"""Independent shooter tracking audit. Never changes the rendered masks."""

from math import ceil
import numpy as np

CHECK_SIZE = 128


def valid_tracking_check(result):
    check = result.get("tracking_check")
    if not isinstance(check, dict):
        return False
    keys = ("anchor_frame", "checked_frames", "disagreement_frames", "target_id")
    if any(type(check.get(key)) is not int for key in keys):
        return False
    flagged = [
        w for w in result["warnings"]
        if isinstance(w, dict) and w.get("kind") == "tracking_disagreement"
    ]
    return (
        0 < check["anchor_frame"] < ceil(result["duration"] * 30)
        and check["checked_frames"] == check["anchor_frame"] + 1
        and all(
            type(w.get("frame")) is int
            and 0 <= w["frame"] <= check["anchor_frame"]
            and w.get("track_ids") == [check["target_id"]]
            for w in flagged
        )
        and check["disagreement_frames"] == len({w["frame"] for w in flagged})
        and any(
            o.get("id") == check["target_id"] and not o.get("ignored")
            for o in result["objects"] if isinstance(o, dict)
        )
    )


def confirmed_shooter_frame(objects, target):
    segments = tracking_check_segments(objects, target)
    return segments[-1]["anchor"] if segments else None


def tracking_check_segments(objects, target):
    shooter = next(o for o in objects if o["id"] == target)
    anchors = [
        p["frame"] for p in shooter["prompts"]
        if p["frame"] > 0 and (p.get("box") or 1 in p.get("labels", []))
    ]
    return [
        dict(anchor=anchor, first=anchors[i - 1] + 1 if i else 0)
        for i, anchor in enumerate(anchors)
    ]


def sample_mask(values):
    height, width = values.shape
    centers = np.arange(CHECK_SIZE) + .5
    ys = np.minimum(height - 1, np.floor(centers * height / CHECK_SIZE).astype(int))
    xs = np.minimum(width - 1, np.floor(centers * width / CHECK_SIZE).astype(int))
    return (values[np.ix_(ys, xs)] > 0).astype(np.uint8)


def masks_disagree(a, b):
    if a.shape != b.shape:
        raise ValueError("Tracking check mask sizes differ")
    union = np.count_nonzero(a | b)
    intersection = np.count_nonzero(a & b)
    return bool(union >= 16 and intersection * 5 < union * 3)


class ShooterTrackingCheck:
    def __init__(self, anchor, target):
        self.anchor, self.target = anchor, target
        self.forward, self.checked, self.disagreements = {}, set(), set()

    def record(self, frame, values):
        if frame <= self.anchor:
            self.forward[frame] = sample_mask(values)

    def compare(self, frame, values):
        if frame not in self.forward:
            raise ValueError("Forward tracking check frame is missing")
        if masks_disagree(self.forward.pop(frame), sample_mask(values)):
            self.disagreements.add(frame)
        self.checked.add(frame)

    def finish(self):
        if len(self.checked) != self.anchor + 1 or self.forward:
            raise ValueError("Backward shooter check did not finish · Retry processing")
        return dict(
            tracking_check=dict(
                anchor_frame=self.anchor, target_id=self.target,
                checked_frames=len(self.checked),
                disagreement_frames=len(self.disagreements),
            ),
            warnings=[
                dict(frame=f, kind="tracking_disagreement", track_ids=[self.target])
                for f in sorted(self.disagreements)
            ],
        )
