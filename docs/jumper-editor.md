# Personal Jumper clips

Open **Others → Guess the Jumper**. Guess, Create and My Clips preserve their
state when switching workspaces. Dark mode remains the default.

## Edit a finished masked video

Open **Edit video** after a successful masking run. No editing action invokes
person detection or SAM. The private masked base is the only source for edits.

- **Cut:** choose a thumbnail strip in the timeline. Moving pieces show beginning,
  middle and ending frame samples; freezes show their held frame. Each strip
  displays its duration and an orange outline when selected. Select with click,
  tap or keyboard to pause and seek to that piece. Thumbnails use only the private
  masked base, are cached within this editor, and never start inference.
  Set source start/end with sliders or
  seconds, split at the playhead, delete, and move left/right. The last piece
  cannot be deleted. All times snap to 30 fps; the timeline cannot exceed 60s.
- **Text:** enter up to 200 characters, then **Add at current time**. A caption
  starts there and lasts two seconds or until the end. Edit its interval,
  size, and top/center/bottom placement. White text has a black backing. Moving
  pieces leaves captions at their edited times; shortening the video clamps
  their intervals and flags them for inspection.
- **Effects:** select 0.5×/1×/2× per piece; insert a one-second freeze and adjust
  its duration in Cut (0.5–3s). Set start/end zoom from 1–2× and drag the preview
  or use horizontal/vertical framing sliders. Fades last approximately 0.25s.
  Slow motion repeats recorded frames; it does not invent body motion.
- **Undo edit / Redo edit** keep up to 50 operations separately from mask history.
  **Reset edits** restores the complete base timeline. Editing requires another
  final-motion review. Mask warnings still block saving until corrected.
- **Update finished video** commits the preview to downloadable media. Cancellation
  or failure retains the previous successful download. Stale results cannot be
  approved or saved. Playback pauses in hidden workspaces and hidden browser tabs.

The **Clean quiz preview** toggle uses identical cuts, speed, and freezes, with
no captions, zoom/pan, or fades. The same clean file plays before and after a
personal quiz answer. My Clips playback/download uses the edited viewing version.

**My Clips → Edit copy** reloads the base and version-1 recipe. Saving makes a
new clip, preserving the original. Private backups atomically include base,
recipe, and finished variants, within the existing 512 MiB archive budget. A
flattened older masked clip can also be edited; original-color legacy highlights
must be masked in Create first. Raw uploads, tracking tensors, and models are
never included in saved edit projects or backups.

Browser export uses Mediabunny/WebCodecs in a dedicated worker and chooses MP4,
then WebM according to encoder support. The local app can fall back to queued
FFmpeg rendering without starting inference. Both use integer frame mapping,
bounded decoding, a bundled OFL caption font, and independent output validation.

## Create

1. Choose a decodable video up to 100 MB; trim to at most 15 seconds.
2. Click or tap to aim at the shooter in the selected segment’s first frame,
   adjust with the nudge buttons, then press **Place point**. Aiming only moves
   the crosshair; it does not add a correction or start processing. Placement
   adds exactly one point and one undo step. Re-aim to add another point;
   changing frame, track, or Include/Exclude mode discards the unplaced aim.
   Escape cancels the unplaced aim without changing existing corrections.
   That person becomes
   black. Other people are detected automatically throughout the segment,
   including later entrants. No player name or manual roster is required.
   Keyboard users focus the frame, move with arrows (Shift for larger steps),
   and press Enter/Space. The magnified view follows your aim; touch users can
   aim with the directional buttons and use **Place point**. Use **Select shooter
   again** to restart selection.
   After selection, a short starting sample is checked automatically, showing the
   first frame with only the selected person black. This check loads
   the free masking model if needed; uploading alone does not. It is not
   a finished clip or tracking approval. Changing the starting selection clears
   the check; cancelling it preserves your drawing.
