import type { CourtPoint } from "./types.ts";

// Inputs and output share the caller's coordinate space. These helpers neither
// convert units nor clamp positions to court bounds or add avoidance detours.
export function linearRoutePoint(start: CourtPoint, end: CourtPoint, amount: number): CourtPoint {
  const progress = Math.max(0, Math.min(1, amount));
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  };
}

export function quadraticRoutePoint(start: CourtPoint, end: CourtPoint, control: CourtPoint, amount: number): CourtPoint {
  const progress = Math.max(0, Math.min(1, amount));
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x,
    y: inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y,
  };
}

/** Bend limits and the one-unit denominator floor use the input coordinate space. */
export function perpendicularRouteControl(start: CourtPoint, end: CourtPoint, minOffset: number, maxOffset: number): CourtPoint {
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const offset = Math.max(minOffset, Math.min(maxOffset, distance * 0.22));
  return {
    x: midpoint.x + dy * offset / Math.max(1, distance),
    y: midpoint.y - dx * offset / Math.max(1, distance),
  };
}
