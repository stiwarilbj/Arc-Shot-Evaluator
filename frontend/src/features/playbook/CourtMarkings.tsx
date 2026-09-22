import { COURT_MARKING_PATHS, NBA_COURT_GEOMETRY } from "./courtGeometry";

export function CourtMarkings({ mini = false }: { mini?: boolean }) {
  const lineClass = mini ? "mini-line" : "court-line";
  const dashClass = mini ? "mini-dash" : "court-dash";
  const basketClass = mini ? "mini-basket" : "basket-mark";
  const { boundary, basket } = NBA_COURT_GEOMETRY;

  return <>
    <rect x={boundary.left} y={boundary.top} width={boundary.width} height={boundary.height} rx="3" className={lineClass} />
    <path d={COURT_MARKING_PATHS.lane} className={lineClass} />
    <path d={COURT_MARKING_PATHS.freeThrowDashed} className={dashClass} />
    <path d={COURT_MARKING_PATHS.freeThrowSolid} className={lineClass} />
    <path d={COURT_MARKING_PATHS.threePointCorners} className={lineClass} />
    <path d={COURT_MARKING_PATHS.threePointArc} className={lineClass} />
    <path d={COURT_MARKING_PATHS.backboard} className={basketClass} />
    <circle cx={basket.center.x} cy={basket.center.y} r={basket.rimRadius} className={basketClass} />
    <path d={COURT_MARKING_PATHS.net} className={lineClass} />
  </>;
}
