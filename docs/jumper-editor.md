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
  **Duplicate**, beside Move left/right and Delete in the shared selected-piece
  toolbar, inserts a copy immediately after the selected piece. Its source
  range, speed, freeze duration, and both framing endpoints remain identical;
  the copy gets a fresh identity and independently editable framing. The editor
  selects, seeks to, and reveals the copy. Captions stay at their existing edited
  times. Undo/Redo names the duplication and restores the appropriate selection.
  Duplication is disabled with an explanation if it would exceed 60 seconds or
  100 pieces. It never repeats masking.
  In Cut, the selected moving piece has orange trim handles on its left/right
  edges. Drag to adjust the source boundaries; the shared preview shows the
  exact first or last retained source frame, labeled with its frame/time.
  This boundary view omits fades, captions and framing so the frame stays visible.
  Normal playback or seeking returns to the edited preview. Source end is
  exclusive: the last retained frame is one frame before that time.
  Focus a handle and use arrows for one frame, Shift+arrows for ten, or Home/End
  for its valid limits. Numeric fields and existing sliders use the same bounds.
  A pointer drag or held arrow key is one undo operation. Pointer interruption
  or Escape ends the gesture at the last accepted boundary. Freeze pieces use
  their existing duration control. Trimming never reruns masking.
  Beside **Split at playhead**, **Previous frame** and **Next frame** pause and
  step exactly one edited 30 fps frame. An orange marker and frame/time label
  locate the cut before the displayed frame, naming the affected piece and
  source frame. Split is disabled with an explanation at empty-piece boundaries,
  on freezes, at the 100-piece limit, and between repeated source samples at
  0.5× speed (step back one frame). Stepping does not change edits or undo history.
- **Text:** enter up to 200 characters, then **Add at current time**. A caption
  starts there and lasts two seconds or until the end. Edit its interval,
  size, and top/center/bottom placement. White text has a black backing. Moving
  pieces leaves captions at their edited times; shortening the video clamps
  their intervals and flags them for inspection.
  Selecting a caption outlines the safe area, inset 4% on every side.
  Preview and browser export share one font-measured layout; the native fallback
  follows the same word-wrapping and padding rules with the bundled font. Normal
  whitespace is collapsed; overlong words split without dropping characters.
  Text uses 88% of the video width, leaving padding inside the 92%-wide backing.
  Captions that exceed the safe height or cannot fit a character at the chosen
  size show a warning in Text and block updating the finished video. Shorten the
  text or reduce its size to continue. Preview clips overflow inside the safe
  area; neither export renderer accepts it. Existing downloads are preserved.
  Safe outlines are editor-only, follow video coordinates on every aspect ratio,
  and never appear in edited exports or clean quizzes.
  **Caption timing → Magnet on/off** defaults on for pointer dragging. The start
  or end of a moving caption, or the edge being trimmed, can align to an edited
  cut, the playhead captured when the drag began, or another caption's start/end.
  The caption's own boundaries are excluded. A dashed guide and destination/time
  appear within 12 pixels (at most six frames); capture occurs within six pixels
  (at most three frames) and changes the guide to solid orange. Nearest reachable
  targets win; ties are deterministic. Whole-bar movement preserves duration,
  trimming retains at least one frame, and all bounds remain inside the video.
  Clicking alone does not snap. Each drag is still one undo operation. Disabling
  the magnet leaves frame-based dragging unrestricted; keyboard and numeric
  adjustments bypass snapping. The magnet is editor-only and does not affect
  masking, exports, or saved project format.
  Click or tap a visible caption in the masked preview to open Text and highlight
  that caption's existing controls. Drag vertically to snap to the top, center,
  or bottom guides. A drag is one undo step; interruption keeps the last accepted
  placement. Clicking alone does not create an edit. Tab to a preview caption and
  press Enter/Space to select it; the Placement dropdown offers the same positions
  without dragging. Hit areas respect text wrapping and letterboxing. Guides and
  selection outlines never enter exported videos. Captions cannot be selected in
  clean-quiz or trim-boundary previews, where caption overlays are intentionally absent.
