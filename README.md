[Open the live ARC GitHub Pages demo →](https://stiwarilbj.github.io/Arc-Shot-Evaluator/)

The hosted demo has Shot Analyzer, Playbook, and Play Finder; the local app has Shot Analyzer and Playbook. The individual-clip upgrade is pending successful NBA feed verification before live deployment.

```bash
cd Arc-Shot-Evaluator
./scripts/setup.sh  #first run only
./scripts/start.sh
```

Then open <http://127.0.0.1:7888>. After the first setup, future runs only need:

```bash
./scripts/start.sh
```

If you downloaded the ZIP into another folder, change the `cd` path to that folder.

The setup script uses `pnpm` when it is installed and automatically falls back
to `npm` when it is not. You only need Node.js and `uv`; there is no separate
pnpm install step.

# ARC, basketball shot analysis and Playbook

I built ARC because rewatching a jumper and guessing what went wrong gets old fast; upload one video or a whole group, review the shot windows, inspect the replay, and keep a Playbook diagram beside the analysis 🏀

<p align="center">
  <img src="docs/screenshots/current/arc-coach-notes.png" alt="ARC with video, analysis queue, Coach Notes, and shot data visible together" width="900" />
</p>

*The video stays on the left. The queue, Coach Notes, and shot data all fit beside it, so you do not have to bounce between pages.*

## How it works

The website uses React, TypeScript, and regular CSS; the hosted build runs its normal browser review in the page with the supplied pose tracks, while the repository also includes the full FastAPI, OpenCV, PyTorch, and YOLO pipeline for development

ARC connects detections across frames, keeps track of the rim when the camera moves, and uses the visible regulation rim as a conditional 2D scale reference. It reports projected measurements only when the evidence supports them, and marks single-camera geometry as estimated or unavailable when it does not. Portrait video, blur, camera movement, and different resolutions are supported. Clear side views still give the best numbers, of course.

ARC also includes **Playbook** as a second tab for drawing half-court diagrams; start with the ready setup, search 24 editable starter plays, or begin on an empty court. Draw movement, passes, screens, dribble handoffs, pick-and-rolls, pick-and-pops, pin-downs, off-ball screens, and backdoor cuts; shape routes with curved control points, run equal-numbered actions together, set timing, and save diagrams or export a high-resolution PNG. Playbook’s deterministic AI moves offense off ball, brings receivers into place before transfers, reacts to screens and handoffs, tracks defensive and off-ball quality, and ends each simulation with a shot. After the drawn and enabled automatic actions, it reads live defender positions to choose an open cutter, roll player, post, drive, or perimeter pass; playback shows the selected read and route without changing the saved diagram. Pause the simulation to edit the board and resume from the same moment. Starter examples include Horns, Flex, Spain pick and roll, Elevator, Shuffle, Triangle, Zipper, Box, and High-low. The hosted demo keeps saved plays in the browser; the development server stores them in the project’s `playbooks/` directory

Play Finder’s individual-event implementation and deployment requirements are described below.

The overview keeps the observed make rate separate from future prediction. A
future FT% stays unavailable until a trained model has been evaluated on held
out shooters and calibrated; the observed confidence stays high for clean
form and drops when a miss or a made shot has severe release problems. Every
new clip uses the Normal analysis path.

Fresh sessions use the original Normal free-throw review path for every clip;
the restored example library includes the Celtics vs Pelicans set plus the
Kevin Durant, LeBron, Steph, and short free-throw clips. Supplied examples
also bring back the pose view with arm and leg projections and joint-angle
labels; the local FastAPI path keeps the complete calibrated shot metrics.

The accuracy and labeling protocol is documented in [docs/accuracy.md](docs/accuracy.md).

## The local Coach Notes

This part is basically a tiny RAG system without an online chatbot. ARC keeps a small local guide with paraphrased shooting ideas from Jr. NBA, USA Basketball, FIBA's WABC coaching workbook, and open biomechanics studies. A pure Python BM25-style search matches the shot's reliable measurements and footage quality to the right passages, then chooses three short human-written notes.

It says what looked good, gives one practice cue, and talks about consistency. It will not roast a shot just because it missed. If the footage is shaky or blurry, it admits the measurement might be off. The wording also stays the same when you refresh; that sounds small, but random advice would get annoying really fast.

<p align="center">
  <img src="docs/screenshots/current/arc-coach-sources.png" alt="ARC Coach Notes with compact local sources expanded" width="900" />
</p>

*Click “Why these tips?” to see the measurement and short source behind each note.*

## Where everything lives

The code is grouped by what it does. `backend/api` owns the local server and queue, `backend/analysis` owns vision and shot measurements, `backend/coaching` owns the local advice, and `backend/domain` holds the shared basketball types. The React side follows the same idea inside `frontend/src/features`.

There is a simple folder map and video data flow in [docs/architecture.md](docs/architecture.md).

## Why it feels different

- Browser review starts in the page with the normal pass and pose overlays; the repository also includes the full model pipeline for development runs.
- Two clips can analyze at the same time, while extra videos wait in the queue.
- If the net hides the ball, ARC checks the ball's reappearance and drop instead of blindly guessing.
- Weak evidence becomes `review`, and shaky footage gets careful advice instead of fake confidence.
- Results save to `sessions/` as annotated videos, JSON data, thumbnails, and coach notes.

The first local analysis can take longer while PyTorch loads the models. The home page has the supplied test clips ready to click. Uploads support MP4, MOV, M4V, AVI, MKV, WebM, MPEG, and more.

For terminal analysis, run:

```bash
.venv/bin/python -m backend.analysis.pipeline /absolute/path/to/clip.mp4
```

ARC uses the E-BARD basketball detector and Ultralytics YOLO11 Pose. Their links and license notes are included with the project.

## Play Finder (GitHub Pages target only)

The hosted build supports searching individual NBA play-by-play video events. The local application exposes **Shot Analyzer and Playbook only**, and its build excludes Play Finder, model files, workers, and index assets.

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm build                              # local app: two workspaces
VITE_DEPLOY_TARGET=github-pages pnpm build # hosted app: three workspaces
```

Play Finder uses exact player/team/opponent/season/date/event/outcome/distance/period/clock/recorded-role filters. Prompt chips are editable and ambiguous names require selection. English semantic ranking runs in a Web Worker using quantized `Xenova/all-MiniLM-L6-v2` through Transformers.js and WASM. The first semantic search downloads the model; browser caching enables warm searches. If model loading fails, filters and keyword search continue. Tactical and defender-matchup inference are unavailable.

Results contain resolved individual NBA-hosted MP4s and their exact NBA Stats event links. Collections save event snapshots and notes in browser storage; version-1 collection IDs and notes remain as legacy references, without being assigned to unrelated plays. Export/import creates portable backups.

### Index ingestion and publication

`scripts/nba/ingest.py` discovers completed NBA games from official NBA game records, reads official game rosters and play-by-play, joins batched `videodetailsasset` playlists by recorded game/event IDs, and resolves remaining advertised events with `videoeventsasset`. `actionNumber` is the NBA Stats event ID; array positions and `actionId` are never substituted. Only response-supplied NBA MP4s with matching game/event paths enter the index.

The deployment workflow verifies the official sources on `ubuntu-latest` **before** backfill. It checkpoints games on the generated `nba-clip-data` branch, publishes version-2 manifests and compressed monthly shards there, embeds deduplicated descriptions, and deploys only after validation. Manifest coverage reports actual completed games, clips, unresolved video events, and the last successful update. Partial backfills are labeled partial. Requested coverage is 2023–24 onward, regular season, play-in and playoffs; full coverage cannot be claimed until every completed season has been indexed.

Daily updates run at **11:00 UTC**, rechecking the latest seven days for corrections and delayed clips. Workflow dispatch accepts `max_games` (1–500) for resumable backfills. Failed feeds or validation preserve the previous healthy index and site. Publication stops above conservative Pages, generated-data and artifact-storage budgets; no paid API or backend is configured. Provider allowances may change and must be reverified before changing these budgets.

**Verification blocker (2026-10-08):** On the standard public GitHub runner, the NBA schedule feed returned HTTP 403 and the Stats asset and game-discovery endpoints timed out. An ordinary Chromium NBA event-page check also timed out waiting for the asset. The upgrade therefore remains on its implementation branch; automatic backfill and live publication are pending successful source verification. No completed-season coverage is claimed.
