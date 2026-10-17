# Personal Jumper clips

Open **Others → Who’s That Jumper?**. Guess, Create and My Clips preserve their
state when switching workspaces. Dark mode remains the default.

## Create

1. Choose a decodable video up to 100 MB; trim to at most 15 seconds.
2. Click the shooter in the selected segment’s first frame. That person becomes
   black. Other people are detected automatically throughout the segment,
   including later entrants. No player name or manual roster is required.
   Keyboard users focus the frame, move with arrows (Shift for larger steps),
   and press Enter/Space. The magnified view follows your cursor; touch users can
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
5. Review the complete motion, then save or download. A player name is required
   only for **Use in my guessing game**. Personal quiz answers reveal the name
   while keeping the same silhouette footage. Failed saves retain the download.

Finished previews, downloads, saved clips and personal quiz playback use exactly
one masked timeline: target black, other included people gray, flat neutral gray
background. The silhouette compositor copies no original pixels, even inside a
bad mask, and exports contain no audio. Original footage is only an editing
reference. Masks can still include background shapes or miss limbs: approve only
after reviewing all frames and correct or reject uncertain results.

Existing personal quiz clips also use their masked video after answering. Older
highlight-only clips are labeled **Legacy** and offered as downloads without an
anonymized preview; they have not been reprocessed automatically.

## Targets and resources

Hosted creation uses a dedicated WebGPU worker, SAM 2.1 Tiny vision, decoder,
attention and memory encoder graphs, and Mediabunny/WebCodecs. It downloads about
170 MB of model assets on first processing or silhouette preview; browser cache reuse depends on quota.
The detector loads when automatic discovery or manual proposals are requested. Devices without WebGPU/video encoding can
still use Guess/My Clips; use the downloaded editor for native processing.

The downloaded app installs SAM from pinned upstream commit
`2b90b9f5ceec907a1c18123530e92e794ad901a4` through `scripts/setup.sh`. It verifies
weights before use, runs one heavy task through the existing queue, uses MPS/CUDA when available and restarts on CPU after accelerator failures.
MPS uses real-valued rotary attention to avoid complex-tensor operations, but
accelerator tracking can still drift. A lost or unstable target, or a mask
expanding into the background, restarts tracking from the original selections
on CPU. Genuine tracking warnings on CPU still require correction before saving.
Native decoded frames use a two-frame cache;
ordinary tracking memory keeps the recent sixteen frames while retaining
correction frames. Temporary jobs
are cancelled and removed when released; saved media is separate in ignored
`jumper-media/saved/`. No processing service receives personal footage.

Hosted videos, attempts and shuffle progress use IndexedDB. Local videos use the
local media directory; quiz attempts/progress remain in that browser. Download
files you want to keep before clearing site data. My Clips supports playback,
download and deletion. No personal file is added to the public pack.

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

Regression results for this update: the complete frontend suite, 169 backend
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
