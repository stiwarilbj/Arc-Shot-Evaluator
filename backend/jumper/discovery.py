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


def resolve_people(boxes, owners):
    height, width = owners.shape
    bounds = {}
    for identity in np.unique(owners):
        if identity:
            ys, xs = np.nonzero(owners == identity)
            bounds[int(identity)] = [
                xs.min() / width,
                ys.min() / height,
                (xs.max() + 1) / width,
                (ys.max() + 1) / height,
            ]
    pairs = []
    for index, box in enumerate(boxes):
        for identity, b in bounds.items():
            intersection = max(0, min(b[2], box[2]) - max(b[0], box[0])) * max(
                0, min(b[3], box[3]) - max(b[1], box[1])
            )
            a, c = (b[2] - b[0]) * (b[3] - b[1]), (box[2] - box[0]) * (box[3] - box[1])
            iou, coverage = (
                intersection / (a + c - intersection),
                intersection / min(a, c),
            )
            if iou >= 0.25 or coverage >= 0.65:
                pairs.append((index, identity, iou))
    pairs.sort(key=lambda p: (-p[2], p[0], p[1]))
    used_boxes, used_tracks = set(), set()
    for index, identity, _ in pairs:
        if index not in used_boxes and identity not in used_tracks:
            used_boxes.add(index)
            used_tracks.add(identity)
    ambiguous_tracks = {
        identity for index, identity, _ in pairs if index not in used_boxes
    }
    for index in range(len(boxes)):
        choices = [p for p in pairs if p[0] == index]
        if len(choices) > 1 and abs(choices[0][2] - choices[1][2]) < 0.1:
            ambiguous_tracks.update(p[1] for p in choices)
    return {
        "unmatched": [b for i, b in enumerate(boxes) if i not in used_boxes],
        "ambiguous": bool(ambiguous_tracks),
        "ambiguous_tracks": sorted(ambiguous_tracks),
    }
