from __future__ import annotations

from dataclasses import dataclass
from typing import Any


JUMP_MODEL_VERSION = "jump-experimental-none"
JUMP_PREDICTION_STATUS = "unavailable_unvalidated"


@dataclass(frozen=True, slots=True)
class PredictionCutoff:
    """The last information allowed to reach one prediction head."""

    name: str
    milliseconds_after_release: int


RELEASE_CUTOFF = PredictionCutoff("release", 0)
EARLY_FLIGHT_CUTOFF = PredictionCutoff("release_plus_200ms", 200)


def cutoff_frame(release_frame: int, fps: float, cutoff: PredictionCutoff) -> int:
    """Return a hard frame boundary for leakage-safe feature extraction."""
    if fps <= 0:
        return release_frame
    return release_frame + round(cutoff.milliseconds_after_release / 1000.0 * fps)


def build_jump_predictions(
    *,
    features_at_release: dict[str, Any],
    features_after_200ms: dict[str, Any],
    sample_size: int = 0,
) -> dict[str, dict[str, Any]]:
    """Return explicit unavailable records until validated heads are shipped.

    Keeping this boundary in a prediction module prevents UI code or the
    free-throw heuristic from accidentally turning mechanics into a made-shot
    probability. The feature arguments are accepted now so a trained model can
    be installed without changing the API shape.
    """
    del features_at_release, features_after_200ms
    return {
        cutoff.name: {
            "status": JUMP_PREDICTION_STATUS,
            "model": None,
            "calibration_model": None,
            "cutoff": cutoff.name,
            "cutoff_ms_after_release": cutoff.milliseconds_after_release,
            "sample_size": int(sample_size),
            "probability": None,
            "reason": "no validated jump-shot model is installed",
            "supported_cohort": None,
        }
        for cutoff in (RELEASE_CUTOFF, EARLY_FLIGHT_CUTOFF)
    }
