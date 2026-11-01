import type { CourtPoint, PlaybookArrow, PlaybookDraft, PlaybookTimingWait } from "./types.ts";
import type { CourtRoute } from "./arrowVisibility.ts";
import { linearRoutePoint, quadraticRoutePoint } from "./routeGeometry.ts";

export const TIMING_SNAP_MS = 100;
export const TIMING_MIN_DURATION_SECONDS = 0.5;
export const TIMING_MAX_DURATION_SECONDS = 4;

export function snapTimingMs(value: number) {
  return Math.min(120_000, Math.max(0, Math.round(value / TIMING_SNAP_MS) * TIMING_SNAP_MS));
}

export function actionPrimaryPlayer(arrow: PlaybookArrow, resolvedActorId: number | null) {
  if (["off-ball-screen", "pin-down"].includes(arrow.kind)) return arrow.screener_id ?? resolvedActorId;
  return arrow.actor_id ?? arrow.screener_id ?? resolvedActorId;
}

export function actionParticipants(arrow: PlaybookArrow, actorId: number | null, recipientId: number | null, partnerId: number | null) {
  const ids = [actionPrimaryPlayer(arrow, actorId), recipientId, partnerId, arrow.cutter_id, arrow.handler_id]
    .filter((value): value is number => value != null);
  return [...new Set(ids)];
}

export function actionTimingMs(arrow: PlaybookArrow, fallbackMs: number) {
  return arrow.timingPlan?.startAtMs ?? snapTimingMs(fallbackMs);
}

export function sameSyncGroup(first: PlaybookArrow, second: PlaybookArrow) {
  return !!first.timingPlan?.syncId && first.timingPlan.syncId === second.timingPlan?.syncId;
}

export function moveTimingGroup(arrows: PlaybookArrow[], actionId: string, startAtMs: number) {
  const selected = arrows.find((arrow) => arrow.id === actionId);
  if (!selected) return arrows;
  const members = selected.timingPlan?.syncId
    ? new Set(arrows.filter((arrow) => sameSyncGroup(selected, arrow)).map((arrow) => arrow.id))
    : new Set([actionId]);
  const previousStart = selected.timingPlan?.startAtMs ?? startAtMs;
  const delta = snapTimingMs(startAtMs) - previousStart;
  return arrows.map((arrow) => members.has(arrow.id) && arrow.timingPlan
    ? { ...arrow, timingPlan: { ...arrow.timingPlan, startAtMs: snapTimingMs(arrow.timingPlan.startAtMs + delta) } }
    : arrow);
}

/** Shift only downstream actions that share an execution participant or the
 * same ball-transfer chain. Independent lanes keep their authored start. */
export function shiftConnectedTiming(arrows: PlaybookArrow[], bindings: Array<{ arrow: PlaybookArrow; sequence: number; actorId: number | null; recipientId: number | null; partnerId?: number | null }>, actionId: string | string[], deltaMs: number) {
  if (!deltaMs) return arrows;
  const bindingById = new Map(bindings.map((binding) => [binding.arrow.id, binding]));
  const ordered = arrows.map((arrow, index) => ({ arrow, index, sequence: arrow.sequence ?? index + 1 }))
    .sort((a, b) => a.sequence - b.sequence || a.index - b.index);
  const seeds = new Set(Array.isArray(actionId) ? actionId : [actionId]);
  if (![...seeds].some((id) => ordered.some((entry) => entry.arrow.id === id))) return arrows;
  const affected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of ordered) {
      if (affected.has(candidate.arrow.id)) continue;
      const candidateBinding = bindingById.get(candidate.arrow.id);
      const candidatePeople = new Set(actionParticipants(candidate.arrow, candidateBinding?.actorId ?? null, candidateBinding?.recipientId ?? null, candidateBinding?.partnerId ?? null));
      const connected = ordered.some((prior) => affected.has(prior.arrow.id) && (
        candidate.arrow.timingPlan?.waits?.some((wait) => wait.actionId === prior.arrow.id)
        || candidate.arrow.timingPlan?.syncId !== undefined && candidate.arrow.timingPlan.syncId === prior.arrow.timingPlan?.syncId
        || prior.sequence < candidate.sequence && (() => {
        const priorBinding = bindingById.get(prior.arrow.id);
        const priorPeople = actionParticipants(prior.arrow, priorBinding?.actorId ?? null, priorBinding?.recipientId ?? null, priorBinding?.partnerId ?? null);
        return priorPeople.some((id) => candidatePeople.has(id))
          || (prior.arrow.kind === "pass" || prior.arrow.kind === "handoff") && (candidate.arrow.kind === "pass" || candidate.arrow.kind === "handoff");
        })()));
      if (connected) { affected.add(candidate.arrow.id); changed = true; }
    }
  }
  return arrows.map((arrow) => affected.has(arrow.id) && arrow.id !== actionId && arrow.timingPlan
    ? { ...arrow, timingPlan: { ...arrow.timingPlan, startAtMs: snapTimingMs(arrow.timingPlan.startAtMs + deltaMs) } }
    : arrow);
}