- **Text → Shooting-motion overlap hints:** after adding captions, the editor
  decodes the masked base once into a bounded (16 MiB), short-lived silhouette-core
  cache at up to 192 pixels on the long edge. It checks every edited 30 fps frame
  with the shared caption layout and export crop; cuts, freezes, speeds, and
  framing use the export timeline. Coverage of at least 15% of the visible body
  or its upper third produces an advisory hint and an inspection time. This is
  approximate geometry, not anatomical hand/release detection; tiny or missing
  silhouettes cannot establish safe placement. A supported position is suggested
  only if its worst overlap is at least 30% lower across the whole caption
  interval. Suggestions are optional, undoable placement edits; warnings neither
  alter exports nor block saving. Fades never suppress warnings. Caption edits
  reuse the base cache; stale checks are cancelled and hidden workspaces pause
  analysis. Failed checks offer retry and manual review. Legacy bases are not
  analyzed because their black pixels may not uniquely identify the shooter.
  No inference, original footage, model downloads, or server calls are involved.
- **Preview → Loop selected piece:** the toggle beside **Play edit preview**
  repeats the selected piece using edited time (including speed changes and
  freeze duration). Enable **Include 0.5s before and after** for neighboring
  footage, clipped to the timeline's ends. Playback starts within the loop or
  returns to its beginning if the playhead is outside it. Selecting another
  piece pauses and retargets the loop; seeking pauses for inspection. Disable
  looping to play through the remaining video normally. The monotonic 30 fps
  clock preserves elapsed time across wraps. Both preview versions support
  looping; hiding the workspace or browser tab pauses it. Loop controls are
  display preferences: they do not alter captions, edits, review approval,
  downloads, quizzes, or undo history.
- **Selected piece toolbar:** available above Cut/Text/Effects controls. Split,
  delete, move left/right, and change 0.5×/1×/2× speed together. Frame stepping and
  the split explanation stay beside these controls. Split only operates inside
  the selected piece; select the piece containing the playhead if they differ.
  The last piece cannot be deleted; end pieces cannot move past the timeline.
  Freeze speed is disabled because Freeze length in Cut or Effects controls
  its duration.
- **Effects → Freeze at playhead:** pauses on entering Effects and identifies the
  displayed frame by edited time and masked source frame. Inserts a one-second
  hold, selects it, and seeks to its beginning. **Freeze length (0.5–3s)** appears
  beside the insertion button; it remains available in Cut too. Selecting an
  existing freeze also reveals the duration field in Effects. Undo/redo and
  save/reload retain the duration. Insertion is unavailable when the extra second
  or required pieces would exceed the 60-second/100-piece limits.
  **Effects** also offers framing and fades. **Start framing** and **End framing**
  are independently transferable with **Copy effects** / **Paste effects**.
  Copy snapshots the selected piece's speed and framing into an editor-private
  clipboard that survives switching editing tools. Select a destination and use
  the Speed / Start framing / End framing checklist, then paste as one undo step.
  Source ranges, identities, captions, and freeze lengths are not copied. Freeze
  pieces neither supply nor accept speed; their framing remains transferable.
  An identical or empty selection disables Paste. Existing project limits still
  reject changes that would exceed 60 seconds, preserving the current timeline.
  **Start framing** and **End framing**
  select the endpoint and seek to its boundary. While paused in Effects, the full
  masked frame shows an orange crop rectangle with that endpoint’s zoom/position.
  Drag the rectangle to pan within the image; letterboxing is excluded. Arrow
  keys move 1% of the available pan range, Shift+arrows 10%; one gesture is one
  undo step. At 1× the full image is retained, so pan has no visible effect.
  The 1–2× zoom and horizontal/vertical sliders use the same geometry. **Match
  start framing** copies the start values to the end in one undoable edit, creating
  a stationary crop. Play to see the finished crop; clean-quiz preview omits zoom
  and the guide. Guides and outside-crop shading never enter exports. Fades last
  approximately 0.25s.
  Slow motion repeats recorded frames; it does not invent body motion.
