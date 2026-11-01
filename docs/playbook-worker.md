# Playbook execution worker

Both build targets create `playbookSimulation.worker.ts` on the first Play.
Resetting/loading another drawing terminates its previous worker; unmounting
does the same. Counter Lab continues to own its independent analysis worker.
Neither execution path calls the local server. The main bundle still uses the
shared engine's lightweight authored bindings, route previews and defense setup
helpers for drawing; it does not create, step, seek or rebase an executable run.

## Commands and ownership

`playbookSimulationProtocol.ts` defines and runtime-validates start, playback
(pause/resume), settings, paused edit/relocation, seek and frame commands. Every
command and response contains a session ID, monotonic revision and request ID.
Settings use the engine's existing validator; documents use the shared version-1
validator. Returned display snapshots validate clocks, engine version, possession,
coordinates, route geometry, action participants and presentation fields before
entering React.

`playbookSimulationHost.ts` owns exactly one recorded simulation run. It executes
the same public engine APIs as direct execution, with the original seeded defense
and session checkpoints. A frame advances at most 50 ms through the unchanged
fixed-step accumulator, then produces the engine's interpolated display snapshot.
Paused frames do not advance execution. Settings and edits are applied between
steps; paused transactions retain the engine's validation/atomic commit behavior.

The client sends one request at a time. Display callbacks supply elapsed time
only; pending time is capped at 100 ms. Repeated adjacent settings, seeking,
playback and edits to the same marker coalesce before posting. Different-marker
edits retain order. Control buffering is capped at 32 entries; overflow stops the
worker rather than retaining an unbounded queue. On very slow devices, the clock
debt cap favors responsiveness over catching up with all elapsed wall time.

Every control intent increments the client revision immediately. An old frame
can acknowledge only its own outstanding request and cannot replace a newer
edit/setting/seek. Worker state is never used to replace the editor draft or its
undo history. Paused marker drags show immediate display-only feedback while the
latest transaction awaits acknowledgment; that feedback is never executable state.

## Lifecycle and failures

Leaving Playbook or hiding the document sends a pause and clears pending clock
debt. Returning does not automatically resume. Pause/resume during startup is
ordered behind start; stale startup acknowledgments do not change the chosen
playback state.

Worker errors, message decoding failures, malformed matching responses, posting
failures and a ten-second response deadline terminate the worker. Intentional
reset/unmount is silent. Unexpected termination without an error event is detected
when the next command exceeds its deadline. The editable draft and undo history
stay available, and the court retains the last acknowledged valid frame. Replay
seeking is disabled until Play starts a fresh session. A failed worker's in-memory
journal is not automatically recovered; no main-thread execution fallback runs.

## Verification

`npm run test:playbook-worker` compares 17,360 display/session snapshots against
direct engine calls across 24 starters in both modes. It includes settings,
attribute edits, relocations, seeking and replay. Transport tests cover delayed,
duplicate and cross-session responses, coalesced drags, bounded debt/control
queues, 30/60/120 Hz advancement, pause/resume, invalid messages, worker errors,
posting failures and silent response loss. The existing engine/session
regressions still check full executable-state equality and fixed trace hashes.

Chrome integration checks exercise the built worker, startup pause/resume,
paused edits and undo/redo, seeking, workspace/visibility pauses and unexpected
worker exit. These are local verification commands, not additional CI workflows.
