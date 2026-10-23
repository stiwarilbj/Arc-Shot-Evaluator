import assert from "node:assert/strict";
import { spacingGateContains, spacingGateMet } from "../frontend/src/features/playbook/spacingGates.ts";
import { validatePlaybookDocument } from "../frontend/src/features/playbook/documentValidation.ts";
import { createBranchFromAction, flattenPlaybookPath, resolvePlaybookPath } from "../frontend/src/features/playbook/playbookBranches.ts";
import { upgradeHostedLibrary, validateHostedLibrary, verifyHostedLibrary } from "../frontend/src/features/playbook/hostedLibrary.ts";
import { playbookContentKey } from "../frontend/src/features/playbook/playbookDraftSession.ts";
import { normalizePlaybookPrecision } from "../frontend/src/features/playbook/documentPrecision.ts";
import { advanceSimulationRun, createSimulationRun, SIMULATION_STEP_MS } from "../frontend/src/features/playbook/simulation.ts";
import { captureSimulationSession, restoreSimulationSession, seekSimulationSession } from "../frontend/src/features/playbook/simulationSession.ts";
import { DEFAULT_SIMULATION_SETTINGS } from "../frontend/src/features/playbook/types.ts";

const movement = { id: "move-one", kind: "movement", actor_id: 1, sequence: 1,
  start: { x: 50, y: 70 }, end: { x: 65, y: 70 }, timing: 1.2, path: "straight" };
const base = { version: 1, id: "spacing-test", name: "Spacing test", defenders_visible: false,
  players: [{ id: 1, x: 50, y: 70 }], defenders: [], ball: { x: 50, y: 70 }, arrows: [movement] };
const settings = { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: "scripted", offenseOffBall: "off",
  automaticActions: { screen: false, handoff: false, pickRoll: false, offBallScreen: false } };
const gate = (overrides = {}) => ({ id: "gate-one", playerId: 1,
  area: { shape: "circle", center: { x: 50, y: 70 }, radiusFeet: 3 }, rule: "inside",
  trigger: { actionId: "move-one", event: "start" }, beforeSeconds: 0, afterSeconds: 0,
  scope: "shared", ...overrides });
const drawing = (...gates) => ({ ...structuredClone(base), spacingGates: { version: 1, gates } });

// Geometry is measured in physical feet; the boundary is inside, so outside
// only becomes true after the center has cleared the complete shape.
const circle = gate({ area: { shape: "circle", center: { x: 50, y: 50 }, radiusFeet: 3 } });
assert.equal(spacingGateContains(circle, { x: 56, y: 50 }), true, "circle boundary is included");
assert.equal(spacingGateContains(circle, { x: 56.001, y: 50 }), false, "a center beyond the circle clears it");
assert.equal(spacingGateMet({ ...circle, rule: "outside" }, { x: 56, y: 50 }), false, "outside rejects the exact boundary");
assert.equal(spacingGateMet({ ...circle, rule: "outside" }, { x: 56.001, y: 50 }), true);
const rectangle = gate({ area: { shape: "rectangle", center: { x: 50, y: 50 }, widthFeet: 6, heightFeet: 8 } });
assert.equal(spacingGateContains(rectangle, { x: 56, y: 50 + 4 / 0.47 }), true, "rectangle corner boundary is included");
assert.equal(spacingGateContains(rectangle, { x: 56.001, y: 50 }), false);

// A quiet outside window is met at its end, while any violation within a hold
// window wins immediately and preserves the first fixed-step evidence.
const metRun = createSimulationRun(drawing(gate({ area: { shape: "circle", center: { x: 20, y: 20 }, radiusFeet: 1 },
  rule: "outside", afterSeconds: 0.2 })), settings, undefined, { seed: 11 });
while (metRun.elapsedMs < 250) advanceSimulationRun(metRun, SIMULATION_STEP_MS, settings);
const met = metRun.frame.spacingGateResults[0];
assert.equal(met.status, "met");
assert.equal(met.triggerAtMs, 0, "start milestone uses the engine's action-start timestamp");
assert.equal(met.checkedAtMs, 200, "hold window is checked through its authored end");

