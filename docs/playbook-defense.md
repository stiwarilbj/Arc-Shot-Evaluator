# Coordinated defensive responsibilities

Playbook and Counter Lab use one team responsibility planner before calculating
individual movement targets. It runs in the shared browser engine on both build
targets. There is no new service, setting, or saved-document migration.

## Ownership and priorities

Each active defender has one executable duty, with a player or zone, start time,
reason, related defender/action where applicable, and release condition:

| Duty | Ownership | Release |
| --- | --- | --- |
| Primary | One defender contains the current ball threat, including an anticipated pass recipient | Ball threat or assignment changes |
| Screen | Locked participants execute the selected coverage | Action ends, participant is lost, or strategy changes |
| Helper | One eligible defender commits to the drive | Ball threat changes, a priority duty takes over, or the threat stays absent for 220 ms |
| Rim protector | One remaining defender supports the interior while retaining their player/zone | Priority takeover or a materially better available position |
| Recovery | A defender returns to the inherited player/zone | Within six feet, assignment changes, or a priority duty takes over |
| Matchup / zone | Remaining defenders retain their team matchup or claim a zone closeout | Assignment, nearby threat, or ball area changes |

A primary involved in a screen retains its primary role and records the screen's
action ID. Screen reservations, primary pressure, and designated hybrid-zone
chasers take priority over voluntary help. Recoveries cannot simultaneously become
new helpers. Spare defenders without a unique matchup hold their positions.

The rim role prefers interior positioning and paint-protector badges. It retains
its owner for at least 320 ms unless a priority takes over, then uses a four-foot
preference for the current owner to avoid small positional changes flipping the
role. Its shading remains bounded and respects the selected strategy. Existing
speed, acceleration, body clearance, anticipation, and collision rules still apply.

## Explicit help rotations

The engine's existing drive, shooting-threat, distance, and badge evidence selects
eligible helpers. One free teammate may inherit the helper's vacated responsibility:

1. The helper commits to the driving threat.
2. A replacement takes the helper's previous player, or the helper's zone slot.
3. The helper inherits the replacement's previous responsibility for recovery.

These ownership changes happen together. Recovery does not send both defenders
back to the helper's old player. Completed rotations remain the team's matchups
until another explicit rotation or switch changes them; they do not rewrite the
saved drawing. Zone rotations exchange area slots without changing hybrid chasers
or converting the zone to permanent man coverage.

The planner records the vacated and exposed player/area, helper, replacement, and
time. The latest 32 rotation events remain in the run for diagnostics. An exposure
is real: helping with five defenders cannot cover six responsibilities. If no free
replacement exists, the record identifies that absence instead of inventing one.
The helper recovers to the inherited responsibility when the drive ends; a pass
or reversal immediately gives primary pressure to the appropriate receiver owner.

## Screens, transitions, and zone claims

Screen locks reserve two distinct defenders from approach onward. They release
when the action ends, changes participants, loses a defender, or the strategy
changes. An unavailable pairing is retried on later steps rather than permanently
remembered as unavailable. Consecutive screens acquire their own current owners.

Man switches exchange both assignments at the actual interaction, and record a
switch only when both defenders exist. Zone switches exchange temporary coverage
at screen use or close handoff contact; approach alone does not trigger them.
The zone ball-pressure selector respects the locked owner while that interaction
is active. A screen trap already supplies its second defender, so voluntary
drive help releases instead of adding a third trap participant. Defensive quality
uses the actual primary owner.

Zone closeouts are claimed as a team. Free slots retain a plausible prior claim
with a three-foot score preference, then choose among remaining nearby threats.
Two free slots cannot independently choose the same player. Recovery and rim
support still retain their area responsibilities. Help and screen commitments
remain separate from ball possession; anticipating a receiver grants no catch.

Changing strategy clears active help/recovery duties and screen locks before the
next step; it never moves a defender instantly. Existing behavior that restores
original man matchups when leaving Switch is retained. The scheme itself remains
fixed for the possession. Partial rosters prioritize the ball threat and report
missing rotation support. Hold positions disables voluntary duties and preserves
bounded collision correction.

## Evidence and verification

Display and Counter Lab replay frames contain independent responsibility snapshots.
Worker replay decoding validates known roles, participant identities, one duty per
defender, exclusive primary/helper/rim roles, zone slots, timestamps, and release
metadata. Older replay fixtures without this optional field remain compatible.
Completed-trial cache version 5 prevents reuse of earlier engine results.

From `frontend/`, run `npm run test:defensive-responsibilities` for explicit help
exchanges, the 220-ms release boundary, inherited recovery, consecutive screens,
drive-and-kick, traps and reversals, zone pressure conflicts, chaser protection,
partial rosters, strategy changes, prepared-run isolation, and worker validation.
`npm run test:coordinated-movement` checks responsibility ownership on every step
of 962 starter/strategy/scheme/mode trials, alongside movement and collision bounds.

The settings regression retains historical traces and checks current display and
diagnostic hashes across 52 deterministic scenarios. Coordinated defense intentionally
changes positions, execution outcomes, adaptive decisions, and some shot scores;
it is not a claim that basketball outcomes match real-world probabilities.

The before/after audit first reproduced all 52 prior ball-state traces exactly.
With coordinated duties, 37 scenarios changed duration and 35 changed final shot
quality. Across those scenarios, completed actions changed from 213 to 195 and
obstructed actions from 92 to 103, with 45 explicit rotations. These changes are
expected consequences of different defensive positions, rather than a promise
that every possession becomes easier for the offense. In the original 288-trial
starter matrix, no player centers came within one foot; the closest observed gap
was 1.939 feet. Another 674 trials passed the per-step clearance and responsibility
checks. Paused drawing rebases preserve active responsibility clocks and rotations
until simulation advances again.
