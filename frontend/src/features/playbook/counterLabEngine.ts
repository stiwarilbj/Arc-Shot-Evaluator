import type { DefenseScheme, PlaybookDraft, SimulationSettings } from "./types.ts";
import {
  advanceSimulationRun,
  createSimulationRun,
  observeCounterLabRun,
  SIMULATION_STEP_MS,
} from "./simulation.ts";
import { DEFAULT_SIMULATION_SETTINGS } from "./types.ts";
import { createCounterLabRepairs, type CounterLabFrame, type CounterLabMode, type CounterLabProfile, type CounterLabRepair, type CounterLabResult } from "./counterLabTypes.ts";

export type CounterLabRepairSummary = Omit<CounterLabRepair, "results"> & { results: Array<Omit<CounterLabResult, "trace">> };
export type CounterLabAnalysis = { results: Array<Omit<CounterLabResult, "trace">>; repairs: CounterLabRepairSummary[]; detailTraces: Map<string, CounterLabFrame[]> };
export type CounterLabProgress = { completed: number; total: number; label: string };

export function runCounterLabTrial(
  draft: PlaybookDraft,
  profile: CounterLabProfile,
  mode: CounterLabMode,
  shouldCancel: () => boolean = () => false,
): CounterLabResult {
  const settings: SimulationSettings = {
    ...DEFAULT_SIMULATION_SETTINGS,
    defenseScheme: profile.scheme as DefenseScheme,
    defenseStrategy: profile.strategy,
    offenseMode: mode,
    automaticActions: mode === "scripted"
      ? { screen: false, handoff: false, pickRoll: false, offBallScreen: false }
      : { screen: true, handoff: true, pickRoll: true, offBallScreen: true },
  };
  const run = createSimulationRun(draft, settings);
  const trace: CounterLabFrame[] = [];
  let openingPeak = 0;
  let pendingLoss: number | null = null;
  let firstLostOpeningMs: number | null = null;
  let firstBlockedPass: CounterLabResult["firstBlockedPass"] = null;
  const appendObservation = () => {
    const observation = observeCounterLabRun(run);
    const opportunities = observation.opportunities;
    const best = opportunities.reduce((quality, option) => Math.max(quality, option.quality), 0);
    const currentOpening = opportunities.some((option) => option.quality >= 55);
    if (currentOpening) {
      openingPeak = Math.max(openingPeak, best);
      pendingLoss = null;
    } else if (openingPeak >= 55 && best <= openingPeak - 15) {
      pendingLoss ??= run.elapsedMs;
      if (firstLostOpeningMs == null && run.elapsedMs - pendingLoss >= 300) firstLostOpeningMs = pendingLoss;
    } else {
      pendingLoss = null;
    }
    if (!firstBlockedPass && observation.blockedPass) {
      firstBlockedPass = { atMs: run.elapsedMs, sequence: observation.sequence, ...observation.blockedPass };
    }
    const frame = observation.frame;
    trace.push({
      elapsedMs: run.elapsedMs,
      sequence: observation.sequence,
      action: observation.action,
      ballHandlerId: observation.ballHandlerId,
      assignments: observation.assignments,
      opportunities,
      blockedPass: observation.blockedPass,
      involvedPlayerIds: observation.involvedPlayerIds,
      activeRoutes: observation.activeRoutes,
      players: frame.players.map(({ id: playerId, x, y }) => ({ id: playerId, x, y })),
      defenders: frame.defenders.map(({ id: defenderId, x, y }) => ({ id: defenderId, x, y })),
      ball: frame.ball,
    });
  };
  appendObservation();
  let nextSample = 100;
  let steps = 0;
  while (run.elapsedMs < run.durationMs && steps++ < 20_000) {
    advanceSimulationRun(run, SIMULATION_STEP_MS, settings);
    if (run.elapsedMs >= nextSample) {
      appendObservation();
      nextSample += 100;
      if (shouldCancel()) throw new DOMException("Analysis cancelled", "AbortError");
    }
  }
  if (trace.at(-1)?.elapsedMs !== run.elapsedMs) appendObservation();
  const actions = [...new Set(run.actions.filter((action) => !action.automatic).map((action) => action.arrow.kind.replaceAll("-", " ")))];
  const finalShotQuality = run.frame.shotQuality;
  const score = Math.round(finalShotQuality);
  const createdAdvantage = openingPeak >= 55;
  const outcome = mode === "scripted"
    ? "Authored sequence only · adaptive recovery off"
    : run.adaptiveActionsTaken > 0
      ? `Offense recovered with ${run.adaptiveActionsTaken} live-read action${run.adaptiveActionsTaken === 1 ? "" : "s"}.`
      : run.adaptiveReadLabel ?? "No adaptive continuation was needed.";
  const lossAt = firstLostOpeningMs;
  const causeAction = lossAt == null ? null : trace.find((frame) => frame.elapsedMs >= lossAt)?.action ?? null;
  const key = `${profile.id}:${mode}`;
  return {
    key, profile, mode, score, finalShotQuality, createdAdvantage, outcome, firstLostOpeningMs, firstBlockedPass,
    actions, notice: causeAction ? `The opening closed during ${causeAction}.` : null, trace,
  };
}

