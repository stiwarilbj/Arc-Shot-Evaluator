import assert from 'node:assert/strict';
import { analyzeCounterLab, runCounterLabTrial } from '../frontend/src/features/playbook/counterLabEngine.ts';
import { COUNTER_LAB_DEFAULT_PROFILES, createCounterLabRepairs, eligibleCounterLabSchemes } from '../frontend/src/features/playbook/counterLabTypes.ts';
import { createSimulationRun } from '../frontend/src/features/playbook/simulation.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';

const switchSlipFixture = {
  id: 'switch-slip-fixture',
  version: 1,
  name: 'Switch slip fixture',
  defenders_visible: false,
  players: [
    { id: 1, x: 25.78064717890755, y: 77.00569651835197 },
    { id: 2, x: 21.60192465372563, y: 73.89039527148977 },
    { id: 3, x: 43.18731441831898, y: 44.00693493243953 },
    { id: 4, x: 23.89531681490626, y: 38.949288396117545 },
    { id: 5, x: 69.31848664518304, y: 45.84292722199385 },
  ],
  defenders: [],
  ball: { x: 25.78064717890755, y: 77.00569651835197 },
  arrows: [{
    id: 'screen-one', kind: 'screen', sequence: 1, path: 'straight', timing: 3.55377678252177,
    start: { x: 21.60192465372563, y: 73.89039527148977 },
    end: { x: 16.111013396746493, y: 65.19622205588615 },
    screener_id: 2, handler_id: 1,
  }],
};
const switchProfile = COUNTER_LAB_DEFAULT_PROFILES.find((profile) => profile.id === 'switch');
assert.ok(switchProfile, 'the default test set includes a switch defense');

const original = structuredClone(switchSlipFixture);
const slip = createCounterLabRepairs(switchSlipFixture).find((repair) => repair.id === 'slip-screen-one');
assert.ok(slip, 'screen actions create a bounded slip-screen repair candidate');
assert.equal(slip.play.arrows[0].kind, 'slip-screen');
assert.equal(switchSlipFixture.arrows[0].kind, 'screen', 'candidate creation preserves the original play');

const defaultRun = createSimulationRun(switchSlipFixture, { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'switch' });
const scriptedRun = createSimulationRun(switchSlipFixture, { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: 'man-to-man', defenseStrategy: 'switch', offenseMode: 'scripted' });
assert.ok(defaultRun.actions.some((action) => action.automatic), 'existing Playbook simulation keeps its adaptive behavior by default');
assert.equal(scriptedRun.actions.some((action) => action.automatic), false, 'scripted runs suppress automatic and off-ball actions');

const brokenRun = runCounterLabTrial(switchSlipFixture, switchProfile, 'adaptive');
const repeatedRun = runCounterLabTrial(switchSlipFixture, switchProfile, 'adaptive');
assert.deepEqual(repeatedRun, brokenRun, 'explicit Counter Lab matchups produce deterministic replays');
assert.deepEqual(switchSlipFixture, original, 'trial runs preserve the original fixture');
assert.ok(brokenRun.firstLostOpeningMs != null, 'the fixture records a sustained loss during a switch');
assert.match(brokenRun.outcome, /recovered with/i, 'adaptive continuation is distinguished from the authored action');
assert.ok(brokenRun.trace.some((frame) => frame.activeRoutes.length), 'replay frames retain the currently executed route');

const slipRun = runCounterLabTrial(slip.play, switchProfile, 'adaptive');
assert.equal(slipRun.firstLostOpeningMs, null, 'the slip repair removes the sustained breakdown in the switch fixture');
assert.ok(slipRun.trace.some((frame) => frame.activeRoutes.some((route) => route.kind === 'slip-screen')), 'the repair executes as a slip in playback');

const spainPickAndRoll = STARTER_PLAYS.find((play) => play.name === 'Spain pick and roll');
assert.ok(spainPickAndRoll, 'the adaptive transfer regression uses a shipped starter play');
const spainSlipRepair = createCounterLabRepairs(spainPickAndRoll).find((repair) => repair.id.startsWith('slip-'));
assert.ok(spainSlipRepair, 'the Spain pick-and-roll starter offers a slip variant');
const spainAdaptiveSlip = runCounterLabTrial(spainSlipRepair.play, switchProfile, 'adaptive');
assert.ok(spainAdaptiveSlip.trace.at(-1).elapsedMs < 20_000, 'an uncaught adaptive transfer ends inside the simulator retry bound');

