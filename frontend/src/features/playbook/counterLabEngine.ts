import type { PlaybookDraft, SimulationSettings } from "./types.ts";
import { DEFAULT_SIMULATION_SETTINGS, validatePlaybookParticipants } from "./types.ts";
import { advanceSimulationRun, createSimulationRun, observeCounterLabRun, pointDistanceFeet, SIMULATION_STEP_MS } from "./simulation.ts";
import { createCounterLabRepairs, type CounterLabFrame, type CounterLabMode, type CounterLabProfile, type CounterLabRepair, type CounterLabResult, type CounterLabSummary, type CounterLabProgress, type PassDiagnostic, type RepairEvidence } from "./counterLabTypes.ts";

export type CounterLabAnalysis = { results: CounterLabSummary[]; repairs: CounterLabRepair[]; detailTraces: Map<string, CounterLabFrame[]> };
export type { CounterLabProgress } from "./counterLabTypes.ts";

/** Loss is a possession-level diagnosis. Released shots no longer have live openings. */
export function diagnoseOpenings(trace: CounterLabFrame[]) {
  let peak = 0;
  let pending: number | null = null;
  let lost: number | null = null;
  for (const frame of trace) {
    if (frame.shotPhase === "air" || frame.shotPhase === "result") break;
    const best = Math.max(0, ...frame.opportunities.map((option) => option.quality));
    if (best >= 55) { peak = Math.max(peak, best); pending = null; }
    else if (peak >= 55 && best <= peak - 15) {
      pending ??= frame.elapsedMs;
      if (lost == null && frame.elapsedMs - pending >= 300 - 1e-6) lost = pending;
    } else pending = null;
  }
  return { createdAdvantage: peak >= 55, firstLostOpeningMs: lost };
}

export function verifiedRecovery(trace: CounterLabFrame[], breakdownAt: number | null, successfulReadTimes: number[], shotQuality: number): number | null {
  if (breakdownAt == null) return null;
  let start: number | null = null;
  for (const frame of trace) {
    if (frame.elapsedMs <= breakdownAt || !successfulReadTimes.some((time) => time > breakdownAt && time <= frame.elapsedMs)) continue;
    if (frame.shotPhase === "air" || frame.shotPhase === "result") return shotQuality >= 55 ? frame.elapsedMs : null;
    if (frame.opportunities.some((option) => option.quality >= 55)) {
      start ??= frame.elapsedMs;
      if (frame.elapsedMs - start >= 300 - 1e-6) return start;
    } else start = null;
  }
  return null;
}

export function repairEvidence(original: CounterLabSummary, repaired: CounterLabSummary): RepairEvidence {
  const gain = repaired.finalShotQuality - original.finalShotQuality;
  const delayMs = original.firstLostOpeningMs != null && repaired.firstLostOpeningMs != null
    ? repaired.firstLostOpeningMs - original.firstLostOpeningMs : 0;
  const opening = original.firstLostOpeningMs == null ? "unchanged"
    : !repaired.createdAdvantage ? "not created"
    : repaired.firstLostOpeningMs == null ? "cleared"
    : delayMs >= 300 ? "delayed" : "still failing";
  const passCleared = Boolean(original.firstBlockedPass && repaired.passDiagnostics.some((pass) => pass.actionId === original.firstBlockedPass?.actionId && pass.status === "delivered") && !repaired.firstBlockedPass);
  const noEarlierFailure = !repaired.firstBreakdown || Boolean(original.firstBreakdown && repaired.firstBreakdown.atMs >= original.firstBreakdown.atMs);
  const actionCleared = Boolean(original.firstBreakdown?.actionId && repaired.actionDiagnostics?.some((action) => action.actionId === original.firstBreakdown!.actionId && action.phase === "completed"));
  const resolvedFirst = original.firstBreakdown?.kind === "opening-lost" ? opening === "cleared" : original.firstBreakdown?.kind === "failed-pass" ? passCleared : actionCleared;
  const cleared = gain >= 0 && noEarlierFailure && resolvedFirst;
  return { key: repaired.key, gain, verified: gain >= 5 || cleared, cleared, opening, delayMs, passCleared };
}

