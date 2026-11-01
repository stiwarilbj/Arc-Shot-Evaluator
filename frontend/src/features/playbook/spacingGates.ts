import type { SpacingGate, SpacingGateResult } from "./types.ts";

const EPSILON = 1e-7;

export function spacingGatePointFeet(point: { x: number; y: number }) {
  return { x: point.x * 0.5, y: point.y * 0.47 };
}

export function spacingGateContains(gate: SpacingGate, point: { x: number; y: number }) {
  const center = spacingGatePointFeet(gate.area.center), player = spacingGatePointFeet(point);
  if (gate.area.shape === "circle") return Math.hypot(player.x - center.x, player.y - center.y) <= gate.area.radiusFeet + EPSILON;
  return Math.abs(player.x - center.x) <= gate.area.widthFeet / 2 + EPSILON
    && Math.abs(player.y - center.y) <= gate.area.heightFeet / 2 + EPSILON;
}

export function newSpacingGateResult(gateId: string): SpacingGateResult {
  return { gateId, status: "pending", triggerAtMs: null, checkedAtMs: null, firstViolationAtMs: null, actualPoint: null, reason: null };
}

export function spacingGateMet(gate: SpacingGate, point: { x: number; y: number }) {
  const inside = spacingGateContains(gate, point);
  return gate.rule === "inside" ? inside : !inside;
}

export function copySpacingGateResult(result: SpacingGateResult): SpacingGateResult {
  return { ...result, actualPoint: result.actualPoint ? { ...result.actualPoint } : null };
}
