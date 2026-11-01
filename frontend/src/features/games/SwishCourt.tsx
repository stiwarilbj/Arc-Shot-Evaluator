import { useId, useMemo } from "react";
import { BALL_RADIUS, RIM_RADIUS, RIM_TUBE, RELEASE_HEIGHT, type FlightPoint, type HoopSetup } from "./swishPhysics";
import type { ShotPrediction } from "./swishPrediction";

type XY = { x: number; y: number };
function hull(points: XY[]): XY[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: XY, b: XY, c: XY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (list: XY[]) => {
    const out: XY[] = [];
    for (const p of list) { while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop(); out.push(p); }
    return out.slice(0, -1);
  };
  return [...half(sorted), ...half(sorted.reverse())];
}
export default function SwishCourt({ setup, prediction, actual, ball, flying }: {
  setup: HoopSetup; prediction: ShotPrediction | null; actual: FlightPoint[]; ball: FlightPoint; flying: boolean;
}) {
  const clipId = useId().replace(/:/g, "");
  // Equal physical scaling on both axes keeps the rim and ball geometry honest
  const worldWidth = Math.max(8.8, setup.distance + 1.5);
  const scale = 700 / worldWidth;
  const visiblePath = prediction?.center.filter(p => p.y >= 0 && p.x <= worldWidth) ?? [];
  const top = Math.max(5, setup.height + 1.4, ...visiblePath.map(p => p.y + 0.3));
  const height = top * scale + 92;
  const X = (x: number) => 55 + x * scale, Y = (y: number) => 24 + (top - y) * scale;
  const path = (points: XY[]) => points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(2)},${Y(p.y).toFixed(2)}`).join(" ");
  const spread = useMemo(() => {
    if (!prediction) return [];
    const paths = [prediction.center, ...prediction.spread];
    return prediction.center.slice(1).map((_, index) => hull(paths.flatMap(points => [points[index], points[index + 1]].flatMap(p => [
      { x: p.x - prediction.error, y: p.y - prediction.error }, { x: p.x + prediction.error, y: p.y - prediction.error },
      { x: p.x - prediction.error, y: p.y + prediction.error }, { x: p.x + prediction.error, y: p.y + prediction.error },
    ]))));
  }, [prediction]);
  const rimLeft = setup.distance - RIM_RADIUS, rimRight = setup.distance + RIM_RADIUS;
  const boardX = rimRight + 0.1524;
  return <svg className="swish-court" viewBox={`0 0 800 ${height}`} role="img" aria-label={`Side view of the shot, hoop ${setup.distance} meters away and ${setup.height.toFixed(2)} meters high${flying ? ", shot in flight" : ""}`}>
    <defs><clipPath id={clipId}><rect x={X(-0.3)} y="0" width={X(worldWidth) - X(-0.3)} height={Y(0)} /></clipPath></defs>
    {Array.from({ length: Math.ceil(top) }, (_, i) => i + 1).map(y => <g key={y} className="swish-grid"><path d={`M${X(-0.2)},${Y(y)} H${X(worldWidth)}`} /><text x="14" y={Y(y) + 4}>{y} m</text></g>)}
    <path className="swish-floor" d={`M${X(-0.3)},${Y(0)} H${X(worldWidth)}`} />
    <g clipPath={`url(#${clipId})`}>
      <g className="swish-spread">{spread.map((points, i) => <path key={i} d={`${path(points)}Z`} />)}</g>
      {prediction ? <path className="swish-prediction" d={path(prediction.center)} /> : null}
      {actual.length > 1 ? <path className="swish-actual" d={path(actual)} /> : null}
    </g>
    <path className="swish-release" d={`M${X(0)},${Y(0)} V${Y(RELEASE_HEIGHT)}`} />
    <circle cx={X(0)} cy={Y(RELEASE_HEIGHT)} r="3" className="swish-release-dot" />
    <path className="swish-backboard" d={`M${X(boardX)},${Y(setup.height - 0.15)} V${Y(setup.height + 0.9)}`} />
    <path className="swish-post" d={`M${X(boardX)},${Y(setup.height + 0.3)} H${X(boardX + 0.3)} V${Y(0)}`} />
    <path className="swish-net" d={`M${X(rimLeft)},${Y(setup.height)} L${X(rimLeft + 0.1)},${Y(setup.height - 0.38)} H${X(rimRight - 0.1)} L${X(rimRight)},${Y(setup.height)} M${X(rimLeft)},${Y(setup.height)} L${X(rimRight - 0.1)},${Y(setup.height - 0.38)} M${X(rimRight)},${Y(setup.height)} L${X(rimLeft + 0.1)},${Y(setup.height - 0.38)}`} />
    <path className="swish-target" d={`M${X(rimLeft + BALL_RADIUS)},${Y(setup.height)} H${X(rimRight - BALL_RADIUS)}`} />
    {[rimLeft, rimRight].map(x => <circle key={x} className="swish-rim" cx={X(x)} cy={Y(setup.height)} r={Math.max(1.6, RIM_TUBE * scale)} />)}
    <g transform={`translate(${X(ball.x)},${Y(ball.y)})`} className="swish-ball">
      <circle r={BALL_RADIUS * scale} /><path d={`M${-BALL_RADIUS * scale},0 H${BALL_RADIUS * scale} M0,${-BALL_RADIUS * scale} V${BALL_RADIUS * scale}`} />
    </g>
    <path className="swish-distance" d={`M${X(0)},${Y(0) + 23} H${X(setup.distance)} M${X(0)},${Y(0) + 18} V${Y(0) + 28} M${X(setup.distance)},${Y(0) + 18} V${Y(0) + 28}`} />
    <text className="swish-distance-label" x={X(setup.distance / 2)} y={Y(0) + 46} textAnchor="middle">{setup.distance.toFixed(1)} m to hoop</text>
  </svg>;
}