export function validateCounterLabInput(draft: PlaybookDraft, profiles: CounterLabProfile[], modes: CounterLabMode[]) {
  if (!draft || !Array.isArray(draft.players) || !Array.isArray(draft.defenders) || !Array.isArray(draft.arrows) || !draft.players.length) throw new Error("Choose a play with offensive players before testing defenses.");
  validatePlaybookParticipants(draft);
  const validPoint = (point: { x: number; y: number }) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;
  if ([...draft.players, ...draft.defenders].some((player) => !validPoint(player)) || (draft.ball && !validPoint(draft.ball))) throw new Error("This play has invalid court positions. Open it in Playbook to correct them.");
  for (const roster of [draft.players, draft.defenders]) if (new Set(roster.map((player) => player.id)).size !== roster.length || roster.some((player) => !Number.isInteger(player.id) || player.id < 1)) throw new Error("Player IDs must be unique positive numbers within each team.");
  const kinds = new Set(["movement", "pass", "screen", "slip-screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"]);
  if (new Set(draft.arrows.map((arrow) => arrow.id)).size !== draft.arrows.length || draft.arrows.some((arrow) => !arrow.id || !kinds.has(arrow.kind) || !validPoint(arrow.start) || !validPoint(arrow.end) || (arrow.control && !validPoint(arrow.control)) || (arrow.exit_target && !validPoint(arrow.exit_target)) || (arrow.timing != null && (!Number.isFinite(arrow.timing) || arrow.timing < .5 || arrow.timing > 4)) || (arrow.sequence != null && (!Number.isInteger(arrow.sequence) || arrow.sequence < 1)) || [arrow.actor_id, arrow.recipient_id, arrow.screener_id, arrow.cutter_id, arrow.handler_id].some((id) => id != null && !draft.players.some((player) => player.id === id)))) throw new Error("This play contains an invalid action or participant. Correct it in Playbook before testing.");
  if (!profiles.length || !modes.length || modes.some((mode) => mode !== "scripted" && mode !== "adaptive")) throw new Error("Choose at least one defense and offense behavior.");
}

