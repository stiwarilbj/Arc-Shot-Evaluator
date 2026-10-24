import assert from "node:assert/strict";
import { READY_SETUP } from "../frontend/src/features/playbook/data.ts";
import { evaluateBaitPayoffReaction, baitPayoffActionSignature, baitPayoffInteractionEndMs, milestoneTime, scriptedBaitPayoffSettings } from "../frontend/src/features/playbook/baitPayoff.ts";
import { validatePlaybookDocument } from "../frontend/src/features/playbook/documentValidation.ts";
import { flattenPlaybookPath, resolvePlaybookPath } from "../frontend/src/features/playbook/playbookBranches.ts";
import { normalizePlaybookPrecision } from "../frontend/src/features/playbook/documentPrecision.ts";
import { playbookContentKey } from "../frontend/src/features/playbook/playbookDraftSession.ts";
import { upgradeHostedLibrary, validateHostedLibrary, verifyHostedLibrary } from "../frontend/src/features/playbook/hostedLibrary.ts";
import { advanceSimulationRun, createSimulationRun, SIMULATION_STEP_MS } from "../frontend/src/features/playbook/simulation.ts";
import { DEFAULT_SIMULATION_SETTINGS } from "../frontend/src/features/playbook/types.ts";

const clone = structuredClone;
const base = {
  version: 1, id: "bait-payoff-test", name: "Bait and payoff", defenders_visible: true,
  players: [{ id: 1, x: 46, y: 72 }, { id: 2, x: 30, y: 58 }],
  defenders: [{ id: 10, x: 52, y: 61 }, { id: 11, x: 35, y: 56 }], ball: { x: 46, y: 72 },
  arrows: [
    { id: "bait-cut", kind: "backdoor-cut", actor_id: 2, sequence: 1, start: { x: 30, y: 58 }, end: { x: 46, y: 42 }, timing: 1.2 },
    { id: "payoff-pass", kind: "pass", actor_id: 1, recipient_id: 2, sequence: 2, start: { x: 46, y: 72 }, end: { x: 46, y: 42 }, timing: 1.2 },
  ],
};
const makeConnection = (play, overrides = {}) => ({
  id: "bait-connection", baitActionId: "bait-cut", payoffActionId: "payoff-pass", title: "Draw the helper",
  explanation: "The cut pulls the low defender away before the pass reaches the receiver", scope: "shared",
  baitSignature: baitPayoffActionSignature(play.arrows[0], play), payoffSignature: baitPayoffActionSignature(play.arrows[1], play),
  ...overrides,
});
const reaction = (direction, actionId = "payoff-pass", event = "start", area = { shape: "circle", center: { x: 50, y: 50 }, radiusFeet: 3 }) => ({
  defenderId: 10, direction, area, checkpoint: { actionId, event },
});
const diagnostic = (overrides = {}) => ({ actionId: "payoff-pass", sequence: 2, actorId: 1, recipientId: 2, partnerId: null,
  phase: "approach", startedAtMs: null, completedAtMs: null, progress: 0, notice: null, ...overrides });
const samples = (start, end, endExecution = diagnostic({ startedAtMs: 200 })) => [
  { atMs: 100, defenders: [{ id: 10, ...start }], execution: [diagnostic({ actionId: "bait-cut", actorId: 2, startedAtMs: 100 })] },
  { atMs: 200, defenders: [{ id: 10, ...end }], execution: [endExecution] },
];

