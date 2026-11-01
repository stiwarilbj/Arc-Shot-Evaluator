"""One-pixel, palette-only antialiasing, identical to the browser renderer."""

import numpy as np


def neutral_edges(image):
    """Filter validated label-derived pixels only; never accepts original footage.

    Replicated borders and integer [1, 6, 1] weights keep interiors unchanged.
    Ownership and tracking evidence are deliberately not modified.
    """
    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3 or min(image.shape[:2]) < 1:
        raise ValueError("Invalid neutral-edge geometry")
    plane = image[..., 0].astype(np.uint16)
    padded = np.pad(plane, ((0, 0), (1, 1)), mode="edge")
    horizontal = padded[:, :-2] + 6 * padded[:, 1:-1] + padded[:, 2:]
    padded = np.pad(horizontal, ((1, 1), (0, 0)), mode="edge")
    values = ((padded[:-2] + 6 * padded[1:-1] + padded[2:] + 32) // 64).astype(np.uint8)
    return np.repeat(values[..., None], 3, axis=2)