export function runCounterLabTrial(draft: PlaybookDraft, profile: CounterLabProfile, mode: CounterLabMode, shouldCancel: () => boolean = () => false): CounterLabResult {
  validateCounterLabInput(draft, [profile], [mode]);
  const settings: SimulationSettings = { ...DEFAULT_SIMULATION_SETTINGS, defenseScheme: profile.scheme, defenseStrategy: profile.strategy, offenseMode: mode,
    automaticActions: mode === "scripted" ? { screen: false, handoff: false, pickRoll: false, offBallScreen: false } : { screen: true, handoff: true, pickRoll: true, offBallScreen: true } };
  const run = createSimulationRun(draft, settings);
  const trace: CounterLabFrame[] = [];
  const diagnosticTrace: CounterLabFrame[] = [];
  let nextDiagnosticMs = 0;
  const passes = new Map<string, PassDiagnostic>();
  const successfulReads = new Map<string, number>();
  function captureActions() {
    for (const action of run.actions) {
      if (run.elapsedMs + 1e-6 < action.startTime) continue;
      if (!action.automatic && !action.adaptiveReadLabel && (action.arrow.kind === "pass" || action.arrow.kind === "handoff")) {
        const previous = passes.get(action.arrow.id);
        passes.set(action.arrow.id, {
          actionId: action.arrow.id, sequence: action.sequence, actorId: action.actorId, playerId: action.recipientId,
          status: action.transferCompletedAtMs != null ? "delivered" : action.transferFailed ? "failed" : "interrupted",
          atMs: action.transferCompletedAtMs ?? action.transferFailedAtMs ?? action.startTime,
          unsafeAtMs: previous?.unsafeAtMs ?? null, receiverGap: previous?.receiverGap ?? 0, laneGap: previous?.laneGap ?? 0,
        });
      }
      if (action.adaptiveReadLabel && !action.transferFailed && !successfulReads.has(action.arrow.id)) {
        const actor = run.players.find((player) => player.id === action.actorId);
        const success = action.transferCompletedAtMs != null || (action.arrow.kind === "movement" && action.execution?.phase === "completed" && actor && pointDistanceFeet(actor, action.arrow.end) <= .6);
        if (success) successfulReads.set(action.arrow.id, action.transferCompletedAtMs ?? run.elapsedMs);
      }
    }
  }
  const append = () => {
    captureActions();
    const observation = observeCounterLabRun(run);
    if (observation.blockedPass) {
      const unsafe = observation.blockedPass;
      const pass = passes.get(unsafe.actionId);
      if (pass && pass.unsafeAtMs == null) Object.assign(pass, { unsafeAtMs: run.elapsedMs, receiverGap: unsafe.receiverGap, laneGap: unsafe.laneGap });
    }
    const frame = observation.frame;
    const sample: CounterLabFrame = { elapsedMs: run.elapsedMs, sequence: observation.sequence, action: observation.action, ballHandlerId: observation.ballHandlerId,
      assignments: observation.assignments, opportunities: observation.opportunities, blockedPass: observation.blockedPass,
      involvedPlayerIds: observation.involvedPlayerIds, activeRoutes: observation.activeRoutes,
      players: frame.players.map(({ id, x, y }) => ({ id, x, y })), defenders: frame.defenders.map(({ id, x, y }) => ({ id, x, y })), ball: frame.ball, shotPhase: frame.shotPhase, execution: frame.execution };
    trace.push(sample);
    if (run.elapsedMs + 1e-6 >= nextDiagnosticMs || run.elapsedMs >= run.durationMs) { diagnosticTrace.push(sample); nextDiagnosticMs += 100; }
  };
  append();
  let nextSample = SIMULATION_STEP_MS;
  let steps = 0;
  while (run.elapsedMs < run.durationMs && steps++ < 20_000) {
    if (shouldCancel()) throw new DOMException("Analysis cancelled", "AbortError");
    advanceSimulationRun(run, SIMULATION_STEP_MS, settings);
    captureActions();
    if (run.elapsedMs + 1e-6 >= nextSample) { append(); nextSample += SIMULATION_STEP_MS; }
  }
  if (run.elapsedMs < run.durationMs) throw new Error("This possession exceeded the simulation limit. Shorten the play and try again.");
  if (trace.at(-1)?.elapsedMs !== run.elapsedMs) append();
  const { createdAdvantage, firstLostOpeningMs } = diagnoseOpenings(diagnosticTrace);
  const passDiagnostics = [...passes.values()].sort((a, b) => a.atMs - b.atMs);
  const failed = passDiagnostics.find((pass) => pass.status === "failed" && pass.playerId != null);
  const firstBlockedPass = failed ? { ...failed, playerId: failed.playerId! } : null;
  const firstUnsafePass = [...passDiagnostics].filter((pass) => pass.unsafeAtMs != null).sort((a, b) => a.unsafeAtMs! - b.unsafeAtMs!)[0] ?? null;
  const lossFrame = firstLostOpeningMs == null ? null : trace.find((frame) => frame.elapsedMs >= firstLostOpeningMs)!;
  const events: NonNullable<CounterLabResult["firstBreakdown"]>[] = [];
  if (lossFrame) events.push({ kind: "opening-lost", atMs: firstLostOpeningMs!, sequence: lossFrame.sequence, actionId: null, playerId: lossFrame.ballHandlerId });
  if (firstBlockedPass) events.push({ kind: "failed-pass", atMs: firstBlockedPass.atMs, sequence: firstBlockedPass.sequence, actionId: firstBlockedPass.actionId, playerId: firstBlockedPass.playerId });
  const actionDiagnostics = run.frame.execution ?? [];
  for (const action of actionDiagnostics) if (action.phase === "obstructed" || action.phase === "conflict") {
    if (passDiagnostics.some((pass) => pass.actionId === action.actionId)) continue;
    events.push({ kind: action.phase === "conflict" ? "action-conflict" : "obstructed-action", atMs: action.completedAtMs ?? action.startedAtMs ?? 0, sequence: action.sequence, actionId: action.actionId, playerId: action.actorId });
  }
  const firstBreakdown = events.sort((a, b) => a.atMs - b.atMs)[0] ?? null;
  const releasedAtMs = trace.find((frame) => frame.shotPhase === "air" || frame.shotPhase === "result")?.elapsedMs ?? null;
  const recoveredAtMs = verifiedRecovery(diagnosticTrace, firstBreakdown?.atMs ?? null, [...successfulReads.values()], run.frame.shotQuality);

  const outcome = mode === "scripted" ? "Drawn actions only. Improvisation is off."
    : recoveredAtMs != null ? `Recovered after improvisation at ${(recoveredAtMs / 1000).toFixed(1)}s.`
    : run.adaptiveActionsTaken ? `${run.adaptiveActionsTaken} adaptive attempt${run.adaptiveActionsTaken === 1 ? "" : "s"}; ${firstBreakdown ? "no verified recovery" : "no breakdown required recovery"}.`
    : "No adaptive actions were attempted.";
  const actions = [...new Set(run.actions.filter((action) => !action.automatic && !action.adaptiveReadLabel).map((action) => action.arrow.kind.replaceAll("-", " ")))];
  return { key: `${profile.id}:${mode}`, profile, mode, score: Math.round(run.frame.shotQuality), finalShotQuality: run.frame.shotQuality, createdAdvantage, outcome,
    firstLostOpeningMs, firstBlockedPass, firstUnsafePass, passDiagnostics, firstBreakdown, releasedAtMs, adaptiveAttempts: run.adaptiveActionsTaken, adaptiveSuccesses: successfulReads.size, recoveredAtMs,
    actionDiagnostics, actions, notice: lossFrame?.action ? `The opening closed during ${lossFrame.action}.` : null, trace };
}

