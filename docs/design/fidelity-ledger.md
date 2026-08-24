# ARC fidelity ledger

Compared on 2026-08-21 against `arc-dashboard-concept.png` using the browser-rendered `arc-dashboard-implementation.png` at the app browser's 1277 × 960 capture surface. Layout was separately evaluated at the selected native viewport of 1584 × 960.

## Matched

1. The information architecture is preserved: compact status header, three analysis tabs, dominant video workspace, right-side evidence rail, attempt strip, and quiet footer.
2. The visual system matches the concept's charcoal surfaces, restrained dividers, warm orange interaction color, green make state, off-white type, small radii, and dense coaching-tool rhythm.
3. The video treatment remains intentionally sparse. Ball/arc evidence is drawn on the annotated stream, while pose evidence is isolated in its own mode so the result does not become the cluttered example supplied with the request.
4. Typography follows the same hierarchy: sans-serif navigation and labels, monospaced timecodes and measurements, compact uppercase outcome language.
5. The concept's core controls are implemented: Original/Annotated/Pose switching, play/pause, seeking, release marker, shot selection, overview/tracking tabs, local notes, full screen, and exports.
6. The composition adapts to 390 × 844 as a single-column layout without horizontal overflow while retaining the video, attempt, metrics, form, notes, and export surfaces.

## Above-the-fold copy comparison

The final build retains `ARC`, `Local shot analysis`, `Analysis complete`, `Analyze another`, `Overview`, `Shot 01`, `Tracking`, the three video modes, `MAKE`, confidence, release metrics, form-at-release metrics, notes, and export labels. The implementation displays the exact uploaded filename rather than the shortened filename used in the concept.

## Intentional deviations

- The concept used seven fictional attempt cards and 92% confidence to establish layout. The tested build shows the one real attempt found in the supplied clip and its measured 83% confidence; no data is invented for visual fidelity.
- Concept metric values were illustrative. The implementation shows the detector's actual 9.67 s release, 46.0° entry angle, 6.8 m/s release speed, 2.57 m release height, and joint estimates.
- The concept depicts an idealized release overlay. The implementation screenshot is a real rendered frame at 10.09 s, immediately after the detected release, with the actual tracked ball and trajectory.
- The logo is rendered as lightweight CSS text rather than introducing a raster brand asset.

## Browser QA

- 1584 × 960: 1584 px document width, 960 px document height; no horizontal or vertical overflow.
- 390 × 844: 390 px document width; no horizontal overflow and expected vertical scrolling for the evidence stack.
- Browser console: no warnings or errors.