const missedRun = createSimulationRun(drawing(gate({ area: { shape: "circle", center: { x: 50, y: 70 }, radiusFeet: 0.5 }, afterSeconds: 0.5 })), settings, undefined, { seed: 11 });
while (missedRun.elapsedMs < 300) advanceSimulationRun(missedRun, SIMULATION_STEP_MS, settings);
const missed = missedRun.frame.spacingGateResults[0];
assert.equal(missed.status, "missed", "a later loss of the target fails the full hold window");
assert.equal(missed.triggerAtMs, 0);
assert.ok(missed.firstViolationAtMs > 0 && missed.firstViolationAtMs <= 500);
assert.ok(missed.actualPoint.x > 50);
assert.equal(spacingGateMet(missedRun.source.spacingGates.gates[0], missed.actualPoint), false);

// Completion and route-point gates use executed timestamps/progress, including
// the curved authored route's physical-distance metric.
const completeGate = gate({ trigger: { actionId: "move-one", event: "complete" }, area: { shape: "circle", center: { x: 65, y: 70 }, radiusFeet: 0.5 }, beforeSeconds: 0.5 });
const completeRun = createSimulationRun(drawing(completeGate), settings, undefined, { seed: 11 });
while (completeRun.elapsedMs < completeRun.durationMs - 1e-6) advanceSimulationRun(completeRun, SIMULATION_STEP_MS, settings);
const completed = completeRun.frame.spacingGateResults[0];
assert.equal(completeRun.frame.execution.find((item) => item.actionId === "move-one").phase, "completed");
assert.equal(completed.status, "missed", "the pre-checkpoint hold is evaluated before action completion");
assert.ok(completed.firstViolationAtMs < completed.triggerAtMs);

const routeGate = gate({ trigger: { actionId: "move-one", event: "route-point", routePlayerId: 1,
  routePhase: "main", routeSegment: 7, progress: 0.35 }, rule: "outside",
  area: { shape: "circle", center: { x: 20, y: 20 }, radiusFeet: 1 } });
const routeRun = createSimulationRun(drawing(routeGate), settings, undefined, { seed: 11 });
while (routeRun.elapsedMs < 800 && routeRun.frame.spacingGateResults[0].status === "pending") advanceSimulationRun(routeRun, SIMULATION_STEP_MS, settings);
assert.ok(routeRun.frame.spacingGateResults[0].triggerAtMs > 0, "route point fires from recorded authored-route progress");
assert.equal(routeRun.frame.spacingGateResults[0].status, "met");

// Gate observation must never affect movement, ball possession, defense,
// action outcomes, or the shot evaluation.
const withGates = createSimulationRun(drawing(gate({ rule: "outside", area: { shape: "circle", center: { x: 20, y: 20 }, radiusFeet: 1 }, afterSeconds: 0.2 })), settings, undefined, { seed: 71 });
const withoutGates = createSimulationRun(structuredClone(base), settings, undefined, { seed: 71 });
while (withGates.elapsedMs < withGates.durationMs - 1e-6) {
  advanceSimulationRun(withGates, SIMULATION_STEP_MS, settings);
  advanceSimulationRun(withoutGates, SIMULATION_STEP_MS, settings);
  assert.deepEqual(withGates.players, withoutGates.players, "gate checks do not alter offense movement");
  assert.deepEqual(withGates.defenders, withoutGates.defenders, "gate checks do not alter defensive movement");
  assert.deepEqual(withGates.ballState, withoutGates.ballState, "gate checks do not alter possession or the ball path");
  assert.equal(withGates.frame.shotQuality, withoutGates.frame.shotQuality, "gate checks do not affect shot quality");
  assert.deepEqual(withGates.frame.execution, withoutGates.frame.execution, "gate checks do not alter action outcomes");
}

