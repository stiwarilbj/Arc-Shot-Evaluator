"""One-to-one mask association, equivalent to the browser discovery helper."""

import numpy as np


def clicked_person_box(boxes, point):
    matches = [
        box
        for box in boxes
        if box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]
    ]
    return list(matches[0]) if len(matches) == 1 else None


def require_shooter_box(boxes, points, labels):
    """Match the browser's automatic-selection gate; negatives refine masks only."""
    included = [p for p, label in zip(points, labels) if label == 1]
    matches = [
        box
        for box in boxes
        if included
        and all(
            box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]
            for p in included
        )
    ]
    if len(matches) > 1:
        raise ValueError(
            "Your selection overlaps more than one detected player. Add another Include point on a part of the shooter away from the other player in the first frame."
        )
    if not matches:
        raise ValueError(
            "Your points do not identify one detected player. Clear the first-frame points and click inside the shooter again. If detection keeps missing them, use manual selection under corrections and check the silhouette preview."
        )
    return list(matches[0])


def _associate_people(boxes, owners):
    """Match the browser's occupied-pixel evidence and uncertainty handling."""
    import math

    height, width = owners.shape
    areas = np.bincount(owners.ravel(), minlength=256)
    pairs = []
    ambiguous_tracks, uncertain_boxes = set(), set()
    for index, box in enumerate(boxes):
        # Half-open boxes include pixels by center, identically to the browser.
        x1 = max(0, min(width, math.ceil(box[0] * width - 0.5)))
        y1 = max(0, min(height, math.ceil(box[1] * height - 0.5)))
        x2 = max(x1, min(width, math.ceil(box[2] * width - 0.5)))
        y2 = max(y1, min(height, math.ceil(box[3] * height - 0.5)))
        box_area = (x2 - x1) * (y2 - y1)
        if not box_area:
            uncertain_boxes.add(index)
            continue
        occupied = np.bincount(owners[y1:y2, x1:x2].ravel(), minlength=256)
        weak, strong = [], []
        for identity in np.flatnonzero(occupied[1:]) + 1:
            identity = int(identity)
            intersection = int(occupied[identity])
            score = intersection / (int(areas[identity]) + box_area - intersection)
            mask_coverage = intersection / int(areas[identity])
            box_coverage = intersection / box_area
            if box_coverage >= 0.1 and (score >= 0.25 or mask_coverage >= 0.65):
                strong.append((index, identity, score))
            elif mask_coverage >= 0.1 or box_coverage >= 0.1:
                weak.append((identity, score))
        best = max((p[2] for p in strong), default=-1)
        competing = [p for p in weak if best - p[1] < 0.1]
        if competing:
            uncertain_boxes.add(index)
            ambiguous_tracks.update(p[1] for p in strong)
            ambiguous_tracks.update(p[0] for p in competing)
        pairs.extend(strong)
    pairs.sort(key=lambda p: (-p[2], p[0], p[1]))
    used_boxes, used_tracks = set(), set()
    for index, identity, _ in pairs:
        if index not in used_boxes and identity not in used_tracks:
            used_boxes.add(index)
            used_tracks.add(identity)
    for index, identity, _ in pairs:
        if index not in used_boxes:
            ambiguous_tracks.add(identity)
            uncertain_boxes.add(index)
    for index in range(len(boxes)):
        choices = [p for p in pairs if p[0] == index]
        if len(choices) > 1 and choices[0][2] - choices[1][2] < 0.1:
            uncertain_boxes.add(index)
            ambiguous_tracks.update(p[1] for p in choices)
    return {
        "unmatched": [
            b for i, b in enumerate(boxes)
            if i not in used_boxes and i not in uncertain_boxes
        ],
        "ambiguous": bool(ambiguous_tracks or uncertain_boxes),
        "ambiguous_tracks": sorted(ambiguous_tracks),
        "confirmed_tracks": sorted(used_tracks - ambiguous_tracks),
    }


def resolve_people(boxes, owners):
    result = _associate_people(boxes, owners)
    result.pop("confirmed_tracks")
    return result


class PeopleDiscovery:
    """Per-job presence ledger matching the browser; never spatial reidentification."""

    def __init__(self):
        self.last_seen = {}

    def resolve(self, frame, boxes, owners, tracks):
        result = _associate_people(boxes, owners)
        confirmed = set(result.pop("confirmed_tracks"))
        missing = []
        for track in tracks:
            if track["prompts"][0]["frame"] > frame:
                continue
            identity = track["id"]
            if identity in confirmed:
                self.last_seen[identity] = frame
            else:
                last = self.last_seen.get(identity)
                # Retain 1.5s of recent presence, then only an unresolved ID.
                # Forgetting the ID would admit the same player as a new track.
                self.last_seen[identity] = (
                    last if last is not None and frame - last <= 45 else None
                )
                missing.append(identity)
        if result["unmatched"] and missing:
            result["unmatched"] = []
            result["ambiguous"] = True
            result["ambiguous_tracks"] = sorted(
                set(result["ambiguous_tracks"]) | set(missing)
            )
        return result