- **Undo: … / Redo: …** describe the next operation (trim/delete/reorder/split,
  speed/freeze/framing, caption text/timing/placement, fades, or reset). They keep
  up to 50 operations separately from masking-correction history. Applying one
  selects its original stable piece/caption identity, opens Cut/Text/Effects as
  appropriate, seeks to its timeline position, and scrolls its strip/bar into view.
  An item restored by undo becomes selected; if redo removes it, a surviving
  piece at that position is selected instead. Framing restores the relevant
  Start/End endpoint. Selection, seeking, and rendering do not add history entries.
  **Reset edits** restores the complete base timeline. Editing requires another
  final-motion review. Mask warnings still block saving until corrected.
- **Update finished video** commits the preview to downloadable media. Cancellation
  or failure retains the previous successful download. Stale results cannot be
  approved or saved. Playback pauses in hidden workspaces and hidden browser tabs.

The **Edited video / Clean quiz** switch above the shared preview uses identical
cuts, speeds, and freezes in both modes. Clean quiz excludes text, zoom/pan, and
fades. Switching is display-only: it never changes the download, edit history, or
review approval. Beside **Update finished video**, the download status distinguishes
the previous finished version from the latest edits. The review status reflects
the existing final-motion confirmation: required while edits are stale or rendering,
required after rendering until confirmed, and complete after confirmation. Editing
requires review again; render failures retain the last successful download.
The same clean file plays before and after a
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
   Use **Add tracking anchor**, scrub to a clear later original frame, and
   aim/place an Include point on the same shooter. Choose **Confirm shooter at
   frame …**, then process again. Each explicit anchor restarts only the shooter’s
   forward tracking memory from that frame onward; subsequent frames use the
   nearest earlier anchor and newer corrections. Other players keep their history.
   The anchor list seeks directly to confirmed frames. **Remove anchor** retains
   its correction points. Editing those points requires reconfirmation, changing
   shooter clears confirmations, and correction undo/redo restores them. Earlier
   occluded frames are not automatically repaired.
   For the independent identity check, each later Include point or explicit box
   anchors a reverse section; Exclude-only prompts do not establish identity.
   The forward shooter pass only sees confirmations when it reaches them, and each reverse section
   starts with independent memory. A **Forward/backward mismatch** marker opens
   the relevant shooter frame. Add corrections or shorten the segment and retry.
   The status reports the checked range and mismatch count; later frames are not
   claimed as checked in both directions. No later confirmation means no backward
   check. This audit adds one bounded shooter pass through the confirmed range,
   reusing cached encoder features. The audit never changes masks or proves which
   pass is correct. Small/tiny outlines can escape the 128×128 diagnostic grid.
   **Possible joined players** uses a bounded grid (at most 128 pixels along the
   longest edge) to compare raw occupied masks with final visible ownership.
   A substantial new claim on a neighboring body interior, while retaining the
   claimant’s body, or support from two distinct occupied detection cores must
   persist for two consecutive frames. The marker includes both stable track IDs
   and the first affected frame. Existing detections are reused; manual mode
   still uses mask and ownership history without downloading a detector.
   Cuts/gaps reset temporal evidence; ignored/unstarted tracks are excluded.
   Corrections do not automatically exempt a still-joined mask. These are review
   hints: real occlusion can resemble a join, tiny silhouettes may be missed, and
   manual clips already merged at the start may have no clean baseline. Inspect
   both tracks, add Include/Exclude points, and reprocess. Warnings block saving
   through the existing review gate; no diagnostic changes the rendered pixels.
   Small-player refinement runs automatically in Create and its shooter preview.
   It re-encodes a padded crop from decoded source frames (up to 2560×1440), using
   the same SAM weights and current-frame body evidence, then maps the outline
   back to the 720p export. One crop is processed at a time. The temporal tracker,
   detection, and forward/backward identity audit keep their original scores.
   A crop must retain at least 60% mask overlap, stay within conservative area
   bounds, and avoid leaking at its edges or adding another player's surface.
   Rejected or extremely tiny crops keep the tracked mask and add **Small-player
   detail uncertain** review markers. Obscured detail is never reconstructed;
   inspect the affected frame and add Include/Exclude points or use a closer view.
   This costs additional processing time. Native detail frames are temporary,
   share the exact trim/30 fps timeline, and are checked against free disk space.
