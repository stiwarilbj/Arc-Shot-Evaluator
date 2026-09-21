# ARC project map

ARC is split by responsibility, so the folder name tells you which part of the product lives there.

```text
arc-shot-evaluator/
├── backend/
│   ├── api/          Local FastAPI routes and the analysis job queue
│   ├── analysis/     Vision models, ball tracking, measurements, and video rendering
│   ├── coaching/     Local BM25 retrieval and shooting advice
│   ├── domain/       Shared basketball data models
│   └── config.py     Paths shared by every backend feature
├── frontend/
│   ├── src/app/      Top-level screen composition and application state
│   ├── src/features/ Components grouped by analysis, queue, and upload workflow
│   ├── src/domain/   TypeScript versions of the analysis data models
│   ├── src/services/ Browser calls to the local API
│   ├── src/layout/   App-wide layout components
│   └── src/styles/   The ARC visual system and responsive rules
├── tests/            Behavior tests for API, tracking, media, and coaching
├── examples/         Videos shown in the test library
├── models/           Local YOLO detector and pose weights
├── sessions/         Generated local analyses and exports
├── playbooks/        Saved local half-court diagrams
├── docs/             Architecture notes, design references, and screenshots
└── scripts/          One-command setup and startup helpers
```

## What happens to a video

1. `backend/api/app.py` accepts an upload or bundled example and queues it in Normal or Deep mode.
2. `backend/analysis/pipeline.py` keeps the uploaded source beside a playback copy, then coordinates detection, tracking, measurement, coaching, and rendering.
3. `backend/analysis/vision_models.py` finds basketballs, rims, and player keypoints.
4. `backend/coaching/retriever.py` matches reliable shot measurements to the local shooting guide.
5. The finished session is saved in `sessions/` with versioned evidence, uncertainty, and a withheld prediction status. Corrections are stored separately in `corrections.json`.
6. `frontend/src/app/ArcShotEvaluatorApp.tsx` composes the video workspace, queue, Coach Notes, and shot data.

The Playbook workspace remains mounted beside the analyzer so switching destinations preserves an in-progress diagram and analysis queue. Its SVG editor uses normalized 0–100 court coordinates, while `backend/api/playbooks.py` validates and atomically persists versioned documents under `playbooks/`.

Shot mode is captured when a queue item is created. Free throw remains the
fresh-launch default; jump-shot analysis adds temporal player association,
court-plane distance, takeoff/landing events, and per-opponent contest evidence
through `backend/analysis/jump_shot.py`. The prediction boundary lives in
`backend/prediction/jump_models.py` and returns explicit unavailable records
until a validated model registry entry exists.

Jump-shot training manifests and split rules live under
`training/jump_shots/`. They are intentionally separate from free-throw data
and keep source rights, duplicate groups, shooter/venue/session splits, and
prediction cutoffs auditable.

The API and export field names remain stable even though the internal Python and TypeScript types use more descriptive names such as `ShotAnalysis`, `BallTrackPoint`, and `AnalysisQueueItem`.
