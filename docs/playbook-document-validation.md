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

## Saved revisions

Creates and successful updates assign an opaque 32-character lowercase hexadecimal
`revision`, independently of timestamps. The editor carries the last saved token
through undo/redo and edits made during pending saves. It is persistence metadata,
excluded from dirty-content comparisons, creation receipts' request signatures,
and simulation behavior. Copies receive a fresh identity and revision.

Updates compare the loaded revision with the stored revision under the existing
write lock. Hosted storage checks within its Web Locks transaction. Local API
clients must send `If-Match: "<revision>"` on PUT; a missing precondition returns
428, malformed preconditions return 400, and mismatches return 409 without writing
the document or its receipt. Conflicts use the existing save error, preserving
the draft, unsaved state, and undo history. Save a copy or reopen the current
saved drawing to continue; never automatically substitute a newer token and retry.

Legacy version-1 documents without a revision load without rewriting storage.
Their first update sends `If-Match: "legacy"` locally, or compares an absent token
in hosted storage. That accepted update assigns a revision, so a second stale
legacy client is rejected. Supplied revisions must have the same valid format on
both targets. Existing idempotent create retries still return their original save
result, including its original revision when available.


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

## Successful save results

A fresh save result is checked before announcing a library change, replacing an
editor draft/baseline, or registering a Counter Lab repair copy. HTTP 2xx alone
is insufficient. It must include an explicit version 1, a complete valid court
(name, roster/action arrays, ball and boolean defender visibility), valid
participant references, a non-provisional persisted ID, and readable creation
and update timestamps. IDs use the local API's lowercase alphanumeric/hyphen
format (8–64 characters). An update must return the requested ID; a new copy
must return an ID different from its source. Optional legacy action defaults
remain supported. Empty drawings and partial rosters remain valid.

The browser-generated result passes the same check before any storage write.
Malformed JSON, incomplete bodies, and mismatched identities use the existing
save-error flow. No success notification is sent and the pending save is
released without clearing unsaved edits, so a valid retry can complete normally.
A server may already have stored a document before returning a damaged response;
response validation does not claim to roll back that server write. Existing
library loads retain their separate, backward-compatible validation rules.

Run `npm run test:playbook-save-results` for malformed 2xx responses, ID/version
checks, browser pre-write guards, preserved draft state, and retry coverage.

## Mutation order

Within an application page, updates (including renames) and deletes of the same
saved play run in invocation order. Playbook and Counter Lab share the same API
module and queue. Each update captures and validates its own input before
waiting, so later caller edits cannot alter a queued save. The next operation
starts only after the preceding operation's storage write or HTTP response
body and validation have completed. Failures reject their own callers and
release the queue; they do not silently cancel later operations. Idle queue
entries are removed.

Within-page queues for separate saved IDs proceed independently. New copies and repair saves receive
fresh IDs and do not block changes to their source play. Existing draft-save
locks continue to handle duplicate create requests. Library reads wait for all
active and queued mutations through the existing write barrier and cannot
publish an intermediate saved library while a later deletion is pending.

Deletion never turns a subsequent update into a create: browser updates check
existence inside the queue, and the local API rejects updates to missing IDs.
A failed deletion leaves the play available for a later save or retry. The in-memory queue preserves invocation order within a page. Cross-client
transaction locks provide the additional guarantees below. Storage events
still invalidate cross-tab library reads.

Run `npm run test:playbook-mutation-order` for deferred save/rename/delete races,
response-body completion, independent-play concurrency, queued read barriers,
input isolation, failure recovery and deletion preservation on both targets.


## Cross-tab and cross-client transactions

On Pages, all creates, updates and deletes acquire the same origin-scoped Web
Lock (`arc-playbooks-v1:write`) before reading the current library. Validation,
existence checks and the complete read–modify–write happen while holding that
lock. A waiting tab rereads storage after acquiring it, preserving changes to
other plays and preventing deleted plays from being recreated by an update.
Native locks release on errors or tab closure. A browser without Web Locks
rejects writes through the existing error path, retaining the in-memory draft;
it never falls back to an unsafe read–modify–write. Pages uses HTTPS, and local
browser testing should use localhost or HTTPS.

The local API uses OS advisory file locks around per-play reads, updates and
deletes across threads and server processes sharing the same storage directory.
Different IDs remain independent; atomic JSON replacement is retained. Lock
files live under `.locks` and intentionally remain after release to avoid
splitting waiters across different inodes. No documents, routes or UI controls
change. Library reads skip files deleted after directory enumeration.

These locks serialize storage transactions, not human editing sessions. Two
clients explicitly saving different whole drawings to the same existing ID
still use last-completed-save behavior; edits are not merged and stale drafts
are not rejected. Older deployed tabs or tools writing storage directly must
be closed/reloaded because they do not participate in this lock protocol.

