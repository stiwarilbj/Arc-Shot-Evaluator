import { ballController, BALL_PHASES } from '../../frontend/src/features/playbook/ballState.ts';
import { DEFAULT_SIMULATION_SETTINGS } from '../../frontend/src/features/playbook/types.ts';
import { validatePlaybookDocument } from '../../frontend/src/features/playbook/documentValidation.ts';
import { createSimulationRun, advanceSimulationState, setSimulationRunSettings, editPausedSimulationMarker,
  rebasePausedSimulation, inspectSimulationExecution, watchSimulationExecution, pointDistanceFeet, validateSettings,
  cloneSimulationExecution, restoreSimulationExecution, DEFENSE_SCHEME_ORDER } from '../../frontend/src/features/playbook/simulation.ts';
import { seededSimulationRandom } from '../../frontend/src/features/playbook/simulationSession.ts';
import { SIMULATION_ENGINE_VERSION } from '../../frontend/src/features/playbook/simulationVersion.ts';

export const AUDIT_VERSION = 1;
export const STEP_MS = 1000 / 60;
export const LAYOUTS = ['crossing', 'overlap', 'crowded-paint', 'baseline', 'curves', 'partial', 'screens', 'transfers', 'edges'];
const strategies = ['off', 'contain', 'help', 'switch', 'trap-rotate', 'fight-over', 'go-under', 'drop', 'hedge', 'deny-lanes', 'protect-paint'];
const phases = new Set(['pending', 'approach', 'set', 'use', 'release', 'transfer', 'completed', 'obstructed', 'conflict', 'interrupted']);
const terminal = new Set(['completed', 'obstructed', 'conflict', 'interrupted']);
const transfers = new Set(['pass', 'handoff']);
const screens = new Set(['screen', 'pick-roll', 'pick-pop', 'slip-screen', 'off-ball-screen', 'pin-down']);
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const round = n => Math.round(n * 1000) / 1000;
const key = p => `${p.team}:${p.id}`;

export class AuditFailure extends Error {
  constructor(code, subject, message) { super(message); this.name = 'AuditFailure'; this.code = code; this.subject = subject; }
}
function requireInvariant(ok, code, subject, message) { if (!ok) throw new AuditFailure(code, subject, message); }

