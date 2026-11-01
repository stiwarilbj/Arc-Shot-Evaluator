# Reproducible Playbook simulation sessions

Both builds use the same browser engine in Playbook's lazily loaded dedicated
worker (see [execution transport](playbook-worker.md)). The worker starts
`createSimulationRun(drawing, settings, hoop, { recordSession: true })`. A session
retains an independent starting drawing and normalized settings, engine version,
unsigned 32-bit seed, hoop, and resolved defense scheme. Seeded automatic defense
is selected once. Restoring the session never consults a new random selection.
Counter Lab's ordinary direct/prepared trials do not retain session journals or
checkpoints; their completed-result and replay caches keep their existing roles.

## Recorded history and checkpoints

The journal records accepted advancement calls, normalized settings changes and
successful paused transactions, including explicit marker relocations and
attribute-only edits. Events retain their actual execution/accumulator clocks,
ordering and drawing snapshots. Failed edits and equivalent settings create no
event. Fractional advancement call boundaries are retained: summing and
regrouping them can change floating-point accumulator bits.

Executable checkpoints are taken approximately every 500 ms of recorded play and
after settings/paused-edit events. Each copies the complete data graph together:

- Authoritative ball state, release/catch evidence and pending-transfer aliases.
- Actual positions, velocities, route progress, action phases and dependencies.
- Defensive assignments, responsibilities, screen locks and completed switches.
- Adaptive decisions, movement/congestion reservations, clocks and previous/current
  frames used for interpolation.

Checkpoint state is private and isolated from live runs and returned frames.
Maps/Sets and shared action/transfer references survive cloning; restored rating
and badge objects are registered with the prepared-attribute caches. Derived
possession getters remain live. Optional execution fields absent at an earlier
time are removed when restoring that time.

Each session keeps at most 24 checkpoints, including its forward-playback cursor,
under a 16 MiB estimated object-graph accounting budget. The first checkpoint is
retained when it fits; older intermediate checkpoints are evicted. An oversized
checkpoint is skipped. The journal and exact starting inputs remain available
to reconstruct earlier states. This is an accounting limit, not a browser heap
measurement. No frames are discarded from Counter Lab replay archives.

## Seeking, branching and recovery

`seekSimulationSession(run, milliseconds)` builds a candidate from the nearest
eligible checkpoint and replays the journal in order. An interior-call seek
replays the exact prefix and a partial final delta. A canonical boundary near the
playhead makes subsequent forward playback incremental and lets it rejoin the
original call boundaries exactly, even at a different display cadence.

Seeking pauses Playbook and restores historical settings in its controls. Resume
uses the run's restored settings and reapplies later recorded changes. It does
not feed today's control values into earlier execution. Seeking leaves the
editor draft, saved identity and undo/redo history intact. An actual edit or
settings change while rewound truncates the future at that point, preserving the
original start and creating a new branch. Changes to actions/roster still start
a new session through Playbook's existing handoff rules.

`captureSimulationSession` returns an independent JSON-compatible version-1
session record. `restoreSimulationSession` validates the engine version, initial
drawing/settings, seed, resolved scheme, event kinds, clocks and deterministic
execution before returning a recovered run, rebuilding bounded checkpoints.
Seeking validates a candidate before replacing a live run, so failed seeks do
not corrupt its court or journal. Recovery can also replace damaged live state
from healthy recorded evidence. These are internal engine APIs; no session file
import/export control or reload persistence is added to the site.

Exact execution equality is supported within the same engine version/runtime.
Cross-version and cross-browser bitwise compatibility is not promised. A new
engine version also invalidates Counter Lab's in-memory deterministic trial keys.

## Regression coverage

Run `npm run test:simulation-sessions` from `frontend/`. It compares uninterrupted
execution against more than 2,000 restored executable states across all 24
starters in scripted/adaptive modes. The samples cover real catches, shot release,
screen switches, delayed phases and defensive duties. Additional fixtures cover
fractional calls, same-time settings/edits, pending-catch relocations, attribute
changes, 30/60/120 Hz forward replay, interior-call branching, JSON recovery, invalid
records, seed isolation, corrupt live-state recovery and checkpoint eviction.
The existing settings regression also retains all 52 exact deterministic trace
hashes for ordinary unrecorded runs.