3. Process, then inspect the entire result in motion. Desktop review shows the
   original reference beside the masked output; on mobile use **Masked / Original
   reference** to switch views. Both share one 1× playback clock aligned to your
   trim start. **Review position** seeks both and pauses playback (keyboard arrows
   work too). Leaving Create or hiding the browser tab pauses both without
   automatically restarting. Only the masked output is saved or downloaded.
   If the original reference cannot decode, masked review remains available.
   In **Correct masks & player
   selection**, select a track, scrub to a problem frame, and add Include/Exclude
   points. Remove spectators/artwork; removed tracks retain stable identities so
   discovery does not immediately add them back. Reprocess after any correction.
   **Undo / Redo** retain up to 50 edits, including points,
   removed tracks, shooter changes, discovery and resets. Ctrl/Cmd+Z undoes and
   Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes when focus is outside text-entry fields.
   Typing retains native text undo. Undo/redo always requires processing and
   review again; saved clips are unaffected. A new edit clears redo. Replacing
   the upload or changing the trim clears history for that segment.
   Automatic discovery can be disabled for manually selected court participants.
   The **Frames to review** timeline marks missing-shooter masks, unstable outlines,
   ambiguous overlaps, and possible camera cuts. Click a colored band to inspect
   the nearest flagged frame and its recorded track; overlap hints offer each
   involved track separately. Focus a row and use Left/Right for keyboard seeking.
   These are review hints, not accuracy guarantees: unmarked frames can still
   contain errors. Corrections retain the previous run’s hints, labeled as stale,
   until reprocessing. Resetting the shooter or replacing the roster clears them.
4. Resolve lost-target, ambiguous-player, instability or cut warnings before
   saving. Detection cannot establish identity through every overlap. The editor
   stops rather than silently dropping people when more than twenty tracks are
   needed. Shorten the clip or use manual selection in a closer view.
5. Edit the masked result using **Cut**, **Text**, and **Effects** (see above).
6. Update the finished video and review the complete motion, then save or download. A player name is required
   only for **Use in my guessing game**. Personal quiz answers reveal the name
   while keeping the same silhouette footage. Failed saves retain the download.

Finished previews, downloads, saved clips and personal quiz playback use a
masked timeline: target black, other included people in stable per-track gray shades, flat neutral gray
background. The silhouette compositor copies no original pixels, even inside a
bad mask, and exports contain no audio. Original footage is only an editing
reference. Masks can still include background shapes or miss limbs: approve only
after reviewing all frames and correct or reject uncertain results.

The personal rendering path reads only label masks, never source image pixels;
an encoding retry likewise needs only the completed masks. Offline preparation
can still explicitly produce original-foreground reveals for licensed public
clips, but the personal editor always requests silhouettes. The native server
validates saved media before publishing metadata. Original silhouette profiles
require byte-identical variants and retain their strict three-color checks. The
new `silhouette-edited-v1` profile allows the viewing and clean quiz versions to
differ, while requiring identical clean quiz/reveal files and matching 30 fps
timelines, neutral colors, correct orientation, and no audio. Backup restores check neutral video interiors as
well as decoding; compression edges allow bounded tolerance. These checks do not
identify every possible incorrectly segmented background shape.

Existing personal quiz clips also use their masked video after answering. Older
highlight-only clips are labeled **Legacy** and offered as downloads without an
anonymized preview; they have not been reprocessed automatically.

## Targets and resources

Hosted creation uses a dedicated WebGPU worker, SAM 2.1 Tiny vision, decoder,
attention and memory encoder graphs, and Mediabunny/WebCodecs. It downloads about
170 MB of model assets on first processing or silhouette preview; browser cache reuse depends on quota.
Download progress supports compressed responses from Pages: decoded byte counts
never exceed the valid progress range or abort processing. Unknown or compressed
totals show bytes received without estimating a completion time from that length.
The detector loads when automatic discovery or manual proposals are requested. Devices without WebGPU/video encoding can
still use Guess/My Clips; use the downloaded editor for native processing.

The downloaded app installs SAM from pinned upstream commit
`2b90b9f5ceec907a1c18123530e92e794ad901a4` through `scripts/setup.sh`. It verifies
weights before use, runs one heavy task through the existing queue, uses MPS/CUDA when available and restarts on CPU after accelerator failures.
MPS uses real-valued rotary attention to avoid complex-tensor operations, but
accelerator tracking can still drift. A lost or unstable target, or a mask
expanding into the background, restarts tracking from the original selections
on CPU. Genuine tracking warnings on CPU still require correction before saving.
If the OS terminates an accelerator subprocess before Python can catch the
failure, the local queue retries once in a fresh CPU process. Released or
cancelled jobs cannot retry; a failed CPU attempt reports an error.
Native decoded frames use a two-frame cache;
ordinary tracking memory keeps the recent sixteen frames while retaining
correction frames. Temporary jobs
are cancelled and removed when released; saved media is separate in ignored
`jumper-media/saved/`. No processing service receives personal footage.