/** Pure checks also accept deliberately damaged snapshots in verifier self-tests. */
export function verifySnapshot(now, before = null, { discontinuity = false } = {}) {
  const check = (ok, code, subject, message) => requireInvariant(ok, code, subject, message);
  check(Number.isFinite(now.elapsedMs) && now.elapsedMs >= 0 && Number.isFinite(now.durationMs) && now.durationMs >= now.elapsedMs - 1e-6,
    'clock', 'run', 'Execution clock must be finite, nonnegative and inside the possession.');
  check(Number.isFinite(now.accumulatorMs) && now.accumulatorMs >= 0, 'accumulator', 'run', 'Fixed-step accumulator is invalid.');
  check(BALL_PHASES.includes(now.ball.kind), 'ball-phase', 'ball', 'Ball must have one recognized state.');
  const ids = new Set(now.markers.filter(p => p.team === 'player').map(p => p.id));
  const controller = ballController(now.ball);
  check(controller === now.controllerId && controller === now.frame.controllerId && (controller == null || ids.has(controller)),
    'possession', 'ball', 'Ball state and frame disagree about the one controlling player.');
  check(now.frame.ballPhase === now.ball.kind, 'ball-frame', 'ball', 'Frame and authoritative ball phases disagree.');
  check(now.ball.position == null || finitePoint(now.ball.position), 'finite-ball', 'ball', 'Ball has nonfinite coordinates.');
  check((now.frame.ball == null) === (now.ball.position == null) && (!now.ball.position ||
    close(now.frame.ball.x, now.ball.position.x) && close(now.frame.ball.y, now.ball.position.y)), 'ball-frame', 'ball', 'Frame ball position is stale.');
  check(finitePoint(now.ball.velocity), 'finite-velocity', 'ball', 'Ball velocity is nonfinite.');
  if (before && !discontinuity && now.ball.releaseContext && before.ball.releaseContext
    && now.ball.setupAtMs === before.ball.setupAtMs && now.ball.shooterId === before.ball.shooterId) {
    check(JSON.stringify(now.ball.releaseContext) === JSON.stringify(before.ball.releaseContext),
      'immutable-release', 'ball', 'Released shot evidence changed after release.');
  }
  check(new Set(now.markers.map(key)).size === now.markers.length, 'roster-identity', 'run', 'Roster identities are duplicated.');
  const dt = before && !discontinuity ? (now.elapsedMs - before.elapsedMs) / 1000 : 0;
  if (before && !discontinuity) check(dt >= -1e-9, 'clock-order', 'run', 'Execution time moved backward without a restore.');
  for (const p of now.markers) {
    check(finitePoint(p), 'finite-position', key(p), 'Marker position is nonfinite.');
    check(p.x >= -1e-6 && p.x <= 100 + 1e-6 && p.y >= -1e-6 && p.y <= 100 + 1e-6, 'court-bounds', key(p), 'Marker left the court.');
    const maximum = p.team === 'player' ? 19 : 15;
    check(finitePoint(p.velocity) && Math.hypot(p.velocity.x, p.velocity.y) <= maximum + 1e-6,
      'speed', key(p), 'Marker velocity exceeds its speed limit.');
    const prior = before?.markers.find(old => key(old) === key(p));
    if (dt > 1e-9 && prior) check(pointDistanceFeet(prior, p) <= maximum * dt + 1e-5,
      'travel', key(p), 'Marker teleported beyond its movement budget.');
  }
  const actionMap = new Map(now.actions.map(a => [a.key, a]));
  check(actionMap.size === now.actions.length, 'action-identity', 'run', 'Action identities are duplicated.');
  const owners = new Set();
  for (const a of now.actions) {
    const e = a.execution, prior = before?.actions.find(old => old.key === a.key);
    if (!e) continue; // Legacy/unstarted bound actions can initialize lazily.
    check(phases.has(e.phase), 'action-phase', a.key, 'Action must have one recognized execution phase.');
    check(Number.isFinite(e.progress) && e.progress >= 0 && e.progress <= 1 + 1e-6 && Number.isFinite(a.startTime) && Number.isFinite(a.durationMs) && a.durationMs > 0,
      'action-numbers', a.key, 'Action timing or progress is invalid.');
    for (const path of a.paths) check(Number.isFinite(path.progress) && Number.isFinite(path.length) && path.progress >= 0 && path.progress <= path.length + 1e-6,
      'route-progress', a.key, 'Executed route progress is invalid.');
    for (const time of [e.startedAtMs, e.completedAtMs, e.setAtMs, e.usedAtMs, e.releasedAtMs].filter(t => t != null)) {
      check(Number.isFinite(time) && time >= -1e-6 && time <= now.elapsedMs + 1e-6, 'action-time', a.key, 'Action evidence lies outside executed time.');
    }
    if (e.startedAtMs != null && e.completedAtMs != null) check(e.completedAtMs >= e.startedAtMs - 1e-6, 'action-time', a.key, 'Completion precedes action start.');
    const active = e.startedAtMs != null && !terminal.has(e.phase);
    if (active && !transfers.has(a.kind)) {
      check(!owners.has(a.actorId), 'movement-ownership', a.key, 'Two executable routes own the same actor simultaneously.'); owners.add(a.actorId);
    }
    if (active) check((e.phase === 'transfer') === transfers.has(a.kind), 'conflicting-phase', a.key, 'Transfer and movement phases conflict.');
    if (terminal.has(e.phase)) check(e.completedAtMs != null, 'terminal-time', a.key, 'Terminal action lacks an outcome time.');
    if (a.transfer) {
      const t = a.transfer;
      check(t.actionKey === a.key && t.giverId === a.actorId && t.receiverId === a.recipientId, 'transfer-identity', a.key, 'Transfer participants disagree with the authored action.');
      for (const sample of [t.release, t.arrival, t.outcome.kind === 'caught' ? t.outcome : null].filter(Boolean)) check(finitePoint(sample.position) && Number.isFinite(sample.atMs) && sample.atMs >= 0 && sample.atMs <= now.elapsedMs + 1e-6,
        'catch-evidence', a.key, 'Transfer sample has invalid coordinates or time.');
      if (t.outcome.kind === 'caught') check(t.release && t.arrival && t.release.atMs <= t.arrival.atMs + 1e-6 && t.arrival.atMs <= t.outcome.atMs + 1e-6,
        'catch-evidence', a.key, 'Catch requires an ordered release and arrival.');
      if (before && !discontinuity && prior?.transfer && prior.transfer.outcome.kind !== 'pending') check(JSON.stringify(t) === JSON.stringify(prior.transfer),
        'immutable-transfer', a.key, 'A finalized transfer changed after its outcome.');
    }
    if (e.startedAtMs != null) for (const dep of a.dependencies) {
      const source = actionMap.get(dep.key), time = dep.milestone === 'catch' ? source?.transfer?.outcome.kind === 'caught' ? source.transfer.outcome.atMs : null : source?.execution?.phase === 'completed' ? source.execution.completedAtMs : null;
      check(time != null && time <= e.startedAtMs + 1e-6, 'dependency', a.key, 'Action started before its prerequisite completed.');
    }
    if (e.phase !== 'completed') continue;
    check(e.startedAtMs != null && e.completedAtMs != null && close(e.progress, 1), 'completion', a.key, 'Completed action lacks execution evidence.');
    if (transfers.has(a.kind)) {
      check(a.transfer?.outcome.kind === 'caught' && close(a.transfer.outcome.atMs, e.completedAtMs), 'completed-catch', a.key, 'Completed transfer has no matching recorded catch.');
    } else if (prior?.execution?.phase !== 'completed' && !discontinuity) {
      const actor = now.markers.find(p => p.team === 'player' && p.id === a.actorId);
      check(actor && pointDistanceFeet(actor, a.target) <= .6 + 1e-6 && Math.hypot(actor.velocity.x, actor.velocity.y) <= 2 + 1e-6,
        'completed-destination', a.key, 'Completed movement did not arrive and brake at its executable destination.');
      if (screens.has(a.kind)) {
        const user = now.markers.find(p => p.team === 'player' && p.id === a.userId);
        check(user && pointDistanceFeet(user, a.userTarget) <= .8 + 1e-6, 'completed-screen-user', a.key, 'Completed screen has no finished screen user.');
        if (a.kind !== 'slip-screen') check(e.setAtMs != null && e.usedAtMs != null && e.releasedAtMs != null && e.setAtMs <= e.usedAtMs && e.usedAtMs <= e.releasedAtMs,
          'completed-screen-phases', a.key, 'Completed screen lacks ordered set/use/release evidence.');
      }
    }
  }
  if (now.ball.kind === 'pass-in-flight' || now.ball.kind === 'handoff-pending') {
    const action = actionMap.get(now.ball.transfer.actionKey);
    check(action?.execution?.phase === 'transfer' && action.transfer?.outcome.kind === 'pending' && JSON.stringify(action.transfer) === JSON.stringify(now.ball.transfer),
      'active-transfer', 'ball', 'In-flight ball has no single matching active transfer.');
  }
}

