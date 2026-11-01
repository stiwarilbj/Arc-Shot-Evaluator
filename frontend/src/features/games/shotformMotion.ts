// Synthetic motion for a game, not a biomechanical assessment
export const SHOTFORM_ENGINE = "shotform-motion-v1";
export const AREAS = ["balance", "elbow", "finish"] as const;
export type Area = typeof AREAS[number];
export type Controls = [number, number, number];
export type V3 = [number, number, number];
export type Pose = Record<"hips" | "chest" | "head" | "leftHip" | "rightHip" | "leftKnee" | "rightKnee" | "leftAnkle" | "rightAnkle" | "leftToe" | "rightToe" | "leftShoulder" | "rightShoulder" | "leftElbow" | "rightElbow" | "leftWrist" | "rightWrist" | "leftHand" | "rightHand", V3>;
export type Challenge = { seed: number; tier: number; target: Controls; start: Controls; matrix: number[][]; samples: [number, number, number]; leftHanded: boolean; minimum: number; id: string };
export const PHASES = [0.28, 0.58, 0.88];
export const SHOT_SECONDS = 1.6;
export const TEST_SECONDS = 4.8; // Exact slider endpoint avoids a floating-point lock at 1.6 × 3
export const FEATURE_ID = "joint-pair-deltas-9-v1";
export const FEATURE_DEFINITION = { phases: PHASES, channels: ["hips-x/0.05", "shooting-upper-yaw/0.09", "shooting-hand-angle/0.11"], repetitions: [0, 2], layout: "channel-major" };
export const LABELS: Record<Area, string> = { balance: "Balance", elbow: "Elbow", finish: "Follow-through" };
export const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
export const randomStep = (seed: number): [number, number] => { const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return [next, next / 4294967296]; };
export const tierFor = (round: number) => round <= 3 ? 1 : round <= 6 ? 2 : 3;
export const validControls = (c: unknown): c is Controls => Array.isArray(c) && c.length === 3 && c.every(x => Number.isInteger(x) && x >= -4 && x <= 4);
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, n: number): V3 => [a[0] * n, a[1] * n, a[2] * n];
const sub = (a: V3, b: V3): V3 => add(a, scale(b, -1));
const norm = (a: V3) => Math.hypot(...a);
const unit = (a: V3): V3 => scale(a, 1 / (norm(a) || 1));
const dot = (a: V3, b: V3) => a.reduce((n, v, i) => n + v * b[i], 0);
const smooth = (a: number, b: number, t: number) => { const u = clamp(t, 0, 1); return a + (b - a) * u * u * (3 - 2 * u); };
function knee(hip: V3, ankle: V3): V3 {
  const delta = sub(ankle, hip), d = norm(delta), along = unit(delta);
  const forward: V3 = [0, 0, 1];
  const bend = unit(sub(forward, scale(along, dot(forward, along))));
  return add(add(hip, scale(delta, 0.5)), scale(bend, Math.sqrt(Math.max(0, 0.48 ** 2 - (d / 2) ** 2))));
}
export function residuals(challenge: Challenge, controls: Controls): number[] {
  return challenge.matrix.map(row => row.reduce((sum, value, i) => sum + value * (controls[i] - challenge.target[i]), 0));
}
export function poseAt(challenge: Challenge, controls: Controls, repetition: number, time: number): Pose {
  const t = clamp(time, 0, 1), q = residuals(challenge, controls);
  // A round's fixed samples produce repeated visible variation, never a reroll
  const variation = challenge.samples[clamp(Math.floor(repetition), 0, 2)];
  const weight = 0.72 + 0.28 * Math.sin(Math.PI * t);
  const jump = 0.12 * Math.sin(Math.PI * clamp((t - 0.22) / 0.62, 0, 1));
  const crouch = 0.09 * Math.sin(Math.PI * clamp(t / 0.52, 0, 1));
  const hips: V3 = [controls[0] * .008 + q[0] * 0.025 * variation * weight, 0.88 + jump - crouch, 0];
  const chest = add(hips, [0, 0.43, 0]);
  const leftHip = add(hips, [-0.12, 0, 0]), rightHip = add(hips, [0.12, 0, 0]);
  const leftAnkle: V3 = [-0.17, jump + 0.025, 0.04], rightAnkle: V3 = [0.17, jump + 0.025, -0.04];
  const leftShoulder = add(chest, [-0.19, 0, 0]), rightShoulder = add(chest, [0.19, 0, 0]);
  function arm(shoulder: V3, shooting: boolean, outward: number): { elbow: V3; wrist: V3; hand: V3 } {
    const yaw = (shooting ? 0.14 + controls[1] * .015 : -0.22) + (shooting ? q[1] * 0.045 * variation * weight : 0);
    const lift = smooth(-0.65, 1.03, (t - 0.12) / 0.48);
    const pitch = shooting ? lift : smooth(lift, -1.15, (t - 0.55) / 0.3);
    const upper: V3 = [outward * Math.sin(yaw), Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.cos(yaw)];
    const elbow = add(shoulder, scale(upper, 0.29));
    const foreLift = smooth(0.6, 1.22, t / 0.6);
    const forePitch = shooting ? foreLift : smooth(foreLift, -1.1, (t - 0.55) / 0.3);
    const wrist = add(elbow, scale([0, Math.sin(forePitch), Math.cos(forePitch)], 0.26));
    const finishWeight = 0.55 + 0.45 * smooth(0, 1, (t - 0.45) / 0.35);
    const handPitch = (shooting ? smooth(1.12, -0.52, (t - 0.44 - controls[2] * .015) / 0.24) : smooth(1.12, -.9, (t - .55) / .3)) + (shooting ? q[2] * 0.055 * variation * finishWeight : 0);
    return { elbow, wrist, hand: add(wrist, scale([0, Math.sin(handPitch), Math.cos(handPitch)], 0.13)) };
  }
  const left = arm(leftShoulder, challenge.leftHanded, -1), right = arm(rightShoulder, !challenge.leftHanded, 1);
  return { hips, chest, head: add(chest, [0, 0.25, 0]), leftHip, rightHip, leftKnee: knee(leftHip, leftAnkle), rightKnee: knee(rightHip, rightAnkle), leftAnkle, rightAnkle, leftToe: add(leftAnkle, [0, 0, 0.16]), rightToe: add(rightAnkle, [0, 0, 0.16]), leftShoulder, rightShoulder, leftElbow: left.elbow, rightElbow: right.elbow, leftWrist: left.wrist, rightWrist: right.wrist, leftHand: left.hand, rightHand: right.hand };
}
export function motionFeatures(challenge: Challenge, controls: Controls): number[] {
  const features: number[][] = [[], [], []];
  for (const t of PHASES) {
    const a = poseAt(challenge, controls, 0, t), b = poseAt(challenge, controls, 2, t);
    features[0].push((b.hips[0] - a.hips[0]) / 0.05);
    const side = challenge.leftHanded ? "left" : "right";
    const yaw = (p: Pose) => Math.asin(clamp((p[`${side}Elbow`][0] - p[`${side}Shoulder`][0]) / 0.29, -1, 1)) * (challenge.leftHanded ? -1 : 1);
    features[1].push((yaw(b) - yaw(a)) / 0.09);
    const handAngle = (p: Pose) => { const d = sub(p[`${side}Hand`], p[`${side}Wrist`]); return Math.atan2(d[1], d[2]); };
    features[2].push((handAngle(b) - handAngle(a)) / 0.11);
  }
  return features.flat();
}
export function scoresFromFeatures(features: number[]): number[] {
  return AREAS.map((_, i) => clamp(100 - Math.hypot(...features.slice(i * 3, i * 3 + 3)) / Math.sqrt(3) * 28, 0, 100));
}
export const measure = (challenge: Challenge, controls: Controls) => scoresFromFeatures(motionFeatures(challenge, controls));
// These equivalent grid scores avoid constructing poses during the bounded search
function gridScores(challenge: Challenge, controls: Controls) {
  const q = residuals(challenge, controls);
  return q.map((value, i) => {
    const weights = PHASES.map(t => i === 2 ? 0.55 + 0.45 * smooth(0, 1, (t - 0.45) / 0.35) : 0.72 + 0.28 * Math.sin(Math.PI * t));
    return clamp(100 - Math.abs(value) * (challenge.samples[2] - challenge.samples[0]) / 2 * Math.hypot(...weights) / Math.sqrt(3) * 28, 0, 100);
  });
}
export const stable = (scores: number[]) => scores.every(n => n >= 80 - 1e-8);
export const steadyScore = (score: number) => stable([score]);
export const formatStability = (score: number) => !steadyScore(score) && score.toFixed(1) === "80.0" ? "<80" : score.toFixed(1);
export function minimumAdjustments(challenge: Challenge): number {
  let best = Infinity;
  for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) for (let c = -4; c <= 4; c++) {
    const controls: Controls = [a, b, c];
    const distance = controls.reduce((n, v, i) => n + Math.abs(v - challenge.start[i]), 0);
    if (distance < best && stable(gridScores(challenge, controls))) best = distance;
  }
  return best;
}
const challengeCache = new Map<string, Challenge>();
export function challengeFromSeed(seed: number, round: number): Challenge {
  const tier = tierFor(round), key = `${seed}:${tier}`;
  const cached = challengeCache.get(key); if (cached) return cached;
  let rng = seed;
  const random = () => { let n; [rng, n] = randomStep(rng); return n; };
  const target = AREAS.map(() => Math.floor(random() * 3) - 1) as Controls;
  const matrix = AREAS.map((_, i) => AREAS.map((__, j) => i === j ? 1 : (random() < 0.5 ? -1 : 1) * (tier === 1 ? 0.09 : tier === 2 ? 0.22 : 0.34)));
  const order = Math.floor(random() * 3), start = [...target] as Controls;
  for (let n = 0; n < tier; n++) { const i = (order + n) % 3; start[i] = clamp(start[i] + (random() < 0.5 ? -1 : 1) * (n === 0 ? 2 + Math.floor(random() * 2) : 1 + Math.floor(random() * 2)), -4, 4); }
  const leftHanded = random() < 0.35;
  const samples: [number, number, number] = [-.9 - random() * .2, -.1 + random() * .2, .9 + random() * .2];
  const challenge: Challenge = { seed, tier, target, start, matrix, samples, leftHanded, minimum: 0, id: JSON.stringify([target, start, matrix, samples, leftHanded]) };
  challenge.minimum = minimumAdjustments(challenge);
  if (challengeCache.size >= 64) challengeCache.delete(challengeCache.keys().next().value!);
  challengeCache.set(key, challenge); return challenge;
}
export function chooseChallenge(seed: number, round: number, recentIds: string[] = []) {
  for (let tries = 0; tries < 256; tries++) {
    let candidate; [seed, candidate] = randomStep(seed);
    const challenge = challengeFromSeed(Math.floor(candidate * 4294967296), round);
    const unstableAreas = measure(challenge, challenge.start).filter(value => !stable([value])).length;
    if (challenge.minimum >= 2 && challenge.minimum <= 8 && unstableAreas === tierFor(round) && !recentIds.includes(challenge.id)) return { challenge, seed };
  }
  throw new Error("Could not prepare a fresh challenge");
}
export function solution(challenge: Challenge): Controls {
  let result = challenge.target, best = Infinity;
  for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) for (let c = -4; c <= 4; c++) {
    const point: Controls = [a, b, c]; const d = point.reduce((n, v, i) => n + Math.abs(v - challenge.start[i]), 0);
    if (d < best && stable(measure(challenge, point))) { best = d; result = point; }
  }
  return result;
}
