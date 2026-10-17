# ARCade Hoops

[![ARCade Hoops: See your game from every angle. Shot Analyzer, Playbook, Counter Lab, and Guess the Jumper.](frontend/public/assets/arcade-hoops-social-card.png)](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#home)

ARCade Hoops leads with **Shot Analyzer** for basketball footage review, alongside
Playbook, Counter Lab, and Guess the Jumper. The original **ARC logo** remains the
app’s main mark.

[Open the live website](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#home) or
[run the downloaded app](#run-the-downloaded-app) on your own computer. Both
versions include all four workspaces. Processing uses the browser or local server;
no account, paid inference API, or cloud-processing service is required.

## Find your tool

| Workspace                                                                            | What you can do                                                                                                       |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| [Shot Analyzer](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#shot-analyzer)      | Upload footage, review attempt windows and available measurements, correct results, and export shot data.             |
| [Playbook](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#playbook)                | Draw and simulate half-court actions, customize players, and save or export diagrams.                                 |
| [Counter Lab](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#counter-lab)          | Test a play against different defenses, inspect breakdowns, and compare verified repairs.                             |
| [Others → Guess the Jumper](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#jumper) | Create silhouette videos from your own footage, keep a private clip library, and guess the shooter from their motion. |

The front page includes a goal-based quick chooser, feature cards, interactive
illustrative mini demos, and direct links to each workspace. **Create a clip**
opens the silhouette editor directly; **Explore the tools** jumps to the cards.
The downloaded-app link opens setup instructions. Promotional copy and link-preview
artwork cover all four tools. Feature descriptions distinguish browser review from
full local analysis. Click the **ARC logo** to return to the front page. Shot Analyzer
stays first in the navigation. **Others** opens by hover, click, keyboard, or mobile
tap. Dark mode is the default; the header also offers light mode and a usage guide.

Each workspace has its own URL fragment and descriptive browser-tab title.
Reloading reopens that workspace/view;
Back and Forward follow tab changes. Nested views include
`#shot-analyzer/overview`, `#shot-analyzer/tracking`, `#jumper/create`, and
`#jumper/my-clips`. Switching workspaces keeps open drafts, uploads, and reports in
memory. Reloading is different: unsaved editor work, uploaded file references,
and Counter Lab reports do not survive it. Save or export work you want to keep.

## Shot Analyzer

### Upload and review

- Select one or several videos, drag them onto the upload area, or use a supplied
  example. The current upload workflow is **Free throw**.
- Choose **Fast**, **Normal** (default), or **Deep** analysis. The queue shows
  waiting, running, completed, failed, and stopped jobs; add videos, cancel work,
  hide completed items, or reopen a result. The app starts one analysis at a time
  by default.
- Use **Overview**, **Shot**, and **Tracking** to inspect the session, individual
  attempts, and available movement evidence. Shot thumbnails jump to the relevant
  attempt; video controls offer **Pose**, **Annotated**, and **Original** views
  when the corresponding data is available.
- Review makes, misses, and uncertain attempts. Correct outcomes and release
  timing, add a missed attempt, and keep per-shot notes. Local corrections retain
  the original model evidence rather than replacing it.
- Download shot data and available video artifacts. The full local pipeline
  creates annotated video exports; the hosted motion pass uses the source video
  and available overlays rather than generating a new annotated recording.

### Hosted review versus full local analysis

The GitHub Pages version samples video motion to propose windows for **manual
review**. Supplied examples can include prepared pose tracks and joint-angle
overlays. Ordinary uploaded videos do not receive full pose, ball, or rim tracking
in this hosted analysis path, and their outcomes start as **review**.

The downloaded app runs the Python vision pipeline: basketball/rim detection,
player pose, temporal tracking, shot measurements, and local Coach Notes. Source
orientation and playback formats are normalized where supported. Projected
measurements are reported only when the footage and calibration support them;
weak evidence stays estimated, unavailable, or marked for review. Clear footage
with the shooter and basket visible gives the pipeline more useful evidence.

Observed make rates describe reviewed footage. Future shooting probabilities
remain unavailable until a prediction model passes held-out validation and
calibration; they are not inferred from the observed percentage. See the
[accuracy and evidence protocol](docs/accuracy.md) for the underlying analysis
fields and review rules. Some backend analysis capabilities are broader than the
current upload controls.

### Local Coach Notes

The local pipeline retrieves relevant passages from a bundled shooting guide
using a BM25-style search, then selects concise notes about a strength, a practice
cue, and consistency. The guide draws on paraphrased coaching and biomechanics
sources. **Why these tips?** connects the note to its measurement and source.
There is no online chatbot or paid language-model call.

<p align="center">
  <img src="docs/screenshots/current/arc-coach-notes.png" alt="Local ARCade Hoops shot review with video, queue, Coach Notes, and shot data" width="900" />
</p>

## Playbook

### Draw and edit

Start with **Ready setup**, **Empty court**, a saved play, or one of **24 editable
starter plays**. Search sets including Horns, Flex, Spain pick-and-roll, Elevator,
Shuffle, Triangle, Zipper, Box, and High-low.

Draw passes, movement, screens, slip screens, dribble handoffs, pick-and-rolls,
pick-and-pops, pin-downs, off-ball screens, and backdoor cuts. Move players,
defenders, and the ball; shape curved routes; choose action order and duration;
and give simultaneous actions the same sequence number. The action list keeps
moves accessible even when their arrows are hidden. Undo/redo, touch dragging,
and keyboard nudging support revisions.

Customize offensive shooting/finishing ratings and badges, defender skills, and
simulation settings. Player strengths, defensive strategies, cuts, spacing, and
enabled automatic actions affect the simulator's decisions.

### Simulate and save

Play, pause, seek, or pause to edit before continuing. The shared fixed-step engine
coordinates movement and collision avoidance, executes screens in phases, follows
actual possession, requires catches for passes and close contact for handoffs,
and explains obstructed or conflicting actions. Adaptive offense can continue
with an available cut, roll, post action, drive, or pass; simulation decisions do
not rewrite the saved drawing.

Save plays, reopen or duplicate them, delete saved copies, or export a
high-resolution PNG. Hosted plays stay in browser storage; downloaded-app plays
live in `playbooks/`. Saves protect newer edits, and opening a different play uses
the existing unsaved-draft protection. Version-1 play documents remain compatible.

### Shared arrow visibility

Playbook and Counter Lab share one browser-persisted **Arrows** preference:

| Setting                 | Visible routes                                                           |
| ----------------------- | ------------------------------------------------------------------------ |
| Off                     | No saved or simulated route overlays.                                    |
| Main on-ball (default)  | Passes, drives, handoffs, and connected screens, slips, rolls, and pops. |
| Main on-ball + off-ball | Main actions, including cuts and off-ball screens.                       |
| All on-ball movements   | Main on-ball actions plus smaller related adjustments.                   |
| All movements           | Main actions and smaller on-ball/off-ball movement trails.               |

The preference updates previews and playback immediately and is reflected in PNG
exports. It does not change simulations, saved actions, or undo history. The
actively edited action remains visible temporarily with its editing handles.

## Counter Lab

Follow **Choose play → Test defenses → Inspect breakdown → Try repair**.

1. Load the current Playbook draft, a saved play, or a starter. **Test in Counter
   Lab** in Playbook transfers the current drawing without discarding its editor
   state. The Lab sidebar keeps the chooser, arrow visibility, and test settings
   accessible.
2. Test containment, help, switching, drop, hedge, and trapping by default. Advanced
   settings expose additional strategies and eligible zones. Compare **Drawn
   play**, which follows authored actions without voluntary improvisation, with
   **Adaptive offense**, which can respond to the defense.
3. Select a defense/mode to inspect court playback, the timeline, involved players,
   and the first breakdown. Sustained opening loss requires 300 ms of evidence;
   unsafe-pass warnings are separate from confirmed execution failures. Plays
   without a clear opening or breakdown are reported that way.
4. Inspect up to three verified repairs for the selected matchup. Candidates can
   change screen/slip behavior, roll/pop choices, timing, spacing, or a pass
   recipient. A repair must gain at least five quality points or resolve a genuine
   breakdown without reducing final quality or introducing an earlier failure.
   Simply delaying failure does not qualify; sometimes no repair qualifies.
5. Compare original and repaired actions with synchronized playback. Desktop uses
   side-by-side courts; narrow screens share a clock with an Original/Repair
   toggle. Tradeoff summaries show regressions against other tested defenses.
6. **Save repair to Playbook** creates a separate editable copy with a fresh ID,
   preserving the original. The editor still protects an unsaved draft.

Analysis runs in a browser worker on both targets, with progress and cancellation.
Baseline results appear before repair testing finishes. Replay pauses when the
workspace or browser tab becomes hidden. Playbook edits do not erase an existing
Lab report; explicitly importing another play or reloading does. Reports remain
in memory, while saved repairs use ordinary Playbook persistence.

Quality is a **simulation score**, not a real-game scoring probability. See the
[recorded movement audit](docs/movement-audit.json) and
[save-and-simulate compatibility harness](docs/save-simulate-compatibility.md) for
engine and persistence verification.

## Guess the Jumper

Open **Others → Guess the Jumper** for **Guess**, **Create**, and **My Clips**.
Personal videos stay on your device; they are never automatically published.

### Create a silhouette clip

1. **Upload:** choose a decodable video up to **100 MB** and trim a segment to
   **15 seconds or less**.
2. **Click shooter:** select the target in the segment's first frame. A magnifier
   and keyboard/touch controls help with small players. A short silhouette preview
   confirms the selected person before full processing; it can load the models.
   The preview and full run reuse the same starting-frame shooter selection,
   including the detected body box when automatic discovery is enabled. The
   preview only tracks the shooter; full processing also discovers other people.
   If the points overlap several detected players, add an Include point on a
   visible part of the shooter away from the overlap in the first frame. If no
   player matches, clear the first-frame points and select again. Automatic
   processing waits for a unique match; it never silently falls back to a
   point-only mask. If detection keeps missing the player, turn off automatic
   discovery under corrections and verify your manual selection in the preview.
   Other people are discovered automatically, including later entrants. During
   tracking, detections are matched against occupied mask pixels rather than
   rectangular mask outlines. Weak or competing overlap is flagged for review;
   uncertain detections are not automatically added as duplicate people.
   Missing tracks retain a short presence record and their existing tracking
   identity. Returning players reuse that identity only when current mask evidence
   supports it. If an unmatched person appears while an existing track is missing,
   automatic discovery requests correction rather than guessing an identity or
   consuming another track slot. Longer absences remain unresolved until tracking
   evidence or a correction identifies the player.
3. **Process:** track people and render a muted video up to **720p/30 fps**. The
   shooter becomes solid black, other included players gray, and the background
   flat neutral gray. Finished silhouette outputs copy no original image pixels,
   removing original court colors, jersey text, graphics, and audio.
4. **Review and correct:** original reference and masked playback share one clock.
   Desktop shows them together; mobile offers a comparison toggle. The review
   timeline checks every included player, black or gray, for missing masks,
   sudden jumps, persistent outline shrinkage, abrupt local outline changes, and
   newly detached mask fragments. Adjacent silhouettes are translation-aligned
   with pixel-jitter tolerance; nearby outline loss/gain from ordinary motion is
   discounted. Shape comparisons reset at camera cuts, corrections, and gaps.
   These checks flag suspicious small hand/arm losses; they never identify
   anatomy or generate missing limbs. Warnings identify the affected
   track and block saving until corrected. Recorded outward movement and clipping
   at the image boundary can establish a legitimate exit; an unexplained interior
   disappearance or a stationary player vanishing at the edge still needs review.
   These are temporal mask checks, not anatomical guarantees: inspect limbs and
   overlaps in the full video, including frames without warnings. The timeline
   also flags uncertain matches and possible camera cuts.
   To reduce black/gray boundary flicker, both processors can retain a previous
   pixel owner for at most two frames when current scores are close, both masks
   still cover that pixel, and nearby current pixels clearly support that owner.
   Stronger occlusion evidence wins immediately; missing masks, camera cuts, new
   tracks, and correction frames bypass this consistency check. It favors no
   player or color, does not add body pixels, and cannot guarantee correct depth
   ordering during every overlap.
   Expand corrections to remove spectators, manage tracks, or add Include/Exclude
   points on problem frames. **Find people in first frame** preserves the chosen
   shooter, track IDs, removed tracks, and every correction. It adds distinct
   detections only after matching existing first-frame selections one-to-one;
   ambiguous or unmatched tracks leave the selections unchanged with guidance.
   Overlapping new detections require manual selection. Undo/redo supports up
   to 50 correction edits.
5. **Save/download:** reprocess corrections and review the complete motion before
   approving the result. Save privately or download MP4 when supported, otherwise
   WebM. A name is required only when enabling **Use in my guessing game**.

Progress separates model downloads, detection, tracking, and export, with estimates
based on measured processing speed. Resource checks flag oversized jobs.
Compressed model downloads retain byte progress without assuming the compressed
transfer length equals the decoded model size.
Corrections can reuse unchanged detections/frame features, and an export failure can retry
from a bounded temporary mask checkpoint without rerunning segmentation. Finished
videos are decoded and checked for timeline, dimensions, neutral colors, and no
audio before becoming ready for review.

Personal silhouette rendering uses label masks alone, without rereading original
pixels or creating color reveals. Highlight, quiz, and answer playback share that
same masked video. The local server also checks received silhouette saves before
publishing them to My Clips; invalid files, mismatched variants, colors, audio,
and broken timelines fail without leaving a partial saved clip. Cancelled or
released local jobs cannot take ownership of a later retry. Browser worker
communication failures stop cleanly and allow another attempt.

These checks do not prove tracking accuracy. Review the full motion and correct
or reject uncertain masks; unresolved tracking warnings prevent approval. The
editor reports its twenty-track limit instead of silently omitting extra people.
Changing the target, trim, or corrections requires processing and review again.
Failed storage keeps the finished result available to download.

### Guess and track progress

Quiz rounds play **already finished videos**; guessing does not run inference or
download models. Type a player name, use spelling/alias suggestions, and explicitly
choose ambiguous matches. Lock one answer per round to reveal the correct name.
Personal clips stay silhouetted after answering.

Attempts, correct/incorrect totals, accuracy, streak, and shuffle progress persist
locally. Clips do not repeat until the collection is exhausted, and playback
failures do not count as wrong answers. Personal, NBA, and combined collections
are offered when their required clips exist. With no playable collection, the
workspace points you to Create.

**The public NBA collection is currently unavailable: zero reviewed clips are
published and no release pack is configured.** Starter packs require at least two
distinct reviewed shots from two verified NBA players; complete packs require 300
shots across 60 players. Support for those packs is not an existing NBA library.
See [actual acquisition and publication status](docs/jumper-starter-status.md).

### My Clips and private backups

Play, download, or delete saved clips and reopen them after a reload. **Back up or
restore library** exports one private ZIP with videos, player labels, and quiz
eligibility, optionally including guessing history. Restore on either app target;
identical clips are skipped and conflicting IDs become separate copies. Backups
are capped at **512 MiB / 1,000 clips** and exclude source uploads, masks, and
models. Keep a backup before clearing browser data.

Older highlight-only clips remain labeled **Legacy** downloads; they are not
presented as newly anonymized videos. See the [editor guide](docs/jumper-editor.md)
for corrections, device support, models, privacy, and verification details, and the
[offline preparation guide](docs/jumper-preparation.md) for public-pack tooling.

## Hosted website and downloaded app

| Area                               | GitHub Pages website                                                                                               | Downloaded app                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Shot Analyzer                      | Browser motion review; prepared example pose tracks where available. Uploaded footage needs manual outcome review. | Full local Python vision pipeline, available measurements, annotated exports, and Coach Notes. |
| Playbook / Counter Lab             | Shared browser editor, simulation engine, and worker analysis.                                                     | Same browser editor, simulation engine, and worker analysis.                                   |
| Saved plays                        | Browser storage.                                                                                                   | Local `playbooks/` directory.                                                                  |
| Personal clip processing           | WebGPU worker with SAM 2.1 Tiny ONNX tracking and browser video decoding/encoding.                                 | Native SAM 2.1 through the Python server; available acceleration with CPU fallback.            |
| Saved personal videos              | IndexedDB in this browser.                                                                                         | Dedicated ignored `jumper-media/saved/` directory.                                             |
| Quiz history, shuffle, preferences | Browser storage.                                                                                                   | Browser storage, even though saved videos live on disk.                                        |
| Full local analysis artifacts      | Not produced by the hosted motion pass.                                                                            | Saved under `sessions/`.                                                                       |

Use a Chrome device with WebGPU and supported video encoding for hosted clip
creation. Models download when the selection preview, detection, or processing
needs them; cached assets may be reused. Opening Guess does not load them.
Unsupported devices can still use Guess and My Clips, or use the downloaded
native editor. First-time downloads and tracking can take time; processing stays
on the device, with no paid or cloud fallback. Storage permissions and available
space affect persistence, so export important clips and play diagrams.

## Run the downloaded app

Install **Node.js 22.18+**, **uv**, **Git**, and **zsh**. The supplied setup/start
scripts use zsh. From the downloaded or cloned project directory:

```sh
cd Arc-Shot-Evaluator
./scripts/setup.sh
./scripts/start.sh
```

Open <http://127.0.0.1:7888>. After setup, later launches only need:

```sh
./scripts/start.sh
```

Adjust the `cd` path if your download has a different folder name. Setup creates a
Python 3.12 virtual environment, installs the local analysis and pinned native SAM
dependencies, and builds the frontend. It uses pnpm when installed and falls back
to npm, so a separate pnpm installation is not required for this setup. Initial
dependency and model downloads require network access. Private uploads, working
files, and saved personal videos are not included in the public website.

For terminal analysis:

```sh
.venv/bin/python -m backend.analysis.pipeline /absolute/path/to/clip.mp4
```

## Development and verification

React, TypeScript, and CSS provide the interface. The local server uses FastAPI,
OpenCV, PyTorch, basketball detection, and YOLO pose models. Clip masking uses
SAM 2.1; the hosted tracker runs through ONNX Runtime Web with Mediabunny/WebCodecs
for media handling. Model versions and license notes are documented in the
[editor guide](docs/jumper-editor.md).

From the repository root, after setup:

```sh
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend test
.venv/bin/python -m pytest

# Downloaded-app frontend, served by the local Python server.
pnpm --dir frontend build

# Static website under the repository's GitHub Pages path.
VITE_DEPLOY_TARGET=github-pages pnpm --dir frontend build
```

Both builds write `frontend/dist/`; the last build replaces the previous output.
For frontend development, run the Python server and `pnpm --dir frontend dev`;
Vite proxies local API/media requests to port 7888. To exercise the static target,
use `VITE_DEPLOY_TARGET=github-pages` with the development or preview command too.

GitHub Pages deploys through the existing workflow after a push to `main`. A
configured prepared NBA pack must pass checksum and publication validation; no
videos are processed during deployment. The media-pack and complete-site budgets
are **600 MiB** and **800 MiB**. An unconfigured pack permits the current
personal-clips release. No extra CI workflow is required.

The frontend regression suite includes
`pnpm --dir frontend test:save-simulate`, which round-trips representative plays
through both persistence targets and compares participant bindings, timing, and
shared-engine outcomes using isolated storage. It does not touch saved libraries.
Real GPU/media verification commands are in the editor guide; passing unit tests
alone does not establish masking quality on arbitrary footage.

## Project guide

| Location                                                    | Contents                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `frontend/src/app/`, `layout/`, `styles/`                   | Navigation, shared layout, theme, and URL state.                         |
| `frontend/src/features/`                                    | Home, analysis/upload/queue, Playbook/Counter Lab, and Guess the Jumper. |
| `backend/api/`                                              | Local analysis, play persistence, and private media/job endpoints.       |
| `backend/analysis/`, `backend/coaching/`, `backend/domain/` | Vision, measurements, local coaching retrieval, and data models.         |
| `scripts/`, `tests/`                                        | Setup, preparation, regression and compatibility tools.                  |
| `examples/`, `models/`                                      | Supplied analysis examples and local model assets.                       |
| `playbooks/`, `sessions/`, `jumper-media/`                  | Local saved plays, analysis artifacts, and private clip data.            |

Further reference: [architecture](docs/architecture.md),
[play document validation](docs/playbook-document-validation.md),
[shared route geometry](docs/playbook-route-geometry.md), and
[save-and-simulate compatibility](docs/save-simulate-compatibility.md).

Feature, navigation, setup, storage, and limitation changes should keep this README
current in the same task; the repository's [contributor instructions](AGENTS.md)
record that maintenance rule.
