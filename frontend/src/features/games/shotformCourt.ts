import { clamp, poseAt, type Challenge, type Controls, type V3 } from "./shotformMotion.ts";

export type CourtPoint = [number, number];
export const BALL_RADIUS = 13;
const point = (v: V3): CourtPoint => [205 + (v[0] + .55 * v[2]) * 170, 405 - v[1] * 170];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function shotBallPosition(challenge: Challenge, controls: Controls, repetition: number, time: number): CourtPoint {
  const t = clamp(time, 0, 1), shootingHand = challenge.leftHanded ? "leftHand" : "rightHand";
  if (t < .52) return point(poseAt(challenge, controls, repetition, t)[shootingHand]);

  // Freeze the hand at release so the ball's path does not move with the follow-through
  const release = point(poseAt(challenge, controls, repetition, .52)[shootingHand]);
  const target: CourtPoint = [470, 169], dx = target[0] - release[0];
  const controlY = BALL_RADIUS + 14;
  const first: CourtPoint = [release[0] + dx / 3, controlY];
  const second: CourtPoint = [release[0] + 2 * dx / 3, controlY];
  const u = clamp((t - .52) / .48, 0, 1), inverse = 1 - u;
  return [
    inverse ** 3 * release[0] + 3 * inverse ** 2 * u * first[0] + 3 * inverse * u ** 2 * second[0] + u ** 3 * target[0],
    inverse ** 3 * release[1] + 3 * inverse ** 2 * u * first[1] + 3 * inverse * u ** 2 * second[1] + u ** 3 * target[1],
  ];
}

export const projectCourtPoint = point;
