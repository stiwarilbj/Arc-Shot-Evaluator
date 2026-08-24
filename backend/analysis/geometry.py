from __future__ import annotations

import math
from collections.abc import Iterable

import numpy as np


def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def joint_angle(
    a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]
) -> float | None:
    """Return the interior angle ABC in degrees."""
    ba = np.asarray(a, dtype=float) - np.asarray(b, dtype=float)
    bc = np.asarray(c, dtype=float) - np.asarray(b, dtype=float)
    denom = float(np.linalg.norm(ba) * np.linalg.norm(bc))
    if denom < 1e-6:
        return None
    cosine = float(np.clip(np.dot(ba, bc) / denom, -1.0, 1.0))
    return round(math.degrees(math.acos(cosine)), 1)


def robust_median(values: Iterable[float]) -> float | None:
    clean = [float(v) for v in values if math.isfinite(float(v))]
    return float(np.median(clean)) if clean else None


def interpolate_series(
    points: list[tuple[int, float]], start: int, end: int
) -> list[float | None]:
    if not points:
        return [None] * (end - start + 1)
    xs = np.asarray([p[0] for p in points], dtype=float)
    ys = np.asarray([p[1] for p in points], dtype=float)
    targets = np.arange(start, end + 1, dtype=float)
    out = np.interp(targets, xs, ys)
    out[targets < xs.min()] = np.nan
    out[targets > xs.max()] = np.nan
    return [None if np.isnan(v) else float(v) for v in out]


def smooth_xy(points: list[tuple[float, float]], window: int = 5) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points[:]
    window = max(3, window | 1)
    pad = window // 2
    arr = np.asarray(points, dtype=float)
    padded = np.pad(arr, ((pad, pad), (0, 0)), mode="edge")
    kernel = np.ones(window, dtype=float) / window
    x = np.convolve(padded[:, 0], kernel, mode="valid")
    y = np.convolve(padded[:, 1], kernel, mode="valid")
    return list(zip(x.tolist(), y.tolist(), strict=True))


def line_angle_degrees(a: tuple[float, float], b: tuple[float, float]) -> float:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    angle = abs(math.degrees(math.atan2(-dy, dx))) % 180.0
    return 180.0 - angle if angle > 90.0 else angle


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))
