import assert from "node:assert/strict";
import { buildAdvantageRelay, isValidAdvantageRelay, validateAdvantageRelay } from "../frontend/src/features/playbook/counterLabAdvantageRelay.ts";
import { diagnoseOpenings, runCounterLabTrial } from "../frontend/src/features/playbook/counterLabEngine.ts";
import { STARTER_PLAYS } from "../frontend/src/features/playbook/data.ts";
import { COUNTER_LAB_DEFAULT_PROFILES, COUNTER_LAB_EXTRA_STRATEGIES, eligibleCounterLabSchemes } from "../frontend/src/features/playbook/counterLabTypes.ts";

const players = [1, 2, 3].map((id) => ({ id, x: id * 10, y: 20 }));
const defenders = [{ id: 1, x: 50, y: 20 }];
const option = (kind, playerId, quality, score = quality) => ({ kind, playerId, quality, score, receiverGap: 5.25, laneGap: 3.5 });
const frame = (elapsedMs, opportunities = [], values = {}) => ({
  elapsedMs, sequence: values.sequence ?? null, action: values.action ?? null, ballHandlerId: values.ballHandlerId ?? 1,
  ballPhase: values.ballPhase ?? "held", assignments: [{ defenderId: 1, playerId: values.ballHandlerId ?? 1 }], opportunities,
  blockedPass: null, involvedPlayerIds: [], activeRoutes: [], players, defenders, ball: { x: 10, y: 20 },
  shotPhase: values.shotPhase ?? "idle", ...(values.execution ? { execution: values.execution } : {}),
});
const optionSet = (quality = 60, playerId = 1, kind = "drive") => [option(kind, playerId, quality), option("pass", 2, 57, 56)];
const allPlayerIds = new Set([1, 2, 3]);
const defenderIds = new Set([1]);

const noOptions = [option("drive", 1, 0), option("pass", 2, 0)];
const initial = buildAdvantageRelay([frame(0, noOptions)], [frame(0, noOptions)]);
assert.deepEqual(initial.events, []);
assert.equal(initial.status, "none");

const availableAtStart = buildAdvantageRelay([frame(0, optionSet())], [frame(0, optionSet())]);
assert.equal(availableAtStart.events[0].kind, "created");
assert.equal(availableAtStart.events[0].note, "Available at start");
assert.equal(availableAtStart.events[0].atMs, 0);

const shotWithoutLane = option("shot", 1, 62);
shotWithoutLane.laneGap = Infinity;
const shotRelay = buildAdvantageRelay([frame(0, [shotWithoutLane])], [frame(0, [shotWithoutLane])]);
assert.equal(isValidAdvantageRelay(shotRelay, allPlayerIds, defenderIds), true, "a shot preserves the engine's positive-infinity no-lane sentinel");
const invalidShot = structuredClone(shotRelay);
invalidShot.events[0].evidence.opportunities[0].laneGap = NaN;
assert.equal(isValidAdvantageRelay(invalidShot, allPlayerIds, defenderIds), false, "non-finite measured shot data is still rejected");

const exactlyThreeHundred = [frame(0, optionSet()), frame(100), frame(200), frame(300), frame(400)];
const relayAtBoundary = buildAdvantageRelay(exactlyThreeHundred, exactlyThreeHundred);
assert.equal(relayAtBoundary.events.find((event) => event.kind === "lost")?.atMs, 100);
assert.equal(diagnoseOpenings(exactlyThreeHundred).firstLostOpeningMs, 100);
const justBelowBoundary = [frame(0, optionSet()), frame(100), frame(200), frame(300), frame(399)];
assert.equal(buildAdvantageRelay(justBelowBoundary, justBelowBoundary).events.some((event) => event.kind === "lost"), false);
const briefDrop = [frame(0, optionSet()), frame(100), frame(200, optionSet())];
assert.equal(buildAdvantageRelay(briefDrop, briefDrop).events.some((event) => event.kind === "lost"), false);

const passTransit = [frame(0, optionSet()), frame(100), frame(200, [], { ballPhase: "pass-in-flight" }), frame(300), frame(400), frame(500), frame(600)];
assert.equal(buildAdvantageRelay(passTransit, passTransit).events.find((event) => event.kind === "lost")?.atMs, 300);

const reopened = [frame(0, optionSet()), frame(100), frame(200), frame(400), frame(500), frame(600, optionSet(61, 3, "shot"))];
const reopenedRelay = buildAdvantageRelay(reopened, reopened);
assert.deepEqual(reopenedRelay.events.filter((event) => event.kind === "created").map((event) => event.atMs), [0, 600]);
assert.equal(reopenedRelay.events.filter((event) => event.kind === "lost").length, 1);

