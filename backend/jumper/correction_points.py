"""Explicit correction cells on SAM's 1024-pixel input; never edit saved prompts."""
import math
import numpy as np


class CorrectionConflictError(ValueError):
    pass


def correction_prompt(prompt, track_id, source_size=None, context=""):
    if not prompt.get('points'):
        return prompt
    normalized = np.asarray(prompt['points'], dtype=np.float32)
    if source_size is not None:
        # Match SAM's existing absolute-coordinate float32 conversion and resize.
        absolute = (normalized * np.asarray(source_size, dtype=np.float64)).astype(np.float32)
        mapped = absolute / np.asarray(source_size, dtype=np.float32) * np.float32(1024)
    else:
        mapped = normalized * np.float32(1024)
    cells, points, labels = {}, [], []
    for point, position, label in zip(prompt['points'], mapped, prompt['labels']):
        cell = tuple(min(1023,max(0,math.floor(float(n)))) for n in position)
        if cell in cells:
            if cells[cell] != label:
                suffix = f" ({context})" if context else ""
                raise CorrectionConflictError(
                    f"Include and Exclude points overlap on the same processing pixel at frame {prompt['frame']+1}, "
                    f"track {track_id}{suffix} · Remove or move one of these correction points, then retry"
                )
            continue
        cells[cell] = label
        points.append(list(point)); labels.append(label)
    return dict(prompt, points=points, labels=labels)