const analysis = await analyzeCounterLab(switchSlipFixture, COUNTER_LAB_DEFAULT_PROFILES, ['scripted', 'adaptive'], () => {});
const verifiedSlip = analysis.repairs.find((repair) => repair.id === 'slip-screen-one');
assert.ok(verifiedSlip, 'the engine offers the repair only after a comparison confirms an improvement');
assert.ok(verifiedSlip.resolvedBreakdowns > 0, 'the verified repair clears at least one recorded breakdown');
assert.equal(analysis.results.find((result) => result.key === 'switch:adaptive')?.firstLostOpeningMs, brokenRun.firstLostOpeningMs);
assert.ok(analysis.detailTraces.has(`slip-screen-one:switch:adaptive`), 'selected repair details are retained for lazy replay');
assert.equal(switchSlipFixture.arrows[0].kind, 'screen', 'analysis never mutates the authored play');

const blockedPassPlay = {
  ...structuredClone(switchSlipFixture),
  id: 'blocked-pass-fixture',
  name: 'Blocked authored pass',
  players: [{ id: 1, x: 50, y: 80 }, { id: 2, x: 50, y: 55 }],
  defenders: [{ id: 1, x: 50, y: 55 }, { id: 2, x: 35, y: 65 }],
  defenders_visible: true,
  ball: { x: 50, y: 80 },
  arrows: [{ id: 'pass-one', kind: 'pass', sequence: 1, path: 'straight', timing: 1, start: { x: 50, y: 80 }, end: { x: 50, y: 55 } }],
};
const holdProfile = { id: 'hold', label: 'Hold positions', strategy: 'off', scheme: 'man-to-man' };
const blockedRun = runCounterLabTrial(blockedPassPlay, holdProfile, 'scripted');
assert.equal(blockedRun.firstBlockedPass?.sequence, 1, 'an obstructed authored pass is diagnosed with its real action sequence');
assert.equal(blockedRun.firstBlockedPass?.atMs, 0, 'the pass obstruction is tied to the start of that authored action');

const noAdvantagePlay = {
  ...structuredClone(switchSlipFixture),
  id: 'no-advantage-fixture',
  name: 'No clear advantage',
  players: [{ id: 1, x: 50, y: 45, ratings: { threePoint: 1, midrange: 1, finishing: 1 } }],
  defenders: [{ id: 1, x: 50, y: 44.6 }],
  defenders_visible: true,
  ball: { x: 50, y: 45 },
  arrows: [],
};
const noAdvantage = runCounterLabTrial(noAdvantagePlay, holdProfile, 'scripted');
assert.equal(noAdvantage.createdAdvantage, false, 'a covered low-skill shot is not mislabeled as an advantage');

assert.deepEqual(eligibleCounterLabSchemes(2, 2), [], 'small lineups do not offer ineligible zone schemes');
assert.ok(!eligibleCounterLabSchemes(5, 1).some((profile) => profile.id === 'triangle-and-two'), 'Triangle-and-two requires two offensive players');
const shortRosterRun = runCounterLabTrial({ ...noAdvantagePlay, players: noAdvantagePlay.players.concat([{ id: 2, x: 25, y: 55 }]), defenders: [{ id: 1, x: 50, y: 44.6 }, { id: 2, x: 25, y: 54.6 }] }, holdProfile, 'scripted');
assert.equal(shortRosterRun.trace[0].defenders.length, 2, 'partial rosters run without inventing extra defenders');

let cancelRequested = false;
await assert.rejects(
  analyzeCounterLab(switchSlipFixture, [switchProfile], ['scripted', 'adaptive'], ({ completed }) => {
    if (completed === 1) cancelRequested = true;
  }, () => cancelRequested),
  (error) => error instanceof DOMException && error.name === 'AbortError',
  'cancellation stops a comparison after its current simulation',
);

console.log('Counter Lab tests passed: deterministic comparisons, switch-slip fixture, recovery, action diagnosis, bounded repairs, replay routes, partial rosters, eligibility, and cancellation');