const transferRecord = {
  actionKey: "pass-1:1", kind: "pass", giverId: 1, receiverId: 2,
  release: { atMs: 100, position: { x: 10, y: 20 } }, arrival: { atMs: 200, position: { x: 20, y: 20 } },
  outcome: { kind: "caught", atMs: 200, position: { x: 20, y: 20 } },
};
const action = (transfer) => ({ actionId: "pass-1", sequence: 1, actorId: 1, recipientId: 2, partnerId: null, phase: "completed", startedAtMs: 0, completedAtMs: 200, progress: 1, notice: null, ...(transfer ? { transfer } : {}) });
const setupFrames = [
  frame(0, optionSet(), { sequence: 1, action: "pass", ballHandlerId: 1, execution: [action(null)] }),
  frame(83.333333333, optionSet(), { sequence: 1, action: "pass", ballHandlerId: 1, execution: [action(null)] }),
  frame(100, [], { ballPhase: "pass-in-flight", ballHandlerId: null, execution: [action(transferRecord)] }),
  frame(200, [option("shot", 2, 70, 70), option("drive", 3, 62, 61)], { ballHandlerId: 2, execution: [action(transferRecord)] }),
  frame(233.3333333, [option("shot", 2, 70, 70)], { ballHandlerId: 2, execution: [action(transferRecord)] }),
];
const qualifiedTransfer = buildAdvantageRelay([frame(0, optionSet())], setupFrames);
const transferred = qualifiedTransfer.events.find((event) => event.kind === "transferred");
assert.ok(transferred, "a recorded eligible pass, catch, and receiver continuation should create a transferred event");
assert.equal(transferred.transfer?.releasedAtMs, 100);
assert.equal(transferred.transfer?.caughtAtMs, 200);
assert.equal(transferred.transfer?.continuationAtMs, 200);
assert.equal(transferred.transfer?.passOpportunity.quality, 57);
assert.equal(isValidAdvantageRelay(qualifiedTransfer, allPlayerIds, defenderIds), true);

const earlyTransfer = { ...transferRecord, release: { atMs: 83.3333333, position: { x: 10, y: 20 } }, arrival: { atMs: 166.6666667, position: { x: 20, y: 20 } }, outcome: { kind: "caught", atMs: 166.6666667, position: { x: 20, y: 20 } } };
const postTransferOpening = buildAdvantageRelay([
  frame(0, noOptions), frame(100, noOptions), frame(200, optionSet(60, 2, "shot")), frame(300, optionSet(60, 2, "shot")),
], [
  frame(50, optionSet(), { sequence: 1, action: "pass", execution: [action(null)] }),
  frame(83.3333333, optionSet(), { sequence: 1, action: "pass", execution: [action(earlyTransfer)] }),
  frame(166.6666667, [], { ballHandlerId: 2, ballPhase: "held", execution: [action(earlyTransfer)] }),
  frame(200, [option("shot", 2, 60)], { ballHandlerId: 2, execution: [action(earlyTransfer)] }),
]);
assert.equal(postTransferOpening.events.some((event) => event.kind === "transferred"), false, "an opening first recorded after release cannot be attributed to an earlier transfer");

const noContinuation = buildAdvantageRelay([frame(0, optionSet())], setupFrames.map((item) => item.elapsedMs >= 200
  ? frame(item.elapsedMs, [], { ballHandlerId: 2, execution: item.execution }) : item));
assert.equal(noContinuation.events.some((event) => event.kind === "transferred"), false);
assert.equal(noContinuation.supportingTransfers[0]?.outcome, "caught");
assert.equal(isValidAdvantageRelay(noContinuation, allPlayerIds, defenderIds), true);

const failedRecord = { ...transferRecord, outcome: { kind: "failed", atMs: 140, reason: "receiver did not arrive" } };
const failed = buildAdvantageRelay([frame(0, optionSet())], [
  frame(0, optionSet(), { sequence: 1, execution: [action(null)] }),
  frame(100, [], { ballPhase: "pass-in-flight", ballHandlerId: null, execution: [action(failedRecord)] }),
]);
assert.equal(failed.events.some((event) => event.kind === "transferred"), false);
assert.equal(failed.supportingTransfers[0]?.outcome, "failed");

const shotEndsLossEvaluation = [frame(0, optionSet()), frame(100), frame(150, [], { shotPhase: "air" }), frame(500)];
assert.equal(buildAdvantageRelay(shotEndsLossEvaluation, shotEndsLossEvaluation).events.some((event) => event.kind === "lost"), false);

const invalid = structuredClone(qualifiedTransfer);
invalid.events.find((event) => event.kind === "transferred").transfer.passOpportunity.quality = 0;
assert.equal(isValidAdvantageRelay(invalid, allPlayerIds, defenderIds), false);
assert.deepEqual(buildAdvantageRelay([frame(0, optionSet())], setupFrames), qualifiedTransfer, "relay ranking and ordering are deterministic");

const realTrial = runCounterLabTrial(STARTER_PLAYS[0], COUNTER_LAB_DEFAULT_PROFILES[0], "scripted");
validateAdvantageRelay(realTrial.advantageRelay, new Set(STARTER_PLAYS[0].players.map((player) => player.id)), new Set(STARTER_PLAYS[0].defenders.map((defender) => defender.id)));
assert.equal(realTrial.advantageRelay.durationMs, realTrial.trace.at(-1).elapsedMs, "real worker trial relays use the exact court replay duration");
const openingPlay = STARTER_PLAYS.find((play) => play.name === "Drive and kick");
assert.ok(openingPlay);
const profiles = [...COUNTER_LAB_DEFAULT_PROFILES, ...COUNTER_LAB_EXTRA_STRATEGIES,
  ...eligibleCounterLabSchemes(openingPlay.defenders.length || Math.min(5, openingPlay.players.length), openingPlay.players.length)];
for (const profile of profiles) {
  const trial = runCounterLabTrial(openingPlay, profile, "scripted");
  validateAdvantageRelay(trial.advantageRelay, new Set(openingPlay.players.map((player) => player.id)), new Set(openingPlay.defenders.map((defender) => defender.id)));
}

console.log(`Advantage Relay thresholds, pass transit, confirmed transfers, neutral catches, runtime validation, and real trials across ${profiles.length} defensive profiles passed`);
