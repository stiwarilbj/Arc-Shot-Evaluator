"""Fail closed on malformed SAM predictions, before resizing or compositing."""
import numpy as np


class InvalidModelOutputError(ValueError):
    def __init__(self, name):
        super().__init__(
            f"The masking model returned an invalid {name} · Processing stopped · "
            "Retry processing; if it repeats, restart the editor or use a shorter segment"
        )


def validate_array(value, shape, name):
    if (not isinstance(value, np.ndarray) or value.shape != tuple(shape)
            or not np.issubdtype(value.dtype, np.floating)
            or not np.isfinite(value).all()):
        raise InvalidModelOutputError(name)
    return value


def tracking_masks(logits, ids, height, width):
    # Check rank before indexing: a malformed tensor must not silently broadcast.
    import torch
    shape = (len(ids), 1, height, width)
    if (len(ids) == 0 or not isinstance(logits, torch.Tensor)
            or tuple(logits.shape) != shape or not logits.is_floating_point()):
        raise InvalidModelOutputError("tracked mask")
    values = logits.detach().float().cpu().numpy()
    validate_array(values, shape, "tracked mask")
    return values[:, 0]