/** Seed + case index determine layout, coverage, attributes, actions and commands. */
export function generateAuditCase(seed, { commands = 72, index = 0 } = {}) {
  const random = seededSimulationRandom(seed), pick = items => items[Math.floor(random() * items.length)];
  const integer = n => Math.floor(random() * n), point = () => ({ x: round(4 + random() * 92), y: round(6 + random() * 88) });
  const layout = LAYOUTS[index % LAYOUTS.length];
  const count = layout === 'partial' ? index % 3 : index % 4 === 0 ? 5 : 2 + integer(4);
  const players = Array.from({ length: count }, (_, n) => ({ id: n + 1, ...point(), ratings: { threePoint: 1 + integer(5), midrange: 1 + integer(5), finishing: 1 + integer(5) }, badges: n % 2 ? ['cutter'] : ['playmaker'] }));
  players.forEach((p, n) => {
    if (layout === 'overlap') Object.assign(p, { x: 50, y: 65 });
    if (layout === 'crowded-paint') Object.assign(p, { x: 47 + (n % 3) * 3, y: 24 + Math.floor(n / 3) * 3 });
    if (layout === 'baseline') Object.assign(p, { x: 10 + n * 18, y: 5 });
    if (layout === 'crossing') Object.assign(p, { x: n % 2 ? 70 : 30, y: 55 + n * 5 });
    if (layout === 'edges') Object.assign(p, { x: n % 2 ? 100 : 0, y: n % 3 ? 100 : 0 });
  });
  const defenders = Array.from({ length: layout === 'partial' ? integer(count + 1) : count }, (_, n) => ({ id: n + 1, ...point(), badges: [pick(['lockdown', 'helper', 'paint-protector'])] }));
  if (layout === 'overlap') defenders.forEach(p => Object.assign(p, { x: 50, y: 65 }));
  const planned = structuredClone(players), arrows = [];
  const kinds = layout === 'screens' ? ['screen', 'pick-roll', 'pick-pop', 'slip-screen', 'off-ball-screen', 'pin-down']
    : layout === 'transfers' ? ['pass', 'handoff', 'movement'] : ['movement', 'movement', 'backdoor-cut', 'pass', 'handoff', 'slip-screen'];
  for (let n = 0, length = count ? 6 + integer(11) : 0; n < length; n++) {
    const actor = planned[n % count], other = planned[(n + 1) % count];
    let kind = kinds[n % kinds.length]; if (count < 2 && !['movement', 'backdoor-cut'].includes(kind)) kind = 'movement';
    const end = layout === 'crossing' ? { x: 100 - actor.x, y: actor.y } : layout === 'curves' ? point() :
      { x: round(Math.max(2, Math.min(98, actor.x + (random() - .5) * 24))), y: round(Math.max(2, Math.min(98, actor.y + (random() - .5) * 24))) };
    const arrow = { id: `action-${n}`, kind, start: { x: actor.x, y: actor.y }, end,
      sequence: 1 + Math.floor(n / (layout === 'crossing' || layout === 'crowded-paint' ? count : 2)), timing: pick([.5, .75, 1.2, 2, 4]) };
    if (transfers.has(kind)) Object.assign(arrow, { actor_id: actor.id, recipient_id: other.id, end: { x: other.x, y: other.y } });
    else if (screens.has(kind)) Object.assign(arrow, { screener_id: actor.id, ...(['off-ball-screen', 'pin-down'].includes(kind) ? { cutter_id: other.id } : { handler_id: other.id }), exit_target: point() });
    else arrow.actor_id = actor.id;
    if (layout === 'curves' || random() < .3) Object.assign(arrow, { path: 'curve', control: point() });
    arrows.push(arrow);
    if (!transfers.has(kind)) Object.assign(actor, arrow.end);
  }
  const settings = { ...structuredClone(DEFAULT_SIMULATION_SETTINGS), offenseMode: index % 2 ? 'adaptive' : 'scripted',
    defenseScheme: index % 12 === 11 ? 'auto' : DEFENSE_SCHEME_ORDER[index % DEFENSE_SCHEME_ORDER.length], defenseStrategy: strategies[index % strategies.length] };
  const drawing = { version: 1, id: `audit-${seed}`, name: `Adversarial ${layout}`, players, defenders, defenders_visible: true,
    ball: players.length && index % 5 !== 4 ? { x: players[0].x, y: players[0].y } : null, arrows };
  const sequence = [], actorIds = players.map(p => p.id);
  for (let n = 0; n < commands; n++) {
    // Include sub-step/no-op advances and a long chain of real pause/edit/resume operations.
    if (n % 8 === 3 && players.length) {
      const team = defenders.length && random() < .3 ? 'defender' : 'player';
      sequence.push({ kind: 'pause' }, { kind: 'advance', steps: 3, deltaMs: STEP_MS },
        { kind: 'edit', team, id: team === 'player' ? pick(actorIds) : pick(defenders).id, point: point() },
        { kind: 'attributes', id: pick(actorIds), rating: 1 + integer(5), badge: pick(['cutter', 'slasher', 'screen-setter']) },
        { kind: 'resume' });
    } else if (n % 8 === 5) sequence.push({ kind: 'settings', settings: { ...structuredClone(settings), defenseStrategy: strategies[(index + n) % strategies.length],
      offenseMode: n % 3 ? settings.offenseMode : settings.offenseMode === 'scripted' ? 'adaptive' : 'scripted', offBallIntensity: integer(101), offenseOffBall: pick(['off', 'spacing', 'cuts', 'read-react']) } });
    else if (n % 16 === 7) sequence.push({ kind: 'checkpoint' }, { kind: 'advance', steps: 9, deltaMs: STEP_MS }, { kind: 'restore' });
    else sequence.push({ kind: 'advance', steps: 1 + integer(28), deltaMs: pick([STEP_MS, 1000 / 120, 1000 / 30, 0, -1]) });
  }
  sequence.push({ kind: 'resume' }, { kind: 'finish', maxSteps: 15000 });
  const result = { version: AUDIT_VERSION, seed, caseIndex: index, engineVersion: SIMULATION_ENGINE_VERSION, layout, drawing, settings, commands: sequence };
  validateAuditCase(result);
  return result;
}

