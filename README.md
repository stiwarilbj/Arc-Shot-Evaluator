```bash
cd Arc-Shot-Evaluator
./scripts/setup.sh  # first run only
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

# ARC, a local basketball shot tracker

I built ARC because rewatching a jumper and guessing what went wrong gets old fast. You drop in one video or a whole group, and it tracks the shot, marks up the replay, estimates the useful numbers, and gives you a few coach notes. Everything stays on your computer, which is honestly one of my favorite parts. 🏀

<p align="center">
  <img src="docs/screenshots/current/arc-coach-notes.png" alt="ARC with video, analysis queue, Coach Notes, and shot data visible together" width="900" />
</p>

*The video stays on the left. The queue, Coach Notes, and shot data all fit beside it, so you do not have to bounce between pages.*

## How it works

The website uses React, TypeScript, and regular CSS. A local FastAPI server handles the heavy work with Python, OpenCV, PyTorch, and two YOLO vision models. They find the ball, rim, players, and body points like the wrist, elbow, shoulder, hip, and knee. It sounds wild at first, but a college intern who knows some Python and web development could build a simpler version and understand each part.

ARC connects detections across frames, keeps track of the rim when the camera moves, and uses the regulation 18-inch rim as a size reference. That lets it estimate release speed, height, arc, and joint angles from a normal single-camera clip. Portrait video, blur, camera movement, and different resolutions are supported. Clear side views still give the best numbers, of course.

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

- Videos never leave your machine, and there is no cloud bill or account.
- Two clips can analyze at the same time, while extra videos wait in the queue.
- If the net hides the ball, ARC checks the ball's reappearance and drop instead of blindly guessing.
- Weak evidence becomes `review`, and shaky footage gets careful advice instead of fake confidence.
- Results save to `sessions/` as annotated videos, JSON data, thumbnails, and coach notes.

The first analysis can take longer while PyTorch loads the models. The home page also has the supplied test clips ready to click. Uploads support MP4, MOV, M4V, AVI, MKV, WebM, MPEG, and more.

For terminal analysis, run:

```bash
.venv/bin/python -m backend.analysis.pipeline /absolute/path/to/clip.mp4
```

ARC uses the E-BARD basketball detector and Ultralytics YOLO11 Pose. Their links and license notes are included with the project.
