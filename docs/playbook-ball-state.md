# Authoritative ball state

Playbook and Counter Lab use the same browser simulation on the hosted and
downloaded targets. `ballState.ts` defines legal possession transitions;
`simulation.ts` supplies movement, proximity checks, and action scheduling.
Saved version-1 drawings are unchanged. There is no new service or API.

## States and control

| State | Controller | Permitted progression |
| --- | --- | --- |
| Held | Holder | Movement, pass release, handoff attempt, or shot setup |
| Pass in flight | None | Confirmed catch, failed/interrupted transfer to loose ball |
| Handoff pending | Giver | Confirmed exchange; failure/interruption retains an available giver |
| Loose | None | Nearby offensive player recovers the ball |
| Shot setup | Shooter | Actual release, or drop if the shooter becomes unavailable |
| Shot in flight | None | Shot result |
| Shot result | None | End of simulated possession |

The run's former possession, shot, position, and velocity fields are represented
by this union. Compatibility reads such as `ballHandlerId`, `ball`, and
`shotStart` are getters derived from it. They cannot independently assign
possession. Defensive anticipation of a receiver remains separate from control.

A new pass/handoff may start only from Held with its actual giver and an available,
different receiver. Another transfer or shot cannot release from an airborne pass.
Shot setup retains the shooter until the existing 18% release boundary; flight
ends at the existing 84% result boundary. The ball follows its recorded release
position, and paused edits preserve the active shot/transfer identity.

## Transfer evidence and recovery

Each transfer has one record, shared with its active ball state. It stores the
action/sequence identity, giver, intended receiver, release position/time, actual
arrival, and exactly one catch, failure, or interruption outcome. Frames receive
independent snapshots of this evidence. It is internal replay data, not a field
added to saved plays.

A pass records release when it starts. Arrival records the first observed ball
position within 1.1 feet of the live receiver. A confirmed catch also requires
the action's minimum duration to have elapsed and the receiver still being within
that radius. The receiver may follow a simultaneous authored receiving route.
Handoffs additionally require participants within 2.8 feet; the pending exchange
does not transfer control. Its release/arrival/catch are recorded at confirmation.

Uncaught transfers retain the existing bounded 1.2-second extension. A timeout
fails the transfer. A released pass becomes loose at its live position and
velocity. An uncompleted handoff retains its available giver; losing the giver
leaves a loose ball. Rejecting an unavailable receiver before release keeps the
holder. Recovery does not rewrite a failed transfer as a successful catch.

Loose balls retain bounded motion/deceleration and may be recovered within 1.15
feet. Nearest distance, then player ID, resolves competing recovery claims.
Recovery starts on a subsequent step after the ball becomes loose, so the same
step cannot both fail a pass and immediately hide that failure through recovery.
Only an explicitly loose ball triggers voluntary recovery movement. Scripted mode
still suppresses voluntary improvisation.

## Step order

1. Reconcile unavailable holders/receivers and interrupted transfers.
2. Start ready actions in stable diagram order against current control.
3. Resolve player and defender movement together.
4. Advance the active ball's physical position.
5. Record arrival and confirm a catch, extend a transfer, or record failure.
6. Finalize other movement actions.
7. At the completed step timestamp, unlock dependent actions using confirmed
   outcomes. A catch and a receiver's drive can share the exact timestamp.
8. Evaluate eligible adaptive reads, then publish the frame. Shot-only steps
   update setup/release/result states at their explicit clock boundaries.

Illegal transitions throw before changing the state or evidence. Transfer
records retain their historical outcome after later possession changes.
Counter Lab reads these records for delivery/failure and adaptive success.
Ordinary pass transit has no actionable shot opportunity and does not itself
establish a lost opening. Failed transfers and subsequent held-ball positions
remain eligible diagnostic evidence. Existing opening thresholds are unchanged.

Both replay paths carry the phase and avoid interpolating across phase or
controller discontinuities. Decoding validates controller/phase consistency and
transfer identity, coordinates, timestamps, and caught outcomes. Legacy replay
fixtures without the optional phase remain compatible. Completed-trial cache
version 4 invalidates prior engine results.

## Verification

Run `npm run test:ball-state` from `frontend/`. It exercises legal/illegal
transitions, actual moving-receiver catches, identical catch/drive timestamps,
receiver loss, handoff interruption, bounded timeout, loose recovery, shot
release, paused edits, frame isolation, prepared runs, worker archive decoding,
and damaged evidence. The full `npm test` command includes this regression.

The historical 52 dependency-engine settings traces were reproduced before new
ball-state hashes were captured. All hashes change because frames now expose
ball phases and transfer evidence; 42 scenarios change duration and 27 change final
quality as possession, adaptive reads, and shot timing follow actual ball control.
The audit observed 95 obstructed/218 completed actions before and 92 obstructed/213
completed afterward; adaptive action counts may differ. Historical hashes and
step counts remain in the fixture alongside the current ones. They are not
asserted as equivalent behavior. Simulation quality remains a simulation score.
