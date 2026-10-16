# Shared route geometry

`routeGeometry.ts` owns linear interpolation, quadratic Bézier evaluation, and
perpendicular default-control construction. Inputs and output must use the same
coordinate space. Progress is bounded to 0–1; point coordinates are not clamped.
The helpers return new points and never modify authored actions.

Callers retain their existing policies:

- `playbookPaths.ts` converts normalized court points to SVG pixels before
  choosing a default control (60–140 pixel bend). It converts the control back
  and clamps editor points to 2–98. Explicit controls bypass default construction.
- `simulation.ts` constructs default controls in normalized court coordinates
  (5–13 unit bend), then clamps them to the physical court. Explicit control
  offsets remain relative to the action's actual starting position.

These default bends are preserved, not made interchangeable: normalized court
coordinates have different x/y scales in SVG. Convert the start, end, and control
together before evaluating a curve in another coordinate space. Both default
policies retain the original 22% bend and one-unit distance denominator floor,
measured in that caller's coordinate space.

Collision avoidance, screen paths, action timing, execution progress, and replay
interpolation retain their separate responsibilities. Do not add execution
detours to the authored-geometry helpers or write them back into saved drawings.
Playbook, miniature previews, Counter Lab, and PNG exports continue to use their
existing route pipelines, now backed by shared mathematical operations.

`npm run test:playbook-geometry` checks recorded pre-refactor fixtures for straight,
curved, explicit/default, short, stationary, and boundary routes, plus coordinate
conversion equivalence. Simulation, coordinated-movement, and Counter Lab tests
cover executable paths and replay behavior.
