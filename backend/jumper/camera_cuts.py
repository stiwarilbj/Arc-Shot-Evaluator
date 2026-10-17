"""Bounded neighboring-frame cut diagnostics, equivalent to cameraCuts.ts."""
import math
import numpy as np

WIDTH, HEIGHT = 64, 36


def scene(rgb):
    pixels = (rgb[:, :, 0].astype(float)*77 + rgb[:, :, 1]*150.0 + rgb[:, :, 2]*29.0)/256
    mean = pixels.mean()
    contrast = math.sqrt(np.mean((pixels-mean)**2))
    return dict(pixels=((pixels-mean)/max(8, contrast)).astype(np.float32), contrast=contrast)


def difference(a, b):
    def at(dx, dy):
        left, right = max(0, -dx), min(WIDTH, WIDTH-dx)
        top, bottom = max(0, -dy), min(HEIGHT, HEIGHT-dy)
        if (right-left)*(bottom-top) < WIDTH*HEIGHT*.35:
            return math.inf
        aa = a["pixels"][top:bottom:2, left:right:2]
        bb = b["pixels"][top+dy:bottom+dy:2, left+dx:right+dx:2]
        return float(np.minimum(2, np.abs(aa.astype(float)-bb)).mean())
    best = at(0, 0)
    if best <= .45:
        return best
    for dy in range(-20, 21):
        for dx in range(-40, 41):
            score = at(dx, dy)
            best = min(best, score)
            if best <= .15:
                return best
    return best


class CameraCuts:
    def __init__(self):
        self.previous = None
        self.frame = -1
        self.pending = []

    def inspect(self, frame, rgb):
        current, cuts = scene(rgb), []
        if frame != self.frame+1:
            self.pending, self.previous = [], None
        returning_flash, pending = False, []
        for p in self.pending:
            if difference(p["before"], current) <= .65:
                if p["after"]["contrast"] < 12:
                    returning_flash = True
                else:
                    cuts.append(p["frame"])
            elif frame-p["frame"] < 2:
                pending.append(p)
            elif difference(p["after"], current) <= .65:
                cuts.append(p["frame"])
        reset = self.previous is not None and not returning_flash and difference(self.previous, current) > .75
        if reset:
            pending.append(dict(frame=frame, before=self.previous, after=current))
        self.pending, self.previous, self.frame = pending, current, frame
        return dict(reset=reset, cuts=cuts)

    def finish(self):
        cuts = [p["frame"] for p in self.pending]
        self.pending = []
        return cuts