4. Resolve lost-target, ambiguous-player, instability, forward/backward mismatch, small-player detail or cut warnings before
   saving. Detection cannot establish identity through every overlap. The editor
   stops rather than silently dropping people when more than twenty tracks are
   needed. Shorten the clip or use manual selection in a closer view.
5. Edit the masked result using **Cut**, **Text**, and **Effects** (see above).
6. Update the finished video and review the complete motion, then save or download. A player name is required
   only for **Use in my guessing game**. Personal quiz answers reveal the name
   while keeping the same silhouette footage. Failed saves retain the download.

Finished previews, downloads, saved clips and personal quiz playback use a
masked timeline: target black, other included people in stable per-track gray shades, flat neutral gray
background. New personal clips choose gray shades from a clip-wide graph of
visible silhouette contacts (including diagonal boundaries), prioritizing pairs
that meet repeatedly. The shooter is always black; each other track keeps one
shade throughout. No team labels, uniform colors, or original pixels influence
assignment. A fully hidden player contributes no contact evidence, and crowded
groups have a limited range of gray contrast. Rendering waits until tracking is
complete and replays lossless owner maps without rerunning segmentation. In the
browser, compressed temporary maps spill from bounded memory into private
IndexedDB when necessary; finished and failed jobs remove their scratch data.
Native rendering rereads its existing temporary mask files. Older saved clips
are unchanged.

The silhouette compositor copies no original pixels, even inside a
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
compositor tests assert the assigned palette before the one-pixel neutral edge
filter, independently of source pixels. Legacy three-color outputs retain their
0/128/224 interiors; new personal palettes use fixed gray shades in 64–200.
Browser/native fixtures require identical contact graphs and shade choices.

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

### Caption timing bars

Each caption has a labeled interval beneath the video timeline, on its own row.
Drag the middle to move the interval while keeping its duration; drag either edge
to adjust start/end. Boundaries snap to 30 fps and cannot cross or leave the video.
Click a bar to select its Text controls. Numeric timing fields and bars update
together. Keyboard: arrows move one frame, Shift+arrows ten, Home/End reach the
allowed bounds. Each drag or held-key adjustment is one undo step.

Caption overlap regressions run with `npm --prefix frontend run test:jumper`.
For the real decoding/editor/export browser check, start the hosted dev build,
then run `node scripts/test-jumper-caption-occlusion-ui.mjs` from the repository
root (Chrome and the local Python/FFmpeg setup required). Set `JUMPER_URL` to
check a preview or deployed build. The script stubs masking with a generated
silhouette fixture; it verifies editing and does not claim segmentation accuracy.

### Nearby recorded frames for freezes

In Effects, open **Choose a nearby freeze frame** to compare up to five frames
at the playhead and ±3/±6 edited frames (up to ±0.20 seconds). Choices clamp to
the current piece, exclude removed footage across cuts, and deduplicate repeated
source frames at slow speed or inside freezes. **Refresh around current playhead**
recenters the choices after seeking. Edited and source frame numbers are shown.
Selecting a thumbnail only pauses/seeks the preview; it does not create an undo
entry, alter the project, or invalidate a finished export. **Freeze at playhead**
then inserts the actual selected source frame using the existing one-second
freeze and duration controls. The freeze remains one undoable edit and survives
save/reload like existing freezes.

Relative sharpness hints use contrast-weighted edge acutance on masked previews
limited to 256 pixels on the long edge, with a similar-clarity label for scores
within 8%. They describe
silhouette edge clarity, not source-video blur, anatomical release detection, or
pose quality. No original upload, inference, enhancement, or generated frames
are involved. Both builds share this browser decoder and picker. At most five
thumbnails are retained; closing the picker, leaving Effects, hiding the workspace,
or starting playback/export cancels outstanding decoding and disposes the input.
Preview failure offers retry while the ordinary freeze control remains usable.

