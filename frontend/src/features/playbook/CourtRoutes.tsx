import { useId } from "react";
import { courtPointToSvg } from "./courtGeometry";
import { routeVisible, type ArrowVisibility, type CourtRoute } from "./arrowVisibility";
export function CourtRoutes({ routes, visibility, labels = false }: { routes: CourtRoute[]; visibility: ArrowVisibility; labels?: boolean }) {
  const marker = `route-${useId().replace(/:/g, "")}`;
  return <g className="court-route-layer" pointerEvents="none"><defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="var(--orange)" /></marker></defs>{routes.filter((route) => routeVisible(route, visibility)).map((route) => {
    const start = courtPointToSvg(route.start), end = courtPointToSvg(route.end);
    const via = route.via && courtPointToSvg(route.via);
    const control = route.kind === "shot" ? { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 105 } : route.control && courtPointToSvg(route.control);
    const d = route.points?.length ? route.points.map((point, index) => { const p = courtPointToSvg(point); return `${index ? "L" : "M"}${p.x} ${p.y}`; }).join(" ") : `M${start.x} ${start.y} ${via ? `L${via.x} ${via.y} L` : control ? `Q${control.x} ${control.y}` : "L"} ${end.x} ${end.y}`;
    return <g key={route.id} data-route-id={route.id} data-route-scope={route.scope} data-route-importance={route.importance}><path d={d} className={`shared-court-route route-${route.importance} route-${route.kind}`} markerEnd={`url(#${marker})`} /><title>{route.sequence != null ? `Move ${route.sequence} · ` : ""}{route.kind} · Player {route.playerId} · {route.scope}</title>{labels && route.sequence != null && route.id.endsWith(":actor") ? <g className="arrow-sequence-badge"><circle cx={(start.x + end.x) / 2} cy={(start.y + end.y) / 2} r="12" /><text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 + 1}>{route.sequence}</text></g> : null}</g>;
  })}</g>;
}
