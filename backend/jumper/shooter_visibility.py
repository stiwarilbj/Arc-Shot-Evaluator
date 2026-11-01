"""Conservative visibility; equivalent to shooterVisibility.ts. Never fill gaps."""
import numpy as np


class ShooterVisibility:
    def __init__(self):
        self.reference = self.pending = self.hidden_at = None
        self.streak = self.last_visible = 0
        self.confirmation = False

    def inspect(self, frame, target, others, score, confirmed=False, uncertain_identity=False):
        mask = target > 0
        area = int(mask.sum())
        competing = np.zeros(target.shape, dtype=bool)
        for other in others:
            competing |= other > .5
        covered = int(np.count_nonzero(mask & competing))
        reference = self.reference > 0 if self.reference is not None else None
        ref_area = int(reference.sum()) if reference is not None else 0
        behind = ref_area > 0 and np.count_nonzero(reference & competing) / ref_area >= .6
        absent = not np.isfinite(score) or score <= 0 or area < 4
        merged = area >= 4 and covered / area >= .85
        prompted = confirmed and not absent
        if prompted:
            self.confirmation = False
        if absent or (not prompted and merged):
            if self.hidden_at is None:
                self.hidden_at = frame
            self.pending = None
            self.streak = 0
            return dict(visible=False, warning=None if behind or merged else 'target_lost')
        if self.hidden_at is not None and not prompted:
            self.confirmation |= uncertain_identity or covered / area >= .25 or frame - self.last_visible > 45
            if self.confirmation:
                return dict(visible=False, warning='ambiguous_players')

            def compatible(before, min_iou):
                old = before > 0
                old_area = int(old.sum())
                if not old_area or not .25 <= area / old_area <= 4:
                    return False
                if min_iou:
                    intersection = int(np.count_nonzero(old & mask))
                    return intersection / (area + old_area - intersection) >= min_iou
                y, x = np.nonzero(mask)
                oy, ox = np.nonzero(old)
                distance = np.hypot((x.mean()-ox.mean()) / target.shape[1],
                                    (y.mean()-oy.mean()) / target.shape[0])
                return distance <= min(.3, .1 + (frame-self.last_visible)*.015)

            if self.reference is None or not compatible(self.reference, 0):
                self.confirmation = True
                return dict(visible=False, warning='ambiguous_players')
            self.streak = self.streak + 1 if self.pending is not None and compatible(self.pending, .5) else 1
            self.pending = target.copy()
            if self.streak < 3:
                return dict(visible=False, warning=None)
        self.hidden_at = self.pending = None
        self.streak = 0
        self.reference = target.copy()
        self.last_visible = frame
        return dict(visible=True, warning=None)
