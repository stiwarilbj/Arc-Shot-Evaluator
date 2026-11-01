# Adversarial simulation audit

Playbook and Counter Lab use the same simulation engine in both builds. This
local verification tool generates difficult **valid version-1 drawings**, runs
long command streams and checks executable state. It does not change saved
libraries, start a server, use an API, or add work to the Pages deployment.

## Commands

From `frontend/`:

```sh
npm run test:simulation-adversarial
npm run audit:simulation
npm run audit:simulation -- --seed 20261020 --cases 2048 --commands 128 --report /tmp/arc-audit.json
npm run audit:simulation -- --seed 20261020 --start-index 128 --cases 128
npm run audit:simulation -- --fixture ../tests/fixtures/simulation-adversarial/automatic-screen-ownership.case.json
```

`test:simulation-adversarial` is part of the ordinary frontend regression suite.
It replays every `*.case.json` fixture, checks the verifier and reducer with
controlled faults, compares deterministic executions, and exercises generated
pause/edit/settings/resume streams through the actual worker host. These host
checks include paused frame requests and compare its frames with direct engine
execution. No real browser worker is needed for this local boundary test; browser
worker behavior is also covered by the existing worker regression command.

The larger `audit:simulation` sweep is **separate from `npm test`**. Defaults are
128 cases, 96 generated command groups per case, and 400 reduction executions per
failure. Pause/edit groups expand into several individual commands. Use
`--commands` up to 1,000, `--cases` up to 10,000, and `--shrink-runs` up to 10,000.
`--output DIRECTORY` changes the failure directory; `--report FILE` writes counts
and observed coverage. The base seed, case index, command count, generator and
engine revision reproduce generated inputs. A saved fixture contains the complete
input and remains the authoritative reproduction after generator changes.
`--start-index` resumes a deterministic range without executing earlier cases.

## What is exercised

Generated cases include crossing routes, exact starting overlaps, crowded paint,
baseline traffic, curved routes, court-edge positions, partial/empty rosters,
screens/rolls/pops/slips, passes and handoffs. Participant IDs remain valid even
when the drawing asks for competing or impossible actions. Those actions may
correctly end in obstruction or conflict; the audit does not demand that every
basketball drawing succeed.

Player ratings and badges, explicit/automatic defensive schemes, all defensive
strategies, both offense modes and off-ball settings vary. Commands include
fractional, ordinary and no-op advancements, pause/relocate/attribute-edit/resume,
settings changes, and executable checkpoint save/restore. Each trial owns its
state and deterministic random seed. Restore clones checkpoints so later
execution cannot overwrite a retained checkpoint.

The opt-in `watchSimulationExecution` observer receives isolated snapshots after
**every internal executed slice**, including action/catch boundaries within a
fixed step. It is separate from replay sampling. Normal application runs allocate
no audit snapshots and run no invariant checks. Paused edits, settings changes,
restores, and sub-step/no-op calls are inspected by the command driver too.

Checks cover:

- One authoritative ball phase and controlling player, with matching frame data.
- Finite coordinates/velocities/clocks, court bounds, speed and per-step travel
  limits, and unique roster/action identities.
- One movement owner per actor; transfer phases cannot double as movement phases.
- Ordered start/completion evidence and satisfied prerequisites before actions
  start. Route progress remains finite and within its executable path length.
- Completed passes/handoffs have recorded, ordered release/arrival/catch evidence;
  a live transfer matches its ball state. Finalized transfer evidence stays fixed.
- Newly completed movement has reached its executable destination and braked;
  screens also require their user's destination and ordered set/use/release
  evidence. Slips legitimately bypass setting a screen.
- Released-shot evidence remains immutable, the input drawing stays unchanged,
  and finishing a possession has a bounded execution budget.

Completion geometry is checked **when the phase becomes completed**, before
later movement can invalidate its old destination. Explicit paused relocations
and checkpoint restores are treated as discontinuities, so they do not look like
teleports or retroactively invalidate a previously completed action.

Coverage reports distinguish generated layouts/settings from **observed**
action kinds, phases, completed kinds, commands and resolved defense schemes.
An ineligible zone can legitimately resolve to man defense for a partial roster.
Counters include execution repeated after checkpoint restoration; they are not
counts of unique shots or possessions.

## Failure reduction and regression fixtures

The sweep stops at its first failure and automatically retries reductions that
retain the same invariant code and subject (or the same engine exception).
Every candidate must still be a valid drawing and legal command stream.
Reduction removes command chunks, actions, defenders, and players with their
references; combines adjacent advances and shortens advance/finish runs; removes incidental attributes; and
simplifies coordinates. It repeats until no supported simplification reproduces
the failure, or its execution budget is exhausted.

The tool reports `deletion-and-step-1-minimal` at a fixed point, or
`budget-limited` when stopped early. It **does not promise a global mathematical
minimum**: interacting timings and geometry make that claim inappropriate for a
bounded reducer. Increase `--shrink-runs` or rerun the original fixture for more
reduction work.

By default, failure artifacts are written atomically under
`tests/fixtures/simulation-adversarial/`:

- `seed-… .case.json`: reduced input, automatically picked up by normal regressions.
- `seed-… .original.json`: complete original drawing and commands.
- `seed-… .trace.txt`: bounded command/phase/possession trace, failure identity,
  reduction status and the failed execution snapshot, including geometry and
  catch/dependency evidence.

Names include a content hash. Existing saved plays are never read or changed.
Inspect the case, fix the engine, and keep the ordinary fixture passing. Controlled
faults used to test the verifier affect **detached diagnostic snapshots only**;
they cannot corrupt real engine execution or become production behavior.

## First discovered regression

The initial larger sweep found that an automatic off-ball screen could extend
past its planned slot. When a later authored route started for the same actor,
both actions remained marked executable until the next movement update. The
boundary frame and diagnostics could therefore show conflicting ownership.

`automatic-screen-ownership.case.json` retains the reduced engine-8 failure;
`automatic-screen-ownership.before.trace.txt` records its original failure at
4,000 ms. After the initial 400-run reduction hit its budget, a second reduction
against the unfixed ownership behavior reached a fixed point in 69 executions:
three players, two authored actions and one advance command. Engine 9 settles
ownership at the start boundary, using the same
authored-first priorities as movement execution. The automatic action gets an
explicit conflict immediately; the authored action keeps ownership. The engine
version invalidates deterministic trial caches from the previous rules.

The [recorded engine-9 sweep](simulation-adversarial-audit.json) passed 2,048
generated cases, 430,080 commands and 2,230,275 internal execution slices. It
observed all ten action kinds, all execution phases and all ten resolved defense
schemes. Completed-action coverage is reported separately; sampling a kind does
not imply that every randomly drawn instance completed.

Passing a finite sweep gives evidence about those cases, not a guarantee that
all possible basketball drawings are bug-free. Existing starter, movement,
Counter Lab, worker and session regressions remain necessary.
