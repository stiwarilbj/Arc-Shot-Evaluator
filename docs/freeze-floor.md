# Freeze Floor · Use and accuracy guide

[Open Freeze Floor](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#freeze-floor) · [Feature guide](feature-guide.md)

## Current release status

The linked editor, local video-frame picker, manual alignment, contact correction, sensitivity-based distances, private project storage, and image downloads work on both frontend targets

Automatic court landmarks and ankle proposals use real bundled neural models locally · **Automatic alignment is experimental, requires manual overlay review, and is not a validated measuring instrument**

The planned independent 60-photo acceptance benchmark is **not complete** · No trained alignment-confidence classifier is shipped · The checkpoint publisher supplies no authoritative 48-slot court map, so only the inspected floor-only subset is proposed and the remaining slots are excluded · The feature must not be described as fully validated automatic calibration

Three licensed real photographs are supplied · Two wide images have manually inspected lane overlays, while the close-up deliberately demonstrates insufficient floor evidence · They are examples, not independent accuracy ground truth · The requested set of three accepted alignment/contact examples and the independent benchmark remain outstanding

## Use the editor

1. Open **Others → Freeze Floor** · The Garden sample opens immediately
2. Choose another photograph or upload JPEG, PNG, or WebP · Limits are 20 MiB and 24 megapixels · Header dimensions are checked before decoding · EXIF orientation is applied and the working image is reduced to a maximum 2048-pixel edge
3. Open **Check the alignment** · Green projected court lines should coincide with the visible floor markings of one NBA half-court · A full-court photo can be used by aligning just one half
4. Correct the floor landmarks · Select an existing landmark to drag, nudge, enter pixel coordinates, reassign its meaning, exclude it, or delete it · Add at least four well-spread floor correspondences when automatic proposals are insufficient · Avoid points on raised equipment, shadows, and advertisements
5. Inspect each landmark’s **Fit mismatch** in working-image pixels · **Select largest mismatch** highlights that anchor in the photograph without changing it · Then select **I checked the floor-line overlay** · Conflicting enabled anchors prevent numeric measurements until corrected or excluded · **Alignment ready** records this manual review, not independent accuracy certification
6. Expand **Player contacts** · Ankles are uncertain proposals · Confirm visible shoe-floor contact as grounded, correct the location, remove spectators, and add missed people · Hidden or airborne feet stay uncertain
7. Use **Measure distance** to choose two different floor points in either view · Selecting the same player or floor location twice keeps the first endpoint and asks for a different second endpoint · Selecting an existing pair in either order highlights that distance in both views and the list without adding another entry, even at the 20-distance limit · Hovering a person highlights the corresponding contact · A free-space cursor represents a floor-plane projection, not a position above the floor
8. Toggle **Measurement coverage** to show the supported floor boundary in both views · Toggle Paint, Corner areas, or Restricted area independently · Select feet or meters
9. Save explicitly, or download the combined photograph/overhead PNG · Project titles and complete photo attribution wrap to measured lines, including long unspaced names and source URLs · Export height grows to fit the text without covering the views or measurement notes · No photo is uploaded

PNG exports clear their temporary text and drawing canvases and decoded image source after success or failure · The temporary SVG URL is revoked immediately, while the finished PNG download keeps its existing 30-second URL lifetime · Failed exports leave the current photograph and corrections available for retry

Fit mismatches compare observed landmark positions with projections from the final fitted alignment, with width and height scaled separately · Excluded anchors also show their mismatch but do not influence the fit · Labels update after corrections and during landmark drags · An unavailable or unstable fit shows **Fit mismatch: unavailable** and disables largest-mismatch selection · A small mismatch is not proof that court labels or geometry are correct, especially with only four anchors

Landmark and contact coordinate fields show the allowed pixel range for blank or out-of-range entries · The input is marked invalid and keeps your entry after Enter or moving focus away, while the last valid position stays unchanged · Correct the value and press Enter or leave the field to apply it · Escape restores the last valid value without adding an undo step · Selecting another landmark or player starts with that selection’s own coordinates

Before replacing an edited photograph with a sample, uploaded image, saved project, or captured video frame, choose **Save**, **Discard**, or **Cancel** · Save finishes successfully before the replacement opens · Storage failures and revision conflicts keep your photograph, corrections, and replacement choice available for retry · Cancel or Escape keeps editing the current photograph · Untouched samples switch immediately, and undoing back to the loaded or last saved state removes the prompt · Browsing videos alone does not replace your photograph

The save label uses that same comparison · Untouched samples show **Sample unchanged**, edited projects show **Unsaved project**, and unchanged saved projects show **Saved on this device** · Undo, redo, or manually restoring the saved contents restores the saved label without another write · Undoing past the last save creates unsaved changes again · New uploads and video stills remain unsaved until explicitly saved

The downloaded server serves the bundled Freeze Floor photographs, video examples, and models from `/freeze-floor` · These asset requests return the files rather than the application’s HTML fallback

Switching photographs or opening a saved project cancels the previous load and aborts its sample download · The latest image identity is checked before decoding, before JPEG conversion, and before installation · Browser decoding and conversion already in progress cannot be interrupted, but obsolete results are discarded, decoded bitmaps close promptly, and conversion canvases are released · Only the latest uploaded image can start analysis · Leaving the workspace or hiding the tab also cancels pending loads without replacing the current project or showing a cancellation error

Automatic retries reuse an existing contact for a proposal only when nearby foot points and strong person-box agreement provide a clear match in both directions · Similar competing boxes prevent automatic matching · Different people returned in the same batch are kept separate · Missing boxes, ambiguous overlaps, and competing matches produce a review warning listing the affected player numbers, while new contacts remain uncertain · Existing identities, corrected locations, and grounding choices stay unchanged · Check the boxes in the contact inspector, remove duplicates or spectators, and add anyone the detector missed

At the 40-contact limit, the notice reports the exact number of new suggestions that could not be added and confirms that existing contacts and corrections were kept · Clear matches to existing contacts do not count as omissions · Remove spectators to free slots, then retry automatic proposals or add the missing players manually

Overhead selection uses a small court-space area around each player marker rather than photograph proximity · Empty court points remain floor endpoints instead of snapping to a distant person · On the photograph, selecting a person’s body still highlights their foot contact

Keyboard selection uses the same player-contact checks as pointer selection · Hidden, airborne, and uncertain contacts keep measurements withheld after save/reopen · Arrow keys nudge by one photograph pixel or 0.1 foot along overhead court axes, with Shift for ten times the step · Place and adjust floor landmarks on the photograph; overhead interaction requires an available alignment

Undo and Redo cancel an unfinished landmark or contact drag before restoring history · Moving or releasing the pointer afterward cannot replace that restored edit · Completed drags remain single undoable edits

Numeric distances are restricted to the convex floor region enclosed by the accepted anchors · **Measurement coverage** outlines that region with a dashed blue boundary on the photograph and overhead court without filling it or hiding players and markings · Rejected and excluded anchors do not expand the boundary · The outline updates with alignment corrections and undo/redo, and is unavailable when there is no usable fit · It describes geometric coverage, not certified accuracy or approval of the alignment

An endpoint beyond the boundary shows **Outside supported region**, even when alignment review or unconfirmed feet also prevent measurement · Its marker is highlighted and its scene label says **Outside** · A pending first endpoint shows the same warning and can be cancelled with Escape · Boundary points count as supported · Outside this region, on unstable projections, or with unconfirmed feet, the editor keeps the endpoints but withholds the number

Measurement coverage starts off and remains a view preference during the visit · Toggling it does not edit the project, mark it unsaved, or add an undo step · PNG downloads include the boundary when enabled and retain explanations for withheld distances

The indicated range estimates sensitivity to point placement and residual landmark error · It is **not a calibrated confidence interval** and does not fully account for lens distortion, nonplanar floors, mistaken landmark meaning, or hidden feet

## Choose a moment from a video

Open **Example videos** for four short, locally hosted clips with thumbnail previews · Select a card to open the existing frame picker

| Example | Length | Source |
| --- | --- | --- |
| Kobe Bryant · Warmup | 3.8 seconds | randychiu · [CC BY 2.0](https://commons.wikimedia.org/wiki/File:Kobe_Bryant.ogv) |
| Mad Ants vs Drive · Possession | 4.5 seconds | Tamara Chaos-Events · [CC BY 3.0](https://commons.wikimedia.org/wiki/File:Mad_Ants_VS_Drive.webm) · source 16.5–21 seconds |
| Mad Ants vs Drive · Free throw | 3.5 seconds | Same source · 30.5–34 seconds |
| Mad Ants vs Drive · Wide view | 5 seconds | Same source · 105–110 seconds |

The Mad Ants–Drive footage is a G League game, with NBA-sized court markings · Examples are trimmed, muted H264 copies of two source videos, totaling approximately 4.8 MiB · They are playback examples, not reviewed calibrations or independent benchmark samples · The source pages, license evidence, modifications, source intervals, and pinned file checksums are recorded in `frontend/public/freeze-floor/provenance.json` and `NOTICE.txt`

Only the selected clip downloads · Selecting or playing a clip does not initialize inference · Downloads are size-bounded and checksum-verified · Interrupted or invalid downloads leave the current project intact and can be retried · Source credits appear in the picker and carry into captured projects and combined PNG exports

**Upload video** accepts local MP4, WebM, M4V, or MOV files when the browser can decode their video codec · Limits are 100 MiB, 10 minutes, and 24 megapixels per frame · Unsupported files leave the current photo and project intact

Use Play/Pause, the scrubber, or a numeric time · Step buttons change the requested time by 1/30 second · These are time steps, not a claim that every source has 30 distinct frames per second · The browser supplies the decoded recorded frame, including its supported orientation handling · Playback speed offers 0.25×, 0.5×, 1×, and 2×, plus optional looping · Preview audio stays muted

The Seconds field displays hundredths, while the selected instant retains its underlying precision · Tab or Enter without typing leaves the frame unchanged · An edited time commits on Enter or leaving the field; Escape cancels it · Playback updates do not replace an unfinished time draft

**Use this frame** pauses playback and creates a new normalized image project · Automatic analysis runs only for that still, not for every video frame · Every chosen moment gets fresh anchors, contacts, and alignment review because camera movement invalidates earlier calibration · **Download frame JPEG** exports the unannotated still without model inference · **Download PNG** exports the current photo/court project with its visible overlays

The selected source time is saved with the normalized image and shown after reopening · The original video and its metadata are not stored in the project library · Closing the picker releases its video URL · Navigation and hidden tabs pause video playback and returning never resumes automatically

## Mouse, touch, and keyboard

- Click or tap a contact or landmark, then drag to correct it · Each completed drag is one undo step · Escape cancels a pending placement, first measurement endpoint, or unfinished drag
- Arrow keys aim on a focused view, or nudge its selected point by one image pixel · Shift changes that to ten pixels · Enter places an anchor, contact, or measurement endpoint in the chosen mode
- Numeric pixel fields allow precise keyboard correction · Both views expose visible focus · Undo and redo retain the last 50 completed edits for the current photograph
- The magnified aiming inset follows the image-space cursor · The split view stacks on narrow screens

## Geometry

Coordinates use feet on the NBA half-court, 50 wide and 47 from baseline to midcourt · The lane is 16 by 19 feet, the three-point radius is 23 feet 9 inches with straight portions 3 feet from each sideline, and the restricted area has a 4-foot radius with lines to the backboard plane

Reference: [NBA Rule 1 · Court dimensions and equipment](https://official.nba.com/rule-no-1-court-dimensions-equipment/)

Court-to-image fitting uses normalized DLT and SVD through pinned `ml-matrix` 6.15.1 · Seeded RANSAC rejects inconsistent evidence and refits accepted inliers · Inverse, spread, conditioning, finite values, and projection sensitivity are checked · A conflicting included anchor is never silently approved

## Models and privacy

- Court model: [koppolusameer/yolo11n-basketball-court-keypoints](https://huggingface.co/koppolusameer/yolo11n-basketball-court-keypoints), pinned revision `6cb899251439982067a81baa225b33f45f335981` · Publisher-declared AGPL-3.0
- Person model: the existing local YOLO11n pose ONNX asset · Ankles suggest contacts and never establish grounding
- Input: 640-square RGB float32 with neutral 114 letterbox padding · Court output has 48 keypoint slots · Only the explicitly mapped floor subset participates in fits
- Downloads are bounded by actual received bytes and SHA-256 checked · Valid cache hits are reused without rewriting · A corrupt, oversized, or interrupted cached model is removed and triggers one fresh download that bypasses the HTTP cache · The fresh copy must pass the same byte limit and checksum checks before caching · A failed fresh copy stops without another automatic attempt, and cancellation never triggers recovery
- A model request stops after 30 seconds without received data, including while waiting for response headers · Each nonempty chunk restarts that deadline, so a steady slow download can continue · A stalled stream is released with a download-specific retry message · Checksum work and inference do not use this inactivity deadline, and completed or cancelled requests leave no active download timer
- A dedicated worker prefers WebGPU and falls back to WebAssembly CPU execution · Models load only for requested automatic proposals, not for pointer movement, measurement, region toggles, or manual anchor correction
- Each operation carries image, job, and edit identities · Source changes, edits, navigation away, and hidden tabs cancel inference · Late responses cannot replace current edits
- Raw upload metadata is stripped when creating the normalized JPEG · Model assets are served by the same website · No paid inference service or backend endpoint is used

Asset licenses, model digests, explicit 48-slot inclusion/exclusion map, and sample sources are recorded in [`frontend/public/freeze-floor/provenance.json`](../frontend/public/freeze-floor/provenance.json)

## Private projects

The normalized JPEG and versioned metadata are committed together in one IndexedDB transaction · Saved status appears only after completion · A failed write leaves the current project and PNG export available · If a save, rename, or deletion finishes after another project is opened, it cannot overwrite that project’s name or saved status · Cancelling a replacement during its save keeps the current photograph open even if that save subsequently succeeds · Leaving the workspace or hiding the tab also cancels queued replacement choices

Opening a saved card reads only that project’s current record by ID, without retrieving other library images · The read must complete successfully and its metadata, revision, and image must pass validation before the photograph replaces the editor · The latest revision becomes the save baseline even if the card was older · A missing, damaged, or interrupted read keeps the current photograph and corrections available

Saves and library renames compare the originally loaded revision with the stored revision inside the same write transaction · If another tab saved first, the write is rejected and your draft stays editable and downloadable · Download a PNG before reopening the latest saved project from **Choose photo** · A stale tab also cannot recreate a project deleted elsewhere · Existing projects without a revision remain readable and acquire a fresh token on their next successful save, without changing their image or editing history

Deletion checks the library card’s revision inside the delete transaction · If another tab saved a newer version, the deletion is rejected and the entire saved project is preserved · The library refreshes so you can review the latest entry and confirm deletion again · Refresh never retries deletion automatically · A missing or damaged record also rejects deletion and refreshes the listing, preserving damaged data for recovery · Rejected deletions leave your open project and corrections intact

The library is limited to 20 projects and 200 MiB, including images and metadata · Save updates the current project identity rather than duplicating it · Choose photo exposes saved projects, rename, and deletion · No automatic deletion frees capacity · Removing a player also cancels any unfinished measurement that refers to that contact

If a saved record fails validation, **Choose photo** still lists healthy projects in newest-first order · Equal timestamps use ascending project IDs as a stable tie-breaker, without changing dates or names · A persistent warning identifies unavailable entries by their stored name, when available, and storage key · Damaged records remain unchanged for recovery and still count toward storage limits · An entirely unavailable library is distinguished from an empty one · A failed or interrupted storage read retains the previously displayed library rather than reporting a complete empty result

Landmark and player-contact IDs must be unique across both collections, including disabled landmarks · Conflicting identities are rejected in projects and inference results so selection cannot address the wrong object · Saved records with these collisions remain unavailable and preserved for recovery

Only the latest requested library refresh may update project cards, unavailable-entry warnings, or storage-error notices · An older read finishing after a save, rename, deletion, or newer refresh cannot replace those results · Leaving the workspace mounted preserves its library state, while unmounting invalidates pending refreshes

Hosted and downloaded libraries belong to different browser origins · Browser data clearing removes this library · Projects are not uploaded or shared and do not change saved Playbook formats

## Reproduce and finish validation

`scripts/freeze-floor-prepare-model.py` is an offline export utility · It is never called at startup, build, or deployment

```sh
uv run --python .venv/bin/python scripts/freeze-floor-prepare-model.py /path/to/private/freeze-floor --export
pnpm --dir frontend test:freeze-floor
pnpm --dir frontend test:navigation
node scripts/test-freeze-floor-browser.mjs
node scripts/test-freeze-floor-interactions.mjs
node scripts/test-freeze-floor-measurements.mjs
node scripts/test-freeze-floor-library.mjs
node scripts/test-freeze-floor-unsaved.mjs
node scripts/test-freeze-floor-conflicts.mjs
node scripts/test-freeze-floor-proposals.mjs
node scripts/test-freeze-floor-image-loading.mjs
node scripts/test-freeze-floor-upload.mjs
FREEZE_FLOOR_CPU=1 node scripts/test-freeze-floor-upload.mjs
node scripts/test-freeze-floor-failures.mjs
pnpm --dir frontend build
VITE_DEPLOY_TARGET=github-pages pnpm --dir frontend build
```

The browser tests use installed Chrome and accept `FREEZE_FLOOR_URL` for a local, preview, or deployed target · They check real WebGPU and CPU model execution, correction, exact selected-time and video-pixel preservation across unchanged focus/blur, numeric time edits and cancellation, frame JPEG download, undo/redo during contact and landmark drags, perspective-safe overhead selection, keyboard/pointer measurement parity, axis-correct court nudging, private save/reopen, damaged-record isolation and preservation, interrupted library reads, out-of-order refreshes after saves and deletions including stale warnings and errors, two-tab conflicts and simultaneous saves, stale-card deletion protection at identical timestamps, cancelled and aborted deletions, explicit reconfirmation and already-deleted records, legacy revision upgrades, failed-write retries, delayed storage-operation isolation, PNG download, EXIF rotation, PNG/WebP decoding, narrow-screen overflow, cancellation, corrupt models, unavailable storage, and source-upload privacy

The interaction browser test also checks pixel mismatch labels, keyboard selection of the largest mismatch without changing saved status or history, live drag diagnostics with Escape cancellation, correction/undo, excluded anchors, and unavailable fits

The measurement browser test exercises repeated player and floor-point selections, reversed and cross-view duplicate pairs, moved contacts, full-capacity reuse, exact undo, Escape, save/reopen, deletion, both themes, and mobile layout · Rejected selections leave saved contents and history unchanged

The unsaved-corrections browser test uses a worker fixture to isolate replacement decisions from inference · It exercises real image/video decoding and IndexedDB for Save/Discard/Cancel, undo-to-baseline switching, fresh same-project reopening, failed and conflicting saves, cancellation during a save, workspace changes, keyboard focus, and mobile layouts · The separate upload test checks actual model execution

For the real-photo acceptance gate, supply independent licensed images and annotations with disjoint training/camera groups · Use at least 40 supported and 20 unsuitable photographs across independent groups · Every accepted photograph needs four or more independent floor checks that were not used for fitting

```sh
node --experimental-strip-types scripts/evaluate-freeze-floor.mjs benchmark.json report.json
```

The gate requires acceptance of at least 70% of supported images, median independent floor-point error at most 0.3 m, 95th-percentile error at most 0.6 m, and at most one false acceptance among unsuitable images · It fails on insufficient data · Passing synthetic geometry tests or successfully running the checkpoint does not satisfy this gate

Before automatic acceptance can be enabled, complete and inspect the mapping against real annotated photographs, improve or fine-tune the landmark detector as needed, train the confidence classifier on correct and incorrect real fits, validate on the independent groups, and review motion-free contacts and exports · No synthetic benchmark result substitutes for those requirements