Queued native work retains its own cancellation event and generation. Cancelling
and retrying cannot revive an old callback; release/expiry removes ownership
immediately, with temporary files deleted after any running subprocess exits.
Incomplete subprocess outputs and unavailable queues report recoverable errors.
Browser workers are terminated on send/receive failures as well as cancellation,
and invalid or stale job updates cannot be accepted as finished videos.

Hosted videos, attempts and shuffle progress use IndexedDB. Local videos use the
local media directory; quiz attempts/progress remain in that browser. Download
files you want to keep before clearing site data. My Clips supports playback,
download and deletion. No personal file is added to the public pack.

## Private library backup

Open **My Clips → Back up or restore library** on either build target.

1. Optionally enable **Include guessing history in backup**, then choose
   **Download backup**. Keep the ZIP on your own device or backup drive.
2. On the destination device, choose **Choose backup ZIP**. ARCade Hoops verifies its
   manifest, checksums, required video variants, and full video decoding before
   showing a restore preview. No masking model or inference service is needed.
3. Review the clip and answer counts. If history is present, choose whether to
   restore it, then select **Restore backup**.

The standard, uncompressed ZIP contains finished videos, player names/aliases,
quiz eligibility, and optional answer records. It excludes raw uploads, masks,
correction history, models, caches, and shuffle position. Existing legacy files
keep their legacy status. The same ZIP works between hosted and local storage.
Limits are 512 MiB, 1,000 clips, 10,000 answers, and 100 MiB per video. This is a
private downloadable file, not an encrypted archive or cloud synchronization.

Identical clips are skipped. Different content sharing an identity receives a
stable separate identity; repeating that import skips the copy too. Existing
videos, names, and answers are never overwritten, and answer records retain their
recorded correct/incorrect outcome. Duplicate answer identities keep the existing
record, preventing repeat imports from increasing statistics.

Hosted clips and answers commit in one IndexedDB transaction. Native videos are
validated and staged before the local library changes; failed staging or commit
rolls back new files. Native answers remain in browser storage, so an answer-storage
failure can occur after clips have restored. The message explains this partial
result; retry the same backup to restore history without duplicating the clips.
Malformed archives leave the existing library intact. Full-storage failures keep
the selected backup available for retry. No personal backup is published.

Run `node --experimental-strip-types scripts/test-jumper-backup.mjs` and
`.venv/bin/python -m pytest -q tests/test_jumper_backup.py` for archive integrity,
cross-target round trips, duplicate/conflict handling, and atomic failure checks.

## Models and reproducibility

SAM graphs/weights: Apache 2.0, Meta SAM 2.1 Tiny. Vision and attention are pinned
to Hugging Face revision `3cb090d9d0b4c897281fdcac7765c0f3a888c49f`.
All SAM assets and the detector are checked against SHA-256 before inference.
`scripts/jumper_export_tracker.py` exports the native decoder’s four mask tokens,
memory encoder, and learned temporal/pointer constants. Export development needs
`onnx==1.23.2`; native/browser comparison additionally uses `onnxruntime==1.31.0`.
The person proposal model is the existing Ultralytics YOLO11n-pose model exported
to ONNX (Ultralytics AGPL-3.0); automatic discoveries require full-motion review
and corrections before saving.

## Prepared NBA collection

NBA is disabled until a genuine reviewed pack exists. `jumper-release.json`
currently has no release configured; this permits personal-first deployment.
A starter pack needs at least two reviewed shots from two NBA players; a complete
pack needs 300 shots and 60 players. The collection area displays its designation
and actual counts. Manifests without a designation retain the complete minimum.
Attribution, license and source links appear with the answer reveal.

A configured Release URL and SHA-256 must verify or Pages publication stops.
The downloaded app setup restores that same pack into its built catalog; raw
footage, masks and personal uploads never enter it.
No video processing happens in deployment. Pack and total site budgets remain
600 MiB and 800 MiB respectively.