export async function analyzeCounterLab(
  draft: PlaybookDraft,
  profiles: CounterLabProfile[],
  modes: CounterLabMode[],
  onProgress: (progress: CounterLabProgress) => void,
  shouldCancel: () => boolean = () => false,
): Promise<CounterLabAnalysis> {
  const repairs = createCounterLabRepairs(draft);
  const variants = [{ id: "original", name: "Original", reason: "The authored Playbook actions." }, ...repairs];
  const total = variants.length * profiles.length * modes.length;
  let completed = 0;
  const originalResults: CounterLabResult[] = [];
  const candidateResults = new Map<string, CounterLabResult[]>();
  variants.forEach((variant) => candidateResults.set(variant.id, []));
  for (const variant of variants) {
    const play = variant.id === "original" ? draft : ("play" in variant ? variant.play : draft);
    for (const profile of profiles) {
      for (const mode of modes) {
        if (shouldCancel()) throw new DOMException("Analysis cancelled", "AbortError");
        const result = runCounterLabTrial(play, profile, mode, shouldCancel);
        candidateResults.get(variant.id)?.push(result);
        if (variant.id === "original") originalResults.push(result);
        onProgress({ completed: ++completed, total, label: `${variant.name} · ${profile.label} · ${mode === "scripted" ? "Drawn play" : "Adaptive offense"}` });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  const baseScores = new Map(originalResults.map((result) => [result.key, result.score]));
  const verified = repairs.map((repair) => {
    const results = candidateResults.get(repair.id) ?? [];
    const gains = results.map((result) => result.score - (baseScores.get(result.key) ?? result.score));
    const averageGain = gains.length ? gains.reduce((sum, gain) => sum + gain, 0) / gains.length : 0;
    const baselineByKey = new Map(originalResults.map((result) => [result.key, result]));
    const resolvedBreakdowns = results.filter((result) => {
      const baseline = baselineByKey.get(result.key);
      if (!baseline) return false;
      const openingResolved = baseline.firstLostOpeningMs != null
        && (result.firstLostOpeningMs == null || result.firstLostOpeningMs - baseline.firstLostOpeningMs >= 300);
      const passResolved = baseline.firstBlockedPass != null && result.firstBlockedPass == null;
      return openingResolved || passResolved;
    }).length;
    return { ...repair, results, averageGain, bestGain: Math.max(0, ...gains), resolvedBreakdowns };
  })
    .filter((repair) => (repair.bestGain >= 5 && repair.averageGain >= 1) || repair.resolvedBreakdowns > 0)
    .sort((a, b) => b.resolvedBreakdowns - a.resolvedBreakdowns || b.averageGain - a.averageGain || b.bestGain - a.bestGain || a.name.localeCompare(b.name))
    .slice(0, 3);
  const detailTraces = new Map<string, CounterLabFrame[]>();
  originalResults.forEach((result) => detailTraces.set(`original:${result.key}`, result.trace));
  for (const repair of verified) {
    for (const result of repair.results) detailTraces.set(`${repair.id}:${result.key}`, result.trace);
  }
  return {
    results: originalResults.map(({ trace: _trace, ...result }) => result),
    repairs: verified.map(({ results: repairResults, ...repair }) => ({
      ...repair,
      results: repairResults.map(({ trace: _trace, ...result }) => result),
    })),
    detailTraces,
  };
}
