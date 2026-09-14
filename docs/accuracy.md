# Accuracy and review protocol

ARC reports four different things for a shot:

- `outcome` is the observed make, miss, or review state.
- `confidence` (also exported as `observation_confidence`) describes the
  evidence for that state: ball tracking, rim geometry, pose association, and
  whether the trajectory completed.
  A clearly tracked wide miss can therefore remain high-confidence even when
  its mechanics look poor.
- `evidence.shot_quality` describes visible mechanics and trajectory quality.
  It never changes observation confidence.
- `evidence.shooting_hand` is a sequence-level wrist association with its own
  confidence; ties are reported as `unknown`.
- `evidence.temporal_mechanics` contains release timing, elbow extension,
  follow-through duration, body alignment, and per-joint motion ranges when
  enough pose frames are visible.
- `prediction.status` is `unavailable_unvalidated` until a model has passed a
  held-out validation and calibration review. The observed make rate remains
  available as `summary.observed_ft_pct` (with `summary.fg_pct` retained for
  older exports).

Each analysis stores `analysis_version`, detector/pose `models`, `processing_mode`, source timing
metadata, and a separate `source_original` artifact. When cadence conversion is
required, near-identical inserted frames are retained for playback but excluded
from observed evidence. Scene cuts reset tracking
and incomplete or rim-less attempts remain `review` records when a release-like
trajectory was found. Metric values include `metric_availability` and
`metric_uncertainty`; a missing value is not replaced with an average.

User corrections are written to `sessions/<id>/corrections.json`. The original
model evidence is retained, and reads apply corrections as a separate
provenance layer. A correction can change an outcome or release frame without
rewriting the original video or detector trace.

## Validation dataset

The pilot target is 1,000 free throws from 50 shooters and 10 venues. Store one
row per attempt with shooter, venue, recording session, source frame rate,
outcome, release frame, visibility/occlusion labels, and ball/rim coordinates
around release and rim interaction. Two reviewers adjudicate disagreements.

Splits are by shooter, venue, and recording session so a replay or another clip
of the same player cannot leak into evaluation. Report attempt precision/recall,
make/miss accuracy at automatic-decision coverage, release-frame error,
tracking error, metric availability, Brier score, log loss, and calibration by
recording condition. Compare regularized logistic regression and gradient
boosted trees against population-rate and player-history baselines before
shipping a future-make model.

The initial release gate is a target of at least 95% attempt precision and
recall, and 98% make/miss accuracy at at least 80% automatic-decision coverage
on visually resolvable adjudicated footage. Evaluate unresolved uploads too,
and publish condition-level uncertainty rather than filtering difficult clips.

The temporal tracker is a basketball-specific implementation point for the
[TrackNet starting paper](https://arxiv.org/abs/1907.03698). Any camera
calibration upgrade should follow the constraints in the
[OpenCV calibration documentation](https://docs.opencv.org/4.13.0/d9/d0c/group__calib3d.html),
and future probability outputs should use held-out calibration methods such as
those discussed in [On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a.html).