export function validateAuditCase(test) {
  if (test.version !== AUDIT_VERSION || !Number.isInteger(test.seed) || test.seed < 0 || test.seed > 0xffffffff || !Array.isArray(test.commands)) throw new Error('Invalid audit fixture.');
  validatePlaybookDocument(test.drawing);
  validateSettings(test.settings);
  let paused = false, checkpoint = null;
  for (const c of test.commands) {
    if (c.kind === 'pause') paused = true;
    else if (c.kind === 'resume') paused = false;
    else if (c.kind === 'checkpoint') checkpoint = { paused };
    else if (c.kind === 'restore') { if (!checkpoint) throw new Error('Missing checkpoint.'); paused = checkpoint.paused; }
    else if (c.kind === 'edit' || c.kind === 'attributes') {
      const roster = c.kind === 'attributes' || c.team === 'player' ? test.drawing.players : test.drawing.defenders;
      if (!paused || !roster.some(p => p.id === c.id) || c.kind === 'edit' && (!finitePoint(c.point) || c.point.x < 0 || c.point.x > 100 || c.point.y < 0 || c.point.y > 100)) throw new Error('Invalid paused edit.');
      if (c.kind === 'attributes' && (!Number.isInteger(c.rating) || c.rating < 1 || c.rating > 5 || !['cutter', 'slasher', 'screen-setter'].includes(c.badge))) throw new Error('Invalid attribute edit.');
      if (c.kind === 'edit' && !['player', 'defender'].includes(c.team)) throw new Error('Invalid marker team.');
    } else if (c.kind === 'advance') {
      if (!Number.isInteger(c.steps) || c.steps < 1 || c.steps > 15000 || !Number.isFinite(c.deltaMs) || Math.abs(c.deltaMs) > 50) throw new Error('Invalid advance.');
    } else if (c.kind === 'finish') {
      if (paused || !Number.isInteger(c.maxSteps) || c.maxSteps < 1 || c.maxSteps > 15000) throw new Error('Invalid finish.');
    } else if (c.kind === 'settings') validateSettings(c.settings);
    else throw new Error('Unknown audit command.');
  }
}

