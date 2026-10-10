/** Positions and velocities in this module are measured in court feet. */
export type MotionPoint = { x: number; y: number };
export type MotionIntent = {
  key: string; point: MotionPoint; velocity: MotionPoint; previousVelocity: MotionPoint;
  speed: number; acceleration: number; priority: number; frozen?: boolean;
  corridor?: { point: MotionPoint; radius: number };
};
export const PLAYER_BODY_RADIUS_FEET = 1;
export const PLAYER_PREFERRED_GAP_FEET = 2.2;
const BODY_GAP = PLAYER_BODY_RADIUS_FEET * 2;
const norm = (p: MotionPoint) => Math.hypot(p.x, p.y);
const dot = (a: MotionPoint, b: MotionPoint) => a.x * b.x + a.y * b.y;
function limit(p: MotionPoint, maximum: number): MotionPoint {
  const length = norm(p), scale = length > maximum && length ? maximum / length : 1;
  return { x: p.x * scale, y: p.y * scale };
}

/** Reciprocal steering followed by swept, joint body constraints. No position snaps. */
export function coordinateMovement(intents: MotionIntent[], dt: number, bounds: { left: number; right: number; top: number; bottom: number }) {
  if (dt <= 0) return intents.map((i) => ({ point: { ...i.point }, velocity: { ...i.previousVelocity } }));
  const order = intents.map((intent, index) => ({ intent, index })).sort((a, b) => a.intent.key.localeCompare(b.intent.key));
  const desired = intents.map((i) => i.frozen ? { x: 0, y: 0 } : { ...i.velocity });
  for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) {
    const ai = order[a].index, bi = order[b].index, A = intents[ai], B = intents[bi];
    const r = { x: B.point.x - A.point.x, y: B.point.y - A.point.y }, distance = norm(r);
    const n = distance > 1e-6 ? { x: r.x / distance, y: r.y / distance } : { x: 1, y: 0 };
    const relative = { x: desired[ai].x - desired[bi].x, y: desired[ai].y - desired[bi].y };
    const closing = dot(relative, n);
    const horizon = Math.min(.4, Math.max(0, closing > 0 ? (distance - BODY_GAP) / closing : .4));
    const predicted = norm({ x: r.x - relative.x * horizon, y: r.y - relative.y * horizon });
    if (distance > 7 || (predicted >= PLAYER_PREFERRED_GAP_FEET && distance >= PLAYER_PREFERRED_GAP_FEET)) continue;
    const aWeight = A.frozen || A.priority >= 5 ? 0 : 1 / A.priority, bWeight = B.frozen || B.priority >= 5 ? 0 : 1 / B.priority;
    const sum = aWeight + bWeight; if (!sum) continue;
    // A stable side choice prevents reciprocal left/right oscillation.
    const tangent = { x: -n.y, y: n.x };
    const pressure = Math.max(0, BODY_GAP + .05 - distance) * 3;
    const side = closing > .5 && distance > BODY_GAP ? Math.min(4, closing * .45) : 0;
    const push = { x: -n.x * pressure + tangent.x * side, y: -n.y * pressure + tangent.y * side };
    desired[ai].x += push.x * aWeight / sum; desired[ai].y += push.y * aWeight / sum;
    desired[bi].x -= push.x * bWeight / sum; desired[bi].y -= push.y * bWeight / sum;
  }
  const velocities = desired.map((v, i) => {
    const intent = intents[i]; if (intent.frozen) return { x: 0, y: 0 };
    const change = limit({ x: v.x - intent.previousVelocity.x, y: v.y - intent.previousVelocity.y }, intent.acceleration * dt);
    return limit({ x: intent.previousVelocity.x + change.x, y: intent.previousVelocity.y + change.y }, intent.speed);
  });
  for (let pass = 0; pass < 16; pass++) {
    for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) {
      const ai = order[a].index, bi = order[b].index, A = intents[ai], B = intents[bi];
      const r = { x: B.point.x - A.point.x, y: B.point.y - A.point.y }, distance = norm(r);
      if (distance > BODY_GAP + (A.speed + B.speed) * dt) continue;
      const n = distance > 1e-6 ? { x: r.x / distance, y: r.y / distance } : { x: 1, y: 0 };
      const relative = { x: velocities[ai].x - velocities[bi].x, y: velocities[ai].y - velocities[bi].y };
      // For initial overlap, separate gently; otherwise this plane guarantees
      // clearance throughout the entire step, including crossing trajectories.
      const separatingSpeed = Math.max(0, -dot({ x: A.previousVelocity.x - B.previousVelocity.x, y: A.previousVelocity.y - B.previousVelocity.y }, n));
      const allowance = distance >= BODY_GAP ? (distance - BODY_GAP) / dt
        : -Math.min(2, (BODY_GAP - distance) * 3, separatingSpeed + (A.acceleration + B.acceleration) * dt * .5);
      const violation = dot(relative, n) - allowance;
      if (violation <= 1e-8) continue;
      const aw = A.frozen ? 0 : 1 / A.priority, bw = B.frozen ? 0 : 1 / B.priority, sum = aw + bw;
      if (!sum) continue;
      velocities[ai].x -= n.x * violation * aw / sum; velocities[ai].y -= n.y * violation * aw / sum;
      velocities[bi].x += n.x * violation * bw / sum; velocities[bi].y += n.y * violation * bw / sum;
    }
    velocities.forEach((v, i) => {
      const intent = intents[i], bounded = limit(v, intent.frozen ? 0 : intent.speed);
      v.x = Math.max(Math.min(0, (bounds.left - intent.point.x) / dt), Math.min(Math.max(0, (bounds.right - intent.point.x) / dt), bounded.x));
      v.y = Math.max(Math.min(0, (bounds.top - intent.point.y) / dt), Math.min(Math.max(0, (bounds.bottom - intent.point.y) / dt), bounded.y));
      if (intent.corridor) {
        const next = { x: intent.point.x + v.x * dt, y: intent.point.y + v.y * dt };
        const offset = { x: next.x - intent.corridor.point.x, y: next.y - intent.corridor.point.y };
        if (norm(offset) > intent.corridor.radius && norm({ x: intent.point.x - intent.corridor.point.x, y: intent.point.y - intent.corridor.point.y }) <= intent.corridor.radius) {
          const safe = limit(offset, intent.corridor.radius);
          v.x = (intent.corridor.point.x + safe.x - intent.point.x) / dt;
          v.y = (intent.corridor.point.y + safe.y - intent.point.y) / dt;
        }
      }
    });
  }
  // Numerical projection of a crowded group can leave a tiny inward residual.
  // Clip travel, never positions, so the final swept segment remains safe.
  for (let pass = 0; pass < 12; pass++) {
    for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) {
      const ai = order[a].index, bi = order[b].index;
      const dx = intents[bi].point.x - intents[ai].point.x, dy = intents[bi].point.y - intents[ai].point.y, distance = Math.hypot(dx, dy);
      if (distance < 1e-8) continue;
      const closing = ((velocities[ai].x - velocities[bi].x) * dx + (velocities[ai].y - velocities[bi].y) * dy) / Math.max(.001, distance);
      const allowed = Math.max(0, (distance - BODY_GAP) / dt);
      if (closing <= allowed + 1e-6) continue;
      const scale = Math.max(0, allowed / closing);
      velocities[ai].x *= scale; velocities[ai].y *= scale;
      velocities[bi].x *= scale; velocities[bi].y *= scale;
    }
  }
  return velocities.map((velocity, i) => ({ velocity, point: { x: intents[i].point.x + velocity.x * dt, y: intents[i].point.y + velocity.y * dt } }));
}

/** Bounded linear interpolation cannot overshoot an executed route segment. */
export function interpolatePosition<T extends MotionPoint>(a: T, b: MotionPoint | undefined, amount: number): T {
  const t = Math.max(0, Math.min(1, amount));
  return b ? { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } : { ...a };
}
