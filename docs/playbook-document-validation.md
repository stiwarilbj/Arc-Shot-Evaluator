# Version-1 play validation

Browser persistence (both build targets) and the local Python API validate the
same document content. The matching examples live in
`tests/fixtures/playbook-documents.json`; the Node and Python regression tests
both consume that file. Keep those examples and both validators in sync when
adding an action, badge, or document field.

- A missing version means legacy version 1; explicit versions must equal 1.
- Names contain 1–80 characters after trimming; omitted names default to
  `Untitled play`. Defender visibility, when supplied, must be boolean.
- Each team has at most five markers. IDs are positive, safe integers, unique
  within each team. Offensive and defensive IDs may coincide. Empty and partial
  rosters are valid drawings.
- Coordinates (markers, ball, action endpoints, controls, and exit targets) are
  finite numbers in [0, 100], never booleans or numeric strings.
- Offensive ratings are integers in [1, 5]. Missing ratings default to 3.
  Missing badge lists default to empty; supplied lists contain unique supported
  badge IDs from the appropriate team's catalog.
- At most 30 actions are allowed. IDs are unique 1–64 character lowercase
  alphanumeric/hyphen labels. Kinds must be supported. Sequences are integers
  in [1, 30] (ties are allowed); omitted sequences follow diagram order.
  Short legacy IDs such as the shipped `cut` action remain valid.
  Paths are straight or curve; durations are finite numbers in [0.5, 4].
  Legacy omitted paths and durations retain their straight/1.2-second defaults.
- Every supplied participant reference must identify an offensive player.
  Pick-and-pop requires distinct screener/handler and an exit target;
  off-ball screens require distinct screener/cutter; pin-down also requires an
  exit target. Backdoor cuts require an actor. Recipients belong only to passes
  and handoffs, and must differ from an explicitly supplied actor. Legacy
  screens without explicit participants remain valid. Null optional
  participants, controls, and ball retain their existing meaning.

Validation does not mutate browser drawings. The API retains its existing
save normalization (default fields, trimmed names, coordinate/timing rounding)
and authoritative IDs/timestamps. Saved documents require an ID, name, and
roster/action arrays. Loads validate before use, retain legacy documents as
stored, and never overwrite damaged data. Invalid browser libraries use the
existing preserved-data error; invalid local files use the existing read error
or library warning. Both Playbook saves and Counter Lab repair copies use the
same persistence entry points.

Run `npm run test:playbook-document-validation` in `frontend` and
`.venv/bin/python -m pytest tests/test_playbooks.py` from the repository root.


## Save precision

Both persistence targets use the local backend's existing version-1 precision:

| Fields | Decimal places |
| --- | --- |
| Player/defender x/y, ball x/y, action start/end/control/exit-target x/y | 4 |
| Action timing in seconds | 2 |

Round to the nearest decimal value, with exact ties going to the even final
digit, evaluated from the actual IEEE-754 binary floating-point input. This is
Python's `round(float, places)` behavior. For example, a timing of `1.125` saves
as `1.12`, `1.375` as `1.38`, and `2.675` as `2.67` (the binary value is slightly
below the decimal midpoint). Multiplying first with `Math.round`, or using
JavaScript `toFixed`, does not reproduce every case. Browser normalization uses
the exact binary significand to match Python, including nearby representable
values. JSON may spell whole numbers differently (`50` versus `50.0`); their
numeric values are equivalent. Signed zero is likewise equivalent in storage.

Validate the original input before rounding, so an out-of-bounds coordinate or
duration is never made valid by rounding. Normalize a separate copy on explicit
create/update, before browser storage or the local HTTP request. The backend
also applies the same policy for direct API clients. Missing optional fields
retain their defaults; no ratings, IDs, sequences, badges, names, or other
numeric fields receive additional rounding. Document version remains 1.

Normalization does not change live simulations, unsaved coordinates, or undo
snapshots. Loads remain lossless and do not rewrite old documents. Saving one
play does not round other saved plays. Saving/reloading repeatedly is
idempotent, and newer edits made while a save is pending remain protected by
the existing revision checks. Playbook and saved Counter Lab repairs share the
same save boundary.

`tests/fixtures/playbook-precision.json` contains shared Python-expected values
for exact ties, adjacent binary values, tiny coordinates, bounds, and seeded
samples. Run `npm run test:playbook-precision`,
`npm run test:playbook-document-validation`, and the Python persistence tests.
