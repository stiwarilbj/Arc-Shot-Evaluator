"""Clip-wide, color-independent visible-contact graph; matches overlapPalette.ts."""
import numpy as np

GRAY_SHADES = (64, 81, 98, 115, 132, 149, 166, 183, 200)


class OverlapPalette:
    def __init__(self, target):
        if type(target) is not int or not 1 <= target <= 255:
            raise ValueError("Invalid palette target")
        self.target = target
        self.weights = np.zeros((256, 256), np.uint32)
        self.present = set()

    def observe(self, labels):
        if labels.dtype != np.uint8 or labels.ndim != 2 or min(labels.shape) < 1:
            raise ValueError("Invalid palette frame")
        self.present.update(int(i) for i in np.unique(labels) if i and i != self.target)
        contacts = set()
        for dx, dy in ((1, 0), (-1, 1), (0, 1), (1, 1)):
            height, width = labels.shape
            a = labels[:height-dy, max(0, -dx):width-max(0, dx)]
            b = labels[dy:, max(0, dx):width-max(0, -dx)]
            valid = (a > 0) & (b > 0) & (a != b) & (a != self.target) & (b != self.target)
            pairs = np.minimum(a[valid], b[valid]).astype(np.uint16) * 256 + np.maximum(a[valid], b[valid])
            contacts.update(int(i) for i in np.unique(pairs))
        for pair in contacts:
            a, b = divmod(pair, 256)
            self.weights[a, b] += 1
            self.weights[b, a] += 1

    def finish(self):
        shades = (64 + ((np.arange(256, dtype=np.int32) - 1) * 47 % 137)).astype(np.uint8)
        shades[0], shades[self.target] = 224, 0
        ids = sorted(self.present, key=lambda i: (-int(self.weights[i].sum()), i))
        assigned, usage = [], {}
        for identity in ids:
            def score(shade):
                return sum(int(self.weights[identity, other]) *
                           (4 * min(abs(shade-int(shades[other])), 96) + abs(shade-int(shades[other]))
                            - (256 if abs(shade-int(shades[other])) < 32 else 0))
                           for other in assigned)
            best = max(GRAY_SHADES, key=lambda shade: (score(shade), -usage.get(shade, 0), -shade))
            shades[identity] = best
            assigned.append(identity)
            usage[best] = usage.get(best, 0) + 1
        return shades