## Verification commands

Run `pnpm --dir frontend test`, `.venv/bin/python -m pytest`, and both frontend
builds (`pnpm --dir frontend build`, and the same command with
`VITE_DEPLOY_TARGET=github-pages`). No additional CI workflow is installed.

`scripts/test-jumper-ui.mjs` exercises navigation, themes, keyboard mask points,
invalid decoding and inference-free empty guessing. With a running production
preview, `JUMPER_URL=... node scripts/test-jumper-browser.mjs` exercises a real
upload, GPU tracking, export, save, reload and exactly-once personal guessing.
Use `JUMPER_TARGET=local` for the native server and optional
`JUMPER_TRIM_START=1.6 JUMPER_TRIM_END=3.4` for the fixture's shot segment.

Against a hosted development server, run
`JUMPER_CORRECTION=1 node scripts/test-jumper-parity.mjs`, then pass its capture to
`.venv/bin/python scripts/jumper_compare_masks.py`. Test-only worker interception
captures decoded frames, exact prompts and owner maps; native comparison uses
those identical inputs. The gate is mean IoU ≥0.99 and minimum ≥0.97. These
technical fixtures are not approved public quiz clips. A short single-shooter
agreement test does not qualify all crowded-court or occlusion cases; review
each personal output and reject masks that cannot be corrected.

Earlier editor verification on October 16, 2026 (before the silhouette-default update): existing frontend regressions and 135 backend tests
passed; both builds passed. Real personal upload/export/save/reload/quiz flows
passed in Chrome WebGPU and the native MPS editor. Exported MP4s decoded in an
independent decoder at 30 fps with matching variant lengths and no audio.
The correction fixture achieved mean/minimum IoU 0.999912/0.999601. A two-person
overlap stress comparison achieved 0.999076/0.990856 over eighteen object/frame
samples; it raised an instability warning and remains rejected footage.
Use `JUMPER_FIXTURE`, `JUMPER_POINT` and `JUMPER_SECOND_POINT` to repeat external
stress fixtures. `--allow-warnings` only compares rejected test masks; it never
approves a clip or bypasses publication gates. Broad codec/device qualification
and reliable masking through every occlusion are not established by these tests.

## Silhouette-default verification

The personal editor now requests automatic discovery and silhouette presentation;
manual preparation requests without these options retain their previous behavior.
Browser and native detection association share numeric fixtures for one-to-one
mask matching, overlaps and later entrants. Removed identities stay stable during
correction; manual reprocessing skips excluded tracks.

The native runner limits MPS allocator memory and releases unused cached buffers
between frames. A GPU exception retries from the original selections on CPU;
partially discovered tracks from the failed run are discarded. This addresses a
reproduced process kill during multi-object tracking on the 16 GB M4 test machine.
Masking remains computationally heavy; the progress display does not imply real-time processing.

Use `.venv/bin/python scripts/jumper_validate_silhouette.py /path/to/export.mp4`
to independently decode every exported frame, check neutral color channels,
30 fps, dimensions, duration limits and absence of audio. Before encoding,
compositor tests assert the exact 0/128/224 palette independently of source pixels.

The silhouette update was exercised in installed Chrome on the M4 test machine,
using Playwright because the Browser plugin was unavailable. The browser flow
used the production Pages build at desktop 1440×1000 and mobile 390×844. A real
54-frame jumpshot passed WebGPU processing, tracking cancellation/restart,
download, a forced storage failure followed by retry, save/reload, and personal
guessing. The answer reveal reused the masked video URL; the round made no model
requests, and hosted processing made no local API requests. All 54 exported
frames were inspected and independently decoded: 640×250, 30 fps, neutral color
channels, no audio. This cropped technical fixture is private, not NBA catalog
content or evidence that every crowded clip can be tracked reliably.

The native MPS test exposed a numerical failure that expanded a small person mask
into almost the entire background. A device guard now restarts that run from the
original prompts on CPU, preserving ordinary warnings if the same problem
persists there. The complete native export then retained the black shooter
through all 54 frames. Its upload/download/save/reload/personal-quiz workflow
passed, including forced local storage failure and retry. This fallback adds
processing time; it does not silently accept a failed GPU result.
Corrective browser/native tracking on identical
decoded inputs measured mean IoU 0.999912 and minimum 0.999601 over nine samples.