Run freeze-frame logic regressions with `npm --prefix frontend run test:jumper`.
With the hosted dev/preview server running, run
`node scripts/test-jumper-freeze-frames-ui.mjs` from the repository root
(Chrome and the local Python/FFmpeg setup required). `JUMPER_URL` selects another
preview or deployed build. This stubs only masking with a moving silhouette
fixture; actual selection, edit history, rendering, and independent FFmpeg decode
verify that export holds the chosen source frame. It does not test segmentation.


## Optional shooting-motion markers

In Create → Edit video → Cut, expand **Protect shooting motion (optional)**.
Seek the masked source segment with its frame scrubber or numeric time, inspect
that exact source frame, then mark **Gather**, **Release**, or **Finish**. Source
frame numbers are one-based in the interface; stored offsets are zero-based
30-fps integers. Source time begins at the masked segment, not the raw upload.
**Use edited playhead for markers** copies the current edited frame's source
position. A source preview can inspect trimmed-out footage; **Return to edited
preview** restores the normal effects preview. Seeking alone does not edit.

Markers belong to source frames, not piece IDs. They remain fixed across trimming,
reordering, duplication, speed changes, and freezes. Advice checks actual rendered
samples, so a 2× edit that skips the exact marked frame is reported honestly.
A stage retained only by a freeze is distinguished from moving footage. With two
or more correctly ordered stages, discontinuous piece seams within their source
interval produce cut warnings. Contiguous splits, holds, and full-shot repeats
remain unrestricted. Wrong stage order is advisory too. These manual references
cannot prove pose quality or detect unmarked interruptions automatically.

Marking, moving, and removing are ordinary editing-history operations. Marker
metadata is optional in version-1 projects and validated identically in browser
and native persistence; it survives saved copies and backups. It changes neither
encoded pixels nor the clean quiz. Marker-only edits invalidate the saved-copy
status but keep the current export and motion-review approval. Reset edits clears
all markers. Run `npm --prefix frontend run test:jumper` and
`.venv/bin/python -m pytest tests/test_jumper_editing.py -q` for focused checks.


## Compression-detail checks

New masking and edited exports compare every decoded frame to bounded evidence
from its intended neutral rendered frame, after antialiasing, cuts, captions,
framing, and fades. This complements the existing guarded interior/color checks.
Two groups separately sample narrow extrema (including thin limbs and player
gaps) and ordinary high-contrast boundaries, using contrast of at least 24 luma
levels. Each group keeps at most 1,024 source-position/luma samples per frame
(8 KiB total; at most 14.1 MiB for a 60-second edit). No original-color pixels or
raw uploaded footage are stored in this evidence.

A frame fails when at least three samples and more than 2% of either group differ
by over 40 luma levels. These thresholds tolerate ordinary edge ringing while
checking small features separately from large outlines. Sampling is not an
anatomical hand detector, an exhaustive pixel comparison, or segmentation QA.
The source mask still requires full-motion human review. Previously saved/imported
videos lack intended-frame evidence and retain their existing integrity checks.

A compression failure gets one higher-quality encoding retry: browser export
uses 8 Mbps instead of 2.5 Mbps; native FFmpeg uses CRF 8 instead of CRF 18.
Both attempts decode and validate their finished result; each variant remains
limited to 100 MB. Masking retries use the existing bounded completed-mask
checkpoint (or temporary palette masks); if unavailable, export fails without
rerunning inference. Editing retries read the existing masked base and recipe.
A second quality failure remains an error; the native generic checkpoint retry
must not restart an already exhausted quality retry. Cancellation and existing
resource cleanup remain active; previous successful edited outputs are retained.

Tests: `npm --prefix frontend run test:jumper` includes native/browser evidence
parity and retry bounds. `.venv/bin/python -m pytest tests/test_jumper*.py -q`
includes independent native encoding, damage detection, mask-only retry,
cancellation, and persistent failure. Browser testing also injects damaged
first-attempt encoder frames, then independently decodes the higher-quality
result; this export test does not require or establish segmentation accuracy.