/** Bounded trace retains command events and execution transitions, not display frames. */
export function executeAuditCase(test, { mutateSnapshot, traceLimit = 200, stepLimit = 50000 } = {}) {
  validateAuditCase(test);
  let commandIndex = -1, paused = false, checkpoint = null, prior = null, steps = 0, trace = [], lastSignature = '', lastSnapshot = null;
  const counts = { slices: 0, commands: 0, completed: 0, caught: 0, obstructed: 0, conflicts: 0, restores: 0 };
  const coverage = { actionKinds: new Set(), phases: new Set(), completedKinds: new Set(), defenseSchemes: new Set(), commandKinds: new Set() };
  const coverageReport = () => Object.fromEntries(Object.entries(coverage).map(([key, values]) => [key, [...values].sort()]));
  let run, stop = () => {};
  const source = JSON.stringify(test.drawing);
  const append = event => { trace.push(event); if (trace.length > traceLimit) trace.shift(); };
  const accept = (snapshot, discontinuity = false) => {
    const original = mutateSnapshot ? structuredClone(snapshot) : snapshot;
    mutateSnapshot?.(snapshot, { commandIndex, steps }); // Used only by audit self-tests.
    lastSnapshot = snapshot;
    const summary = { atMs: round(snapshot.elapsedMs), commandIndex, ball: snapshot.ball.kind, holder: snapshot.controllerId,
      actions: snapshot.actions.filter(a => a.execution).map(a => ({ key: a.key, phase: a.execution.phase, notice: a.execution.notice,
        ...(a.transfer ? { transfer: a.transfer.outcome.kind } : {}) })) };
    const signature = JSON.stringify([summary.ball, summary.holder, summary.actions]);
    if (signature !== lastSignature) { append(summary); lastSignature = signature; }
    verifySnapshot(snapshot, prior, { discontinuity });
    coverage.defenseSchemes.add(snapshot.defenseScheme);
    for (const a of snapshot.actions) {
      coverage.actionKinds.add(a.kind);
      if (a.execution) coverage.phases.add(a.execution.phase);
      const old = prior?.actions.find(p => p.key === a.key);
      if (a.execution?.phase === 'completed' && old?.execution?.phase !== 'completed') { counts.completed++; coverage.completedKinds.add(a.kind); }
      if (a.transfer?.outcome.kind === 'caught' && old?.transfer?.outcome.kind !== 'caught') counts.caught++;
      if (a.execution?.phase === 'obstructed' && old?.execution?.phase !== 'obstructed') counts.obstructed++;
      if (a.execution?.phase === 'conflict' && old?.execution?.phase !== 'conflict') counts.conflicts++;
    }
    prior = original;
  };
  const advance = delta => {
    if (++steps > stepLimit) throw new AuditFailure('step-budget', 'run', 'Command sequence exceeded the fixed-step budget.');
    const before = paused ? inspectSimulationExecution(run) : null;
    if (!paused) advanceSimulationState(run, delta);
    if (paused && JSON.stringify(inspectSimulationExecution(run)) !== JSON.stringify(before)) throw new AuditFailure('pause', 'run', 'Paused advancement changed execution.');
    // Also inspect no-op and sub-step calls; the internal observer handles all actual slices.
    accept(inspectSimulationExecution(run));
  };
  try {
    run = createSimulationRun(test.drawing, test.settings, undefined, { seed: test.seed, recordSession: false });
    stop = watchSimulationExecution(run, snapshot => { counts.slices++; accept(snapshot); });
    accept(inspectSimulationExecution(run));
    for (const [index, command] of test.commands.entries()) {
      commandIndex = index; counts.commands++;
      coverage.commandKinds.add(command.kind);
      append({ commandIndex, atMs: round(run.elapsedMs), command });
      switch (command.kind) {
        case 'pause': paused = true; break;
        case 'resume': paused = false; break;
        case 'advance': for (let n = 0; n < command.steps; n++) advance(command.deltaMs); break;
        case 'finish': {
          let n = 0; while (run.elapsedMs < run.durationMs - 1e-6 && n++ < command.maxSteps) advance(STEP_MS);
          requireInvariant(run.elapsedMs >= run.durationMs - 1e-6, 'liveness', 'run', 'Possession did not finish within the supported audit budget.'); break;
        }
        case 'settings': setSimulationRunSettings(run, command.settings); accept(inspectSimulationExecution(run)); break;
        case 'edit': {
          const draft = structuredClone(run.source), roster = command.team === 'player' ? draft.players : draft.defenders;
          Object.assign(roster.find(p => p.id === command.id), command.point);
          editPausedSimulationMarker(run, command.team, command.id, command.point, draft); accept(inspectSimulationExecution(run), true); break;
        }
        case 'attributes': {
          const draft = structuredClone(run.source), p = draft.players.find(p => p.id === command.id);
          p.ratings = { threePoint: command.rating, midrange: command.rating, finishing: command.rating }; p.badges = [command.badge];
          requireInvariant(rebasePausedSimulation(run, draft), 'paused-edit', 'run', 'Compatible attribute edit was rejected.');
          accept(inspectSimulationExecution(run), true); break;
        }
        case 'checkpoint': checkpoint = { state: cloneSimulationExecution(run), paused }; break;
        case 'restore': restoreSimulationExecution(run, cloneSimulationExecution(checkpoint.state)); paused = checkpoint.paused; counts.restores++; accept(inspectSimulationExecution(run), true); break;
      }
    }
    requireInvariant(JSON.stringify(test.drawing) === source, 'source-mutation', 'drawing', 'Execution changed the input drawing.');
    return { ok: true, counts, coverage: coverageReport(), final: inspectSimulationExecution(run), trace };
  } catch (error) {
    return { ok: false, counts, coverage: coverageReport(), failure: { code: error.code ?? 'engine-exception', subject: error.subject ?? 'run', message: error.message,
      commandIndex, atMs: round(run?.elapsedMs ?? 0), snapshot: lastSnapshot, stack: error.stack }, trace: [...trace, { error: error.message, atMs: round(run?.elapsedMs ?? 0), commandIndex }] };
  } finally { stop(); }
}

