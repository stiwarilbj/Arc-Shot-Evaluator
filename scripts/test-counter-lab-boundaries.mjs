import assert from 'node:assert/strict';
import { mock } from 'node:test';

// Supply controlled, completed simulation observations to the real trial runner.
// This isolates diagnosis/event ordering from basketball movement and sampling
// drift. No diagnosis, sorting, repair or scoring implementation is mocked.
let scenario = {};
const simulation = mock.module(new URL('../frontend/src/features/playbook/simulation.ts', import.meta.url).href, { namedExports: {
  SIMULATION_STEP_MS: 100,
  DEFENSE_SCHEME_ORDER: ['man-to-man'],
  bindAuthoredActions: () => [],
  pointDistanceFeet: () => 0,
  prepareSimulationRun: () => { throw new Error('Unexpected prepared simulation'); },
  createSimulationRun: (draft) => ({
    elapsedMs: 0, durationMs: 600, routeRevision: 0, adaptiveActionsTaken: 0,
    players: structuredClone(draft.players), frame: { shotQuality: 50, execution: [] },
    actions: (scenario.passes ?? []).map((pass) => ({
      arrow: { id: pass.id, kind: 'pass' }, actorId: 1, recipientId: 2,
      sequence: pass.sequence, startTime: 0, transferFailed: false,
    })),
  }),
  advanceSimulationState: (run, step) => {
    run.elapsedMs += step; run.routeRevision++;
    for (const [i, action] of run.actions.entries()) {
      const pass = scenario.passes[i];
      if (run.elapsedMs >= pass.atMs) {
        if (pass.delivered) action.transferCompletedAtMs = pass.atMs;
        else { action.transferFailed = true; action.transferFailedAtMs = pass.atMs; }
      }
    }
    run.frame.execution = (scenario.execution ?? []).filter((action) => action.completedAtMs <= run.elapsedMs);
  },
  observeCounterLabRun: (run) => ({
    sequence: 9, action: 'Controlled action', ballHandlerId: 1, assignments: [], involvedPlayerIds: [], activeRoutes: [],
    opportunities: [{ quality: scenario.opening === false ? 30 : run.elapsedMs === 0 ? 70 : 30 }],
    blockedPass: scenario.unsafe && run.elapsedMs >= 100 ? { actionId: scenario.passes[0].id, sequence: 7, playerId: 2, receiverGap: 1, laneGap: 1 } : null,
    frame: { players: run.players, defenders: [], ball: { x: 50, y: 50 }, execution: run.frame.execution,
      shotPhase: run.elapsedMs >= (scenario.releaseAt ?? 600) ? 'air' : 'idle' },
  }),
} });

