import { newCreationId } from "./creationAttempt.ts";
import { ArrowVisibilityControl, useArrowVisibility } from "./ArrowVisibilityControl";
import { CourtRoutes } from "./CourtRoutes";
import { authoredCourtRoutes, bindAuthoredActions, pointDistanceFeet } from "./simulation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, FlaskConical, LoaderCircle, Pause, Play, RotateCcw, Save, X } from "lucide-react";
import type { PlaybookDraft, PlaybookDocument } from "./types";
import { clonePlaybook } from "./types";
import { createPlaybook, fetchPlaybooks, subscribePlaybooks } from "./api";
import { STARTER_PLAYS } from "./data";
import { COUNTER_LAB_DEFAULT_PROFILES, COUNTER_LAB_EXTRA_SCHEMES, COUNTER_LAB_EXTRA_STRATEGIES, eligibleCounterLabSchemes, type CounterLabFrame, type CounterLabMode, type CounterLabProfile, type CounterLabRepair, type CounterLabSummary, type CounterLabMessage, type CounterLabProgress } from "./counterLabTypes";
import { DILEMMA_CHOICES, dilemmaChoiceLabel, dilemmaReleaseMilestones, type DefenderDilemmaChoice, type DefenderDilemmaConfiguration, type DefenderDilemmaChoiceSummary, type DefenderDilemmaProgress, type DefenderDilemmaSetup } from "./defenderDilemma.ts";
import { advanceReplay, matchesReplay, replayFrame } from "./counterLabReplay";
import { decodeReplayForPlayback } from "./counterLabReplayValidation.ts";
import { createDecodedReplayCache } from "./decodedReplayCache.ts";
import { COURT_VIEWBOX, courtPointToSvg } from "./courtGeometry";
import { CourtMarkings } from "./CourtMarkings";
import { flattenPlaybookPath } from "./playbookBranches.ts";
import { AdvantageRelay, type AdvantageRelaySelection, type AdvantageRelaySide } from "./AdvantageRelay.tsx";
import { validateAdvantageRelay } from "./counterLabAdvantageRelay.ts";
const requestId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clock = (time: number) => `${(time / 1000).toFixed(1)}s`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${Number(value.toFixed(1))}`;
const modeName = (mode: CounterLabMode) => mode === "scripted" ? "Drawn play" : "Adaptive offense";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Something went wrong · Please retry";
function validDilemmaSummary(value: unknown): value is DefenderDilemmaChoiceSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  if (!DILEMMA_CHOICES.includes(summary.choice as DefenderDilemmaChoice)
    || !["released", "trigger-not-reached", "release-not-reached"].includes(summary.status as string)
    || !Number.isFinite(summary.durationMs) || (summary.durationMs as number) <= 0 || typeof summary.message !== "string") return false;
  const start = summary.startedAtMs, release = summary.releasedAtMs;
  if (!(start === null || Number.isFinite(start) && (start as number) >= 0)
    || !(release === null || Number.isFinite(release) && (release as number) >= 0)) return false;
  if (summary.status === "released") return start !== null && release !== null && (release as number) >= (start as number) && (release as number) <= (summary.durationMs as number);
  if (summary.status === "trigger-not-reached") return start === null && release === null;
  return start !== null && release === null;
}
function validateRelaySummaries(values: unknown, play: PlaybookDraft) {
  if (!Array.isArray(values) || values.length > 64) throw new Error("Counter Lab returned an invalid Advantage Relay summary · Retry the analysis");
  const playerIds = new Set(play.players.map((player) => player.id));
  const defenderIds = new Set(play.defenders.length ? play.defenders.map((player) => player.id) : play.players.slice(0, 5).map((_, index) => index + 1));
  for (const item of values) {
    if (!item || typeof item !== "object") throw new Error("Counter Lab returned an invalid Advantage Relay summary · Retry the analysis");
    const summary = item as Record<string, unknown>;
    validateAdvantageRelay(summary.advantageRelay, playerIds, defenderIds);
  }
}

export function CounterLab({ active, currentDraft, requestedPlay, onOpenEditor, onOpenInPlaybook }: {
  active: boolean; currentDraft: PlaybookDraft | null; requestedPlay: { requestId: string; play: PlaybookDraft } | null;
  onOpenEditor: () => void; onOpenInPlaybook: (play: PlaybookDocument) => void;
}) {
  const [draft, setDraft] = useState(() => clonePlaybook(requestedPlay?.play ?? currentDraft ?? STARTER_PLAYS[0]));
  const [source, setSource] = useState(currentDraft || requestedPlay ? "Playbook draft" : "Starter play");
  const [saved, setSaved] = useState<PlaybookDocument[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [playQuery, setPlayQuery] = useState("");
  const [profiles, setProfiles] = useState<CounterLabProfile[]>(() => [...COUNTER_LAB_DEFAULT_PROFILES]);
  const [modes, setModes] = useState<CounterLabMode[]>(["scripted", "adaptive"]);
  const [advanced, setAdvanced] = useState(false);
  const [results, setResults] = useState<CounterLabSummary[] | null>(null);
  const [repairs, setRepairs] = useState<CounterLabRepair[]>([]);
  const [selection, setSelection] = useState({ profileId: "switch", mode: "scripted" as CounterLabMode });
  const [repairId, setRepairId] = useState("original");
  const [baselineTrace, setBaselineTrace] = useState<CounterLabFrame[] | null>(null);
  const [repairTrace, setRepairTrace] = useState<CounterLabFrame[] | null>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [courtView, setCourtView] = useState<"original" | "repair" | "dilemma">("original");
  const [relayFocus, setRelayFocus] = useState<{ side: AdvantageRelaySide; playerIds: number[]; defenderIds: number[]; actionIds: string[] } | null>(null);
  const [progress, setProgress] = useState<CounterLabProgress | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailRetry, setDetailRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedCopies, setSavedCopies] = useState<Record<string, PlaybookDocument>>({});
  const [saveMessage, setSaveMessage] = useState("");
  const [dilemmaSetup, setDilemmaSetup] = useState<DefenderDilemmaSetup>({ defenderId: null, stayWithPlayerId: null, tagPlayerId: null, actionId: "", milestone: "" });
  const [dilemmaSummaries, setDilemmaSummaries] = useState<DefenderDilemmaChoiceSummary[]>([]);
  const [dilemmaProgress, setDilemmaProgress] = useState<DefenderDilemmaProgress | null>(null);
  const [dilemmaError, setDilemmaError] = useState("");
  const [dilemmaTrace, setDilemmaTrace] = useState<CounterLabFrame[] | null>(null);
  const [dilemmaChoice, setDilemmaChoice] = useState<DefenderDilemmaChoice>("stay");
  const [dilemmaPickTarget, setDilemmaPickTarget] = useState<"defenderId" | "stayWithPlayerId" | "tagPlayerId" | null>(null);
  const reportWorker = useRef<Worker | null>(null), pendingWorker = useRef<Worker | null>(null);
  const simulationWorker = useRef<Worker | null>(null);
  const [repairCreates] = useState(() => new Map<string, { draft: PlaybookDraft; id: string }>());
  const reportId = useRef(""), pendingId = useRef("");
  const dilemmaRequest = useRef<{ id: string; dilemmaId: string } | null>(null);
  const dilemmaOwner = useRef<{ id: string; dilemmaId: string } | null>(null);
  const dilemmaDetail = useRef<{ id: string; dilemmaId: string; detailId: string; choice: DefenderDilemmaChoice } | null>(null);
  const expectedDetail = useRef<{ id: string; detailId: string; key: string; repairId: string } | null>(null);
  const [replayCache] = useState(createDecodedReplayCache);
  const libraryVersion = useRef(0), saveLock = useRef(false), positionRef = useRef(0);
  const resultsRef = useRef<HTMLElement>(null);
  const key = `${selection.profileId}:${selection.mode}`;
  const baseline = results?.find((result) => result.key === key) ?? null;
  const eligibleRepairs = useMemo(() => repairs.flatMap((repair) => {
    const evidence = repair.evidence.find((e) => e.key === key);
    return evidence?.verified ? [{ repair, evidence }] : [];
  }).sort((a, b) => Number(b.evidence.cleared) - Number(a.evidence.cleared) || b.evidence.gain - a.evidence.gain || a.repair.name.localeCompare(b.repair.name))
    .slice(0, 3).map((entry) => ({ ...entry, negatives: entry.repair.evidence.filter((e) => e.gain < 0).length })), [repairs, key]);
  const chosenRepair = eligibleRepairs.find(({ repair }) => repair.id === repairId)?.repair ?? null;
  const chosenId = chosenRepair?.id ?? "original";
  const repaired = chosenRepair?.results.find((result) => result.key === key) ?? null;
  const dilemmaMode = courtView === "dilemma";
  const playbackTrace = dilemmaMode ? dilemmaTrace : baselineTrace;
  const duration = dilemmaMode ? dilemmaTrace?.at(-1)?.elapsedMs ?? 0 : Math.max(baselineTrace?.at(-1)?.elapsedMs ?? 0, repairTrace?.at(-1)?.elapsedMs ?? 0);
  const relayDuration = Math.max(duration, baseline?.advantageRelay.durationMs ?? 0, repaired?.advantageRelay.durationMs ?? 0);
  const originalFrame = replayFrame(playbackTrace, position);
  const repairedFrame = chosenRepair ? replayFrame(repairTrace, position) : null;
  const schemes = eligibleCounterLabSchemes(draft.defenders.length || Math.min(5, draft.players.length), draft.players.length);
  const dilemmaActions = useMemo(() => bindAuthoredActions(draft).filter((action) => dilemmaReleaseMilestones(action.arrow.kind).length), [draft]);
  const dilemmaAction = dilemmaActions.find((action) => action.arrow.id === dilemmaSetup.actionId) ?? null;
  const dilemmaMilestones = dilemmaAction ? dilemmaReleaseMilestones(dilemmaAction.arrow.kind) : [];
  const replayDefenders = baselineTrace?.[0]?.defenders ?? draft.defenders;
  const selectedDilemmaSummary = dilemmaSummaries.find((summary) => summary.choice === dilemmaChoice) ?? null;
  const spotlight = dilemmaSetup.defenderId == null ? undefined : { defenderId: dilemmaSetup.defenderId,
    playerIds: [dilemmaSetup.stayWithPlayerId, dilemmaSetup.tagPlayerId].filter((id): id is number => id != null) };
  const dilemmaPlaybackFrame = dilemmaMode ? originalFrame : null;
  const dilemmaDefender = dilemmaPlaybackFrame?.defenders.find((player) => player.id === dilemmaSetup.defenderId);
  const stayThreat = dilemmaPlaybackFrame?.players.find((player) => player.id === dilemmaSetup.stayWithPlayerId);
  const tagThreat = dilemmaPlaybackFrame?.players.find((player) => player.id === dilemmaSetup.tagPlayerId);
  const stayOpportunity = dilemmaPlaybackFrame?.opportunities.find((option) => option.playerId === dilemmaSetup.stayWithPlayerId);
  const tagOpportunity = dilemmaPlaybackFrame?.opportunities.find((option) => option.playerId === dilemmaSetup.tagPlayerId);
  const showReplay = useCallback(({ original, repaired }: { original: CounterLabFrame[]; repaired: CounterLabFrame[] | null }) => {
    setBaselineTrace(original); setRepairTrace(repaired); setDetailError("");
    positionRef.current = Math.min(positionRef.current, Math.max(original.at(-1)?.elapsedMs ?? 0, repaired?.at(-1)?.elapsedMs ?? 0)); setPosition(positionRef.current);
  }, []);
  const refreshLibrary = useCallback(() => {
    const version = ++libraryVersion.current;
    void fetchPlaybooks().then((plays) => { if (version === libraryVersion.current) { setSaved(plays); setLibraryError(""); } }).catch((caught: unknown) => { if (version === libraryVersion.current) setLibraryError(messageOf(caught)); });
  }, []);
  useEffect(() => {
    refreshLibrary(); const unsubscribe = subscribePlaybooks(refreshLibrary);
    return () => { ++libraryVersion.current; unsubscribe(); replayCache.reset(null); simulationWorker.current?.terminate(); simulationWorker.current = null; reportWorker.current = null; pendingWorker.current = null; };
  }, [refreshLibrary, replayCache]);
  useEffect(() => { if (active) refreshLibrary(); }, [active, refreshLibrary]);
  useEffect(() => { if (requestedPlay) loadPlay(requestedPlay.play, "Playbook draft"); }, [requestedPlay?.requestId]);
  useEffect(() => { if (!active) { setPlaying(false); cancelDilemma(true); } }, [active]);
  useEffect(() => { const pause = () => { if (document.hidden) setPlaying(false); }; document.addEventListener("visibilitychange", pause); return () => document.removeEventListener("visibilitychange", pause); }, []);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => {
    if (!playing || !active || !duration) return;
    let previous = performance.now(), handle = 0;
    const tick = (now: number) => {
      if (document.hidden) { setPlaying(false); return; }
      const next = advanceReplay(positionRef.current, now - previous, speed, duration); previous = now; positionRef.current = next; setPosition(next);
      if (next >= duration) setPlaying(false); else handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick); return () => cancelAnimationFrame(handle);
  }, [playing, active, speed, duration]);
  useEffect(() => {
    if (!baseline) return;
    setPlaying(false); setDetailError(""); expectedDetail.current = null;
    const expected = { id: reportId.current, detailId: requestId(), key, repairId: chosenId };
    const cached = replayCache.get(expected);
    if (cached) { showReplay(cached); return; }
    setBaselineTrace(null); setRepairTrace(null);
    if (!reportWorker.current) { setDetailError("The replay worker stopped · Test defenses again to restore replay"); return; }
    expectedDetail.current = expected;
    reportWorker.current.postMessage({ type: "details", ...expected });
    const timeout = window.setTimeout(() => { if (expectedDetail.current?.detailId === expected.detailId) setDetailError("Replay could not be loaded · Retry the replay or test defenses again"); }, 8000);
    return () => window.clearTimeout(timeout);
  }, [baseline, key, chosenId, detailRetry, replayCache, showReplay]);
  useEffect(() => { if (results && active) resultsRef.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }, [Boolean(results)]);

  function pauseAndSeek(time: number) { setPlaying(false); positionRef.current = Math.max(0, Math.min(time, duration)); setPosition(positionRef.current); }
  function cancelDilemma(clear = false) {
    const request = dilemmaOwner.current ?? dilemmaRequest.current;
    if (request) reportWorker.current?.postMessage({ type: "dilemma-cancel", ...request });
    dilemmaRequest.current = null; dilemmaOwner.current = null; dilemmaDetail.current = null;
    setDilemmaProgress(null); setDilemmaPickTarget(null);
    if (clear) { setDilemmaSummaries([]); setDilemmaTrace(null); setDilemmaError(""); }
  }
  function resetDilemmaResults() {
    cancelDilemma(true); setCourtView("original"); pauseAndSeek(0);
  }
  function setDilemmaRole(role: "defenderId" | "stayWithPlayerId" | "tagPlayerId", id: number) {
    resetDilemmaResults(); setDilemmaSetup((current) => ({ ...current, [role]: id }));
    setDilemmaPickTarget(null);
  }
  function editDilemmaSetup(update: (current: DefenderDilemmaSetup) => DefenderDilemmaSetup) {
    resetDilemmaResults(); setDilemmaSetup(update);
  }
  function pickDilemmaMarker(id: number) {
    if (!dilemmaPickTarget) return;
    setDilemmaRole(dilemmaPickTarget, id);
  }
  function clearReport() {
    if (pendingId.current) pendingWorker.current?.postMessage({ type: "cancel", id: pendingId.current });
    if (reportId.current) reportWorker.current?.postMessage({ type: "release", id: reportId.current });
    cancelDilemma(true);
    pendingWorker.current = null; reportWorker.current = null;
    pendingId.current = ""; reportId.current = ""; expectedDetail.current = null;
    replayCache.reset(null);
    setProgress(null); setResults(null); setRepairs([]); setRepairId("original"); setRelayFocus(null); setBaselineTrace(null); setRepairTrace(null); setPlaying(false); setPosition(0); positionRef.current = 0;
    setSavedCopies({}); repairCreates.clear(); setSaveMessage(""); setError(""); setDetailError("");
  }
  function loadPlay(play: PlaybookDraft, origin: string) {
    const selectedPath = clonePlaybook(play);
    delete selectedPath.branches;
    clearReport(); setDraft(selectedPath); setSource(origin);
    setDilemmaSetup({ defenderId: null, stayWithPlayerId: null, tagPlayerId: null, actionId: "", milestone: "" }); setDilemmaChoice("stay");
    const allowed = new Set<string>(eligibleCounterLabSchemes(selectedPath.defenders.length || Math.min(5, selectedPath.players.length), selectedPath.players.length).map((profile) => profile.id));
    setProfiles((current) => current.filter((profile) => !COUNTER_LAB_EXTRA_SCHEMES.some((extra) => extra.id === profile.id) || allowed.has(profile.id)));
  }
  function chooseResult(profileId: string, mode = selection.mode) { resetDilemmaResults(); setSelection({ profileId, mode }); setRepairId("original"); setRelayFocus(null); setCourtView("original"); pauseAndSeek(0); }
  function toggleProfile(profile: CounterLabProfile) { clearReport(); setProfiles((current) => current.some((item) => item.id === profile.id) ? current.filter((item) => item.id !== profile.id) : [...current, profile]); }
  function toggleMode(mode: CounterLabMode) { clearReport(); setModes((current) => current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode]); }
  function cancel() {
    const worker = pendingWorker.current; if (worker) worker.postMessage({ type: "cancel", id: pendingId.current });
    pendingWorker.current = null; pendingId.current = ""; setProgress(null); setSaveMessage("Comparison cancelled · Completed results remain available");
  }
  function runAnalysis() {
    if (pendingWorker.current || !draft.players.length || !draft.arrows.length || !profiles.length || !modes.length) return;
    setPlaying(false); setError(""); setSaveMessage("");
    const id = requestId(); let worker: Worker;
    try { worker = simulationWorker.current ??= new Worker(new URL("./counterLab.worker.ts", import.meta.url), { type: "module" }); }
    catch { setError("Analysis could not start · Reload Counter Lab and retry; your play is unchanged"); return; }
    pendingWorker.current = worker; pendingId.current = id;
    worker.onmessage = (event: MessageEvent<CounterLabMessage>) => {
      const raw = event.data as unknown;
      if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string" || typeof (raw as { id?: unknown }).id !== "string") return;
      const message = raw as CounterLabMessage;
      if (message.type.startsWith("dilemma-")) {
        if (message.type === "dilemma-details") {
          const expected = dilemmaDetail.current;
          if (!expected || message.id !== expected.id || message.dilemmaId !== expected.dilemmaId || message.detailId !== expected.detailId || message.choice !== expected.choice) return;
          dilemmaDetail.current = null;
          if (!message.archive) { setDilemmaError("This comparison replay is unavailable · Run the three choices again"); return; }
          try { const frames = decodeReplayForPlayback(message.archive); setDilemmaTrace(frames); positionRef.current = 0; setPosition(0); setCourtView("dilemma"); setDilemmaError(""); }
          catch (caught) { setDilemmaError(messageOf(caught)); }
          return;
        }
        if (message.type === "dilemma-error" && message.detailId) {
          if (dilemmaDetail.current?.detailId !== message.detailId || dilemmaDetail.current.id !== message.id || dilemmaDetail.current.dilemmaId !== message.dilemmaId) return;
          dilemmaDetail.current = null; setDilemmaError(message.message); return;
        }
        const expected = dilemmaRequest.current;
        if (!expected || !("dilemmaId" in message) || message.id !== expected.id || message.dilemmaId !== expected.dilemmaId) return;
        if (message.type === "dilemma-progress") {
          if (!Number.isInteger(message.completed) || message.completed < 0 || message.completed > 3 || message.total !== 3
            || typeof message.label !== "string" || !DILEMMA_CHOICES.includes(message.choice)) return;
          setDilemmaProgress(message); return;
        }
        if (message.type === "dilemma-complete") {
          const valid = Array.isArray(message.summaries) && message.summaries.length === 3
            && message.summaries.every(validDilemmaSummary)
            && new Set(message.summaries.map((summary) => summary.choice)).size === 3
            && DILEMMA_CHOICES.every((choice) => message.summaries.some((summary) => summary.choice === choice));
          if (!valid) { setDilemmaError("The worker returned an incomplete comparison · Retry the Dilemma"); dilemmaRequest.current = null; setDilemmaProgress(null); return; }
          dilemmaRequest.current = null; setDilemmaProgress(null); setDilemmaSummaries(message.summaries); setDilemmaError(""); return;
        }
        if (message.type === "dilemma-cancelled") { dilemmaRequest.current = null; setDilemmaProgress(null); return; }
        if (message.type === "dilemma-error") {
          dilemmaRequest.current = null;
          setDilemmaProgress(null); setDilemmaError(message.message); return;
        }
        return;
      }
      if (message.type === "details") {
        if (!matchesReplay(message, expectedDetail.current) || message.id !== reportId.current) return;
        expectedDetail.current = null;
        if (!message.original || (message.repairId !== "original" && !message.repaired)) { setDetailError("This replay is unavailable · Test defenses again to regenerate it"); return; }
        try {
          const original = decodeReplayForPlayback(message.original), repaired = message.repaired ? decodeReplayForPlayback(message.repaired) : null;
          replayCache.set(message, { original, repaired });
          showReplay({ original, repaired });
        } catch (caught) { setDetailError(messageOf(caught)); }
        return;
      }
      if (message.type === "error" && message.detailId) {
        if (message.id !== reportId.current || message.detailId !== expectedDetail.current?.detailId) return;
        expectedDetail.current = null; setDetailError(message.message); return;
      }
      if (message.id !== pendingId.current) return;
      if (message.type === "progress") setProgress(message);
      if (message.type === "baseline") {
        try { validateRelaySummaries(message.results, draft); }
        catch (caught) { worker.postMessage({ type: "cancel", id: message.id }); setError(messageOf(caught)); setProgress(null); pendingWorker.current = null; pendingId.current = ""; return; }
        if (reportId.current && reportId.current !== message.id) reportWorker.current?.postMessage({ type: "release", id: reportId.current });
        reportWorker.current = worker; reportId.current = message.id;
        replayCache.reset(message.id);
        setResults(message.results); setRepairs([]); setRepairId("original"); setSavedCopies({}); repairCreates.clear(); setPosition(0); positionRef.current = 0;
        const mode = modes.includes("scripted") ? "scripted" : modes[0];
        const candidates = message.results.filter((result) => result.mode === mode).sort((a, b) => Number(Boolean(b.firstBreakdown)) - Number(Boolean(a.firstBreakdown)) || a.score - b.score);
        setSelection({ profileId: candidates[0]?.profile.id ?? profiles[0].id, mode });
      }
      if (message.type === "complete") {
        try {
          for (const repair of message.repairs) validateRelaySummaries(repair.results, draft);
          setRepairs(message.repairs);
        } catch (caught) { setError(messageOf(caught)); }
        setProgress(null); pendingWorker.current = null; pendingId.current = "";
      }
      if (message.type === "error") { setError(message.message); setProgress(null); pendingWorker.current = null; pendingId.current = ""; }
      if (message.type === "cancelled") { setProgress(null); pendingWorker.current = null; pendingId.current = ""; }
    };
    worker.onerror = () => {
      if (worker !== simulationWorker.current) return; worker.terminate(); simulationWorker.current = null;
      if (worker === pendingWorker.current) { pendingWorker.current = null; pendingId.current = ""; setProgress(null); }
      if (worker === reportWorker.current) {
        reportWorker.current = null; expectedDetail.current = null; setDetailError("The replay worker stopped · Test defenses again to restore replay");
        if (dilemmaRequest.current || dilemmaDetail.current) {
          dilemmaRequest.current = null; dilemmaDetail.current = null; setDilemmaProgress(null);
          setDilemmaError("The comparison worker stopped · Completed Counter Lab results remain available; retry the Dilemma");
        }
      }
      setError("Analysis stopped unexpectedly · Your play and completed results are unchanged; try again");
    };
    setProgress({ completed: 0, total: 0, label: "Preparing the same court for every defense", stage: "defenses" }); worker.postMessage({ type: "analyze", id, draft: clonePlaybook(draft), profiles, modes });
  }
  async function saveRepair() {
    if (!chosenRepair || savedCopies[chosenRepair.id] || saveLock.current) return;
    saveLock.current = true; setSaving(true); setError(""); const analysisId = reportId.current, repair = chosenRepair;
    try {
      const key = `${analysisId}:${repair.id}`;
      let attempt = repairCreates.get(key);
      if (!attempt) {
        const standalone = clonePlaybook(repair.play);
        delete standalone.branches;
        attempt = { id: newCreationId(), draft: { ...standalone, id: `draft-counter-${requestId()}`, created_at: undefined, updated_at: undefined, name: `${draft.name} · ${repair.name}`.slice(0, 80) } };
        repairCreates.set(key, attempt);
      }
      const copy = await createPlaybook(attempt.draft, attempt.id);
      if (reportId.current === analysisId) { setSavedCopies((current) => ({ ...current, [repair.id]: copy })); setSaveMessage(`Saved “${copy.name}” as a separate editable play`); }
    } catch (caught) { if (reportId.current === analysisId) setError(messageOf(caught)); }
    finally { saveLock.current = false; setSaving(false); }
  }
  function playPause() { if (position >= duration) { positionRef.current = 0; setPosition(0); } setPlaying((value) => !value); }
  function runDilemma() {
    if (!baseline || !reportId.current || !reportWorker.current || dilemmaRequest.current || !dilemmaSetup.defenderId
      || !dilemmaSetup.stayWithPlayerId || !dilemmaSetup.tagPlayerId || dilemmaSetup.stayWithPlayerId === dilemmaSetup.tagPlayerId
      || !dilemmaAction || !dilemmaSetup.milestone || !dilemmaMilestones.some((item) => item.id === dilemmaSetup.milestone)) return;
    resetDilemmaResults(); setDilemmaError(""); setPlaying(false); setCourtView("dilemma"); positionRef.current = 0; setPosition(0);
    const request = { id: reportId.current, dilemmaId: requestId() };
    dilemmaRequest.current = request; dilemmaOwner.current = request;
    const values = new Uint32Array(1);
    const seed = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(values)[0] : Date.now() >>> 0;
    const configuration: DefenderDilemmaConfiguration = { defenderId: dilemmaSetup.defenderId, stayWithPlayerId: dilemmaSetup.stayWithPlayerId,
      tagPlayerId: dilemmaSetup.tagPlayerId, actionId: dilemmaSetup.actionId, milestone: dilemmaSetup.milestone };
    setDilemmaProgress({ completed: 0, total: 3, choice: "stay", label: "Preparing three matched commitments" });
    try { reportWorker.current.postMessage({ type: "dilemma", ...request, draft: clonePlaybook(draft), profile: baseline.profile, mode: selection.mode, configuration, seed }); }
    catch (caught) { dilemmaRequest.current = null; setDilemmaProgress(null); setDilemmaError(messageOf(caught)); }
  }
  function selectDilemmaChoice(choice: DefenderDilemmaChoice) {
    setPlaying(false); setDilemmaChoice(choice); setCourtView("dilemma"); setDilemmaTrace(null); positionRef.current = 0; setPosition(0);
    if (!reportWorker.current || !dilemmaOwner.current || !dilemmaSummaries.some((summary) => summary.choice === choice)) return;
    const detailId = requestId();
    const expected = { ...dilemmaOwner.current, detailId, choice };
    dilemmaDetail.current = expected;
    try { reportWorker.current.postMessage({ type: "dilemma-details", ...expected }); }
    catch (caught) { dilemmaDetail.current = null; setDilemmaError(messageOf(caught)); }
  }
  function selectRelayEvent(side: AdvantageRelaySide, selection: AdvantageRelaySelection) {
    const value = selection.value;
    const playerIds = selection.kind === "event" ? selection.value.playerIds : [selection.value.giverId, selection.value.receiverId];
    const assignments = selection.kind === "event" ? selection.value.evidence.assignments : [];
    setRelayFocus({ side, playerIds, defenderIds: assignments.filter((assignment) => playerIds.includes(assignment.playerId)).map((assignment) => assignment.defenderId), actionIds: value.actionId ? [value.actionId] : [] });
    setCourtView(side);
    pauseAndSeek(value.atMs);
  }
  const previewRoutes = useMemo(() => authoredCourtRoutes(draft), [draft]);
  const preview: CounterLabFrame = { elapsedMs: 0, sequence: null, action: null, ballHandlerId: null, assignments: [], opportunities: [], blockedPass: null, involvedPlayerIds: [], activeRoutes: previewRoutes, players: draft.players, defenders: draft.defenders, ball: draft.ball, shotPhase: "idle" };

  return <main className="counter-lab-page">
    <header className="counter-lab-header"><div><span className="section-kicker">BREAK MY PLAY</span><h1><FlaskConical size={26} />Counter Lab</h1><p>See where your play breaks · Try a small change and test it again</p></div></header>
    <ol className="counter-steps" aria-label="Counter Lab workflow"><li className={!results ? "is-current" : ""}><b>1</b>Choose play</li><li className={progress ? "is-current" : ""}><b>2</b>Test defenses</li><li className={results ? "is-current" : ""}><b>3</b>Inspect breakdown</li><li className={chosenRepair ? "is-current" : ""}><b>4</b>Try repair</li></ol>
    <div className="counter-workbench"><aside className="counter-sidebar" aria-label="Play selection and test settings">
    <section className="counter-import-panel" aria-label="Choose a play"><div className="counter-import-heading"><h2>Choose a play</h2></div><label className="counter-play-search">Find a play<input type="search" value={playQuery} onChange={(event) => setPlayQuery(event.target.value)} placeholder="Search starter or saved plays" /></label>{currentDraft ? <button className="counter-import-choice" onClick={() => loadPlay(currentDraft, "Playbook draft")}><strong>Current Playbook draft</strong><span>{currentDraft.name}</span></button> : null}<h3>Saved plays</h3>{libraryError ? <div className="counter-alert" role="alert">{libraryError}<button className="counter-text-button" onClick={refreshLibrary}>Retry saved plays</button></div> : saved.length ? <div className="counter-import-list">{saved.filter((play) => play.name.toLowerCase().includes(playQuery.toLowerCase().trim())).map((play) => <div className="counter-import-family" key={play.id}>
      <button type="button" className="counter-import-choice" aria-pressed={source === "Saved play" && draft.id === play.id} onClick={() => loadPlay(flattenPlaybookPath(play), "Saved play · Main")}><strong>{play.name}</strong><span>{play.players.length} players · {play.arrows.length} actions · Main</span></button>
      {play.branches?.length ? <div className="counter-import-endings" role="group" aria-label={`${play.name} endings`}><span>Test one ending</span>{play.branches.map((branch) => <button type="button" key={branch.id} onClick={() => loadPlay(flattenPlaybookPath(play, branch.id, branch.label), `Saved play · ${branch.label}`)}>{branch.label}</button>)}</div> : null}
    </div>)}</div> : <p className="counter-muted">No saved plays yet · Choose a starter below</p>}<h3>Starter plays</h3><div className="counter-starters">{STARTER_PLAYS.filter((play) => play.name.toLowerCase().includes(playQuery.toLowerCase().trim())).map((play) => <button key={play.id} className="counter-chip" aria-pressed={source === "Starter play" && draft.id === play.id} onClick={() => loadPlay(play, "Starter play")}>{play.name}</button>)}</div>{playQuery.trim() && ![...saved, ...STARTER_PLAYS].some((play) => play.name.toLowerCase().includes(playQuery.toLowerCase().trim())) ? <p className="counter-muted" role="status">No matching plays · Try another name</p> : null}</section>
      <ArrowVisibilityControl />
      <details open={advanced} onToggle={(event) => { setAdvanced(event.currentTarget.open); if (!event.currentTarget.open) event.currentTarget.closest(".counter-sidebar")?.scrollTo({ top: 0 }); }} className="counter-settings"><summary>Test settings · {profiles.length} defenses · {modes.length === 2 ? "both offense modes" : modes.map(modeName).join(", ") || "choose a mode"}</summary><fieldset><legend>Defensive responses</legend><div className="counter-options">{[...COUNTER_LAB_DEFAULT_PROFILES, ...COUNTER_LAB_EXTRA_STRATEGIES, ...schemes].map((profile) => <label key={profile.id}><input type="checkbox" checked={profiles.some((item) => item.id === profile.id)} onChange={() => toggleProfile(profile)} />{profile.label}</label>)}</div></fieldset><fieldset><legend>Offense behavior</legend><div className="counter-options">{(["scripted", "adaptive"] as const).map((mode) => <label key={mode}><input type="checkbox" checked={modes.includes(mode)} onChange={() => toggleMode(mode)} />{modeName(mode)}</label>)}</div><p>Drawn play follows your actions · Adaptive offense can improvise</p></fieldset></details>
    </aside><div className="counter-main">
    <section className="counter-setup" aria-label="Play and test settings"><div className="counter-play-summary"><span className="section-kicker">1 · YOUR PLAY</span><h2>{draft.name}</h2><p>{source} · {draft.players.length} players · {draft.arrows.length} actions</p>{!draft.arrows.length ? <div className="counter-empty"><h3>Start with a play that has actions</h3><p>This draft has a starting lineup, but no moves to test</p><button className="counter-text-button" onClick={onOpenEditor}>Open Playbook to draw a play</button></div> : <p className="counter-muted">The original stays unchanged · Every defense starts with the same positions and ratings</p>}
      <div className="counter-run-row"><button className="button button-primary" disabled={!progress && (!draft.players.length || !draft.arrows.length || !profiles.length || !modes.length)} onClick={progress ? cancel : runAnalysis}>{progress ? <><X size={17} />Cancel test</> : <><FlaskConical size={17} />Test defenses</>}</button>{progress ? <div className="counter-progress" role="status"><strong>{progress.stage === "defenses" ? "Testing defenses" : "Testing repairs"}</strong><span>{progress.label}</span><progress max={progress.total || 1} value={progress.completed} aria-label="Comparison progress" /></div> : <span className="counter-muted">Runs in your browser</span>}</div>{(!profiles.length || !modes.length) ? <p role="status">Choose at least one defense and offense behavior in Test settings</p> : null}</div><div className="counter-preview"><CounterCourt title="Play preview" frame={preview} preview pickTarget={dilemmaPickTarget} onPick={pickDilemmaMarker} spotlight={spotlight} /></div></section>
    {error ? <div className="counter-alert" role="alert"><CircleAlert size={20} />{error}</div> : null}{saveMessage ? <div className="counter-success" role="status"><Check size={20} />{saveMessage}</div> : null}
    {results ? <section ref={resultsRef} className="counter-results" aria-label="Counter Lab results"><div className="counter-results-heading"><div><span className="section-kicker">3 · INSPECT THE RESULT</span><h2>How the defense answers</h2></div><div className="counter-mode-tabs" role="group" aria-label="Offense behavior results">{modes.map((mode) => <button key={mode} aria-pressed={selection.mode === mode} onClick={() => chooseResult(selection.profileId, mode)}>{modeName(mode)}</button>)}</div></div><div className="counter-matchups">{results.filter((result) => result.mode === selection.mode).map((result) => <button key={result.key} className={`counter-matchup ${selection.profileId === result.profile.id ? "is-selected" : ""}`} aria-pressed={selection.profileId === result.profile.id} onClick={() => chooseResult(result.profile.id)}><strong>{result.profile.label}</strong><b>{result.score}<small> / 100</small></b><span>{resultLabel(result)}</span></button>)}</div><p className="counter-score-note">Simulation quality score · This is not a real scoring probability</p>
      <div className="counter-inspect-layout"><div className="counter-playback">{chosenRepair || dilemmaSummaries.length ? <div className="counter-court-tabs" role="group" aria-label="Court comparison view"><button aria-pressed={courtView === "original"} onClick={() => { setCourtView("original"); setRelayFocus(null); setPlaying(false); }}>Original</button>{dilemmaSummaries.length ? <button aria-pressed={dilemmaMode} onClick={() => selectDilemmaChoice(dilemmaChoice)}>Defender Dilemma</button> : null}{chosenRepair ? <button aria-pressed={courtView === "repair"} onClick={() => { setCourtView("repair"); setRelayFocus(null); setPlaying(false); }}>Repair</button> : null}</div> : null}
        {!dilemmaMode && baseline ? <AdvantageRelay key={`${reportId.current}:${baseline.key}:${chosenId}`} original={baseline.advantageRelay} repaired={repaired?.advantageRelay ?? null} durationMs={relayDuration} positionMs={position} profile={baseline.profile} mode={baseline.mode} visibleSide={courtView} onSelect={selectRelayEvent} /> : null}
        <div className={`counter-courts ${dilemmaMode ? "is-single" : chosenRepair ? `mobile-${courtView}` : "is-single"}`}>{dilemmaMode ? <CounterCourt title={dilemmaChoiceLabel(dilemmaChoice, `Player ${dilemmaSetup.stayWithPlayerId ?? "?"}`, `Player ${dilemmaSetup.tagPlayerId ?? "?"}`)} frame={originalFrame} view="dilemma" spotlight={spotlight} /> : <><CounterCourt title="Original play" frame={originalFrame} view="original" pickTarget={dilemmaPickTarget} onPick={pickDilemmaMarker} spotlight={spotlight} relayFocus={relayFocus?.side === "original" ? relayFocus : null} />{chosenRepair ? <CounterCourt title={chosenRepair.name} frame={repairedFrame} view="repair" relayFocus={relayFocus?.side === "repair" ? relayFocus : null} /> : null}</>}</div>
        {detailError ? <div className="counter-alert" role="alert">{detailError}<button className="counter-text-button" onClick={() => setDetailRetry((value) => value + 1)}>Retry replay</button></div> : dilemmaMode && !dilemmaTrace ? <div className="counter-loading-detail" role="status"><LoaderCircle className="counter-spinner" size={20} />Loading the selected commitment…</div> : !playbackTrace ? <div className="counter-loading-detail" role="status"><LoaderCircle className="counter-spinner" size={20} />Loading the selected replay…</div> : <div className="counter-timeline" tabIndex={0} aria-label="Court replay controls" onKeyDown={(event) => { if ((event.target as HTMLElement).closest("select,input,button")) return; if (event.key === " ") { event.preventDefault(); playPause(); } if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); pauseAndSeek(position + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1000 : 100)); } if (event.key === "Home" || event.key === "End") { event.preventDefault(); pauseAndSeek(event.key === "Home" ? 0 : duration); } }}>
          <div className="counter-timeline-actions"><button aria-label={playing ? "Pause court replay" : "Play court replay"} onClick={playPause}>{playing ? <Pause size={18} /> : <Play size={18} />}{playing ? "Pause" : "Play"}</button><button aria-label="Restart court replay" onClick={() => pauseAndSeek(0)}><RotateCcw size={17} /></button><span>{clock(position)} / {clock(duration)}</span><label>Speed <select aria-label="Replay speed" value={speed} onChange={(event) => setSpeed(Number(event.currentTarget.value))}><option value={.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label></div><div className="counter-scrub-wrap"><input aria-label="Scrub court replay" type="range" min={0} max={duration || 1} step={50} value={position} onChange={(event) => pauseAndSeek(Number(event.currentTarget.value))} />{baseline?.firstBreakdown ? <button className="counter-scrub-marker" style={{ left: `${baseline.firstBreakdown.atMs / Math.max(1, duration) * 100}%` }} aria-label={`Jump to first breakdown at ${clock(baseline.firstBreakdown.atMs)}`} title="First breakdown" onClick={() => pauseAndSeek(baseline.firstBreakdown!.atMs)} /> : null}</div><div className="counter-scrub-foot"><span>{originalFrame?.action ?? "Possession"}</span>{baseline?.firstBreakdown ? <button className="counter-text-button" onClick={() => pauseAndSeek(baseline.firstBreakdown!.atMs)}>Jump to breakdown · {clock(baseline.firstBreakdown.atMs)}</button> : null}</div></div>}
      </div><aside className="counter-diagnosis"><span className="section-kicker">{baseline?.profile.label} · {modeName(selection.mode)}</span><h3>{baseline ? resultLabel(baseline) : "Choose a defense"}</h3><p>{baseline ? explainResult(baseline) : ""}</p>{baseline?.firstUnsafePass ? <div className="counter-warning"><strong>Contested pass · Move {baseline.firstUnsafePass.sequence}</strong><p>The lane was unsafe at {clock(baseline.firstUnsafePass.unsafeAtMs!)}. {baseline.firstUnsafePass.status === "delivered" ? "The pass was still delivered in this simulation" : baseline.firstUnsafePass.status === "interrupted" ? "The action was interrupted before a catch was recorded" : "The transfer later failed"}</p></div> : null}<p className="counter-outcome">{baseline?.outcome}</p>{baseline ? <details><summary>Simulation evidence</summary><p>Adaptive attempts: {baseline.adaptiveAttempts} · completed: {baseline.adaptiveSuccesses}</p>{baseline.actionDiagnostics?.filter((action) => action.notice).map((action) => <p key={action.actionId}>Move {action.sequence}: {action.notice}</p>)}{baseline.passDiagnostics.map((pass) => <p key={pass.actionId}>Move {pass.sequence}: Player {pass.actorId} → {pass.playerId ?? "missing receiver"} · {pass.status}{pass.unsafeAtMs != null ? ` · separation ${pass.receiverGap.toFixed(1)} ft, lane ${pass.laneGap.toFixed(1)} ft` : ""}</p>)}</details> : null}
        <details className="counter-dilemma"><summary>Defender Dilemma · test one defender’s choice</summary><p>Replay the same play, defense, and offense mode with three temporary commitments. The trigger and release use recorded events only.</p>
          {!replayDefenders.length ? <p className="counter-muted" role="status">This play has no available defenders · Add a defender in Playbook before comparing choices</p> : null}
          {draft.players.length < 2 ? <p className="counter-muted" role="status">Two offensive players are needed to compare a stay-with threat and a tag threat</p> : null}
          {!dilemmaActions.length ? <p className="counter-muted" role="status">No action in this play has a supported recorded release milestone</p> : null}
          <label>Defender<select aria-label="Dilemma defender" value={dilemmaSetup.defenderId ?? ""} onChange={(event) => { const defenderId = Number(event.currentTarget.value) || null; editDilemmaSetup((current) => ({ ...current, defenderId })); }}><option value="">Choose a defender</option>{replayDefenders.map((player) => <option key={player.id} value={player.id}>Defender {player.id}</option>)}</select></label><button type="button" className="counter-text-button" disabled={!baselineTrace} aria-pressed={dilemmaPickTarget === "defenderId"} onClick={() => setDilemmaPickTarget((current) => current === "defenderId" ? null : "defenderId")}>Pick defender on court</button>
          <label>Stay with<select aria-label="Stay with offensive player" value={dilemmaSetup.stayWithPlayerId ?? ""} onChange={(event) => { const stayWithPlayerId = Number(event.currentTarget.value) || null; editDilemmaSetup((current) => ({ ...current, stayWithPlayerId })); }}><option value="">Choose a threat</option>{draft.players.map((player) => <option key={player.id} value={player.id}>Player {player.id}</option>)}</select></label><button type="button" className="counter-text-button" aria-pressed={dilemmaPickTarget === "stayWithPlayerId"} onClick={() => setDilemmaPickTarget((current) => current === "stayWithPlayerId" ? null : "stayWithPlayerId")}>Pick stay-with threat on court</button>
          <label>Tag<select aria-label="Tag offensive player" value={dilemmaSetup.tagPlayerId ?? ""} onChange={(event) => { const tagPlayerId = Number(event.currentTarget.value) || null; editDilemmaSetup((current) => ({ ...current, tagPlayerId })); }}><option value="">Choose a threat</option>{draft.players.map((player) => <option key={player.id} value={player.id}>Player {player.id}</option>)}</select></label><button type="button" className="counter-text-button" aria-pressed={dilemmaPickTarget === "tagPlayerId"} onClick={() => setDilemmaPickTarget((current) => current === "tagPlayerId" ? null : "tagPlayerId")}>Pick tag threat on court</button>
          <label>Trigger action<select aria-label="Dilemma trigger action" value={dilemmaSetup.actionId} onChange={(event) => { const actionId = event.currentTarget.value; const action = dilemmaActions.find((item) => item.arrow.id === actionId); const first = action ? dilemmaReleaseMilestones(action.arrow.kind)[0] : null; editDilemmaSetup((current) => ({ ...current, actionId, milestone: first?.id ?? "" })); }}><option value="">Choose an action</option>{dilemmaActions.map((action) => <option key={action.arrow.id} value={action.arrow.id}>Move {action.sequence} · {action.arrow.kind.replaceAll("-", " ")}</option>)}</select></label>
          <label>Actual release milestone<select aria-label="Dilemma release milestone" value={dilemmaSetup.milestone} disabled={!dilemmaAction} onChange={(event) => { const milestone = event.currentTarget.value as DefenderDilemmaSetup["milestone"]; editDilemmaSetup((current) => ({ ...current, milestone })); }}><option value="">Choose a recorded event</option>{dilemmaMilestones.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          {dilemmaPickTarget ? <p className="counter-dilemma-pick" role="status">Choose {dilemmaPickTarget === "defenderId" ? "a defender" : dilemmaPickTarget === "stayWithPlayerId" ? "the stay-with player" : "the tag player"} on a court preview</p> : null}
          <button className="button button-primary" disabled={dilemmaProgress ? false : !baseline || !dilemmaSetup.defenderId || !dilemmaSetup.stayWithPlayerId || !dilemmaSetup.tagPlayerId || dilemmaSetup.stayWithPlayerId === dilemmaSetup.tagPlayerId || !dilemmaAction || !dilemmaSetup.milestone} onClick={dilemmaProgress ? () => cancelDilemma() : runDilemma}>{dilemmaProgress ? <><X size={16} />Cancel comparison</> : <><FlaskConical size={16} />Compare the three choices</>}</button>
          {dilemmaProgress ? <div className="counter-progress" role="status"><strong>Running Defender Dilemma</strong><span>{dilemmaProgress.label}</span><progress max={dilemmaProgress.total || 3} value={dilemmaProgress.completed} aria-label="Defender Dilemma progress" /></div> : null}
          {dilemmaError ? <div className="counter-alert" role="alert">{dilemmaError}<button className="counter-text-button" onClick={runDilemma}>Retry comparison</button></div> : null}
          {dilemmaSummaries.length ? <div className="counter-dilemma-results" aria-label="Defender commitment results">{dilemmaSummaries.map((summary) => { const milestoneLabel = dilemmaMilestones.find((item) => item.id === dilemmaSetup.milestone)?.label ?? "Release milestone"; return <button type="button" key={summary.choice} aria-pressed={dilemmaMode && dilemmaChoice === summary.choice} onClick={() => selectDilemmaChoice(summary.choice)}><strong>{dilemmaChoiceLabel(summary.choice, `Player ${dilemmaSetup.stayWithPlayerId}`, `Player ${dilemmaSetup.tagPlayerId}`)}</strong><span>{summary.status === "released" ? `Start ${clock(summary.startedAtMs ?? 0)} · ${milestoneLabel} at ${clock(summary.releasedAtMs ?? 0)}` : summary.status === "trigger-not-reached" ? "Trigger not reached" : `${milestoneLabel} not reached`}</span></button>; })}</div> : null}
          {selectedDilemmaSummary && dilemmaMode ? <div className="counter-dilemma-evidence"><p>{selectedDilemmaSummary.message}</p>{dilemmaDefender && stayThreat && tagThreat ? <><p>Recorded defender distances · Stay-with: {pointDistanceFeet(dilemmaDefender, stayThreat).toFixed(1)} ft · Tag: {pointDistanceFeet(dilemmaDefender, tagThreat).toFixed(1)} ft</p><p>Simulation opportunities · Player {dilemmaSetup.stayWithPlayerId}: {stayOpportunity ? `${stayOpportunity.kind}, score ${stayOpportunity.score}` : "none recorded"} · Player {dilemmaSetup.tagPlayerId}: {tagOpportunity ? `${tagOpportunity.kind}, score ${tagOpportunity.score}` : "none recorded"}</p></> : null}<small>Distances and options describe the simulation evidence · They do not establish that the play caused a reaction or that a threat was open</small></div> : null}
        </details>{repaired ? <div className="counter-repaired-outcome"><strong>Repair result</strong><p>{resultLabel(repaired)}</p><p>{repaired.outcome}</p></div> : null}</aside></div>
      <section className="counter-repairs" aria-label="Verified repairs"><span className="section-kicker">4 · TRY A REPAIR</span><h3>Small changes, tested against {baseline?.profile.label}</h3>{progress ? <p className="counter-muted" role="status">Your original results are ready · Repairs are still being tested</p> : !eligibleRepairs.length ? <p className="counter-no-repairs">No tested edit improved this matchup · Keep the original or inspect another defense</p> : null}<div className="counter-repair-grid">{eligibleRepairs.map(({ repair, evidence, negatives }) => <button key={repair.id} className={`counter-repair-card ${chosenId === repair.id ? "is-selected" : ""}`} aria-pressed={chosenId === repair.id} onClick={() => { setRepairId(repair.id); setCourtView("repair"); pauseAndSeek(0); }}><strong>{repair.name}</strong><b>{evidence.cleared ? "Breakdown cleared" : `${signed(evidence.gain)} quality points`}</b><span>{repair.reason}</span><small>{negatives ? `${negatives} other trial${negatives === 1 ? "" : "s"} had lower quality` : "No quality regression in the tested trials"}</small></button>)}</div>
        {chosenRepair ? <div className="counter-repair-details"><div className="counter-repair-toolbar"><button className="counter-text-button" onClick={() => { setRepairId("original"); setCourtView("original"); pauseAndSeek(0); }}>View original only</button>{savedCopies[chosenRepair.id] ? <button className="button button-primary" onClick={() => onOpenInPlaybook(savedCopies[chosenRepair.id])}>Open saved repair in Playbook</button> : <button className="button button-primary" disabled={saving} onClick={() => void saveRepair()}><Save size={17} />{saving ? "Saving…" : "Save repair to Playbook"}</button>}</div><div className="counter-action-changes"><strong>Changed actions</strong>{describeChanges(draft, chosenRepair.play).map((change) => <span key={change}>{change}</span>)}</div><details><summary>Compare all tested defenses</summary><div className="counter-table-wrap"><table><thead><tr><th>Defense / offense</th><th>Quality change</th><th>Breakdown</th></tr></thead><tbody>{chosenRepair.evidence.map((e) => <tr key={e.key}><th>{chosenRepair.results.find((r) => r.key === e.key)?.profile.label} · {modeName(chosenRepair.results.find((r) => r.key === e.key)!.mode)}</th><td>{signed(e.gain)}</td><td>{e.cleared ? "Cleared" : e.opening === "delayed" ? `Delayed ${clock(e.delayMs)}` : e.opening === "not created" ? "No advantage created" : e.opening === "still failing" ? "Still failing" : "Unchanged"}</td></tr>)}</tbody></table></div></details></div> : null}
      </section>
    </section> : null}
    </div></div>
  </main>;
}
function resultLabel(result: CounterLabSummary) {
  if (result.firstBreakdown) {
    const event = result.firstBreakdown;
    return event.kind === "failed-pass" ? `Transfer failed · Move ${event.sequence}` : event.kind === "obstructed-action" ? `Route obstructed · Move ${event.sequence}` : event.kind === "action-conflict" ? `Conflicting actions · Move ${event.sequence}` : `Opening lost · ${clock(event.atMs)}`;
  }
  return result.createdAdvantage ? "No breakdown detected" : "No clear advantage created";
}
function explainResult(result: CounterLabSummary) {
  if (result.firstBreakdown?.kind === "obstructed-action" || result.firstBreakdown?.kind === "action-conflict") return result.actionDiagnostics.find((action) => action.actionId === result.firstBreakdown?.actionId)?.notice ?? "This action could not finish cleanly within its bounded waiting window";
  if (result.firstBreakdown?.kind === "failed-pass") return `The authored pass or handoff did not complete at ${clock(result.firstBreakdown.atMs)} · The receiver did not catch the ball within the engine's retry window`;
  if (result.firstBreakdown?.kind === "opening-lost") return `An opening existed, then the best eligible option dropped by at least 15 quality points and stayed below the opening threshold for 0.3 seconds · ${result.notice ?? ""}`;
  return result.createdAdvantage ? "A clear option remained available · No sustained loss or failed authored transfer was recorded before the shot" : "This run did not create an eligible opening of 55 quality or higher · There is no lost advantage to diagnose";
}
function describeChanges(original: PlaybookDraft, repaired: PlaybookDraft) {
  return repaired.arrows.flatMap((arrow, index) => {
    const before = original.arrows.find((a) => a.id === arrow.id); if (!before) return [`Added ${arrow.kind}`]; const changes: string[] = [];
    if (before.kind !== arrow.kind) changes.push(`${before.kind.replaceAll("-", " ")} → ${arrow.kind.replaceAll("-", " ")}`);
    if (before.timing !== arrow.timing) changes.push(`duration ${(before.timing ?? 1.2).toFixed(2)}s → ${(arrow.timing ?? 1.2).toFixed(2)}s`);
    if (before.end.x !== arrow.end.x || before.end.y !== arrow.end.y) changes.push("destination changed");
    if (JSON.stringify(before.exit_target) !== JSON.stringify(arrow.exit_target)) changes.push("finish route changed");
    return changes.length ? [`Move ${arrow.sequence ?? index + 1}: ${changes.join(" · ")}`] : [];
  });
}
function CounterCourt({ title, frame, preview = false, view, pickTarget = null, onPick, spotlight, relayFocus }: {
  title: string; frame: CounterLabFrame | null; preview?: boolean; view?: string;
  pickTarget?: "defenderId" | "stayWithPlayerId" | "tagPlayerId" | null; onPick?: (id: number) => void;
  spotlight?: { defenderId: number; playerIds: number[] };
  relayFocus?: { playerIds: number[]; defenderIds: number[]; actionIds: string[] } | null;
}) {
  const visibility = useArrowVisibility();
  const involvedDefenders = new Set(frame?.assignments.filter((a) => frame.involvedPlayerIds.includes(a.playerId)).map((a) => a.defenderId));
  const pickable = Boolean(pickTarget && onPick);
  const highlightedActions = new Set(relayFocus?.actionIds ?? []);
  return <figure className={`counter-court ${preview ? "is-preview" : "is-replay"}`} data-view={view}><figcaption>{title}{pickable ? <span className="counter-dilemma-pick"> · Select {pickTarget === "defenderId" ? "a defender" : "an offensive threat"}</span> : null}</figcaption><svg viewBox={`0 0 ${COURT_VIEWBOX.width} ${COURT_VIEWBOX.height}`} role={pickable ? "group" : "img"} aria-label={`${title} court position`}><rect width={COURT_VIEWBOX.width} height={COURT_VIEWBOX.height} className="counter-court-floor" /><CourtMarkings /><CourtRoutes routes={frame?.activeRoutes ?? []} visibility={visibility} highlightActionIds={highlightedActions} />{frame?.defenders.map((defender) => { const p = courtPointToSvg(defender), selected = spotlight?.defenderId === defender.id; return <g key={`d${defender.id}`} className={`${involvedDefenders.has(defender.id) ? "counter-defender-involved " : ""}${relayFocus?.defenderIds.includes(defender.id) ? "is-relay-focus " : ""}${selected ? "is-dilemma-defender" : ""}${pickable && pickTarget === "defenderId" ? " is-pickable" : ""}`} role={pickable && pickTarget === "defenderId" ? "button" : undefined} tabIndex={pickable && pickTarget === "defenderId" ? 0 : undefined} aria-label={pickable && pickTarget === "defenderId" ? `Choose defender ${defender.id}` : undefined} onClick={pickable && pickTarget === "defenderId" ? () => onPick?.(defender.id) : undefined} onKeyDown={pickable && pickTarget === "defenderId" ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick?.(defender.id); } } : undefined}><circle cx={p.x} cy={p.y} r={selected ? 27 : preview ? 30 : 18} className="counter-dilemma-halo" /><circle cx={p.x} cy={p.y} r={preview ? 30 : 18} className="counter-defense-dot" /><text x={p.x} y={p.y + 2} className="counter-defender-number">{defender.id}</text></g>; })}{frame?.players.map((player) => { const p = courtPointToSvg(player), selected = spotlight?.playerIds.includes(player.id) ?? false, relaySelected = relayFocus?.playerIds.includes(player.id) ?? false; return <g key={`p${player.id}`} className={`${selected ? "is-dilemma-threat " : ""}${relaySelected ? "is-relay-focus " : ""}${pickable && pickTarget !== "defenderId" ? " is-pickable" : ""}`} role={pickable && pickTarget !== "defenderId" ? "button" : undefined} tabIndex={pickable && pickTarget !== "defenderId" ? 0 : undefined} aria-label={pickable && pickTarget !== "defenderId" ? `Choose player ${player.id}` : undefined} onClick={pickable && pickTarget !== "defenderId" ? () => onPick?.(player.id) : undefined} onKeyDown={pickable && pickTarget !== "defenderId" ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick?.(player.id); } } : undefined}><circle cx={p.x} cy={p.y} r={selected ? 27 : preview ? 30 : 18} className="counter-dilemma-halo" /><circle cx={p.x} cy={p.y} r={preview ? 30 : 18} className={`counter-offense-dot ${frame.involvedPlayerIds.includes(player.id) ? "is-involved" : ""}`} /><text x={p.x} y={p.y + 2} className="counter-player-number">{player.id}</text></g>; })}{frame?.ball ? (() => { const p = courtPointToSvg(frame.ball); const holder = frame.players.find((player) => player.id === frame.ballHandlerId); const attached = holder && Math.hypot(holder.x - frame.ball!.x, holder.y - frame.ball!.y) < .2; return <circle cx={p.x + (attached ? 14 : 0)} cy={p.y - (attached ? 14 : 0)} r="8" className="counter-ball-dot" />; })() : null}</svg><div className="counter-court-legend"><span><i className="counter-legend-offense" />Offense</span><span><i className="counter-legend-defense" />Defense</span>{spotlight ? <span>Dilemma focus <b>Defender {spotlight.defenderId} · Players {spotlight.playerIds.join(" & ")}</b></span> : null}{!preview ? <span>Best option <b>{frame ? Math.max(0, ...frame.opportunities.map((o) => o.quality)) : "—"}</b></span> : null}</div></figure>;
}
