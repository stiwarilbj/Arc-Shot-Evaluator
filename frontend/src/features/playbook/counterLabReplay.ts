import type { CounterLabFrame, CounterLabMessage } from "./counterLabTypes.ts";
export function advanceReplay(position: number, delta: number, speed: number, duration: number) { return Math.min(duration, position + Math.max(0, delta) * speed); }
export function matchesReplay(message: Extract<CounterLabMessage, { type: "details" }>, expected: { id: string; detailId: string; key: string; repairId: string } | null) {
  return Boolean(expected && message.id === expected.id && message.detailId === expected.detailId && message.key === expected.key && message.repairId === expected.repairId);
}
export function replayFrame(trace: CounterLabFrame[] | null, time: number): CounterLabFrame | null {
  if (!trace?.length) return null;
  let lo = 0, hi = trace.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (trace[mid].elapsedMs <= time) lo = mid; else hi = mid - 1; }
  const before = trace[lo], after = trace[Math.min(lo + 1, trace.length - 1)];
  const amount = Math.max(0, Math.min(1, (time - before.elapsedMs) / Math.max(1, after.elapsedMs - before.elapsedMs)));
  const mix = <T extends { x: number; y: number }>(a: T, b?: { x: number; y: number }): T => b ? { ...a, x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount } : a;
  return { ...before, elapsedMs: time, players: before.players.map((p) => mix(p, after.players.find((n) => n.id === p.id))), defenders: before.defenders.map((p) => mix(p, after.defenders.find((n) => n.id === p.id))), ball: before.ball && after.ball ? mix(before.ball, after.ball) : before.ball };
}
