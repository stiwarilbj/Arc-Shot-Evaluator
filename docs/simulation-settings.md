# Simulation settings boundaries

Playbook and Counter Lab use the same browser engine on both hosted and
downloaded builds. `createSimulationRun`, the factory returned by
`prepareSimulationRun`, and `setSimulationRunSettings` reject invalid runtime
settings with a field-specific `TypeError` before changing simulation state.
Advancing with explicit settings uses the same update boundary before the
fixed-step movement loop. No validator is added to individual movement steps.

Required values:

- `offenseOffBall`: `off`, `spacing`, `cuts`, or `read-react`.
- `defenseStrategy`: `off`, `contain`, `help`, `switch`, `trap-rotate`,
  `fight-over`, `go-under`, `drop`, `hedge`, `deny-lanes`, or `protect-paint`.
- `offBallIntensity`: a finite JavaScript number. Strings, booleans, boxed
  numbers, `NaN`, and infinities are rejected. Existing finite-value clamping in
  movement calculations is retained; fractional values and finite numbers
  outside the UI's 0–100 range keep their prior simulation behavior.
- `automaticActions`: an object containing boolean `screen`, `handoff`,
  `pickRoll`, and `offBallScreen` fields. Missing flags are not silently disabled.

Omitted/undefined `defenseScheme` keeps the `auto` default; otherwise it must be
`auto` or a scheme from the engine's `DEFENSE_SCHEME_ORDER`. Omitted/undefined
`offenseMode` keeps `adaptive`; otherwise it must be `adaptive` or `scripted`.
Explicit null values are malformed, rather than omitted options. Existing
unrelated extra properties do not affect validation or movement.

Validate first, then enforce scripted mode's disabled off-ball improvisation
and automatic actions. This prevents those overrides from concealing bad input.
On updates, even the fixed defense scheme and overridden scripted fields must
be valid. A valid scheme change still cannot change a run's initial scheme.

Normalization compares effective values before allocating new settings or
rebuilding frames. Unchanged values retain both objects. Validation precedes
attribute refresh, assignment changes, route invalidation, and clock advancement,
so a rejected update preserves the active run. Caller settings remain unmodified
and nested automatic flags are copied; reusing a caller object after mutation
does not bypass validation. No UI controls or saved drawing format change.

Run `npm run test:simulation-settings` from `frontend/`. The regression rejects
malformed objects, enums, missing/non-boolean flags, and nonfinite intensity
across direct/prepared/update/advance boundaries, including scripted overrides.
It checks unchanged state on errors, retrying corrected inputs, caller isolation,
defaults, and the unchanged-settings fast path. A fixture captured from the
pre-validation engine compares exact hashes of every recorded display/diagnostic
sample through completion in 52 scenarios across all 24 starters, covering every
strategy, scheme, off-ball style, flag combination, and representative intensities.
The tests hold the random input for `auto` scheme selection fixed; ordinary
automatic selection retains its existing randomness.

## Elapsed-time advancement

`advanceSimulationState` and `advanceSimulationRun` reject nonfinite elapsed
milliseconds with a `TypeError` before inspecting completion or changing settings,
attributes, frames, or the fixed-step accumulator. This includes `NaN` and both
infinities, even on completed runs. Runtime non-number values are not coerced.
The caller can resume with valid input against the unchanged run.

Finite zero and negative deltas remain no-ops. Positive deltas still contribute
at most 50 ms per call, and tiny fractional deltas accumulate with the existing
fixed-step tolerance. Run `npm run test:simulation-advancement` from `frontend/`
to check rejection, frame preservation, resumption, fractional accumulation,
completed runs, and the unchanged positive-delta cap through both entry points.