Regression results for the silhouette-default release: the complete frontend suite, 169 backend
tests, both build targets, mobile/keyboard/theme checks, and GPU-unavailable,
cancelled-startup, storage-unavailable and unsupported-encoder states passed.
The Pages artifact is approximately 62 MiB, below the 800 MiB budget. The checks
cover tested fixtures and device paths, not all GPUs, codecs or occlusions.
An additional real multi-person overlap run raised an ambiguous-player warning
at frame 5 and correctly disabled saving; that uncertain output was not approved.

The same 54-frame upload workflow passed on the deployed GitHub Pages site,
including tracking cancellation/restart, storage failure/retry, save/reload and
exactly-once personal guessing. The reveal kept the masked video, the guessing
round made no inference requests, and hosted processing called no local API.
Live keyboard/mobile/theme/workspace checks also passed.

`JUMPER_FIXTURE=/path/to/video.mp4 JUMPER_POINT=.485,.482
JUMPER_URL=http://127.0.0.1:5173/ node scripts/test-jumper-selection-preview.mjs`
checks real first-frame segmentation, the magnifier, mobile layout, clearing,
and cancellation. For hosted GPU testing, use the Pages preview URL and
`JUMPER_HEADED=1`. Choose a point inside the shooter for your footage.

`JUMPER_URL=http://127.0.0.1:5177/Arc-Shot-Evaluator/ node scripts/test-jumper-timeline.mjs`
checks all warning kinds with controlled worker evidence, exact frame and track
selection, overlapping-track choices, keyboard navigation, stale hints, roster
reset and both themes/mobile layouts. `JUMPER_EXPECT_WARNING=1` on the real browser
workflow additionally checks the timeline against actual inference warnings.

`JUMPER_TEST_URL=http://127.0.0.1:5175/Arc-Shot-Evaluator/
node scripts/test-jumper-aim-ui.mjs` checks desktop mouse and mobile touch aiming,
nudging, exactly-once placement, undo/redo, keyboard controls and pending-aim
reset when context changes. It uses the existing technical video fixture;
`JUMPER_TEST_VIDEO` can select another decodable source. Inference workers are
held idle in this interaction regression; it does not verify segmentation.

## Video-editing verification

`pnpm --dir frontend test:jumper` includes frame-mapping and native parity
regressions for cuts, fractional times, speed, freezes, caption boundaries,
framing, fades, clean quiz separation, 50-operation history and the 60-second
limit. `tests/test_jumper_editing.py` also exercises real FFmpeg encoding,
edited/base persistence and backup round trips, invalid recipes, queue failure,
cancellation and released-job ownership. No additional Actions workflow is used.

The production Pages build was exercised with a real 54-frame, 640×250 personal
jumpshot and corrective SAM tracking. Its edited result had 114 frames (3.8s),
including reordered cuts, slow motion, a freeze, timed text, zoom/pan and fades.
Independent decoding confirmed 30 fps, neutral channels and no audio. Preview
samples at cuts, freeze and effect boundaries differed from the encoded viewing
video by less than 0.02 intensity levels on average (0–255 scale).
Every clean frame was compared with its recipe-mapped base frame; mean pixel
error stayed below 0.023. Quiz and reveal files were byte-identical.

Save/reload, editing a separate copy, backup/restore, exactly-once guessing,
mobile layout and both themes passed. Forced worker failure, cancellation and
storage exhaustion preserved the previous downloadable result; retries worked.
Editing and prepared guessing made no inference/model-download requests.
The downloaded-app workflow also passed with real native tracking and a fresh
CPU recovery after an interrupted accelerator process. Correcting the flagged
frames removed the warnings before approval. A forced browser-renderer failure
then exercised the actual queued FFmpeg fallback, followed by save/reload,
editing a fresh copy, backup/restore and personal guessing. Independent decoding
of all eight saved variants/base files confirmed their expected 54/114 frame
counts, 30 fps, zero color-channel differences and no audio.
The complete frontend regressions, 249 backend tests and both builds passed.
These are tested fixture results, not a guarantee for every codec, device or
mask. Tracking warnings still require correction and final-motion review.