Run `npm run test:playbook-cross-client` and the Python playbook tests for
independent-client coordination, concurrent creates/updates/deletes, failure
recovery, and separate-process lock exclusion. Native two-tab browser checks
also verify waiting and release against the deployed persistence code.


## Persistence deadlines and uncertain writes

Local API requests have a 15-second deadline covering connection, headers and
complete response bodies. Abort signals cancel cooperative transports; a promise
race also rejects stalled transports that ignore cancellation. Late results do
not apply state or announce a save. Timers are cleared on success and failure.
The existing `finally` paths release shared-read entries, mutation barriers,
per-play queues and UI save ownership. Hosted Web Lock acquisition has the same
15-second bound; expired waiters cannot execute a storage write later.

A timeout or network interruption does not prove that a write failed. The client
makes one read-only check with a separate five-second deadline (at most 20 seconds
total for a timed-out request and verification). Updates require a validated
same-ID document whose persisted content matches the submitted snapshot, with
existing precision/defaults and trimmed names. Deletes require a 404. Creates
send a fresh random 128-bit ID in `X-ARC-Create-ID`, allowing the check to identify
that exact copy rather than guessing from its name. The local API accepts this
optional header, validates it and replays matching creation receipts under the document lock;
reusing the identity for different content returns 409. Older callers without the header retain server-generated IDs;
an older server that ignores it may leave the outcome uncertain.

Only confirmed desired state returns success. Missing, different, malformed or
unavailable verification results produce an explicit uncertain-outcome error;
they never claim that the write definitely failed. No mutation is automatically
repeated. Drafts and existing Counter Lab reports stay in memory, and existing
retry controls become available again. Uncertain creates now retain their attempt identity and submitted snapshot,
so an explicit retry returns the original result without another copy. An aborted HTTP request may
still finish on the server after verification; cancellation is not a rollback.

Run `npm run test:playbook-deadlines` for exact deadline boundaries, stalled
headers/bodies, late results, write verification, bounded uncertainty, cleanup,
retry and hosted lock waits. The Python playbook tests also cover create-ID
validation and duplicate-create exclusion.


## Retrying a creation attempt

Playbook retains the creation identity, first submitted snapshot and draft
revision when a valid create has an uncertain response. Retry submits that same
attempt; confirming it attaches the saved identity without replacing newer
edits. Those edits remain dirty and can then be saved as an update. Loading a
different drawing abandons the in-memory retry. Invalid-input responses release
the attempt so corrected content can be submitted. Counter Lab retains a separate
attempt for each repair in the current report, including while switching results.
New drafts, explicit copies, and repairs in a new report get fresh identities.
Neither caller automatically repeats a request.

The backend commits a private `_creation` receipt and its version-1 document in
one atomic JSON replacement. The receipt stores normalized request content and
the original result, including its timestamps. Updates preserve it; deletes
atomically move the file to `.deleted`, keeping the receipt out of the library.
A matching `X-ARC-Create-ID` returns that original result even after edits or
deletion, without overwriting or recreating anything. A different payload with
the same identity returns 409. Legacy creates without a header remain separate
server-generated plays. Old ID-bearing files without receipts cannot be safely
replayed and return a conflict rather than guessing.

Hosted storage reads the existing `arc-playbooks-v1` array format and writes an
internal `{ version: 1, plays, creations }` envelope on the next mutation. The
single `localStorage.setItem` atomically commits both plays and receipts while
the cross-tab lock is held. All subsequent writes preserve receipts, including
deletes. Corrupt envelopes or receipts fail without overwriting stored data.
Older deployed tabs must be reloaded; their array validator rejects the envelope
rather than silently dropping its receipts. Public library reads and exported
play documents expose only the unchanged version-1 drawings.

Receipts are durable and do not expire automatically: expiring them could make
an old retry create another copy. They consume additional local disk/browser
storage; the existing storage-full error preserves the library if a write cannot
fit. They persist until application data is explicitly cleared. Attempt tokens
in the editor and in-memory Counter Lab reports last for that workspace session.

Run `npm run test:playbook-idempotency` plus the Python playbook tests for lost
acknowledgements, original-snapshot retries, preservation of newer edits,
independent clients, content conflicts, concurrent requests, storage failures,
receipt corruption and replays after edits/deletion. Existing deadline tests
continue to assert that no writes are retried automatically.

Saved libraries use descending `updated_at` timestamp text, with ascending document
ID as the tie-breaker. Both targets compare Unicode code points, independent of
locale; absent/non-string legacy timestamps use an empty key and appear last.
Playbook's immediate save update uses the same order. Sorting read views never
rewrites stored documents, receipts, or timestamps.
