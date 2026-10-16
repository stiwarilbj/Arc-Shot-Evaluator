# Personal Jumper clips

Open **Others → Who’s That Jumper?**. Guess, Create and My Clips preserve their
state when switching workspaces. Dark mode remains the default.

## Create

1. Choose a decodable video up to 100 MB; trim to at most 15 seconds.
2. Find people in the first frame or add tracks manually. Remove spectators,
   wall artwork and false proposals. Detection is a proposal, not confirmation.
   Name the player and mark their track as the named player. Names label tracks;
   no facial recognition runs.
   Add an entering player at their first visible frame; the named player must
   be selected in the starting frame. Keyboard users can focus the frame, move
   the crosshair with arrows (Shift for larger steps), and press Enter/Space.
3. Include points select bodies; exclude points remove ball/background pixels.
   Scrub to add corrections to the same track. Processing applies corrections
   across the segment. Changes require reprocessing before saving.
4. Inspect the entire result in motion. Resolve lost-target/cut warnings by
   correcting masks or shortening the trim. Segmentation can be wrong even when
   no warning appears: approve only after reviewing every foreground person.
5. Save to My Clips or download. Enable the quiz checkbox to save the silhouette
   and foreground reveal on the same timeline. Failed saves retain the download.

Every variant uses a newly rendered neutral background, no audio, and no original
court pixels outside selected masks. Exclude the ball explicitly if it enters a
person’s mask. SAM does not guarantee perfect masks or identity through occlusion.
Do not approve a result with leakage or identity changes.

## Targets and resources

Hosted creation uses a dedicated WebGPU worker, SAM 2.1 Tiny vision, decoder,
attention and memory encoder graphs, and Mediabunny/WebCodecs. It downloads about
170 MB of model assets on first processing; browser cache reuse depends on quota.
The detector loads only when requested. Devices without WebGPU/video encoding can
still use Guess/My Clips; use the downloaded editor for native processing.

The downloaded app installs SAM from pinned upstream commit
`2b90b9f5ceec907a1c18123530e92e794ad901a4` through `scripts/setup.sh`. It verifies
weights before use, runs one heavy task through the existing queue, uses MPS/CUDA when available and restarts on CPU after accelerator failures.
MPS uses equivalent real-valued rotary attention: complex-tensor rotary operations
caused tracking drift in the tested runtime. The replacement matches the CPU
reference on real fixture masks. Native decoded frames use a two-frame cache;
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
to ONNX (Ultralytics AGPL-3.0); proposals require human confirmation.

## Prepared NBA collection

NBA is disabled until a genuine reviewed pack exists. `jumper-release.json`
currently has no release configured; this permits personal-first deployment.
A configured Release URL and SHA-256 must verify or Pages publication stops.
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

Verified on October 16, 2026: existing frontend regressions and 135 backend tests
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
