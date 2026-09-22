import type { CourtPoint } from "./types";

export const COURT_WIDTH = 1000;
export const COURT_HEIGHT = 940;
export const COURT_VIEWBOX = { width: COURT_WIDTH, height: COURT_HEIGHT } as const;

export const NBA_COURT_DIMENSIONS = {
  widthFeet: 50,
  fullLengthFeet: 94,
  halfLengthFeet: 47,
} as const;

export const COURT_SCALE = (COURT_VIEWBOX.width - 48) / NBA_COURT_DIMENSIONS.widthFeet;

const courtLeft = 24;
const courtTop = (COURT_VIEWBOX.height - NBA_COURT_DIMENSIONS.halfLengthFeet * COURT_SCALE) / 2;
const courtRight = courtLeft + NBA_COURT_DIMENSIONS.widthFeet * COURT_SCALE;
const courtBottom = courtTop + NBA_COURT_DIMENSIONS.halfLengthFeet * COURT_SCALE;
const centerX = (courtLeft + courtRight) / 2;
const baselineY = courtTop;

export function courtFeetToSvg(point: { x: number; y: number }) {
  return {
    x: courtLeft + point.x * COURT_SCALE,
    y: courtTop + point.y * COURT_SCALE,
  };
}

const basketCenter = courtFeetToSvg({ x: 25, y: 5.25 });
const laneWidthFeet = 16;
const laneDepthFeet = 19;
const laneLeft = centerX - (laneWidthFeet / 2) * COURT_SCALE;
const laneRight = centerX + (laneWidthFeet / 2) * COURT_SCALE;
const freeThrowY = courtTop + laneDepthFeet * COURT_SCALE;
const freeThrowRadiusFeet = 6;
const freeThrowRadius = freeThrowRadiusFeet * COURT_SCALE;
const threePointRadiusFeet = 23.75;
const threePointRadius = threePointRadiusFeet * COURT_SCALE;
const cornerInsetFeet = 3;
const threePointHalfWidthFeet = NBA_COURT_DIMENSIONS.widthFeet / 2 - cornerInsetFeet;
const threePointArcRiseFeet = Math.sqrt(threePointRadiusFeet ** 2 - threePointHalfWidthFeet ** 2);
const threePointIntersectionYFeet = 5.25 + threePointArcRiseFeet;
const threePointIntersectionY = courtFeetToSvg({ x: 0, y: threePointIntersectionYFeet }).y;
const threePointLeft = courtFeetToSvg({ x: cornerInsetFeet, y: threePointIntersectionYFeet });
const threePointRight = courtFeetToSvg({ x: NBA_COURT_DIMENSIONS.widthFeet - cornerInsetFeet, y: threePointIntersectionYFeet });
const backboardY = courtFeetToSvg({ x: 0, y: 4 }).y;
const rimRadius = 0.75 * COURT_SCALE;

export const NBA_COURT_GEOMETRY = {
  scale: COURT_SCALE,
  boundary: {
    left: courtLeft,
    top: courtTop,
    right: courtRight,
    bottom: courtBottom,
    width: courtRight - courtLeft,
    height: courtBottom - courtTop,
  },
  basket: {
    center: basketCenter,
    distanceFromBaselineFeet: 5.25,
    rimRadiusFeet: 0.75,
    rimRadius,
    backboardY,
    backboardWidth: 6 * COURT_SCALE,
  },
  lane: {
    widthFeet: laneWidthFeet,
    depthFeet: laneDepthFeet,
    left: laneLeft,
    right: laneRight,
    top: baselineY,
    freeThrowY,
  },
  freeThrowCircle: {
    radiusFeet: freeThrowRadiusFeet,
    radius: freeThrowRadius,
    center: { x: centerX, y: freeThrowY },
    leftX: centerX - freeThrowRadius,
    rightX: centerX + freeThrowRadius,
  },
  threePoint: {
    radiusFeet: threePointRadiusFeet,
    radius: threePointRadius,
    cornerInsetFeet,
    leftCornerX: courtFeetToSvg({ x: cornerInsetFeet, y: 0 }).x,
    rightCornerX: courtFeetToSvg({ x: NBA_COURT_DIMENSIONS.widthFeet - cornerInsetFeet, y: 0 }).x,
    leftIntersection: threePointLeft,
    rightIntersection: threePointRight,
    intersectionYFeet: threePointIntersectionYFeet,
  },
} as const;

const { boundary, basket, lane, freeThrowCircle, threePoint } = NBA_COURT_GEOMETRY;

export const COURT_MARKING_PATHS = {
  lane: `M${lane.left} ${lane.top}V${lane.freeThrowY}M${lane.right} ${lane.top}V${lane.freeThrowY}M${lane.left} ${lane.freeThrowY}H${lane.right}`,
  freeThrowDashed: `M${freeThrowCircle.leftX} ${freeThrowCircle.center.y}A${freeThrowCircle.radius} ${freeThrowCircle.radius} 0 0 1 ${freeThrowCircle.rightX} ${freeThrowCircle.center.y}`,
  freeThrowSolid: `M${freeThrowCircle.leftX} ${freeThrowCircle.center.y}A${freeThrowCircle.radius} ${freeThrowCircle.radius} 0 0 0 ${freeThrowCircle.rightX} ${freeThrowCircle.center.y}`,
  threePointCorners: `M${threePoint.leftCornerX} ${boundary.top}V${threePoint.leftIntersection.y}M${threePoint.rightCornerX} ${boundary.top}V${threePoint.rightIntersection.y}`,
  threePointArc: `M${threePoint.leftIntersection.x} ${threePointIntersectionY}A${threePoint.radius} ${threePoint.radius} 0 0 0 ${threePoint.rightIntersection.x} ${threePointIntersectionY}`,
  backboard: `M${basket.center.x - basket.backboardWidth / 2} ${basket.backboardY}H${basket.center.x + basket.backboardWidth / 2}`,
  net: `M${basket.center.x - basket.rimRadius * 0.65} ${basket.center.y + basket.rimRadius * 0.35}L${basket.center.x - basket.rimRadius * 0.45} ${basket.center.y + basket.rimRadius * 1.8}H${basket.center.x + basket.rimRadius * 0.45}L${basket.center.x + basket.rimRadius * 0.65} ${basket.center.y + basket.rimRadius * 0.35}`,
} as const;

export function courtPointToSvg(point: CourtPoint) {
  return {
    x: (point.x / 100) * COURT_VIEWBOX.width,
    y: (point.y / 100) * COURT_VIEWBOX.height,
  };
}

export function courtSvgToPoint(point: { x: number; y: number }): CourtPoint {
  return {
    x: (point.x / COURT_VIEWBOX.width) * 100,
    y: (point.y / COURT_VIEWBOX.height) * 100,
  };
}

export interface SvgScreenTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function courtPointToClient(point: CourtPoint, transform: SvgScreenTransform) {
  const svgPoint = courtPointToSvg(point);
  return {
    x: transform.a * svgPoint.x + transform.c * svgPoint.y + transform.e,
    y: transform.b * svgPoint.x + transform.d * svgPoint.y + transform.f,
  };
}

export function clientPointToCourt(clientX: number, clientY: number, transform: SvgScreenTransform): CourtPoint | null {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < Number.EPSILON) return null;

  const translatedX = clientX - transform.e;
  const translatedY = clientY - transform.f;
  const svgPoint = {
    x: (transform.d * translatedX - transform.c * translatedY) / determinant,
    y: (-transform.b * translatedX + transform.a * translatedY) / determinant,
  };
  return courtSvgToPoint(svgPoint);
}
