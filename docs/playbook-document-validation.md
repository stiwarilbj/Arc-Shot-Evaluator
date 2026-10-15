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
