"""Per-player visible-mask diagnostics, kept equivalent to maskQuality.ts."""
import math
import numpy as np
from .mask_outline import outline_changes


def mask_extents(owners):
    height, width = owners.shape
    ys, xs = np.nonzero(owners)
    ids = owners[ys, xs]
    areas = np.bincount(ids, minlength=256)
    sum_x = np.bincount(ids, weights=xs, minlength=256)
    sum_y = np.bincount(ids, weights=ys, minlength=256)
    left, top = np.full(256, width), np.full(256, height)
    right, bottom = np.zeros(256, dtype=int), np.zeros(256, dtype=int)
    np.minimum.at(left, ids, xs)
    np.minimum.at(top, ids, ys)
    np.maximum.at(right, ids, xs + 1)
    np.maximum.at(bottom, ids, ys + 1)
    return {int(i): dict(area=int(areas[i]), x=sum_x[i] / (areas[i] * width),
                        y=sum_y[i] / (areas[i] * height),
                        bounds=[left[i] / width, top[i] / height, right[i] / width, bottom[i] / height])
            for i in np.flatnonzero(areas[1:]) + 1}


def leaving(a, b, width, height):
    # A clipped mask alone is insufficient: require observed outward motion.
    mx, my = max(2 / width, .015), max(2 / height, .015)
    ab, bb = a["bounds"], b["bounds"]
    horizontal = bb[3] - bb[1] >= (ab[3] - ab[1]) * .8 and abs(b["y"] - a["y"]) <= .05
    vertical = bb[2] - bb[0] >= (ab[2] - ab[0]) * .8 and abs(b["x"] - a["x"]) <= .05
    if b["area"] > a["area"] * 1.15:
        return False
    return bool((horizontal and (
        (ab[0] <= mx and bb[0] <= 1 / width and b["x"] < a["x"] - .5 / width) or
        (ab[2] >= 1 - mx and bb[2] >= 1 - 1 / width and b["x"] > a["x"] + .5 / width)
    )) or (vertical and (
        (ab[1] <= my and bb[1] <= 1 / height and b["y"] < a["y"] - .5 / height) or
        (ab[3] >= 1 - my and bb[3] >= 1 - 1 / height and b["y"] > a["y"] + .5 / height)
    )))


def shrunk(a, b):
    ab, bb = a["bounds"], b["bounds"]
    return (b["area"] / a["area"] < .65 or
            (bb[3] - bb[1]) / (ab[3] - ab[1]) < .75 or
            (bb[2] - bb[0]) / (ab[2] - ab[0]) < .55)


class MaskQuality:
    def __init__(self):
        self.states = {}
        self.previous_owners = None
        self.previous_frame = -2

    def inspect(self, frame, owners, tracks, target, reset=False, invisible=()):
        height, width = owners.shape
        extents = mask_extents(owners)
        warnings = []
        for track in tracks:
            if track.get("ignored") or frame < track["prompts"][0]["frame"]:
                continue
            identity = track["id"]
            if identity in invisible:
                self.states.pop(identity, None)
                continue
            state = self.states.setdefault(identity, dict(exiting=False, exited=False))
            current, previous = extents.get(identity), state.get("previous")

            def warn(at, kind):
                warnings.append(dict(frame=at, kind=kind, track_ids=[identity]))

            if current is None:
                state["exited"] = state["exited"] or state["exiting"]
                if not state["exited"]:
                    warn(frame, "target_lost" if identity == target else "player_lost")
                state.update(previous=None, exiting=False, shrink=None)
            else:
                recovering_shrink = bool(state.get("shrink"))
                exit_frame = previous is not None and leaving(previous, current, width, height)
                unstable = previous and (
                    current["area"] / previous["area"] < .35 or
                    current["area"] / previous["area"] > 2.8 or
                    math.hypot(current["x"] - previous["x"], current["y"] - previous["y"]) > .2)
                if previous and not exit_frame and unstable:
                    warn(frame, "tracking_unstable")
                    state["shrink"] = None
                elif previous and not exit_frame and shrunk(state.get("shrink") or previous, current):
                    # Confirm on a second frame; retain the first affected frame.
                    if state.get("shrink"):
                        first = state.pop("shrink_frame", None)
                        if first is not None:
                            warn(first, "tracking_unstable")
                        warn(frame, "tracking_unstable")
                    else:
                        state.update(shrink=previous, shrink_frame=frame)
                else:
                    state["shrink"] = None
                # Large truncations retain their existing persistence rule.
                if (previous and not exit_frame and not leaving(current, previous, width, height)
                        and not unstable and not shrunk(previous, current)
                        and not recovering_shrink and not reset
                        and self.previous_frame == frame - 1 and self.previous_owners is not None
                        and self.previous_owners.shape == owners.shape
                        and not any(p["frame"] == frame for p in track["prompts"])):
                    changes = outline_changes(self.previous_owners, owners, identity, previous, current)
                    if changes["outline"]:
                        warn(frame, "outline_changed")
                    if changes["fragmented"]:
                        warn(frame, "mask_fragmented")
                state.update(previous=current, exiting=bool(exit_frame), exited=False)
        self.previous_owners = owners.copy()
        self.previous_frame = frame
        return warnings
