# Paused simulation editing

Playbook on GitHub Pages and in the downloaded app uses the same browser engine.
Pause, move a marker or change ratings/badges, then resume. Undo/redo of compatible
edits keeps the simulation clock. Changes to authored actions, ordered roster
identities, or ball presence require a fresh run, as before.

## Transaction boundary

`editPausedSimulationMarker` and `rebasePausedSimulation` share a transaction:

1. Validate the proposed drawing and explicit marker relocation. Match roster
   identities and authored actions before attempting a rebase.
2. Clone the run's complete mutable data graph, retaining its derived ball/shot
   accessors. Shared action graph and pending-transfer references remain shared
   inside the candidate, never with the live run.
3. Apply changed attributes independently of position. Unmoved markers retain
   their simulated positions and velocities, rather than returning to their
   authored starting positions. Refresh prepared ratings, badges and spacing
   preferences for changed players.
4. Invalidate affected paths, receiving origins, screen approaches/coverage,
   target filters, movement history and congestion reservations. Preserve other
   execution progress, schedules, assignment rotations and completed switches.
5. Prepare the frame and display snapshot, and validate finite positions,
   velocities, timing, route progress, action-graph identity and pending-catch
   consistency. Commit only after preparation succeeds.

The commit is synchronous and contains no asynchronous work or movement step.
Bound-action identities survive for existing observers. Previous display and
recording snapshots and the caller's drawing remain isolated. Unsupported or
invalid edits do not clear a valid frame or partially advance the run.

The editor constructs the proposed drawing first. A rejected handoff leaves its
history and drawing intact and uses the existing error display. Successful
paused drags produce one history entry; undo and redo use the same transaction.
Ratings, team ratings and both offensive/defensive badge controls now use the
paused handoff instead of resetting playback.

## Dependencies and historical evidence

- Moving an actor resets that actor's velocity and executing-route origin.
  Simultaneous unrelated actions keep their paths and progress.
- Moving a receiving player rebuilds their receiving route without granting
  possession. The pass still needs an actual catch; its release evidence remains.
- Moving an unused set screener requires another approach before screen use.
  Related user paths and coverage geometry are rebuilt. A screen already used
  keeps its use/release evidence and an already-performed switch is not repeated.
- Attribute-only edits keep coordinates and velocities while refreshing the
  cached decision inputs and relevant defensive/spacing targets.
- A released shot retains its shooter, release position, timestamps and quality.
  Explicitly relocating the live ball only changes the remaining path override;
  it does not rewrite historical release/catch evidence.

This remains a basketball simulation, not a guarantee that any manually placed
marker has a clear route. Resume still uses normal collision and obstruction
rules. Authored destinations and saved version-1 drawings are unchanged.

## Regression command

From `frontend`, run `npm run test:paused-transactions`. It covers attribute-only
changes and reversals, simultaneous routes, pending catches and dependent drives,
screen approach/coverage invalidation, released shots, caller/snapshot isolation,
malformed input, failed candidate validation, incompatible rebases, and all 24
starters in both offense modes. Existing action-dependency, ball-state, movement,
defense, simulation, frontend and backend regressions remain separate checks.
