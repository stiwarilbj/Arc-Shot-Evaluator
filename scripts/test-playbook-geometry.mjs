import assert from 'node:assert/strict';
import {
  COURT_MARKING_PATHS,
  COURT_SCALE,
  COURT_VIEWBOX,
  NBA_COURT_DIMENSIONS,
  NBA_COURT_GEOMETRY,
  clientPointToCourt,
  courtFeetToSvg,
  courtPointToClient,
  courtPointToSvg,
  courtSvgToPoint,
} from '../frontend/src/features/playbook/courtGeometry.ts';

function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

assert.deepEqual(NBA_COURT_DIMENSIONS, { widthFeet: 50, fullLengthFeet: 94, halfLengthFeet: 47 });
near(COURT_VIEWBOX.width / COURT_VIEWBOX.height, NBA_COURT_DIMENSIONS.widthFeet / NBA_COURT_DIMENSIONS.halfLengthFeet);
near(NBA_COURT_GEOMETRY.boundary.width / COURT_SCALE, 50);
near(NBA_COURT_GEOMETRY.boundary.height / COURT_SCALE, 47);

const { basket, lane, freeThrowCircle, threePoint } = NBA_COURT_GEOMETRY;
near(lane.widthFeet, 16);
near((lane.right - lane.left) / COURT_SCALE, 16);
near(lane.depthFeet, 19);
near((lane.freeThrowY - lane.top) / COURT_SCALE, 19);
near(freeThrowCircle.radiusFeet, 6);
near(freeThrowCircle.radius / COURT_SCALE, 6);
near(basket.distanceFromBaselineFeet, 5.25);
near(threePoint.radiusFeet, 23.75);
near(threePoint.cornerInsetFeet, 3);
near((threePoint.leftCornerX - NBA_COURT_GEOMETRY.boundary.left) / COURT_SCALE, 3);
near((NBA_COURT_GEOMETRY.boundary.right - threePoint.rightCornerX) / COURT_SCALE, 3);
near(Math.hypot(threePoint.leftIntersection.x - basket.center.x, threePoint.leftIntersection.y - basket.center.y) / COURT_SCALE, 23.75);
near(Math.hypot(threePoint.rightIntersection.x - basket.center.x, threePoint.rightIntersection.y - basket.center.y) / COURT_SCALE, 23.75);
near(threePoint.leftIntersection.y, threePoint.rightIntersection.y);
assert.match(COURT_MARKING_PATHS.freeThrowDashed, / 0 0 1 /, 'the lane-side free-throw semicircle is the dashed half');
assert.match(COURT_MARKING_PATHS.freeThrowSolid, / 0 0 0 /, 'the outside free-throw semicircle is the solid half');

for (const point of [{ x: 50, y: 50 }, { x: 25, y: 12.5 }, { x: 98, y: 84 }]) {
  assert.deepEqual(courtSvgToPoint(courtPointToSvg(point)), point, 'normalized marker positions round-trip through court SVG coordinates');
}
near(courtFeetToSvg({ x: 25, y: 5.25 }).x, basket.center.x);
near(courtFeetToSvg({ x: 25, y: 5.25 }).y, basket.center.y);

const marker = { x: 23.5, y: 76.25 };
const screenTransform = { a: 0.62, b: 0, c: 0, d: 0.62, e: 120, f: 38 };
const clientPoint = courtPointToClient(marker, screenTransform);
const pointerPoint = clientPointToCourt(clientPoint.x, clientPoint.y, screenTransform);
near(pointerPoint.x, marker.x);
near(pointerPoint.y, marker.y);
assert.equal(clientPointToCourt(120, 38, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }), null, 'singular SVG transforms are rejected');

console.log('Playbook court geometry tests passed: NBA dimensions, lane and circle, three-point arc, marker transforms, and pointer-coordinate round trips');
