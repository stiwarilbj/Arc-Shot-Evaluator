# Shot release evaluation

Playbook and Counter Lab share engine version 8. Saved version-1 drawings and
the interface are unchanged. Release records are internal, in-memory simulation
evidence; neither build uses a server or external model for this calculation.

## Evidence and timing

`beginShot` creates provisional setup quality. `updateShot` evaluates the actual
release boundary after coordinated movement, using court-feet velocities and
current positions. `ballState.releaseContext` and `frame.shotRelease` carry the
same deeply frozen, value-only record. Counter Lab summaries retain it once per
trial, rather than repeating it in every replay sample.

The record includes the shooter, hoop, distance, rating for that shot location,
badges, spacing score, and recent executed movement IDs/sequences/timestamps.
An authored movement that never started cannot earn a movement badge bonus.
Confirmed passes and handoffs record the receiver's position, velocity, nearest
defender gap, and actual catch time. Failed transfers cannot supply catch evidence.
Catch evidence remains available even when defenders move away before release.

Each defender records position, velocity, a unit direction toward the shooter,
signed approach speed, relative closing speed, goal-side alignment, and badge
pressure. Positive approach speed means movement toward the shooter; lateral
and retreating motion contribute no additional closeout penalty. Relative
closing speed is diagnostic evidence, avoiding double-counting shooter motion
in the defender modifier. Coincident centers use a zero direction vector.

## Scoring rules

Existing range, defender-gap, defensive-badge, spacing, rating, offensive-badge,
rating-cap and rounding rules remain, with these explicit simulation heuristics:

- Closeout motion subtracts at most 6 points, weighted by approach speed up to
  15 feet/second and proximity inside 12 feet. Use the strongest closeout;
  defender-ID ordering breaks ties deterministically.
- Shooter motion above 2.5 feet/second subtracts up to 4 points (2 for finishes),
  reaching the cap at 19 feet/second.
- A catch is settled after 150 ms with shooter speed at most 2.5 feet/second.
  During the existing 1,150 ms recent-catch window, an unsettled catch subtracts
  2 points. Catch-and-shoot's existing 6-point bonus requires a settled catch.

Every applied contribution records its points and supporting inputs, including
caps and final clamping/rounding. Contributions sum to the final integer score.
The result is **not a calibrated probability**; it does not model hand height,
body orientation, balance, or biomechanics absent from the simulation.

After release, the record and score stay unchanged by marker/attribute edits,
settings, interpolation, and shot results. Checkpoint cloning restores deep
freezing, and worker response validation checks the record against the displayed
shooter, score, phase and session time. Frame rendering checks shot existence,
never score truthiness, so zero cannot trigger live recalculation.

## Regression checks

Run `npm run test:shot-release` from `frontend/` for signed closeouts at identical
positions, lateral movement, settled/hard-cut and contested catches, exact
150/1,150 ms boundaries, evidence accounting, nested immutability, pre/post-release
edits, checkpoint restoration, genuine zero releases, and corrupted worker data.
The full test command also covers all 24 starters, worker/direct parity,
deterministic sessions, and the existing verified switch/slip repair fixture.

The settings fixture retains previous congestion-planning hashes and adds
`releaseContextSha256`/`releaseContextSteps`. Before updating, the previous
engine's 52 traces were checked against their historical hashes. Outcomes may
change because evaluation now uses actual release positions and motion rather
than freezing during setup: 29 final scores changed by between −7 and +1 points,
and one adaptive possession changed its release time. The existing switch/slip
repair fixture still passes its simulation-evidence checks.
Engine-version changes invalidate in-memory trial
caches and older simulation sessions.