export async function analyzeCounterLab(draft: PlaybookDraft, profiles: CounterLabProfile[], modes: CounterLabMode[], onProgress: (progress: CounterLabProgress) => void,
  shouldCancel: () => boolean = () => false, onBaseline?: (results: CounterLabSummary[], traces: Map<string, CounterLabFrame[]>) => void): Promise<CounterLabAnalysis> {
  validateCounterLabInput(draft, profiles, modes);
  const repairs = createCounterLabRepairs(draft);
  const detailTraces = new Map<string, CounterLabFrame[]>();
  const originals: CounterLabSummary[] = [];
  const candidates: CounterLabRepair[] = [];
  const total = (repairs.length + 1) * profiles.length * modes.length;
  let completed = 0;
  for (const variant of [{ id: "original", name: "Original play", play: draft, reason: "" }, ...repairs]) {
    const results: CounterLabSummary[] = [];
    const traces = new Map<string, CounterLabFrame[]>();
    for (const profile of profiles) for (const mode of modes) {
      if (shouldCancel()) throw new DOMException("Analysis cancelled", "AbortError");
      const { trace, ...result } = runCounterLabTrial(variant.play, profile, mode, shouldCancel);
      results.push(result); traces.set(`${variant.id}:${result.key}`, trace);
      onProgress({ completed: ++completed, total, label: `${profile.label} · ${mode === "scripted" ? "Drawn play" : "Adaptive offense"}`, stage: variant.id === "original" ? "defenses" : "repairs" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (variant.id === "original") {
      originals.push(...results); traces.forEach((trace, key) => detailTraces.set(key, trace));
      onBaseline?.(originals, detailTraces);
    } else {
      const evidence = results.map((result) => repairEvidence(originals.find((original) => original.key === result.key)!, result));
      if (!evidence.some((item) => item.verified)) continue;
      traces.forEach((trace, key) => detailTraces.set(key, trace));
      candidates.push({ ...variant, results, evidence, averageGain: evidence.reduce((sum, item) => sum + item.gain, 0) / evidence.length,
        bestGain: Math.max(0, ...evidence.map((item) => item.gain)), resolvedBreakdowns: evidence.filter((item) => item.cleared).length });
    }
  }
  return { results: originals, repairs: candidates, detailTraces };
}
