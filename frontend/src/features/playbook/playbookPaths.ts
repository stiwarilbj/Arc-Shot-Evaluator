import { linearRoutePoint, quadraticRoutePoint, perpendicularRouteControl } from "./routeGeometry.ts";
import type { CourtPoint, PlaybookArrow, PlaybookMarker } from "./types.ts";
import { courtPointToSvg, courtSvgToPoint, NBA_COURT_GEOMETRY } from "./courtGeometry.ts";

export function clamp(value: number, min = 2, max = 98) {
  return Math.max(min, Math.min(max, value));
}

export function markerPoint(marker: CourtPoint) {
  return courtPointToSvg(marker);
}

export function arrowSequence(arrow: PlaybookArrow, index: number) {
  return Number.isInteger(arrow.sequence) && (arrow.sequence ?? 0) > 0 ? arrow.sequence as number : index + 1;
}

export function lerpPoint(start: CourtPoint, end: CourtPoint, amount: number): CourtPoint {
  const point = linearRoutePoint(start, end, amount);
  return { x: clamp(point.x), y: clamp(point.y) };
}

export function defaultArrowControl(start: CourtPoint, end: CourtPoint): CourtPoint {
  // Editor bend limits are SVG pixels; convert back before editor bounds.
  const control = courtSvgToPoint(perpendicularRouteControl(
    courtPointToSvg(start), courtPointToSvg(end), 60, 140,
  ));
  return { x: clamp(control.x), y: clamp(control.y) };
}

export function arrowControl(arrow: PlaybookArrow) {
  return arrow.control ?? defaultArrowControl(arrow.start, arrow.end);
}

export function quadraticPoint(start: CourtPoint, end: CourtPoint, control: CourtPoint, amount: number): CourtPoint {
  const point = quadraticRoutePoint(start, end, control, amount);
  return { x: clamp(point.x), y: clamp(point.y) };
}

export function actionPointAt(arrow: PlaybookArrow, amount: number) {
  return arrow.path === "curve" ? quadraticPoint(arrow.start, arrow.end, arrowControl(arrow), amount) : lerpPoint(arrow.start, arrow.end, amount);
}

export function actionPath(arrow: PlaybookArrow) {
  const start = markerPoint(arrow.start);
  const end = markerPoint(arrow.end);
  if (arrow.kind === "pick-pop" && arrow.exit_target) {
    const pop = markerPoint(arrow.exit_target);
    return `M${start.x} ${start.y} L${end.x} ${end.y} L${pop.x} ${pop.y}`;
  }
  if (arrow.path === "curve") {
    const control = markerPoint(arrowControl(arrow));
    return `M${start.x} ${start.y} Q${control.x} ${control.y} ${end.x} ${end.y}`;
  }
  return `M${start.x} ${start.y} L${end.x} ${end.y}`;
}

export function screenCutterPath(arrow: PlaybookArrow, players: PlaybookMarker[]) {
  if (arrow.kind !== "off-ball-screen" && arrow.kind !== "pin-down") return null;
  const cutter = players.find((player) => player.id === arrow.cutter_id);
  if (!cutter) return null;
  const start = markerPoint(cutter);
  const screen = markerPoint(arrow.end);
  const hoop = courtSvgToPoint(NBA_COURT_GEOMETRY.basket.center);
  const distance = Math.hypot(hoop.x - arrow.end.x, hoop.y - arrow.end.y);
  const finishPoint = markerPoint(arrow.exit_target ?? {
    x: arrow.end.x + (hoop.x - arrow.end.x) * Math.min(1, 16 / Math.max(1, distance)),
    y: arrow.end.y + (hoop.y - arrow.end.y) * Math.min(1, 16 / Math.max(1, distance)),
  });
  return `M${start.x} ${start.y} L${screen.x} ${screen.y} L${finishPoint.x} ${finishPoint.y}`;
}
