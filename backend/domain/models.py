from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class BoundingBox:
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float = 0.0
    source: str = "model"

    @property
    def width(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0)

    def to_list(self) -> list[float]:
        return [round(self.x1, 2), round(self.y1, 2), round(self.x2, 2), round(self.y2, 2)]


@dataclass(slots=True)
class BallCandidate:
    x: float
    y: float
    confidence: float
    size: float
    source: str


@dataclass(slots=True)
class BallTrackPoint:
    frame: int
    x: float
    y: float
    confidence: float
    observed: bool = True
    source: str = "model"


@dataclass(slots=True)
class PlayerPose:
    box: BoundingBox
    keypoints: list[tuple[float, float, float]]
    confidence: float


@dataclass(slots=True)
class FrameDetections:
    balls: list[BallCandidate] = field(default_factory=list)
    hoops: list[BoundingBox] = field(default_factory=list)
    poses: list[PlayerPose] = field(default_factory=list)
    # Normalized Laplacian sharpness (0..1). It is used to widen temporal
    # tracking gaps when motion blur hides the ball for a few frames.
    sharpness: float = 1.0
    # Large inter-frame changes usually indicate an edit, replay, or hard
    # camera cut. Tracking must not bridge those boundaries.
    scene_cut: bool = False
    # Frames inserted by a cadence conversion are retained for playback but
    # excluded from observed ball evidence. This keeps duplicated images from
    # inflating coverage or creating extra attempts.
    duplicate_frame: bool = False


@dataclass(slots=True)
class ShotAnalysis:
    id: int
    outcome: str
    # Confidence that the observed outcome and tracked attempt are correct.
    # This is deliberately independent from form quality: an awkward-looking
    # release can still be an unambiguous make or miss.
    confidence: float
    release_frame: int
    release_time: float
    end_frame: int
    release_speed_ms: float | None
    release_height_m: float | None
    entry_angle_deg: float | None
    arc_peak_m: float | None
    form: dict[str, float | None]
    flags: list[str]
    evidence: dict[str, Any]
    trace: list[BallTrackPoint] = field(repr=False)
    observation_confidence: float | None = None
    coaching: dict[str, Any] | None = None

    def to_public_dict(self) -> dict[str, Any]:
        """Return the serializable shot record stored in API responses and exports."""
        data = asdict(self)
        data.pop("trace", None)
        if data.get("coaching") is None:
            data.pop("coaching", None)
        data["confidence_label"] = (
            "high" if self.confidence >= 0.84 else "medium" if self.confidence >= 0.62 else "review"
        )
        # Keep the old `confidence` field for clients written against v1 while
        # making the semantic name explicit for new consumers.
        data["observation_confidence"] = (
            round(self.observation_confidence, 3)
            if self.observation_confidence is not None
            else round(self.confidence, 3)
        )
        # Expose metric reliability at the shot boundary as well as inside the
        # evidence object so API consumers do not have to know the internal
        # evidence layout to distinguish unavailable from estimated values.
        evidence = data.get("evidence") or {}
        if "metric_availability" in evidence:
            data["metric_availability"] = evidence["metric_availability"]
        if "metric_uncertainty" in evidence:
            data["metric_uncertainty"] = evidence["metric_uncertainty"]
        return data