/** Delta debugging + scalar simplification. Preserve the same failure code and
 * subject, never turn an invalid drawing/command into the reproducer. A budget
 * bounds local work; a fixed point is 1-minimal under the documented edits. */
export function reduceAuditFailure(input, { execute = executeAuditCase, maxRuns = 300 } = {}) {
  let best = structuredClone(input), result = execute(best), runs = 1, changed = true;
  if (result.ok) throw new Error('Cannot reduce a passing audit case.');
  const identity = failure => `${failure.code}:${failure.subject}${failure.code === 'engine-exception' ? `:${failure.message}` : ''}`;
  const target = identity(result.failure);
  const tryCase = candidate => {
    if (runs >= maxRuns) return false;
    try { validateAuditCase(candidate); } catch { return false; }
    runs++;
    const outcome = execute(candidate);
    if (!outcome.ok && identity(outcome.failure) === target) { best = candidate; result = outcome; return true; }
    return false;
  };
  const removeChunks = field => {
    let granularity = 2;
    while (best[field].length && runs < maxRuns) {
      const length = best[field].length, chunk = Math.ceil(length / granularity); let reduced = false;
      for (let start = 0; start < length && runs < maxRuns; start += chunk) {
        const candidate = structuredClone(best); candidate[field].splice(start, chunk);
        if (tryCase(candidate)) { changed = reduced = true; granularity = Math.max(2, granularity - 1); break; }
      }
      if (!reduced) { if (granularity >= length) break; granularity = Math.min(length, granularity * 2); }
    }
  };
  while (changed && runs < maxRuns) {
    changed = false;
    removeChunks('commands');
    // Removal alone can leave many individually essential short advances.
    // Try the same elapsed budget at one cadence; retain it only if the exact
    // failure survives (floating boundaries or intervening edits may matter).
    for (let start = 0; start < best.commands.length && runs < maxRuns; start++) {
      if (best.commands[start].kind !== 'advance') continue;
      let end = start, total = 0;
      while (end < best.commands.length && best.commands[end].kind === 'advance') {
        const c = best.commands[end++]; total += c.steps * Math.max(0, c.deltaMs);
      }
      const whole = Math.floor((total + 1e-6) / STEP_MS), remainder = Math.max(0, total - whole * STEP_MS);
      const combined = [...(whole ? [{ kind: 'advance', steps: whole, deltaMs: STEP_MS }] : []),
        ...(remainder > 1e-6 ? [{ kind: 'advance', steps: 1, deltaMs: remainder }] : [])];
      if (combined.length < end - start) {
        const candidate = structuredClone(best); candidate.commands.splice(start, end - start, ...combined);
        if (tryCase(candidate)) { changed = true; continue; }
      }
      start = end - 1;
    }
    // Treat drawing arrays through the same reducer, retaining participant references.
    for (const field of ['arrows', 'defenders', 'players']) {
      const length = best.drawing[field].length;
      for (let i = length - 1; i >= 0 && runs < maxRuns; i--) {
        const candidate = structuredClone(best), removed = candidate.drawing[field].splice(i, 1)[0];
        if (field === 'players') {
          candidate.drawing.arrows = candidate.drawing.arrows.filter(a => !['actor_id', 'recipient_id', 'screener_id', 'handler_id', 'cutter_id'].some(k => a[k] === removed.id));
          candidate.commands = candidate.commands.filter(c => !((c.kind === 'attributes' || c.kind === 'edit' && c.team === 'player') && c.id === removed.id));
          if (!candidate.drawing.players.length) candidate.drawing.ball = null;
        }
        if (field === 'defenders') candidate.commands = candidate.commands.filter(c => !(c.kind === 'edit' && c.team === 'defender' && c.id === removed.id));
        if (tryCase(candidate)) changed = true;
      }
    }
    for (let i = 0; i < best.commands.length && runs < maxRuns; i++) {
      const c = best.commands[i], field = c.kind === 'advance' ? 'steps' : c.kind === 'finish' ? 'maxSteps' : null;
      if (!field || c[field] === 1) continue;
      let low = 1, high = c[field];
      while (low < high && runs < maxRuns) {
        const middle = Math.floor((low + high) / 2), candidate = structuredClone(best); candidate.commands[i][field] = middle;
        if (tryCase(candidate)) { changed = true; high = middle; } else low = middle + 1;
      }
    }
    // Remove incidental attributes, then simplify coordinates in a strict order
    // so repeated passes cannot oscillate between equally complex drawings.
    for (const team of ['players', 'defenders']) for (let i = 0; i < best.drawing[team].length && runs < maxRuns; i++) {
      const marker = best.drawing[team][i];
      if (!marker.ratings && !marker.badges) continue;
      const candidate = structuredClone(best); delete candidate.drawing[team][i].ratings; delete candidate.drawing[team][i].badges;
      if (tryCase(candidate)) changed = true;
    }
    const points = play => [
      ...play.players, ...play.defenders, ...(play.ball ? [play.ball] : []),
      ...play.arrows.flatMap(a => [a.start, a.end, a.control, a.exit_target].filter(Boolean)),
    ];
    const cost = value => value === 0 ? 0 : value === 50 ? 1 : value === 100 ? 2 : Number.isInteger(value) ? 3 : close(value * 10, Math.round(value * 10)) ? 4 : 5;
    for (let i = 0; i < points(best.drawing).length && runs < maxRuns; i++) for (const axis of ['x', 'y']) {
      const value = points(best.drawing)[i][axis];
      for (const simple of [...new Set([0, 50, 100, Math.round(value), Math.round(value * 10) / 10])]) {
        if (cost(simple) >= cost(points(best.drawing)[i][axis])) continue;
        const candidate = structuredClone(best); points(candidate.drawing)[i][axis] = simple;
        if (tryCase(candidate)) changed = true;
      }
    }
  }
  return { test: best, result, runs, budgetExhausted: runs >= maxRuns, minimality: runs >= maxRuns ? 'budget-limited' : 'deletion-and-step-1-minimal' };
}

export function readableTrace(test, result, reduction = null) {
  return [`Adversarial simulation audit v${AUDIT_VERSION}; engine ${SIMULATION_ENGINE_VERSION}; seed ${test.seed}; ${test.layout}`,
    `Failure: ${result.failure?.code ?? 'none'} / ${result.failure?.subject ?? ''}: ${result.failure?.message ?? 'passed'}`,
    ...(reduction ? [`Reduction: ${reduction.runs} runs, ${reduction.minimality}`] : []),
    ...result.trace.map(item => item.command ? `${item.atMs} ms | command ${item.commandIndex}: ${JSON.stringify(item.command)}`
      : item.error ? `${item.atMs} ms | FAIL ${item.error}` : `${item.atMs} ms | ball=${item.ball}, holder=${item.holder ?? 'none'} | ${item.actions.map(a => `${a.key}=${a.phase}${a.transfer ? `/${a.transfer}` : ''}${a.notice ? ` (${a.notice})` : ''}`).join('; ')}`),
    ...(result.failure?.snapshot ? ['Failed execution snapshot:', JSON.stringify(result.failure.snapshot, null, 2)] : []), ''].join('\n');
}
