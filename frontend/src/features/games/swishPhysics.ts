// A deterministic game approximation, independent of Playbook's tactical engine
export const SWISH_ENGINE = "swish-flight-v1";
export const STEP = 1 / 240;
export const RELEASE_HEIGHT = 2;
export const BALL_RADIUS = 0.12;
export const RIM_RADIUS = 0.2286;
export const RIM_TUBE = 0.0095;
export const MAX_FLIGHT = 4;
export const MODEL_ERROR = 0.05;
export const SPREAD = { angle: 0.15, power: 0.2, spin: 0.03 };
export const CONTROL_LIMITS = { angle: [35, 75], power: [0, 100], spin: [0, 5] } as const;
export type ShotControls = { angle: number; power: number; spin: number };
export type HoopSetup = { distance: number; height: number };
export type FlightPoint = { t: number; x: number; y: number };
export type ShotOutcome = "Swish" | "Short" | "Long" | "Front rim" | "Back rim" | "Backboard";
export type ShotFlight = { points: FlightPoint[]; outcome: ShotOutcome; duration: number };
export const speedForPower = (power: number) => 5 + power * 0.08;
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export function validControls(value: unknown): value is ShotControls {
  if (!value || typeof value !== "object") return false;
  const c = value as ShotControls;
  return (Object.keys(CONTROL_LIMITS) as (keyof ShotControls)[]).every(k => Number.isFinite(c[k]) && c[k] >= CONTROL_LIMITS[k][0] && c[k] <= CONTROL_LIMITS[k][1]);
}
export function validSetup(s: HoopSetup): boolean {
  return !!s && Number.isFinite(s.distance) && s.distance >= 3 && s.distance <= 8 && Number.isFinite(s.height) && s.height >= 2.7 && s.height <= 3.5;
}
// Linear drag and a small spin-dependent lift normal to velocity
export function acceleration(vx: number, vy: number, spin: number): [number, number] {
  return [-0.035 * vx - 0.012 * spin * vy, -9.81 - 0.035 * vy + 0.012 * spin * vx];
}
export function initialVelocity(c: ShotControls): [number, number] {
  const angle = c.angle * Math.PI / 180, speed = speedForPower(c.power);
  return [speed * Math.cos(angle), speed * Math.sin(angle)];
}
// RK4 at fixed 240 Hz, also used to generate the model's training samples
export function stepFlight(x: number, y: number, vx: number, vy: number, spin: number, dt = STEP): [number, number, number, number] {
  const a = acceleration(vx, vy, spin);
  const b = acceleration(vx + a[0] * dt / 2, vy + a[1] * dt / 2, spin);
  const c = acceleration(vx + b[0] * dt / 2, vy + b[1] * dt / 2, spin);
  const d = acceleration(vx + c[0] * dt, vy + c[1] * dt, spin);
  return [x + dt * (vx + dt * (a[0] + b[0] + c[0]) / 6), y + dt * (vy + dt * (a[1] + b[1] + c[1]) / 6), vx + dt * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6, vy + dt * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6];
}
export function segmentDistance(a: FlightPoint, b: FlightPoint, x: number, y: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const u = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(a.x + u * dx - x, a.y + u * dy - y);
}
export function segmentSeparation(a: FlightPoint, b: FlightPoint, c: FlightPoint, d: FlightPoint): number {
  const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
  const determinant = ux * vy - uy * vx;
  if (Math.abs(determinant) > 1e-12) {
    const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / determinant;
    const u = ((c.x - a.x) * uy - (c.y - a.y) * ux) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(segmentDistance(a, b, c.x, c.y), segmentDistance(a, b, d.x, d.y), segmentDistance(c, d, a.x, a.y), segmentDistance(c, d, b.x, b.y));
}
export function simulateShot(controls: ShotControls, setup: HoopSetup, collisions = true): ShotFlight {
  if (!validControls(controls) || !validSetup(setup)) throw new Error("Unsupported shot settings");
  let [vx, vy] = initialVelocity(controls), x = 0, y = RELEASE_HEIGHT;
  const points: FlightPoint[] = [{ t: 0, x, y }];
  let crossed = false;
  for (let i = 1; i <= MAX_FLIGHT / STEP; i++) {
    const before = points[points.length - 1];
    [x, y, vx, vy] = stepFlight(x, y, vx, vy, controls.spin);
    const after = { t: i * STEP, x, y };
    points.push(after);
    if (collisions) {
      for (const side of [-1, 1]) {
        if (segmentDistance(before, after, setup.distance + side * RIM_RADIUS, setup.height) <= BALL_RADIUS + RIM_TUBE)
          return { points, duration: after.t, outcome: side < 0 ? "Front rim" : "Back rim" };
      }
      const board = setup.distance + RIM_RADIUS + 0.1524;
      if (segmentSeparation(before, after, { x: board, y: setup.height - 0.15, t: 0 }, { x: board, y: setup.height + 0.9, t: 0 }) <= BALL_RADIUS)
        return { points, duration: after.t, outcome: "Backboard" };
      if (before.y >= setup.height && y < setup.height && vy < 0) {
        const u = (before.y - setup.height) / (before.y - y);
        const at = before.x + u * (x - before.x);
        crossed = Math.abs(at - setup.distance) < RIM_RADIUS - BALL_RADIUS;
      }
      // Wait until the whole ball has passed the rim plane, so rear-rim contact cannot score
      if (crossed && y < setup.height - BALL_RADIUS - RIM_TUBE)
        return { points, duration: after.t, outcome: "Swish" };
    }
    if (y <= BALL_RADIUS || x > setup.distance + 2) break;
  }
  const end = points[points.length - 1];
  return { points, duration: end.t, outcome: end.x < setup.distance ? "Short" : "Long" };
}
export function freeTrajectory(controls: ShotControls, times: number[]): FlightPoint[] {
  let [vx, vy] = initialVelocity(controls), x = 0, y = RELEASE_HEIGHT, t = 0;
  return times.map(target => {
    if (!Number.isFinite(target) || target < t || target > MAX_FLIGHT) throw new Error("Invalid sample time");
    while (t < target - 1e-10) {
      const dt = Math.min(STEP, target - t);
      [x, y, vx, vy] = stepFlight(x, y, vx, vy, controls.spin, dt);
      t += dt;
    }
    return { t: target, x, y };
  });
}
export function sampleFlight(points: FlightPoint[], time: number): FlightPoint {
  const position = clamp(time / STEP, 0, points.length - 1);
  const a = points[Math.floor(position)], b = points[Math.min(Math.floor(position) + 1, points.length - 1)], u = position % 1;
  return { t: time, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}
export function randomStep(seed: number): [number, number] {
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return [next, next / 4294967296];
}
export function varyControls(controls: ShotControls, seed: number): { controls: ShotControls; seed: number } {
  const varied = { ...controls };
  for (const key of ["angle", "power", "spin"] as const) {
    let r: number;
    [seed, r] = randomStep(seed);
    varied[key] = clamp(controls[key] + (r * 2 - 1) * SPREAD[key], CONTROL_LIMITS[key][0], CONTROL_LIMITS[key][1]);
  }
  return { controls: varied, seed };
}
export function spreadControls(c: ShotControls): ShotControls[] {
  return [-1, 1].flatMap(a => [-1, 1].flatMap(p => [-1, 1].map(s => ({
    angle: clamp(c.angle + a * SPREAD.angle, ...CONTROL_LIMITS.angle),
    power: clamp(c.power + p * SPREAD.power, ...CONTROL_LIMITS.power),
    spin: clamp(c.spin + s * SPREAD.spin, ...CONTROL_LIMITS.spin),
  }))));
}
export const ROUND_SETUPS: HoopSetup[] = [
  { distance: 4, height: 3.048 }, { distance: 3.5, height: 3.048 }, { distance: 4.5, height: 3.048 },
  { distance: 5, height: 3.048 }, { distance: 5.5, height: 2.8 }, { distance: 4, height: 3.3 },
  { distance: 6, height: 3.048 }, { distance: 6.5, height: 3.3 }, { distance: 7, height: 2.8 },
  { distance: 7.5, height: 3.048 }, { distance: 5, height: 3.5 }, { distance: 6, height: 2.7 },
];
// Bisection finds a centered descending entry; used to verify the round catalog, never to aim for the player
export function solutionFor(setup: HoopSetup): ShotControls {
  for (const angle of [55, 60, 65, 70]) {
    let lo = 0, hi = 100;
    for (let n = 0; n < 35; n++) {
      const power = (lo + hi) / 2;
      const points = freeTrajectory({ angle, power, spin: 2 }, Array.from({ length: 121 }, (_, i) => i / 30));
      let entryX = -1;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (a.y >= setup.height && b.y < setup.height) {
          entryX = a.x + (b.x - a.x) * (a.y - setup.height) / (a.y - b.y);
          break;
        }
      }
      if (entryX < setup.distance) lo = power; else hi = power;
    }
    const c = { angle, power: Math.round((lo + hi) / 2 * 10) / 10, spin: 2 };
    if ([c, ...spreadControls(c)].every(v => simulateShot(v, setup).outcome === "Swish")) return c;
  }
  throw new Error("No forgiving solution for this setup");
}
