# Transactional saved-play recovery

Playbook and Counter Lab repair saves use the same persistence service. Drawing
exports remain version 1. History is private storage metadata, never part of the
court, simulation, undo history, or exported drawing.

## Commit and retention rules

Each play retains eight recent committed entries, including deletion entries.
Every entry has a SHA-256 checksum, revision identity, and parent revision/checksum.
Pruning records the last removed parent's identity/checksum as an explicit chain
boundary; a missing retained parent is never treated as normal pruning. The
current head is checksummed too. Checksums detect accidental damage; they are not
signatures or protection against someone intentionally editing browser storage.

Successful saves acknowledge the complete head/history/receipt transaction.
Preparing revision data alone is not a commit. Ordinary readers never load an old
revision as a fallback, promote an orphan, or infer deletion from a missing file.
Explicit tombstones take precedence over any leftover current drawing. Late
creation retries can return their original receipt without restoring a deleted
play, preserving the existing idempotency contract.

## Hosted storage

The existing `arc-playbooks-v1` localStorage key now contains a version-2 library.
All current drawings, bounded history, deletion records, migration evidence, and
creation receipts share **one atomic `setItem`**, inside the existing cross-tab
Web Lock. This uses the browser's existing atomic value replacement rather than
introducing a separate IndexedDB transaction or a multi-key migration. The
complete candidate is validated and checksummed before writing, then exact bytes
are read back before success. Checksum verification is cached only for identical
stored content. Deadlines are checked again immediately before writing, including
when checksum work takes time. Other tabs receive the existing storage event.

Legacy arrays and version-1 envelopes load without rewriting anything. Their
first accepted mutation prepares and verifies history for every existing play,
including tombstones inferred from retained creation receipts. It retains the
validated legacy envelope as a checksummed migration snapshot in that same
transaction. Failure preserves the previous stored value. The fixed migration
snapshot and original creation receipts are retained separately from the eight
recent entries; history never grows per save beyond that bound.

The complete envelope retains the existing 16 MiB intake budget; the browser's
actual quota can be lower. If history/migration cannot fit, the save fails safely,
retaining the draft and previous library. No history is silently discarded to make
a save succeed. Browser clearing and device failure can still remove local data;
this is revision recovery, not an external backup.

## Downloaded app

Immutable entries live at `playbooks/.revisions/<id>/<revision>.json`. The existing
`playbooks/<id>.json` becomes the atomic current-head record, retaining the current
drawing and creation receipt plus private `_history` metadata. API responses strip
private fields. A save validates every retained revision, writes/synchronizes its
immutable entry and directory ancestry, validates the resulting head, then
atomically replaces and synchronizes the current head. Legacy files gain a retained
baseline on their first mutation. Missing legacy dates receive an epoch metadata
fallback in that baseline; saved route coordinates are retained without rounding.

Deletion commits the matching head at `playbooks/.deleted/<id>.json` with a new
checksummed deletion revision, then removes the former current file. Every reader
and writer checks the tombstone first. Tombstones survive indefinitely, including
plays created without idempotency headers. Pruning follows the commit, removes
only independently verified unreferenced revision files, and preserves damaged
files. Failed cleanup cannot undo a committed save. A later save retries retention.

A failure after replacement reports an uncertain outcome. Direct GET and creation
retry revalidate and synchronize the referenced files/directories before confirming
success; an unreadable or unsynchronized head cannot confirm a save. Directory
synchronization remains subject to operating-system support and physical storage
behavior. Existing per-play process locks and two-second acquisition deadlines
remain in force.

## Explicit recovery access

No new editor controls are added. Once Playbook or Counter Lab has loaded, a
maintenance helper is available in the browser console on **both targets**:

```js
const history = await window.arcPlaybookRecovery.history("play-your-saved-id");
// Inspect integrity, deleted, and each revision's valid flag/document first.
const savedCopy = await window.arcPlaybookRecovery.recover(
  history.id,
  history.revisions.find(r => r.valid && r.document).revision
);
```

Choose the intended revision explicitly. `recover` creates a new play named
`<name> (recovered)` with a fresh ID/revision and normal save validation. The
original, its tombstone, and the active draft are untouched. An optional third
argument supplies a `play-<32 lowercase hex>` creation identity for safe retries
when a recovery response is uncertain. Reuse that identity for the same attempt.

The downloaded API additionally exposes `GET /api/playbooks/<id>/history`.
`integrity` distinguishes verified/damaged heads; `deleted: null` means it cannot
be established. Local entries distinguish committed revisions from uncommitted
preparations, or report unknown commitment when the head itself is unreadable.
Independently validated revision files remain inspectable after head corruption.
Inspection is capped at 32 files per play; larger abandoned sets remain on disk
for manual inspection instead of an unbounded request. Storage access failures
remain errors, rather than being presented as ordinary corruption.

For a damaged hosted transaction, explicit recovery preserves its **exact source
JSON** and checksum in `preservedSources`, reserves all known original identities,
and commits the selected verified copy separately. It does not promote any
uncertain old heads. Further copies can be recovered from that preserved source.
Ordinary library refresh continues reporting an incomplete library, with recovered
copies in its diagnostic `availablePlays`; previously loaded libraries remain in
place. This intentionally requires manual inspection of the preserved source
before normal complete-library operation can be restored. Recovery that cannot
fit the preserved source plus copy fails without changing storage. Invalid JSON
or a revision that itself fails verification requires an external backup/manual
repair; it is never guessed or silently replaced.

## Verification

```sh
cd frontend
npm run test:playbook-history
npm run test:playbook-cross-client
npm run test:playbook-idempotency
cd ..
.venv/bin/python -m pytest tests/test_playbook_history.py tests/test_playbook_durability.py -q
```

Regressions cover migration/quota failures, immutable preparation versus commit,
interruption before/after head publication, checksums and parent chains, pruning,
missing/corrupt revisions, unreadable heads, retained evidence, tombstones with
interrupted cleanup, idempotent retries, and explicit recovery to fresh copies.
