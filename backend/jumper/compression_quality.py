"""Bounded output-pixel evidence matching the browser detail checks."""
import numpy as np


class SilhouetteCompressionError(ValueError):
    def __init__(self):
        super().__init__(
            "Compression damaged silhouette details · Try a shorter or lower-resolution "
            "clip if higher-quality export also fails"
        )


def detail_proof(image):
    v = image[:, :, 0].astype(np.int16)
    h, w = v.shape
    padded = np.pad(v, 2, mode="edge")
    l, r = padded[2:2+h, 1:1+w], padded[2:2+h, 3:3+w]
    u, d = padded[1:1+h, 2:2+w], padded[3:3+h, 2:2+w]
    edge = np.maximum.reduce([abs(v-l), abs(v-r), abs(v-u), abs(v-d)]) >= 24
    a, b = padded[2:2+h, :w], padded[2:2+h, 4:4+w]
    c, e = padded[:h, 2:2+w], padded[4:4+h, 2:2+w]
    thin = edge & (
        (v <= np.minimum(a, b)-24) | (v >= np.maximum(a, b)+24)
        | (v <= np.minimum(c, e)-24) | (v >= np.maximum(c, e)+24)
    )

    def samples(mask):
        indices = np.flatnonzero(mask)
        indices = indices[::max(1, (len(indices)+1023)//1024)]
        return (indices * 256 + v.ravel()[indices]).astype(np.uint32)

    return (samples(thin), samples(edge & ~thin))


def validate_detail_pixels(image, proof):
    values = image.astype(np.float32).mean(axis=2).ravel()
    for points in proof:
        if len(points) and np.max(points // 256) >= len(values):
            raise ValueError("Invalid detail-proof sample")
        damaged = np.count_nonzero(abs(values[points // 256] - (points & 255)) > 40)
        if damaged >= 3 and damaged / len(points) > 0.02:
            raise SilhouetteCompressionError()