export function resizeActionMinimum(arrow: PlaybookArrow, seconds: number): PlaybookArrow {
  const bounded = Math.max(TIMING_MIN_DURATION_SECONDS, Math.min(TIMING_MAX_DURATION_SECONDS, seconds));
  return { ...arrow, timing: Math.round(bounded * 100) / 100 };
}

export function waitLabel(wait: PlaybookTimingWait, source?: PlaybookArrow) {
  const sourceName = source ? `Move ${source.sequence ?? "?"}` : "Missing action";
  switch (wait.event) {
    case "start": return `when ${sourceName} starts`;
    case "complete": return `when ${sourceName} finishes`;
    case "catch": return `when ${sourceName} is caught`;
    case "screen-set": return `when ${sourceName} is set`;
    case "screen-use": return `when ${sourceName} is used`;
    case "route-point": return `when Player ${wait.playerId ?? "?"} reaches ${Math.round((wait.progress ?? 0) * 100)}% of ${sourceName}`;
  }
}

/** Nearest point and normalized distance along a polyline, used for court-picked waits */
export function projectPointToRoute(point: CourtPoint, route: CourtPoint[], scale = { x: 1, y: 1 }) {
  if (!route.length) return { progress: 0, segment: 0, point, distance: Infinity };
  const metric = (value: CourtPoint) => ({ x: value.x * scale.x, y: value.y * scale.y });
  const metricRoute = route.map(metric), metricPoint = metric(point);
  const lengths = [0];
  for (let i = 1; i < metricRoute.length; i++) lengths.push(lengths[i - 1] + Math.hypot(metricRoute[i].x - metricRoute[i - 1].x, metricRoute[i].y - metricRoute[i - 1].y));
  const total = lengths.at(-1) ?? 0;
  let best = { gap: Infinity, progress: 0, segment: 0, point: route[0] };
  for (let i = 1; i < route.length; i++) {
    const a = metricRoute[i - 1], b = metricRoute[i], dx = b.x - a.x, dy = b.y - a.y;
    const amount = dx * dx + dy * dy
      ? Math.max(0, Math.min(1, ((metricPoint.x - a.x) * dx + (metricPoint.y - a.y) * dy) / (dx * dx + dy * dy)))
      : 0;
    const candidate = { x: route[i - 1].x + (route[i].x - route[i - 1].x) * amount, y: route[i - 1].y + (route[i].y - route[i - 1].y) * amount };
    const gap = Math.hypot(metricPoint.x - (candidate.x * scale.x), metricPoint.y - (candidate.y * scale.y));
    if (gap < best.gap) best = { gap, point: candidate, segment: i - 1, progress: total ? (lengths[i - 1] + (lengths[i] - lengths[i - 1]) * amount) / total : 0 };
  }
  return { progress: best.progress, segment: best.segment, point: best.point, distance: best.gap };
}

/** Sample the same authored curve and screen segments shown by the court renderer */
export function sampleAuthoredCourtRoute(route: CourtRoute, samplesPerSegment = 20): CourtPoint[] {
  if (route.points?.length) return route.points.map((point) => ({ ...point }));
  if (route.via) return [
    ...Array.from({ length: samplesPerSegment }, (_, index) => linearRoutePoint(route.start, route.via!, index / samplesPerSegment)),
    ...Array.from({ length: samplesPerSegment + 1 }, (_, index) => linearRoutePoint(route.via!, route.end, index / samplesPerSegment)),
  ];
  if (route.control) return Array.from({ length: samplesPerSegment + 1 }, (_, index) => quadraticRoutePoint(route.start, route.end, route.control!, index / samplesPerSegment));
  return Array.from({ length: samplesPerSegment + 1 }, (_, index) => linearRoutePoint(route.start, route.end, index / samplesPerSegment));
}

export function hasTimingPlan(play: PlaybookDraft) {
  return play.arrows.some((arrow) => arrow.timingPlan !== undefined);
}

export function timingActions(play: PlaybookDraft) {
  return play.arrows.map((arrow, index) => ({ arrow, index, startAtMs: actionTimingMs(arrow, index * 1200) }))
    .sort((a, b) => a.startAtMs - b.startAtMs || (a.arrow.sequence ?? a.index + 1) - (b.arrow.sequence ?? b.index + 1) || a.index - b.index);
}