// Session checkpoint restoration and seek reproduce the same transient result.
const recorded = createSimulationRun(drawing(gate({ area: { shape: "circle", center: { x: 50, y: 70 }, radiusFeet: 0.5 }, afterSeconds: 0.5 })), settings, undefined,
  { seed: 91, recordSession: true });
while (recorded.elapsedMs < 700) advanceSimulationRun(recorded, SIMULATION_STEP_MS, settings);
const at700 = structuredClone(recorded.frame.spacingGateResults);
const session = captureSimulationSession(recorded);
const restored = restoreSimulationSession(session);
assert.deepEqual(restored.frame.spacingGateResults, at700, "restored checkpoint retains gate evaluation");
seekSimulationSession(restored, 100);
seekSimulationSession(restored, 700);
assert.deepEqual(restored.frame.spacingGateResults, at700, "seek and replay reconstruct the same gate evidence");

// Persistence validation keeps branch scopes explicit and excludes gate
// metadata from flattened executable inputs.
const persisted = drawing(gate());
persisted.arrows.push({ ...structuredClone(movement), id: "move-two", sequence: 2, start: { x: 65, y: 70 }, end: { x: 75, y: 70 } });
const branch = createBranchFromAction(persisted, "move-two", 1);
persisted.branches = [branch];
const branchGate = gate({ id: "gate-ending", scope: "ending", branchId: branch.id,
  trigger: { actionId: "move-two", event: "complete" } });
persisted.spacingGates.gates.push(branchGate);
validatePlaybookDocument(persisted);
assert.deepEqual(resolvePlaybookPath(persisted, null).play.spacingGates.gates.map((item) => item.id), ["gate-one"]);
assert.deepEqual(resolvePlaybookPath(persisted, branch.id).play.spacingGates.gates.map((item) => item.id), ["gate-one", "gate-ending"]);
assert.equal(flattenPlaybookPath(persisted, branch.id).spacingGates, undefined, "Counter Lab and lesson snapshots receive no gate metadata");
assert.notEqual(playbookContentKey(persisted), playbookContentKey({ ...structuredClone(persisted), spacingGates: { version: 1, gates: [] } }),
  "dirty-state comparison includes the spacing-gate extension");
const precise = structuredClone(persisted);
precise.spacingGates.gates[0].area.radiusFeet = 3.127;
const normalized = normalizePlaybookPrecision(precise);
assert.equal(normalized.spacingGates.gates[0].area.radiusFeet, 3.13, "gate measurements follow the cross-target save precision policy");
assert.equal(precise.spacingGates.gates[0].area.radiusFeet, 3.127, "normalization does not mutate the live document");
const saved = { ...structuredClone(persisted), id: `play-${"a".repeat(32)}`, created_at: "2026-10-22T12:00:00Z", updated_at: "2026-10-22T12:00:00Z" };
const upgraded = await upgradeHostedLibrary({ version: 1, plays: [saved], creations: [] });
assert.equal(upgraded.version, 7, "spacing-gate documents upgrade the hosted library to envelope 7");
assert.equal(validateHostedLibrary(upgraded).version, 7);
await verifyHostedLibrary(upgraded);
assert.deepEqual(upgraded.plays[0].spacingGates, saved.spacingGates, "versioned library migration retains both shared and ending gates");
for (const bad of [
  { ...gate(), area: { shape: "circle", center: { x: 0, y: 0 }, radiusFeet: 3 } },
  { ...gate(), beforeSeconds: 0.15 },
  { ...gate(), playerId: 99 },
  { ...gate(), trigger: { actionId: "missing-action", event: "start" } },
  { ...gate(), trigger: { actionId: "move-one", event: "catch" } },
]) assert.throws(() => validatePlaybookDocument(drawing(bad)), undefined, "malformed gate is rejected at the persistence boundary");
assert.throws(() => validatePlaybookDocument(drawing(...Array.from({ length: 31 }, (_, index) => gate({ id: `gate-${index}` })))), /30 entries/);

console.log("Spacing gates pass geometry, fixed-step evaluation, hold-window, replay, branch, and no-simulation-effect checks");
