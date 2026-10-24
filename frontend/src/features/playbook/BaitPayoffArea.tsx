import { courtPointToSvg, COURT_VIEWBOX } from "./courtGeometry.ts";
import type { BaitPayoffArea } from "./types.ts";

export function BaitPayoffAreaOverlay({ area, selected = false }: { area: BaitPayoffArea; selected?: boolean }) {
  const center = courtPointToSvg(area.center);
  const pixelsPerFootX = COURT_VIEWBOX.width / 50;
  const pixelsPerFootY = COURT_VIEWBOX.height / 47;
  return <g className={`bait-payoff-area ${selected ? "is-selected" : ""}`} pointerEvents="none">
    {area.shape === "circle" ? <circle cx={center.x} cy={center.y} r={area.radiusFeet * pixelsPerFootX} />
      : <rect x={center.x - area.widthFeet * pixelsPerFootX / 2} y={center.y - area.heightFeet * pixelsPerFootY / 2} width={area.widthFeet * pixelsPerFootX} height={area.heightFeet * pixelsPerFootY} rx="4" />}
    <circle className="bait-payoff-area-center" cx={center.x} cy={center.y} r="6" />
  </g>;
}