// Recorded endpoint checks use actual execution times, exact physical boundaries,
// and never claim that the decoy caused a defensive response.
const enter = makeConnection(base, { reaction: reaction("enter") });
assert.equal(evaluateBaitPayoffReaction(enter, samples({ x: 60, y: 50 }, { x: 56, y: 50 })).status, "reaction-observed", "circle boundary is inside");
assert.equal(evaluateBaitPayoffReaction(makeConnection(base, { reaction: reaction("leave") }), samples({ x: 56, y: 50 }, { x: 60, y: 50 })).status, "reaction-observed", "leaving occurs only after clearing the boundary");
assert.equal(evaluateBaitPayoffReaction(enter, samples({ x: 56, y: 50 }, { x: 60, y: 50 })).status, "already-in-expected-position");
assert.equal(evaluateBaitPayoffReaction(enter, samples({ x: 60, y: 50 }, { x: 59, y: 50 })).status, "reaction-not-observed");
const rectangleReaction = makeConnection(base, { reaction: reaction("enter", "payoff-pass", "start", { shape: "rectangle", center: { x: 50, y: 50 }, widthFeet: 6, heightFeet: 8 }) });
assert.equal(evaluateBaitPayoffReaction(rectangleReaction, samples({ x: 58, y: 50 }, { x: 56, y: 50 })).status, "reaction-observed", "rectangle edge counts as inside");
const noDefender = samples({ x: 60, y: 50 }, { x: 56, y: 50 }); noDefender[1].defenders = [];
assert.equal(evaluateBaitPayoffReaction(enter, noDefender).status, "not-evaluated", "missing endpoint defender does not become a negative result");
assert.equal(evaluateBaitPayoffReaction(enter, samples({ x: 60, y: 50 }, { x: 56, y: 50 }, diagnostic({ startedAtMs: 90 }))).status, "not-evaluated", "a checkpoint before the bait is not evaluated");
assert.equal(evaluateBaitPayoffReaction(enter, []).status, "not-evaluated", "complete recording without bait start is not evaluated");
const routeConnection = makeConnection(base, { reaction: { ...reaction("enter", "payoff-pass", "start"), checkpoint: { actionId: "payoff-pass", event: "route-point", routePlayerId: 2, routePhase: "main", routeSegment: 0, progress: 0.5 } } });
assert.equal(milestoneTime(samples({ x: 60, y: 50 }, { x: 56, y: 50 }, diagnostic({ startedAtMs: 200, progress: 0.7 })), "payoff-pass", "route-point", 0.5, 2), 200,
  "route point is recorded only for a participant and executed progress");
assert.equal(milestoneTime(samples({ x: 60, y: 50 }, { x: 56, y: 50 }, diagnostic({ startedAtMs: 200, progress: 0.7 })), "payoff-pass", "route-point", 0.5, 99), null,
  "unrelated player proximity cannot trigger the route point");
const blockedPayoffSamples = [
  { atMs: 100, defenders: [{ id: 10, x: 60, y: 50 }], execution: [diagnostic({ actionId: "bait-cut", actorId: 2, startedAtMs: 100 })] },
  { atMs: 7020, defenders: [{ id: 10, x: 58, y: 50 }], execution: [diagnostic({ actionId: "bait-cut", actorId: 2, startedAtMs: 100, phase: "obstructed", notice: "Blocked by traffic" }), diagnostic({ startedAtMs: null, phase: "obstructed", notice: "Prerequisite did not complete" })] },
];
assert.equal(milestoneTime(blockedPayoffSamples, "payoff-pass", "start"), null, "a blocked payoff has no invented start milestone");
assert.equal(baitPayoffInteractionEndMs(blockedPayoffSamples, "payoff-pass", 7020), 7020, "failed interactions remain replayable through the recorded session end");
assert.equal(baitPayoffInteractionEndMs(samples({ x: 60, y: 50 }, { x: 56, y: 50 }, diagnostic({ startedAtMs: 200, completedAtMs: 800, phase: "completed" })), "payoff-pass", 1400), 800,
  "successful interactions stop at the actual payoff completion");

// The extension is real persisted content, remains branch-aware and is stripped
// from executable drawings used by simulations and teaching snapshots.
const play = clone(base);
play.baitPayoffs = { version: 1, connections: [enter] };
validatePlaybookDocument(play);
assert.notEqual(playbookContentKey(play), playbookContentKey({ ...play, baitPayoffs: undefined }), "connections are part of dirty-state comparison");
assert.equal(flattenPlaybookPath(play).baitPayoffs, undefined, "simulation inputs do not contain teaching links");
const precise = clone(play); precise.baitPayoffs.connections[0].reaction.area.radiusFeet = 3.127;
assert.equal(normalizePlaybookPrecision(precise).baitPayoffs.connections[0].reaction.area.radiusFeet, 3.13);
assert.equal(precise.baitPayoffs.connections[0].reaction.area.radiusFeet, 3.127, "precision normalization does not mutate the draft");

