import { routeVisible, normalizeArrowVisibility, ARROW_VISIBILITY_OPTIONS } from '../frontend/src/features/playbook/arrowVisibility.ts';
import assert from 'node:assert/strict';
import { advanceReplay, matchesReplay, replayFrame } from '../frontend/src/features/playbook/counterLabReplay.ts';
import { analyzeCounterLab, runCounterLabTrial, diagnoseOpenings, repairEvidence, verifiedRecovery } from '../frontend/src/features/playbook/counterLabEngine.ts';
import { COUNTER_LAB_DEFAULT_PROFILES, createCounterLabRepairs, eligibleCounterLabSchemes } from '../frontend/src/features/playbook/counterLabTypes.ts';
import { createSimulationRun, authoredCourtRoutes, advanceSimulationRun, getSimulationFrame } from '../frontend/src/features/playbook/simulation.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../frontend/src/features/playbook/types.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';

const switchSlipFixture = {
  id: 'switch-slip-fixture',
  version: 1,
  name: 'Switch slip fixture',
  defenders_visible: false,
  players: [
    { id: 1, x: 51.80839931126684, y: 57.520748605020344 },
    { id: 2, x: 46.11721276305616, y: 59.95294767897576 },
    { id: 3, x: 52.65480529051274, y: 53.28355757519603 },
    { id: 4, x: 15.666752534452826, y: 55.878381822258234 },
    { id: 5, x: 72.6544732763432, y: 53.517179004848 },
  ],
  defenders: [],
  ball: { x: 51.80839931126684, y: 57.520748605020344 },
  arrows: [{
    id: 'screen-one', kind: 'screen', sequence: 1, path: 'straight', timing: 3.591288176830858,
    start: { x: 46.11721276305616, y: 59.95294767897576 },
    end: { x: 57.11684093112126, y: 47.20973610528745 },
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
assert.ok(brokenRun.firstLostOpeningMs < brokenRun.releasedAtMs, 'the switch breakdown occurs before shot release');
assert.equal(typeof brokenRun.adaptiveAttempts, 'number', 'adaptive attempts are recorded independently of the outcome');
assert.doesNotMatch(brokenRun.outcome, /^Recovered/, 'attempts alone do not imply recovery');
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
assert.equal(blockedRun.firstUnsafePass?.sequence, 1, 'an unsafe authored pass uses its own action sequence');
assert.equal(blockedRun.firstUnsafePass?.unsafeAtMs, 0, 'the warning records the actual unsafe window');
assert.equal(blockedRun.firstBlockedPass, null, 'a contested but delivered pass is not called a failure');
assert.equal(blockedRun.passDiagnostics[0].status, 'delivered');

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

const forcedShot = runCounterLabTrial(STARTER_PLAYS.find((play) => play.name === 'Pick and pop'), COUNTER_LAB_DEFAULT_PROFILES.find((profile) => profile.id === 'help'), 'adaptive');
assert.ok(forcedShot.adaptiveAttempts > 0, 'the forced-shot regression actually attempts adaptive reads');
assert.ok(forcedShot.score < 55);
assert.equal(forcedShot.recoveredAtMs, null);
assert.doesNotMatch(forcedShot.outcome, /^Recovered/, 'low-quality improvisation is not claimed as recovery');
const makeFrame = (time, quality, phase = 'idle') => ({ ...brokenRun.trace[0], elapsedMs: time, shotPhase: phase, opportunities: [{ kind: 'shot', playerId: 1, quality, score: 1, receiverGap: 5, laneGap: 5 }] });
assert.equal(diagnoseOpenings([makeFrame(0, 70), makeFrame(100, 30), makeFrame(300, 30)]).firstLostOpeningMs, null, 'brief closure is not a sustained breakdown');
assert.equal(diagnoseOpenings([makeFrame(0, 70), makeFrame(100, 30), makeFrame(400, 30)]).firstLostOpeningMs, 100, '300ms closure is confirmed at its onset');
assert.equal(diagnoseOpenings([makeFrame(0, 70), makeFrame(100, 30, 'air'), makeFrame(500, 30, 'result')]).firstLostOpeningMs, null, 'released shots cannot create an opening-loss diagnosis');
assert.equal(verifiedRecovery([makeFrame(300, 65), makeFrame(600, 65)], 200, [], 70), null, 'unexecuted adaptive attempts cannot recover');
assert.equal(verifiedRecovery([makeFrame(300, 65), makeFrame(600, 65)], 200, [250], 70), 300, 'a completed read followed by sustained eligibility recovers');
assert.equal(verifiedRecovery([makeFrame(300, 30), makeFrame(600, 30, 'air')], 200, [250], 22), null, 'a low-quality forced shot does not recover');
assert.equal(verifiedRecovery([makeFrame(600, 30, 'air')], 200, [250], 60), 600, 'a qualifying released shot after a completed read recovers');
const baseSummary = { ...brokenRun, score: 50, finalShotQuality: 50, createdAdvantage: true, firstLostOpeningMs: 1000, firstBreakdown: { kind: 'opening-lost', atMs: 1000 }, firstBlockedPass: null };
assert.equal(repairEvidence(baseSummary, { ...baseSummary, firstLostOpeningMs: 1400, firstBreakdown: { kind: 'opening-lost', atMs: 1400 } }).verified, false, 'delay alone is not a verified repair');
assert.equal(repairEvidence(baseSummary, { ...baseSummary, firstLostOpeningMs: 1400 }).opening, 'delayed');
assert.equal(repairEvidence(baseSummary, { ...baseSummary, firstLostOpeningMs: null, firstBreakdown: null, createdAdvantage: false }).cleared, false, 'eliminating the advantage is not holding it');
assert.equal(repairEvidence(baseSummary, { ...baseSummary, firstLostOpeningMs: null, firstBreakdown: null, finalShotQuality: 49 }).cleared, false, 'a resolution must preserve final quality');
assert.equal(repairEvidence(baseSummary, { ...baseSummary, firstLostOpeningMs: null, firstBreakdown: null }).cleared, true);
const laterPass = { actionId: 'later-pass', sequence: 3, actorId: 1, playerId: 2, status: 'failed', atMs: 1800, unsafeAtMs: 1700, receiverGap: 1, laneGap: 1 };
assert.equal(repairEvidence({ ...baseSummary, firstBlockedPass: laterPass }, { ...baseSummary, passDiagnostics: [{ ...laterPass, status: 'delivered' }] }).cleared, false, 'clearing a later pass must not label the first opening loss as cleared');

assert.equal(advanceReplay(0, 1100, 1, 10000), 1100, 'normal replay uses actual elapsed time');
assert.equal(advanceReplay(0, 1000, .5, 10000), 500);
assert.equal(advanceReplay(0, 1000, 2, 10000), 2000);
const detail = { type: 'details', id: 'run', detailId: 'detail', key: 'switch:scripted', repairId: 'original' };
assert.ok(matchesReplay(detail, detail));
for (const field of ['id', 'detailId', 'key', 'repairId']) assert.equal(matchesReplay({ ...detail, [field]: 'stale' }, detail), false, `stale ${field} is rejected`);
const interpolated = replayFrame([{ ...makeFrame(0, 60), players: [{ id: 1, x: 10, y: 20 }] }, { ...makeFrame(100, 60), players: [{ id: 1, x: 30, y: 40 }] }], 50);
assert.deepEqual(interpolated.players[0], { id: 1, x: 20, y: 30 }, 'motion interpolates between recorded samples');
assert.equal(replayFrame(null, 50), null);
let baselineWasFirst = false;
await analyzeCounterLab(switchSlipFixture, [switchProfile], ['adaptive'], ({ stage }) => { if (stage === 'repairs') assert.ok(baselineWasFirst, 'baseline arrives before candidate trials'); }, () => false, (results, traces) => { baselineWasFirst = true; assert.equal(results.length, 1); assert.ok(traces.has('original:switch:adaptive')); });
assert.ok(baselineWasFirst);
const beforeAll = JSON.stringify(STARTER_PLAYS);
for (const play of STARTER_PLAYS) {
  for (const mode of ['scripted', 'adaptive']) for (const profile of COUNTER_LAB_DEFAULT_PROFILES) {
    const result = runCounterLabTrial(play, profile, mode);
    if (result.firstUnsafePass) assert.ok(play.arrows.some((arrow, index) => arrow.id === result.firstUnsafePass.actionId && (arrow.sequence ?? index + 1) === result.firstUnsafePass.sequence), 'contested-pass mapping survives simultaneous phase boundaries');
    if (result.firstLostOpeningMs != null && result.releasedAtMs != null) assert.ok(result.firstLostOpeningMs < result.releasedAtMs);
    const events = [result.firstLostOpeningMs, result.firstBlockedPass?.atMs].filter((time) => time != null);
    assert.equal(result.firstBreakdown?.atMs ?? null, events.length ? Math.min(...events) : null, 'first breakdown is chronological');
  }
  const candidates = createCounterLabRepairs(play);
  assert.ok(candidates.length <= 8);
  for (const candidate of candidates) {
    const originalActions = createSimulationRun(play, { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: 'scripted' }).actions;
    const candidateActions = createSimulationRun(candidate.play, { ...DEFAULT_SIMULATION_SETTINGS, offenseMode: 'scripted' }).actions;
    for (const action of candidateActions) if (candidate.id.startsWith('pass-') && action.arrow.id === candidate.id.slice(5).replace(/-[0-9]+$/, '')) {
      assert.notEqual(action.recipientId, originalActions.find((original) => original.arrow.id === action.arrow.id).recipientId);
      assert.notEqual(action.actorId, action.recipientId);
    }
  }
}
assert.equal(JSON.stringify(STARTER_PLAYS), beforeAll, 'all starter trials and repairs preserve source plays');
assert.throws(() => runCounterLabTrial({ ...noAdvantagePlay, players: [{ id: 1, x: NaN, y: 10 }] }, holdProfile, 'scripted'), /invalid court positions/);
assert.throws(() => runCounterLabTrial({ ...noAdvantagePlay, arrows: [{ id: 'bad', kind: 'pass', start: { x: 10, y: 10 }, end: { x: 20, y: 20 }, timing: Infinity }] }, holdProfile, 'scripted'), /invalid action/);
console.log('Counter Lab tests passed: deterministic comparisons, switch-slip fixture, recovery, action diagnosis, bounded repairs, replay routes, partial rosters, eligibility, and cancellation');


assert.equal(normalizeArrowVisibility(null), 'main-on-ball');
assert.equal(normalizeArrowVisibility('invalid'), 'main-on-ball');
const routeCases = [
  { scope: 'on-ball', importance: 'main' },
  { scope: 'off-ball', importance: 'main' },
  { scope: 'on-ball', importance: 'adjustment' },
  { scope: 'off-ball', importance: 'adjustment' },
];
assert.deepEqual(ARROW_VISIBILITY_OPTIONS.map(({value}) => routeCases.map(route => routeVisible(route, value))), [
  [false,false,false,false], [true,false,false,false], [true,true,false,false], [true,false,true,false], [true,true,true,true],
]);
const visibilityFixture = {
  version: 1, id: 'visibility-fixture', name: 'Visibility', defenders_visible: false,
  players: [{id:1,x:50,y:70},{id:2,x:70,y:60},{id:3,x:20,y:60}],
  defenders: [], ball: {x:50,y:70},
  arrows: [
    {id:'offball', kind:'movement', start:{x:20,y:60}, end:{x:20.2,y:60}, sequence:1},
    {id:'transfer', kind:'pass', start:{x:50,y:70}, end:{x:70,y:60}, sequence:2},
    {id:'after-catch', kind:'movement', start:{x:70,y:60}, end:{x:70.1,y:60}, sequence:3},
    {id:'support',kind:'pick-roll',screener_id:1,handler_id:2,start:{x:50,y:70},end:{x:65,y:50},sequence:4},
    {id:'cut',kind:'off-ball-screen',screener_id:1,cutter_id:3,start:{x:65,y:50},end:{x:25,y:45},exit_target:{x:40,y:30},sequence:5},
  ],
};
const routes = authoredCourtRoutes(visibilityFixture);
assert.equal(routes.find(r=>r.actionId==='offball').scope,'off-ball');
assert.equal(routes.find(r=>r.actionId==='offball').importance,'main','short authored actions remain main');
assert.equal(routes.find(r=>r.actionId==='after-catch').scope,'on-ball','binding follows possession changes');
assert.equal(routes.find(r=>r.actionId==='after-catch').sequence,3,'filtering preserves original move numbers');
assert.equal(routes.find(r=>r.actionId==='support' && r.kind==='pick-roll').scope,'on-ball');
assert(routes.some(r=>r.actionId==='support' && r.kind==='handler-support' && r.playerId===2));
assert(routes.some(r=>r.actionId==='support' && r.via),'screen/roll preserves both legs');
assert(routes.some(r=>r.actionId==='cut' && r.kind==='cutter' && r.scope==='off-ball' && r.via));
const trailRun=createSimulationRun(STARTER_PLAYS[0],DEFAULT_SIMULATION_SETTINGS);
for(let i=0;i<50;i++)advanceSimulationRun(trailRun,20);
const trailFrame=getSimulationFrame(trailRun);
assert(trailFrame.routes.some(r=>r.importance==='adjustment' && r.points.length>1),'small movements are recorded');
assert(trailFrame.routes.filter(r=>routeVisible(r,'main-on-ball')).every(r=>r.scope==='on-ball'&&r.importance==='main'));
assert(trailRun.routeHistory.length<=24,'recent movement history is bounded');
const snapshot=JSON.stringify(trailRun.players);
for(const {value} of ARROW_VISIBILITY_OPTIONS)trailFrame.routes.filter(r=>routeVisible(r,value));
assert.equal(JSON.stringify(trailRun.players),snapshot,'filtering cannot change simulation');
for(const play of STARTER_PLAYS){
 const before=JSON.stringify(play);const rs=authoredCourtRoutes(play);
 assert.equal(JSON.stringify(play),before);
 assert.equal(new Set(rs.map(r=>r.id)).size,rs.length,'route IDs are unique');
 assert(rs.every(r=>r.actionId && r.sequence>=1));
}
console.log('Arrow visibility tests passed: five modes, default fallback, possession binding, connected support, short authored actions, stable sequence numbers, trails and all starters');
