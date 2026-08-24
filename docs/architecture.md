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
├── docs/             Architecture notes, design references, and screenshots
└── scripts/          One-command setup and startup helpers
```

## What happens to a video

1. `backend/api/app.py` accepts an upload or bundled example and queues it.
2. `backend/analysis/pipeline.py` normalizes the clip and coordinates detection, tracking, measurement, coaching, and rendering.
3. `backend/analysis/vision_models.py` finds basketballs, rims, and player keypoints.
4. `backend/coaching/retriever.py` matches reliable shot measurements to the local shooting guide.
5. The finished session is saved in `sessions/` and returned to the React app.
6. `frontend/src/app/ArcShotEvaluatorApp.tsx` composes the video workspace, queue, Coach Notes, and shot data.

The API and export field names remain stable even though the internal Python and TypeScript types use more descriptive names such as `ShotAnalysis`, `BallTrackPoint`, and `AnalysisQueueItem`.
