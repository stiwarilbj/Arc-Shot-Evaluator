# Playbook action dependencies

Playbook and Counter Lab share this browser engine on both hosted and downloaded
builds. Version-1 play documents and original action sequence labels are unchanged.
The compiler binds legacy participants using the existing rules, then creates a
private graph with stable action/sequence keys, nominal start times, required
possession, and completion/catch prerequisites. Prepared trials copy their plans
and mutable execution state; their graphs reference only their own bound actions.

## Execution rules

- Drawing sequence groups still establish the nominal timeline. Independent moves
  do not run early; dependency delays no longer extend their whole sequence group.
- Actions sharing participants across earlier sequences wait for those actions to
  finish. Transfers share the single ball and require recorded catches. An on-ball
  move requires actual possession when it starts; a receiver's next drive cannot
  start merely because the planned pass duration ended.
- Each delayed action owns its existing maximum 1.2-second execution extension.
  Only unstarted descendants have their predicted start times adjusted. Waiting
  on a prerequisite does not consume the dependent action's own execution allowance.
- A failed prerequisite obstructs its descendants with a notice identifying the
  prerequisite move. Unrelated actions remain executable. Waiting notices and
  compile-time conflicts use the existing execution diagnostics and UI notice.
- Duplicate simultaneous primary movement claims and competing simultaneous ball
  transfers are rejected in stable drawing order. A rejected competing route does
  not become a prerequisite for later moves controlled by the winning route.
- Simultaneous receiving cuts can guide the recipient of a pass. Screen-support
  movement can coexist with a deliberate authored route. Cooperative screens with
  the same user and exit target remain allowed; contradictory screens for the same
  user are diagnosed before execution. All members of a circular dependency are
  identified, while their descendants receive ordinary prerequisite failures.
- Screen approach/set/use/release phases remain authoritative. Rolls and pops
  cannot release before recorded screen use. Slips retain their deliberate bypass
  of the set/use phases. An unavailable screen participant obstructs the action;
  it cannot manufacture successful screen use.
- Automatic actions join the graph after defense-dependent initialization. Adaptive
  continuation retains its bounded duration and scripted mode still disables it.
  Starting an eligible action at a completed step boundary avoids a display-tick
  gap between a catch and its dependent action.

Plans are internal execution data, never fields on saved arrows. This feature does
not reinterpret a diagram's intent beyond its existing binding rules. In particular,
a movement authored simultaneously with a pass to that player remains a receiving
route; a later on-ball movement requires the catch. Existing saved drawings and undo
history are not rewritten. Quality remains a simulation score.

## Regression commands and audit

From `frontend/`, run `npm run test:action-dependencies`,
`npm run test:playbook-simulation`, `npm run test:counter-lab`,
`npm run test:counter-lab-boundaries`, `npm run test:coordinated-movement`, and
`npm run test:simulation-settings`. These are local commands; no CI workflow is added.

Focused fixtures cover a genuinely delayed handoff with an independent cut, failed
prerequisites, two chained catches, a moving receiver, simultaneous ownership,
cooperative screens, circular/self dependencies, abandoned screen participants,
roll release, partial rosters, source preservation, and prepared-run isolation.
The existing matrix covers all 24 starters across six defenses and two offense
modes (288 trials), plus 674 additional strategy/eligible-zone trials.

The historical 52 settings traces were reproduced using the pre-change engine
before capturing new dependency-engine hashes in the same fixture. All 52 traces
change because start-boundary diagnostics and/or scheduling change; 46 have changed
duration. The previous whole-phase delay could inflate unrelated action durations;
the new scheduler also exposes failed prerequisites that previously allowed later
moves to proceed. Historical hashes and step counts remain available in the fixture;
new hashes/step counts are pinned separately rather than claiming unchanged output.
