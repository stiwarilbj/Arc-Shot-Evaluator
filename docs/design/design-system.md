# ARC design system

The accepted visual specification is `arc-dashboard-concept.png` (1584 × 960).

- Background: true-neutral graphite `#0d0f10`; raised media `#151819`; hairlines `#2b3032`.
- Text: `#f3f1ec`, muted `#9da2a3`; tabular numbers use a mono fallback.
- Accent: basketball orange `#ee733f`; make/evidence green `#66c184`; review amber `#e0aa55`; miss red `#db655e`.
- Type: Inter/system sans, compact editorial hierarchy, explicit 12–14 px control chrome.
- Geometry: open workspace with one media frame and one narrow evidence rail. Radius is 10 px on large media, 8 px on controls, 6 px on small elements.
- Annotation rule: the video remains the focal point. A 2 px ball ring, thin fading trail, corner rim bracket, and shooter-local pose are the maximum overlay density.
- Motion: 160–220 ms state transitions; no ambient animation. Reduced-motion is honored.
- Responsive: below 980 px the evidence rail moves below the player; below 680 px the header and attempt rail simplify without horizontal page overflow.

Allowed above-the-fold copy: `ARC`, `Local shot analysis`, the session filename, `Analysis complete`/processing status, `Analyze another`, `Overview`, `Shot 01`, `Tracking`, `Original`, `Annotated`, `Pose`, video time, `MAKE`/`MISS`/`REVIEW`, release metrics, form metrics, exports, and the single-camera note.
