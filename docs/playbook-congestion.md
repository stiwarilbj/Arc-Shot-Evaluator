# Movement congestion and passage planning

Playbook and Counter Lab share a run-local congestion planner on both hosted and
downloaded builds. It guides authored movement and authored supporting routes;
defenders retain the targets selected by their coordinated responsibilities.
Other moving players are predicted obstacles, rather than extra voluntary
cutters. Saved version-1 drawings, editing history, and authored destinations
remain unchanged.

## Short reservations

The fixed-step engine supplies the route identity, phase, path in court feet,
actual progress, endpoint, intended target, and previous velocity. The planner
looks 450 ms ahead using five acceleration-limited trajectory segments. Curved
routes and screen approaches follow their local path rather than cutting
straight to the endpoint. It replans every 100 ms, or immediately when active
route membership changes.

Conflicting passages receive a stable owner for at most 450 ms per lease. Frozen
screens keep their position, nearing arrivals receive priority, and waiting
age plus participant identity resolves symmetric priorities. Leases may renew
while traffic persists; they do not authorize indefinite action retries.
Circular wait chains are resolved together, giving one member passage while the
others make room. A yielding player can proceed as soon as the owner's predicted
passage is clear; ownership never requires an unnecessary stop for the entire
lease.

Destinations are reserved near arrival. Goals less than two feet apart cannot
be simultaneously occupied: one player can arrive while another waits or remains
obstructed. Distinct, legally separated endpoints are not rewritten or merged.
Goal reservations are temporary and disappear when their owning route changes
or leaves. Losing a passage or endpoint never grants permission to cross the
owner's body.

## Bounded choices and execution

The planner evaluates at most ten choices per active mover: continuing, short
forward/side detours, lateral clearance, short retreat/side combinations, or
braking. A side preference persists for a short window to resist left/right
flipping. Candidate trajectories must stay within court bounds and the existing
three-foot authored-route allowance, avoid reserved destinations, and retain
predicted body clearance. Small initial overlaps must recover gradually.
If a later phase begins outside its approach corridor, candidates may return
gradually without increasing that existing deviation. Projecting onto an endpoint
does not count as arriving while the player is still displaced from it; measured
return toward the goal also counts as progress.

These trajectories guide intentions, not marker positions. The existing joint
movement solver still applies its speed caps, bounded acceleration steering,
current route corridor, frozen screens, and swept body constraints every step.
The one-foot body radius and 2.2-foot preferred separation are unchanged. Hard
collision/boundary corrections can still require stronger braking than ordinary
acceleration steering; this planner does not claim a new global trajectory
optimizer or physically exact contact model.

After 1.2 seconds without measurable route progress, a traffic diagnostic records
`blocked`. That diagnosis does not immediately abort a feasible escape. Existing
action durations remain minimums and existing phase-extension limits still apply;
when the action exhausts its allowed waiting, execution reports obstruction rather
than marking an unfinished route complete. Some legal but lengthy maneuvers may
therefore time out. No search over a small planning horizon can guarantee that
every geometrically possible drawing finishes.

## Diagnostics and lifecycle

Action diagnostics identify yielding, detouring, or stalled traffic, its participant,
blocking player/defender identities, start time, and explanation. Counter Lab replay
archives retain these records; runtime decoding checks their identities and times.
Compact recordings and display frames own independent nested copies. Existing
obstruction explanations distinguish reserved traffic from an ordinary timeout.

Each run owns its own bounded maps (participants, passage pairs, destinations).
Phase/route changes release old leases. Effective settings changes and paused
marker/drawing edits clear active planning and active traffic diagnostics; repeated
identical settings and zero-time advancement preserve them. Completed action
evidence remains recorded. Trial-cache engine version 6 prevents earlier movement
results from being reused as current comparisons.

## Regression evidence

Run these local commands from `frontend/`:

- `npm run test:congestion-planning`: symmetric/head-on and crossing routes,
  four-way paint traffic, baseline congestion around a frozen screen, conflicting
  destinations, an impossible narrow lane, initial overlaps, deterministic input
  reordering, bounds/speed/swept clearance, leases, and isolated run state. Actual
  authored-engine trials also cover curves, 30/60/120-Hz caller cadence, bounded
  obstruction, worker replay validation, nested snapshot isolation, and plan resets.
- `npm run test:coordinated-movement`: all 24 starters against six default defenses
  and both offense modes (288 trials), plus 674 strategy/zone/repeat trials, checking
  body separation, movement bounds, completion evidence, and defensive ownership.
- `npm run test:simulation-settings`: exact display and diagnostic traces for 52
  deterministic scenarios; historical hashes remain alongside the new traces.
- `npm run test:counter-lab` and `npm run test:counter-lab-replay-validation`:
  diagnosis, verified repairs, replay transport, and malformed traffic metadata.

The [recorded before/after audit](congestion-audit.json) first reproduced all 52
previous coordinated-defense traces exactly. In those scenarios, completed actions
changed from 195 to 205 and obstructions from 103 to 98; 28 durations and 26 final
quality scores changed. Adaptive decisions can also change the number of actions.
The controlled baseline fixture previously left one mover 11.514 feet from its
destination; both movers now finish within 0.067 feet while the screen stays fixed.

The full 962-trial matrix retained zero severe overlaps and the same closest
observed default-matrix separation (1.939 feet during recovery from imported
starting overlaps). Its action totals changed from 2,830 completed / 1,396 obstructed
to 2,734 / 1,468. This is not an improvement claim for every possession: conservative
passage rights, actual defensive traffic, and bounded waiting can also prevent
completion. Every previously separated pair retains swept body clearance.

The switch/slip fixture now keeps the weak-side player away from the screen-user
endpoint and sets the screen five drawing units nearer the handler's lane and
three units closer to the original approach. Its
screen completes before a recorded opening is lost; its tested slip improves the
simulation score and avoids that sustained loss. The earlier crowded setup now
reports its blocked screen without creating an eligible opening. Both cases are
retained as regressions; an advantage that never existed cannot be reported as
lost or preserved. Repairs still require measured evidence; none are
accepted solely because planning delayed an action or suppressed an advantage.
