# Save-and-simulate compatibility

Run from the repository root after installing frontend and backend development
dependencies:

```sh
npm --prefix frontend run test:save-simulate
```

Or run `npm run test:save-simulate` from `frontend/`. The command is also included
in `npm test`; no GitHub check workflow is added. Use Node.js 22.18+ (native
TypeScript stripping), the frontend dependencies, and Python 3.12 with the
project's `dev` extra (`uv pip install --python .venv/bin/python -e '.[dev]'`
after the normal setup). The harness uses the repository's `.venv` Python when
available and otherwise `python3`. Set `ARC_TEST_PYTHON` to an interpreter path
if the environment lives elsewhere.

The harness bundles the real `api.ts` twice with the local and GitHub Pages
build flags. Hosted persistence uses an isolated in-memory `localStorage` and
Web Locks stand-in. Local API requests go through the real FastAPI routes and
file persistence using `TestClient` in a Python subprocess. A temporary directory
holds all local plays, locks, and creation receipts; it is removed on completion
or ordinary assertion failure. No HTTP server, listening port, running app, user
library, paid service, or network request is required.

Seven fixtures cover explicit/default curves, slips, handoffs, simultaneous
sequences with deliberately unsorted array order, explicit/nonconsecutive
participants, legacy implicit bindings and omitted action defaults, partial
rosters, no defenders, empty drawings, ratings/badges, and precision on every
supported point field, controls, exit targets, and timing. Each fixture goes
through creation, two updates, and three fresh-client library reloads on each
target. Assertions check fresh identity, unchanged source drafts, version-1
content, fixed precision examples, no drift, action order, and all participant
bindings and planned action timing.

Each reloaded play then runs through the shared engine in four explicit,
repeatable configurations: switching/drop defense and Drawn play/Adaptive
offense. Comparisons include the normalized source, hosted reload, local reload,
and a repeated hosted run. Every fixed-step display frame and Counter Lab
observation is compared via SHA-256 digests; failures identify the scenario and
first differing sample. Final execution outcomes, possession, shot state, quality,
and retained sample count are compared directly. A handoff must actually complete
and transfer possession in Drawn play mode, guarding against vacuous agreement.

Generated document IDs and timestamps are excluded from semantic comparisons.
Only supported omitted-field defaults are normalized: straight paths, 1.2-second
timing, index-based sequences, default ratings, and empty badge lists. Replay
points compare coordinates; redundant marker attributes on a route endpoint do
not change its geometry. Effective roster attributes and all route metadata are
checked separately. Values are otherwise compared exactly, without rounding
simulation output or allowing a floating-point tolerance.

This is a persistence/engine integration check, not a native-browser storage,
rendering, or cross-tab-lock test. Existing browser and persistence regressions
cover those boundaries. To extend coverage, add a fixture with independent
expected actor/order values in `scripts/fixtures/save-simulate-plays.mjs`.
