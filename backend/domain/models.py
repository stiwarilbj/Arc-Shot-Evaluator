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


@dataclass(slots=True)
class ShotAnalysis:
    id: int
    outcome: str
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
        return data
