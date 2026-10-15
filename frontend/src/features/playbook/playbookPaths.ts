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
  const progress = Math.max(0, Math.min(1, amount));
  return {
    x: clamp(start.x + (end.x - start.x) * progress),
    y: clamp(start.y + (end.y - start.y) * progress),
  };
}

export function defaultArrowControl(start: CourtPoint, end: CourtPoint): CourtPoint {
  const from = courtPointToSvg(start);
  const to = courtPointToSvg(end);
  const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const offset = Math.max(60, Math.min(140, distance * 0.22));
  const control = courtSvgToPoint({
    x: midpoint.x + dy * offset / Math.max(1, distance),
    y: midpoint.y - dx * offset / Math.max(1, distance),
  });
  return { x: clamp(control.x), y: clamp(control.y) };
}

export function arrowControl(arrow: PlaybookArrow) {
  return arrow.control ?? defaultArrowControl(arrow.start, arrow.end);
}

export function quadraticPoint(start: CourtPoint, end: CourtPoint, control: CourtPoint, amount: number): CourtPoint {
  const progress = Math.max(0, Math.min(1, amount));
  const inverse = 1 - progress;
  return {
    x: clamp(inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x),
    y: clamp(inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y),
  };
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
