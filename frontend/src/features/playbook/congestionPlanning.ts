import type { MotionIntent, MotionPoint } from "./coordinatedMovement.ts";

type Bounds = { left: number; right: number; top: number; bottom: number };
export type NavigationRoute = { id: string; goal: MotionPoint; points: readonly MotionPoint[]; progress: number; remaining: number };
export type CongestionDecision = {
  routeId: string; status: "yielding" | "detouring" | "blocked"; blockers: string[];
  sinceMs: number; reason: string; waypoint: MotionPoint | null;
};
type Agent = { routeId: string; progress: number; goalGap: number; progressedAtMs: number; side: number; sideUntilMs: number; yieldedAtMs: number | null };
type Passage = { owner: string; untilMs: number };
export type DestinationReservation = { owner: string; routeId: string; point: MotionPoint; untilMs: number };
export type CongestionState = {
  elapsedMs: number; nextPlanMs: number; agents: Map<string, Agent>;
  passages: Map<string, Passage>; destinations: DestinationReservation[]; decisions: Map<string, CongestionDecision>;
};
export const CONGESTION_WINDOW_MS = 450;
export const CONGESTION_YIELD_MS = 450;
export const CONGESTION_STALL_MS = 1200;
const REPLAN_MS = 100, GAP = 2.2, BODY = 2, EPS = 1e-6;
const length = (p: MotionPoint) => Math.hypot(p.x, p.y);
const distance = (a: MotionPoint, b: MotionPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const pairKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
const routeId = (i: MotionIntent) => i.navigation?.id ?? "";
export function createCongestionState(): CongestionState {
  return { elapsedMs: 0, nextPlanMs: 0, agents: new Map(), passages: new Map(), destinations: [], decisions: new Map() };
}
export function clearCongestionState(state: CongestionState) {
  state.agents.clear(); state.passages.clear(); state.destinations.length = 0; state.decisions.clear(); state.nextPlanMs = 0;
}
function segmentDistance(p: MotionPoint, a: MotionPoint, b: MotionPoint) {
  const x = b.x - a.x, y = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / Math.max(EPS, x * x + y * y)));
  return distance(p, { x: a.x + x * t, y: a.y + y * t });
}
function sweptDistance(a: MotionPoint, b: MotionPoint, nextA: MotionPoint, nextB: MotionPoint) {
  return segmentDistance({ x: 0, y: 0 }, { x: a.x - b.x, y: a.y - b.y }, { x: nextA.x - nextB.x, y: nextA.y - nextB.y });
}
function legalPoint(i: MotionIntent, p: MotionPoint, bounds: Bounds) {
  if (p.x < bounds.left - EPS || p.x > bounds.right + EPS || p.y < bounds.top - EPS || p.y > bounds.bottom + EPS) return false;
  const path = i.navigation?.points;
  if (!path?.length) return true;
  const pathGap = (point: MotionPoint) => {
    let gap = distance(point, path[0]);
    for (let n = 1; n < path.length; n++) gap = Math.min(gap, segmentDistance(point, path[n - 1], path[n]));
    return gap;
  };
  // Imported overlaps/out-of-corridor positions may return gradually; the
  // planner never enlarges the authored three-foot deviation allowance.
  return pathGap(p) <= Math.max(i.corridor?.radius ?? 3, pathGap(i.point)) + EPS;
}
function velocityToward(i: MotionIntent, point: MotionPoint, speed = i.speed): MotionPoint {
  const x = point.x - i.point.x, y = point.y - i.point.y, d = Math.hypot(x, y);
  const maximum = Math.min(speed, Math.sqrt(2 * i.acceleration * d));
  return d < .02 ? { x: 0, y: 0 } : { x: x / d * maximum, y: y / d * maximum };
}
function hasRouteTurn(i: MotionIntent) {
  const points = i.navigation?.points;
  return Boolean(points && points.some(p => segmentDistance(p, points[0], points.at(-1)!) > .1));
}
function nextRoutePoint(i: MotionIntent, position: MotionPoint) {
  const route = i.navigation!;
  let closest = Infinity, progress = route.progress, total = 0;
  const segments: Array<{ a: MotionPoint; b: MotionPoint; start: number; length: number }> = [];
  for (let n = 1; n < route.points.length; n++) {
    const a = route.points[n - 1], b = route.points[n], size = distance(a, b);
    segments.push({ a, b, start: total, length: size });
    if (total + size >= route.progress - .25 && total <= route.progress + 6) {
      const t = Math.max(0, Math.min(1, ((position.x - a.x) * (b.x - a.x) + (position.y - a.y) * (b.y - a.y)) / Math.max(EPS, size * size)));
      const gap = distance(position, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (gap < closest) { closest = gap; progress = Math.max(route.progress, total + size * t); }
    }
    total += size;
  }
  const ahead = Math.min(total, progress + 1.3 + length(i.previousVelocity) * .12);
  const segment = segments.find(s => s.start + s.length >= ahead);
  if (!segment) return route.goal;
  const t = (ahead - segment.start) / Math.max(EPS, segment.length);
  return { x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t };
}
/** Five acceleration-limited segments reserve a short space/time passage. */
function trajectory(i: MotionIntent, velocity: MotionPoint, target: MotionPoint | null, followRoute = false) {
  const points = [{ ...i.point }]; let v = { ...i.previousVelocity };
  for (let step = 1; step <= 5; step++) {
    const p = points.at(-1)!, next = followRoute && i.navigation ? nextRoutePoint(i, p) : target;
    const desired = next ? velocityToward({ ...i, point: p }, next, length(velocity)) : velocity;
    const dx = desired.x - v.x, dy = desired.y - v.y, delta = Math.hypot(dx, dy), scale = Math.min(1, i.acceleration * .09 / Math.max(EPS, delta));
    v = i.frozen ? { x: 0, y: 0 } : { x: v.x + dx * scale, y: v.y + dy * scale };
    const magnitude = length(v); if (magnitude > i.speed) v = { x: v.x * i.speed / magnitude, y: v.y * i.speed / magnitude };
    points.push({ x: p.x + v.x * .09, y: p.y + v.y * .09 });
  }
  return points;
}
function clearance(a: MotionPoint[], b: MotionPoint[]) {
  let gap = Infinity;
  for (let n = 1; n < a.length; n++) gap = Math.min(gap, sweptDistance(a[n - 1], b[n - 1], a[n], b[n]));
  return gap;
}
function nominal(i: MotionIntent) {
  const goal = i.target ?? i.navigation?.goal;
  if (i.frozen || length(i.velocity) < .02) return trajectory(i, { x: 0, y: 0 }, null);
  // Continue the intended direction, with destination braking; a single
  // already-accelerated fixed-step velocity would underestimate future traffic.
  const speed = Math.min(i.speed, Math.max(length(i.previousVelocity), 3) + i.acceleration * .225);
  const direction = length(i.velocity);
  return trajectory(i, { x: i.velocity.x / direction * speed, y: i.velocity.y / direction * speed }, goal ?? null, hasRouteTurn(i));
}

/** Reservations guide intentions only. The joint swept solver remains the
 * authority on bodies, speed, bounds and the current route corridor. */
export function planCongestion(intents: MotionIntent[], desired: MotionPoint[], dt: number, bounds: Bounds, state: CongestionState) {
  state.elapsedMs += dt * 1000;
  const now = state.elapsedMs, byKey = new Map(intents.map(i => [i.key, i]));
  let changed = false;
  const reset = new Set<string>();
  for (const [key, agent] of state.agents) if (!byKey.has(key) || routeId(byKey.get(key)!) !== agent.routeId) {
    state.agents.delete(key); state.decisions.delete(key); reset.add(key); changed = true;
  }
  if (reset.size) for (const key of state.passages.keys()) if ((JSON.parse(key) as string[]).some(id => reset.has(id))) state.passages.delete(key);
  for (const i of intents) {
    let agent = state.agents.get(i.key);
    if (!agent) {
      agent = { routeId: routeId(i), progress: i.navigation?.progress ?? 0, goalGap: i.navigation ? distance(i.point, i.navigation.goal) : 0, progressedAtMs: now, side: 0, sideUntilMs: 0, yieldedAtMs: null };
      state.agents.set(i.key, agent); changed = true;
    }
    if (i.navigation && (i.navigation.progress >= agent.progress + .12
      || distance(i.point, i.navigation.goal) <= agent.goalGap - .12
      || (i.navigation.remaining <= .65 && distance(i.point, i.navigation.goal) <= .65))) {
      agent.progress = i.navigation.progress; agent.goalGap = distance(i.point, i.navigation.goal); agent.progressedAtMs = now;
    }
  }
  if (!intents.some(i => i.navigation)) { clearCongestionState(state); return; }
  if (changed || now >= state.nextPlanMs) {
    state.nextPlanMs = now + REPLAN_MS;
    const predictions = new Map(intents.map(i => [i.key, nominal(i)]));
    const blockedBy = new Map<string, Set<string>>(), livePairs = new Set<string>();
    const block = (key: string, owner: string) => { const set = blockedBy.get(key) ?? new Set<string>(); set.add(owner); blockedBy.set(key, set); };
    const rank = (i: MotionIntent) => {
      const agent = state.agents.get(i.key);
      return (i.frozen ? 10000 : i.priority >= 8 ? 1000 : i.navigation ? 100 : 0)
        + (agent?.yieldedAtMs == null ? 0 : Math.min(80, (now - agent.yieldedAtMs) / 5));
    };
    const order = intents.slice().sort((a, b) => rank(b) - rank(a) || a.key.localeCompare(b.key));
    for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) {
      const A = order[a], B = order[b];
      if ((!A.navigation && !B.navigation) || distance(A.point, B.point) > 12) continue;
      if (!A.navigation || !B.navigation) {
        const mover = A.navigation ? A : B, obstacle = A.navigation ? B : A;
        if (!obstacle.frozen && now - state.agents.get(mover.key)!.progressedAtMs < 180) continue;
      }
      if (clearance(predictions.get(A.key)!, predictions.get(B.key)!) >= GAP) continue;
      const key = pairKey(A.key, B.key); livePairs.add(key);
      const old = state.passages.get(key);
      const owner = !A.navigation ? A.key : !B.navigation ? B.key
        : old && old.untilMs > now && byKey.has(old.owner) ? old.owner : A.key;
      if (!old || old.untilMs <= now) state.passages.set(key, { owner, untilMs: now + CONGESTION_YIELD_MS });
      block(owner === A.key ? B.key : A.key, owner);
    }
    for (const key of state.passages.keys()) if (!livePairs.has(key)) state.passages.delete(key);

    state.destinations = state.destinations.filter(r => {
      const owner = byKey.get(r.owner);
      return owner?.navigation?.id === r.routeId && distance(owner.navigation.goal, r.point) < .1
        && (r.untilMs > now || distance(owner.point, r.point) <= .8);
    });
    const arrivals = order.slice().sort((a, b) => Number(Boolean(b.frozen)) - Number(Boolean(a.frozen))
      || (a.navigation?.remaining ?? Infinity) / Math.max(1, a.speed) - (b.navigation?.remaining ?? Infinity) / Math.max(1, b.speed)
      || a.key.localeCompare(b.key));
    for (const i of arrivals) if (i.navigation && i.navigation.remaining <= Math.max(2.5, i.speed * .45)) {
      const own = state.destinations.find(r => r.owner === i.key);
      if (own) { own.untilMs = now + CONGESTION_WINDOW_MS; continue; }
      const occupied = state.destinations.find(r => r.owner !== i.key && distance(r.point, i.navigation!.goal) < BODY - .001);
      if (occupied) {
        block(i.key, occupied.owner);
        blockedBy.get(occupied.owner)?.delete(i.key);
        state.passages.set(pairKey(i.key, occupied.owner), { owner: occupied.owner, untilMs: occupied.untilMs });
      }
      else state.destinations.push({ owner: i.key, routeId: i.navigation.id, point: { ...i.navigation.goal }, untilMs: now + CONGESTION_WINDOW_MS });
    }

    // Leases acquired at different times can form a circular wait. Break the
    // cycle as a group; pairwise right-of-way alone cannot resolve that deadlock.
    for (let attempt = 0; attempt < intents.length; attempt++) {
      let cycle: string[] | null = null;
      const walk = (key: string, path: string[], done: Set<string>): void => {
        const at = path.indexOf(key);
        if (at >= 0) { cycle = path.slice(at); return; }
        if (done.has(key) || cycle) return;
        done.add(key);
        for (const next of blockedBy.get(key) ?? []) walk(next, [...path, key], done);
      };
      const done = new Set<string>(); for (const i of order) walk(i.key, [], done);
      if (!cycle) break;
      const members = cycle as string[], winner = order.find(i => members.includes(i.key))!.key;
      for (const key of members) {
        const held = blockedBy.get(key); for (const other of members) held?.delete(other);
        if (key !== winner) block(key, winner);
      }
      for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) state.passages.delete(pairKey(members[a], members[b]));
      for (const key of members) if (key !== winner) state.passages.set(pairKey(key, winner), { owner: winner, untilMs: now + CONGESTION_YIELD_MS });
    }

    const next = new Map<string, CongestionDecision>(), reserved = new Map<string, MotionPoint[]>();
    const planOrder = order.slice().sort((a, b) => Number(Boolean(blockedBy.get(a.key)?.size)) - Number(Boolean(blockedBy.get(b.key)?.size))
      || Number(state.destinations.some(r => r.owner === b.key)) - Number(state.destinations.some(r => r.owner === a.key))
      || rank(b) - rank(a) || a.key.localeCompare(b.key));
    for (const i of planOrder) {
      const agent = state.agents.get(i.key), blockers = blockedBy.get(i.key) ?? new Set<string>();
      const original = predictions.get(i.key)!;
      const conflicts = intents.filter(other => other.key !== i.key && distance(i.point, other.point) <= 12
        && (other.navigation || other.frozen || agent && now - agent.progressedAtMs >= 180)
        && clearance(original, reserved.get(other.key) ?? predictions.get(other.key)!) < GAP);
      if (i.frozen || !i.navigation || !conflicts.length && !blockers.size) {
        reserved.set(i.key, original); if (agent) agent.yieldedAtMs = null; continue;
      }
      for (const other of conflicts) blockers.add(other.key);
      const goal = i.navigation?.goal ?? i.target ?? i.point;
      const heading = hasRouteTurn(i) ? nextRoutePoint(i, i.point) : goal;
      const dx = heading.x - i.point.x, dy = heading.y - i.point.y, d = Math.max(EPS, Math.hypot(dx, dy));
      const forward = { x: dx / d, y: dy / d }, side = agent && agent.sideUntilMs > now ? agent.side : i.key.localeCompare([...blockers].sort()[0] ?? i.key) <= 0 ? 1 : -1;
      const advance = Math.min(distance(i.point, goal), 2.8);
      const choices: Array<{ point: MotionPoint | null; side: number; kind: "yielding" | "detouring" | "proceed" }> = [
        // A yielding player may continue once the owner's reserved trace is
        // clear. A lease is right-of-way, not a mandatory stop for its lifetime.
        { point: goal, side: 0, kind: "proceed" },
        ...[side, -side].flatMap(sign => [1.4, 2.7].map(offset => ({ point: { x: i.point.x + forward.x * advance - forward.y * offset * sign, y: i.point.y + forward.y * advance + forward.x * offset * sign }, side: sign, kind: "detouring" as const }))),
        ...[side, -side].map(sign => ({ point: { x: i.point.x - forward.y * 2.5 * sign, y: i.point.y + forward.x * 2.5 * sign }, side: sign, kind: "detouring" as const })),
        ...[side, -side].map(sign => ({ point: { x: i.point.x - forward.x * 1.5 - forward.y * 1.4 * sign, y: i.point.y - forward.y * 1.5 + forward.x * 1.4 * sign }, side: sign, kind: "detouring" as const })),
        { point: null, side: 0, kind: "yielding" },
      ];
      let best: { choice: typeof choices[number]; trace: MotionPoint[]; score: number } | null = null;
      for (const choice of choices) {
        const velocity = choice.point ? velocityToward(i, choice.point, Math.min(i.speed, 7)) : { x: 0, y: 0 };
        const trace = choice.kind === "proceed" ? original : trajectory(i, velocity, choice.point);
        if (trace.slice(1).some(p => !legalPoint(i, p, bounds))) continue;
        if (state.destinations.some(r => r.owner !== i.key && distance(r.point, goal) < BODY - .001
          && trace.slice(1).some(p => distance(p, r.point) < Math.min(BODY, distance(i.point, r.point)) - .015))) continue;
        let safe = true, gap = Infinity;
        for (const other of intents) if (other.key !== i.key) {
          // Unplanned lower-priority traffic must at least be able to brake.
          // This does not grant permission to pass through its current body.
          const fallback = blockedBy.get(other.key)?.size ? trajectory(other, { x: 0, y: 0 }, null) : predictions.get(other.key)!;
          const separation = clearance(trace, reserved.get(other.key) ?? fallback);
          const minimum = Math.min(BODY, distance(i.point, other.point)) - .015;
          if (separation < minimum) { safe = false; break; }
          gap = Math.min(gap, separation);
        }
        if (!safe) continue;
        const end = trace.at(-1)!, progress = distance(i.point, goal) - distance(end, goal);
        const stalledBriefly = agent && now - agent.progressedAtMs >= 350;
        const score = progress * (stalledBriefly ? 1 : 4) + Math.min(gap, GAP + 1) + (choice.kind === "yielding" ? stalledBriefly ? -5 : -.3 : 0)
          - (agent && agent.sideUntilMs > now && choice.side && choice.side !== agent.side ? 2 : 0);
        if (!best || score > best.score + EPS) best = { choice, trace, score };
      }
      const prior = state.decisions.get(i.key);
      if (best?.choice.kind === "proceed") {
        reserved.set(i.key, best.trace); if (agent) agent.yieldedAtMs = null; continue;
      }
      const stalled = i.navigation && (i.navigation.remaining > .65 || distance(i.point, i.navigation.goal) > .65) && agent && now - agent.progressedAtMs >= CONGESTION_STALL_MS;
      const status = stalled ? "blocked" : best?.choice.kind ?? "yielding";
      const waypoint = best?.choice.point ?? null;
      if (agent) {
        agent.yieldedAtMs ??= now;
        if (best?.choice.side && (agent.sideUntilMs <= now || agent.side === best.choice.side)) { agent.side = best.choice.side; agent.sideUntilMs = now + CONGESTION_WINDOW_MS; }
      }
      next.set(i.key, { routeId: routeId(i), status, blockers: [...blockers].sort(),
        sinceMs: prior?.status === status && prior.routeId === routeId(i) ? prior.sinceMs : now,
        reason: status === "blocked" ? "Route progress stalled during the bounded planning window"
          : status === "yielding" ? "Yield briefly to a reserved passage or destination" : "Use a bounded detour around reserved traffic", waypoint });
      reserved.set(i.key, best?.trace ?? trajectory(i, { x: 0, y: 0 }, null));
    }
    state.decisions = next;
  }
  intents.forEach((i, index) => {
    const decision = state.decisions.get(i.key);
    if (!decision || decision.routeId !== routeId(i) || i.frozen) return;
    const velocity = decision.waypoint ? velocityToward(i, decision.waypoint, Math.min(i.speed, 7)) : { x: 0, y: 0 };
    desired[index].x = velocity.x; desired[index].y = velocity.y;
  });
}