const branched = clone(base);
branched.arrows.push({ id: "shared-two", kind: "movement", actor_id: 1, sequence: 2, start: { x: 46, y: 72 }, end: { x: 58, y: 61 }, timing: 1.2 });
branched.arrows.push({ id: "main-only", kind: "movement", actor_id: 1, sequence: 3, start: { x: 58, y: 61 }, end: { x: 60, y: 50 }, timing: 1.2 });
branched.branches = [{ id: "ending-left", label: "Left read", fork: { actionIds: ["shared-two"], sequence: 2 }, continuation: [
  branched.arrows[2], { id: "payoff-left", kind: "pass", actor_id: 1, recipient_id: 2, sequence: 3, start: { x: 46, y: 72 }, end: { x: 30, y: 58 }, timing: 1.2 },
] }];
const sharedLink = makeConnection(branched, { id: "shared-link", baitActionId: "bait-cut", payoffActionId: "shared-two" });
const endingLink = makeConnection(branched, { id: "ending-link", payoffActionId: "payoff-left", scope: "ending", branchId: "ending-left",
  payoffSignature: baitPayoffActionSignature(branched.branches[0].continuation[1], branched) });
branched.baitPayoffs = { version: 1, connections: [sharedLink, endingLink] };
validatePlaybookDocument(branched);
assert.deepEqual(resolvePlaybookPath(branched, "ending-left").play.baitPayoffs.connections.map((item) => item.id), ["ending-link"],
  "a link to an action at the fork is not inherited as a shared opening link");
const invalidPath = clone(branched); invalidPath.baitPayoffs.connections[1].payoffActionId = "main-only";
assert.throws(() => validatePlaybookDocument(invalidPath), /selected path|saved path/i, "ending links cannot point to Main-only post-fork actions");
const badRoute = clone(play); badRoute.baitPayoffs.connections[0].reaction = { ...reaction("enter"), checkpoint: { actionId: "payoff-pass", event: "route-point", routePlayerId: 99, routePhase: "main", routeSegment: 0, progress: 0.5 } };
assert.throws(() => validatePlaybookDocument(badRoute), /route-point/i, "route event requires a valid court player and route");
const unsupportedRoute = clone(play); unsupportedRoute.baitPayoffs.connections[0].reaction = { ...reaction("enter"), checkpoint: { actionId: "payoff-pass", event: "route-point", routePlayerId: 2, routePhase: "release", routeSegment: 1, progress: 0.5 } };
assert.throws(() => validatePlaybookDocument(unsupportedRoute), /main route/i, "the route event shape matches the event evaluator");

// Selected defense remains intact while the teaching recording disables only
// adaptive offense, and the extension cannot change deterministic execution.
const settings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: "man-to-man", offenseMode: "adaptive" };
const scripted = scriptedBaitPayoffSettings(settings);
assert.equal(scripted.offenseMode, "scripted"); assert.equal(scripted.defenseScheme, "man-to-man");
assert.deepEqual(scripted.automaticActions, { screen: false, handoff: false, pickRoll: false, offBallScreen: false });
const plainRun = createSimulationRun(flattenPlaybookPath(play), settings, undefined, { seed: 184 });
const linkedRun = createSimulationRun(play, settings, undefined, { seed: 184 });
while (plainRun.elapsedMs < plainRun.durationMs - 1e-6) {
  advanceSimulationRun(plainRun, SIMULATION_STEP_MS, settings);
  advanceSimulationRun(linkedRun, SIMULATION_STEP_MS, settings);
  assert.deepEqual(linkedRun.players, plainRun.players);
  assert.deepEqual(linkedRun.defenders, plainRun.defenders);
  assert.deepEqual(linkedRun.ballState, plainRun.ballState);
  assert.deepEqual(linkedRun.frame.execution, plainRun.frame.execution);
  assert.equal(linkedRun.frame.shotQuality, plainRun.frame.shotQuality);
}

const hosted = await upgradeHostedLibrary(validateHostedLibrary([play]));
assert.equal(hosted.version, 9, "Bait & Payoff upgrades hosted persistence to envelope v9");
assert.deepEqual(hosted.plays[0].baitPayoffs, play.baitPayoffs);
await verifyHostedLibrary(hosted);
assert.equal(hosted.migration.source.version, 8, "version nine keeps a checksummed v8 source");

console.log("Bait & Payoff passed: milestone evidence, endpoint boundaries, unavailable and early events, route identity, branch scoping, dirty-state and precision handling, deterministic execution, and hosted v9 migration");