try {
  const { diagnoseOpenings, verifiedRecovery, repairEvidence, runCounterLabTrial } = await import('../frontend/src/features/playbook/counterLabEngine.ts');
  let checks = 0;
  const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  const frame = (elapsedMs, quality, shotPhase = 'idle') => ({ elapsedMs, shotPhase, sequence: 1, action: null,
    ballHandlerId: 1, assignments: [], opportunities: quality == null ? [] : [{ kind: 'shot', playerId: 1, quality, score: 1, receiverGap: 5, laneGap: 5 }],
    blockedPass: null, involvedPlayerIds: [], activeRoutes: [], players: [], defenders: [], ball: null });
  const loss = (trace) => diagnoseOpenings(trace).firstLostOpeningMs;

  // Offsets are larger than the existing 1e-6 ms floating-point tolerance.
  for (const [duration, expected] of [[299.999, null], [300, 100], [300.001, 100]]) {
    equal(loss([frame(0, 70), frame(100, 30), frame(100 + duration, 30)]), expected, `${duration}ms closure: inclusive 300ms boundary, reported at onset`);
  }
  for (const [duration, expected] of [[300 - 2e-6, null], [300 - .5e-6, 100]]) {
    equal(loss([frame(0, 70), frame(100, 30), frame(100 + duration, 30)]), expected, 'existing floating-point tolerance is preserved');
  }
  for (const [quality, created] of [[54.999, false], [55, true], [55.001, true]]) {
    equal(diagnoseOpenings([frame(0, quality)]).createdAdvantage, created, `opening eligibility at ${quality}`);
  }
  for (const [drop, expected] of [[14.999, null], [15, 100], [15.001, 100]]) {
    equal(loss([frame(0, 65), frame(100, 65 - drop), frame(400, 65 - drop)]), expected, `quality drop of ${drop} points`);
  }
  equal(loss([frame(0, 70), frame(0, 30), frame(300, 30)]), 0, 'a closure beginning at timestamp zero is retained');
  equal(diagnoseOpenings([]), { createdAdvantage: false, firstLostOpeningMs: null }, 'empty observations do not invent an advantage');
  equal(loss([frame(0, 54.999), frame(100, 0), frame(500, 0)]), null, 'a low-quality starting state cannot lose an opening it never created');
  for (const resetQuality of [55, 50.001]) {
    equal(loss([frame(0, 65), frame(100, 30), frame(399.999, resetQuality), frame(500, 30), frame(800, 30)]), 500, 'eligibility or a smaller drop resets persistence rather than adding separate closures');
  }
  equal(loss([frame(0, 70), frame(100, 30), frame(400, 30), frame(500, 70), frame(600, 30), frame(900, 30)]), 100, 'later closures never replace the first sustained loss');
  for (const phase of ['air', 'result']) {
    for (const releaseAt of [399.999, 400, 400.001]) {
      equal(loss([frame(0, 70), frame(100, 30), frame(releaseAt, 30, phase), frame(900, 0, 'result')]), null, `a ${phase} sample at ${releaseAt}ms cannot finish a pending closure`);
    }
    equal(loss([frame(0, 70), frame(100, 30), frame(400, 30), frame(400.001, 0, phase)]), 100, 'release retains a loss already confirmed before it');
    equal(loss([frame(0, 30), frame(100, 70, phase)]), null, 'released-shot quality cannot create a live opening');
  }
  for (const [lastLiveAt, expected] of [[399.999, null], [400, 100], [400.001, 100]]) {
    equal(loss([frame(0, 70), frame(100, 30), frame(lastLiveAt, 30), frame(500, 0, 'air')]), expected, 'last live observation must itself confirm 300ms before release');
  }
  equal(loss([frame(0, 70), frame(100, 30), frame(400, 0, 'air'), frame(400, 30)]), null, 'when release is observed first at a tied timestamp, subsequent samples cannot diagnose closure');
  equal(loss([frame(0, 70), frame(100, 30), frame(400, 30), frame(400, 0, 'air')]), 100, 'an idle sample confirmed before the tied release retains its diagnosis');

  for (const [duration, expected] of [[299.999, null], [300, 300], [300.001, 300]]) {
    equal(verifiedRecovery([frame(300, 60), frame(300 + duration, 60)], 200, [250], 60), expected, `recovery requires ${duration}ms of sustained eligibility after a successful read`);
  }
  for (const [quality, expected] of [[54.999, null], [55, 300], [55.001, 300]]) {
    equal(verifiedRecovery([frame(300, quality), frame(600, quality)], 200, [250], 60), expected, `recovered opening eligibility at ${quality}`);
  }
  for (const [readAt, expected] of [[199.999, null], [200, null], [200.001, 300]]) {
    equal(verifiedRecovery([frame(300, 60), frame(600, 60)], 200, [readAt], 60), expected, 'read must succeed strictly after the breakdown');
  }
  equal(verifiedRecovery([frame(300, 60), frame(600, 60)], 200, [], 60), null, 'an attempted or failed read cannot recover');
  equal(verifiedRecovery([frame(100, 60), frame(400, 60)], 0, [.001], 60), 100, 'a breakdown at timestamp zero still permits a later verified recovery');
  equal(verifiedRecovery([frame(300, 60), frame(600, 60)], null, [250], 60), null, 'there is no recovery without an earlier breakdown');
  equal(verifiedRecovery([frame(300, 60), frame(599.999, 54.999), frame(700, 60), frame(1000, 60)], 200, [250], 60), 700, 'an interrupted recovery restarts its own persistence clock');
  for (const [quality, expected] of [[54.999, null], [55, 500], [55.001, 500]]) {
    equal(verifiedRecovery([frame(500, 0, 'air')], 200, [250], quality), expected, `released-shot recovery threshold at ${quality}`);
  }
  for (const [readAt, expected] of [[499.999, 500], [500, 500], [500.001, null]]) {
    equal(verifiedRecovery([frame(500, 0, 'air')], 200, [readAt], 55), expected, 'a catch/read recorded by release can qualify; one afterward cannot');
  }
  for (const releaseAt of [199.999, 200]) {
    equal(verifiedRecovery([frame(releaseAt, 0, 'air')], 200, [199], 100), null, 'a shot before or simultaneous with breakdown cannot recover it');
  }
  equal(verifiedRecovery([frame(200.001, 0, 'air')], 200, [200.0005], 55), 200.001, 'a qualifying shot and successful read strictly after breakdown can recover');

  const event = (kind, atMs, actionId = null) => ({ kind, atMs, actionId, sequence: 1, playerId: 1 });
  const base = { key: 'switch:scripted', finalShotQuality: 50, score: 50, createdAdvantage: true,
    firstLostOpeningMs: 1000, firstBreakdown: event('opening-lost', 1000), firstBlockedPass: null, passDiagnostics: [], actionDiagnostics: [] };
  for (const [gain, verified] of [[4.999, false], [5, true], [5.001, true]]) {
    const repaired = { ...base, finalShotQuality: base.finalShotQuality + gain, score: 55 };
    const evidence = repairEvidence(base, repaired);
    equal(evidence.verified, verified, `${gain}-point gain: use full precision, not rounded display score`);
    equal(evidence.cleared, false, 'quality improvement alone does not claim a cleared breakdown');
  }
  for (const [delay, opening] of [[299.999, 'still failing'], [300, 'delayed'], [300.001, 'delayed']]) {
    const evidence = repairEvidence(base, { ...base, firstLostOpeningMs: 1000 + delay, firstBreakdown: event('opening-lost', 1000 + delay) });
    equal(evidence.opening, opening, `${delay}ms delay classification`);
    equal(evidence.verified, false, 'a delay by itself never verifies a repair');
    equal(evidence.cleared, false, 'delayed remains distinct from cleared');
  }
  for (const [gain, cleared] of [[-.001, false], [0, true], [.001, true]]) {
    const evidence = repairEvidence(base, { ...base, firstLostOpeningMs: null, firstBreakdown: null, finalShotQuality: 50 + gain });
    equal([evidence.cleared, evidence.verified], [cleared, cleared], 'genuine resolution must preserve final quality at the exact zero-gain boundary');
  }
  for (const [atMs, cleared] of [[999.999, false], [1000, true], [1000.001, true]]) {
    const evidence = repairEvidence(base, { ...base, firstLostOpeningMs: null, firstBreakdown: event('obstructed-action', atMs, 'route') });
    equal([evidence.cleared, evidence.verified], [cleared, cleared], 'resolution cannot introduce an earlier failure; equal-time failure preserves chronology');
  }
  equal(repairEvidence(base, { ...base, firstLostOpeningMs: null, firstBreakdown: null, createdAdvantage: false }).opening, 'not created', 'removing the opening is not preserving it');
  equal(repairEvidence(base, { ...base, firstLostOpeningMs: null, firstBreakdown: null, createdAdvantage: false }).verified, false, 'eliminated advantage cannot qualify as a zero-gain resolution');
  const failedPass = { actionId: 'pass', status: 'failed', atMs: 1000, sequence: 2, actorId: 1, playerId: 2 };
  const passBase = { ...base, firstLostOpeningMs: null, firstBreakdown: event('failed-pass', 1000, 'pass'), firstBlockedPass: failedPass, passDiagnostics: [failedPass] };
  for (const status of ['interrupted', 'failed', 'delivered']) {
    const evidence = repairEvidence(passBase, { ...passBase, firstBreakdown: null, firstBlockedPass: null, passDiagnostics: [{ ...failedPass, status }] });
    equal(evidence.cleared, status === 'delivered', 'pass resolution requires a recorded delivery, not the absence of a failed flag');
  }
  equal(repairEvidence(base, { ...base, firstBlockedPass: null, passDiagnostics: [{ ...failedPass, status: 'delivered' }] }).cleared, false, 'fixing a different/later action cannot clear the first opening loss');

  // Exercise the actual event construction in runCounterLabTrial, with exact
  // observed timestamps rather than reproducing its sort in a test helper.
  let trialId = 0;
  const trial = (input) => {
    scenario = input;
    return runCounterLabTrial({ version: 1, id: `boundary-${++trialId}`, name: 'Boundary observations', defenders_visible: false,
      players: [{ id: 1, x: 50, y: 50 }, { id: 2, x: 60, y: 50 }], defenders: [], arrows: [], ball: { x: 50, y: 50 } },
      { id: 'switch', label: 'Switch', strategy: 'switch', scheme: 'man-to-man' }, 'scripted');
  };
  const pass = (atMs, extra = {}) => ({ id: 'pass', atMs, sequence: 7, ...extra });
  const obstruction = (completedAtMs, extra = {}) => ({ actionId: 'route', sequence: 2, actorId: 2, phase: 'obstructed', startedAtMs: 0, completedAtMs, ...extra });
  for (const [atMs, kind] of [[99.999, 'failed-pass'], [100, 'opening-lost'], [100.001, 'opening-lost']]) {
    const result = trial({ passes: [pass(atMs)] });
    equal(result.firstBreakdown.kind, kind, 'compare transfer failure with the onset of a subsequently confirmed opening loss');
    equal(result.firstBreakdown.atMs, Math.min(atMs, 100), 'chronology uses onset, not confirmation at 400ms');
  }
  for (const [atMs, kind] of [[99.999, 'obstructed-action'], [100, 'opening-lost'], [100.001, 'opening-lost']]) {
    equal(trial({ execution: [obstruction(atMs)] }).firstBreakdown.kind, kind, 'route failure immediately before, tied with, or after opening loss');
  }
  for (const [atMs, kind] of [[199.999, 'action-conflict'], [200, 'failed-pass'], [200.001, 'failed-pass']]) {
    equal(trial({ opening: false, passes: [pass(200)], execution: [obstruction(atMs, { phase: 'conflict' })] }).firstBreakdown.kind, kind, 'transfer versus conflicting action: exact chronological ordering and stable ties');
  }
  const tiedRoutes = [obstruction(200), obstruction(200, { actionId: 'conflict', phase: 'conflict', sequence: 1 })];
  for (const execution of [tiedRoutes, [...tiedRoutes].reverse()]) {
    equal(trial({ opening: false, execution }).firstBreakdown.actionId, execution[0].actionId, 'simultaneous route failures retain diagnostic order rather than inventing kind/sequence priority');
  }
  equal(trial({ opening: false, execution: [obstruction(200.001, { sequence: 1 }), obstruction(200, { actionId: 'earlier', sequence: 9 })] }).firstBreakdown.actionId, 'earlier', 'earlier failure wins even when listed later with a larger move number');
  const tiedPasses = [pass(200, { id: 'second-move', sequence: 2 }), pass(200, { id: 'first-move', sequence: 1 })];
  equal(trial({ opening: false, passes: tiedPasses }).firstBreakdown.actionId, 'second-move', 'simultaneous passes retain recorded order and original move identities');
  for (const releaseAt of [300, 400]) equal(trial({ releaseAt }).firstBreakdown, null, 'release before or at closure confirmation prevents a false breakdown');
  equal(trial({ releaseAt: 500 }).firstBreakdown.kind, 'opening-lost', 'a confirmed pre-release loss remains visible');
  const atRelease = trial({ releaseAt: 400, passes: [pass(400)] });
  equal(atRelease.firstLostOpeningMs, null, 'release sample does not finish a pending loss');
  equal([atRelease.firstBreakdown.kind, atRelease.firstBreakdown.atMs, atRelease.releasedAtMs], ['failed-pass', 400, 400], 'release does not erase a distinct simultaneous transfer failure');
  const unsafe = trial({ opening: false, unsafe: true, passes: [pass(200, { delivered: true })], execution: [obstruction(200, { actionId: 'pass' })] });
  equal(unsafe.firstUnsafePass.unsafeAtMs, 100, 'unsafe lane warning keeps its own timestamp');
  equal(unsafe.firstBlockedPass, null, 'a contested but delivered pass is not failed');
  equal(unsafe.firstBreakdown, null, 'pass execution diagnostics are not counted again as route failures');
  equal(trial({ opening: false, passes: [pass(200)], execution: [obstruction(100, { actionId: 'pass' })] }).firstBreakdown.atMs, 200, 'one failed transfer produces one failure at its recorded completion, not a duplicate obstruction');
  console.log(`Counter Lab exact-boundary regressions passed: ${checks} assertions covering persistence, eligibility, recovery, repair gains/delays, chronological failures, simultaneous events and shot release`);
} finally {
  simulation.restore();
}
