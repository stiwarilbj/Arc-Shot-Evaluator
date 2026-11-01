"""Current-evidence boundary consistency; equivalent to maskOwnership.ts."""
import cv2
import numpy as np

CLOSE = .35
CORE = .5
MAX_HOLD = 2


class MaskOwnership:
    def __init__(self, width, height):
        self.previous = np.zeros((height, width), dtype=np.uint8)
        self.age = np.zeros_like(self.previous)

    def resolve(self, ids, values, excluded=(), reset=False):
        best = np.zeros(self.previous.shape, dtype=np.float32)
        second = np.zeros_like(best)
        prior_score = np.zeros_like(best)
        raw = np.zeros_like(self.previous)
        for identity, scores in zip(ids, values):
            previous = self.previous == identity
            prior_score[previous] = scores[previous]
            # Exact positive ties use identity, never input order or shooter/color.
            wins = (scores > best) | ((scores > 0) & (scores == best) & (identity < raw))
            second = np.where(wins, best, np.maximum(second, scores))
            best = np.where(wins, scores, best)
            raw[wins] = identity
        output = raw.copy()
        age = np.zeros_like(self.age)
        if not reset:
            eligible = ((self.previous > 0) & (raw > 0) & (raw != self.previous)
                        & (self.age < MAX_HOLD) & (prior_score > 0)
                        & (best - prior_score <= CLOSE))
            for identity in np.unique(self.previous[eligible]):
                if identity in excluded:
                    continue
                # Require a current unambiguous core within two pixels. Old
                # geometry alone cannot paint over a foreground occluder.
                core = ((raw == identity) & (best > CORE)
                        & (best - second > CLOSE)).astype(np.uint8)
                supported = cv2.dilate(core, np.ones((5, 5), np.uint8)) > 0
                keep = eligible & (self.previous == identity) & supported
                output[keep] = identity
                age[keep] = self.age[keep] + 1
        for identity in excluded:
            output[output == identity] = 0
        self.previous = output.copy()
        self.age = age
        return output
