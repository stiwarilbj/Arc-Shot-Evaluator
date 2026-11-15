import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { BarChart3, CircleDot, Waypoints } from "lucide-react";
import { CoachNotes } from "../features/analysis/CoachNotes";
import { ShotDataPanel } from "../features/analysis/ShotDataPanel";
import { ShotSelector } from "../features/analysis/ShotSelector";
import { shotPreviewStart, VideoWorkspace } from "../features/analysis/VideoWorkspace";
import { AnalysisQueue } from "../features/queue/AnalysisQueue";
import { ExampleVideoLibrary } from "../features/upload/ExampleVideoLibrary";
import { VideoUpload } from "../features/upload/VideoUpload";
import { PlaybookBoard } from "../features/playbook/PlaybookBoard";
import type { PlaybookDocument, PlaybookDraft } from "../features/playbook/types";
import { AppHeader } from "../layout/AppHeader";
import { HomePage } from "../features/home/HomePage";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";
import { IS_GITHUB_PAGES } from "../runtime";
import { isProcessingMode } from "../domain/analysisModes";
import { refreshBrowserShotReview } from "../domain/shotReview";
import {
  cancelAnalysisJob,
  fetchAnalysisJob,
  fetchExampleVideos,
  registerBrowserAnalysisSession,
  startExampleVideoAnalysis,
  startUploadedVideoAnalysis,
} from "../services/analysisApi";
import { analyzeVideoInBrowser } from "../services/browserAnalysis";
import type {
  AnalysisQueueItem,
  AnalysisSession,
  ExampleVideo,
  ProcessingMode,
  ShotMode,
  ThemeMode,
  VideoMode,
} from "../domain/analysisTypes";

const ShotformJenga = lazy(() => import("../features/games/ShotformJenga"));
const FreezeFloor = lazy(() => import("../features/freezeFloor/FreezeFloor"));
const JumperLab = lazy(() => import("../features/jumper/JumperLab"));
const CounterLab = lazy(() => import("../features/playbook/CounterLab").then((module) => ({ default: module.CounterLab })));

const WAIT_MS = 750;
const MAX_CONCURRENT_ANALYSES = 1;
const QUEUE_STORAGE_KEY = "arc-analysis-queue-v2";
const HOSTED_QUEUE_STORAGE_KEY = "arc-analysis-queue-pages-v1";
const HOSTED_UPLOAD_INTERRUPTED = "This upload was interrupted by a page reload · Add the video again";
const MISSING_REVIEW_RESULT = "No review result was saved · Analyze the video again";
function delay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    function cancel() {
      window.clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function fetchAnalysisJobWithRetries(jobId: string, signal: AbortSignal) {
  for (let retry = 0; ; retry += 1) {
    try {
      const state = await fetchAnalysisJob(jobId, signal);
      if (state.status === "done" && !state.result) throw new Error(MISSING_REVIEW_RESULT);
      return state;
    } catch (caught) {
      // A busy local worker can briefly interrupt a fetch while the browser
      // is still connected. Retry those transport errors before surfacing a
      // real analysis/API error in the queue.
      if (!(caught instanceof TypeError) || retry === 3 || signal.aborted) throw caught;
      await delay(350 * 2 ** retry, signal);
    }
  }
}

function createQueueItemId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createQueuedAnalysis(
  filename: string,
  file: File | undefined,
  exampleId: string | undefined,
  processingMode: ProcessingMode,
  shotMode: ShotMode,
): AnalysisQueueItem {
  return {
    id: createQueueItemId(exampleId ? "example" : "upload"),
    filename,
    kind: exampleId ? "example" : "upload",
    file,
    exampleId,
    status: "queued",
    stage: "Waiting for an analysis slot",
    progress: 0,
    result: null,
    error: null,
    processingMode,
    shotMode,
  };
}

type PersistedQueueItem = Omit<AnalysisQueueItem, "file" | "result">;
type HostedPersistedQueueItem = Omit<AnalysisQueueItem, "file">;

export function ArcShotEvaluatorApp() {
  // The landing state intentionally starts empty. Previous sessions remain on
  // disk for export, but opening the page never surprises the user by loading
  // an old video or replaying a stale analysis.
  const [session, setSession] = useState<AnalysisSession | null>(null);
  const reviewOpen = useRef(false);
  const [queue, setQueue] = useState<AnalysisQueueItem[]>([]);
  const [hiddenQueueIds, setHiddenQueueIds] = useState<Set<string>>(new Set());
  const [examples, setExamples] = useState<ExampleVideo[]>([]);
  const [examplesLoading, setExamplesLoading] = useState(true);
  const [examplesError, setExamplesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedShot, setSelectedShot] = useState(0);
  const [reviewOpening, setReviewOpening] = useState(0);
  const [reviewSeek, setReviewSeek] = useState<{ time: number } | null>(null);
  const [mode, setMode] = useState<VideoMode>("pose");
  const { workspace, changeWorkspace, analysisView: tab, changeAnalysisView: setTab, jumperView, changeJumperView, playbookView, rolePlayerId, changePlaybookView } = useWorkspaceNavigation();
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("normal");
  // The selected analysis depth is captured into each queue item so changing
  // it never mutates a queued or active job.
  const [shotMode, setShotMode] = useState<ShotMode>("free_throw");
  const [shotformHasOpened, setShotformHasOpened] = useState(workspace === "shotform");
  const [freezeFloorHasOpened, setFreezeFloorHasOpened] = useState(workspace === "freezefloor");
  const [jumperHasOpened, setJumperHasOpened] = useState(workspace === "jumper");
  const [counterLabHasOpened, setCounterLabHasOpened] = useState(workspace === "counterlab");
  useEffect(() => {
    if (workspace === "shotform") setShotformHasOpened(true);
    if (workspace === "freezefloor") setFreezeFloorHasOpened(true);
    if (workspace === "jumper") setJumperHasOpened(true);
    if (workspace === "counterlab") setCounterLabHasOpened(true);
  }, [workspace]);
  const [counterLabPlay, setCounterLabPlay] = useState<PlaybookDraft | null>(null);
  const [counterLabRequest, setCounterLabRequest] = useState<{ requestId: string; play: PlaybookDraft } | null>(null);
  const [playbookRequest, setPlaybookRequest] = useState<{ requestId: string; play: PlaybookDocument } | null>(null);
  function testInCounterLab(play: PlaybookDraft) {
    setCounterLabRequest({ requestId: createQueueItemId("counter-import"), play });
    setCounterLabHasOpened(true);
    changeWorkspace("counterlab");
  }
  function openSavedPlayInEditor(play: PlaybookDocument) {
    setPlaybookRequest({ requestId: createQueueItemId("counter-copy"), play });
    changeWorkspace("playbook");
  }
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "dark";
    try { return window.localStorage.getItem("arc-theme-v2") === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  const activeQueueItemsRef = useRef<Set<string>>(new Set());
  const cancelledQueueItemsRef = useRef<Set<string>>(new Set());
  const queueControllersRef = useRef(new Map<string, AbortController>());
  const jobIdsRef = useRef<Map<string, string>>(new Map());
  const [queueHydrated, setQueueHydrated] = useState(false);
  const [queueSlotRevision, setQueueSlotRevision] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("arc-theme-v2", theme); } catch { /* Theme remains usable without storage. */ }
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    fetchExampleVideos(controller.signal)
      .then(setExamples)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setExamplesError(caught instanceof Error ? caught.message : "Could not load example clips");
      })
      .finally(() => setExamplesLoading(false));
    return () => controller.abort();
  }, []);

  function updateAnalysisQueueItem(id: string, patch: Partial<AnalysisQueueItem>) {
    setQueue((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let saved: Array<PersistedQueueItem | HostedPersistedQueueItem> = [];
    const storageKey = IS_GITHUB_PAGES ? HOSTED_QUEUE_STORAGE_KEY : QUEUE_STORAGE_KEY;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        saved = parsed.filter((item): item is PersistedQueueItem | HostedPersistedQueueItem => Boolean(item && typeof item.id === "string"));
      }
    } catch {
      saved = [];
    }
    if (IS_GITHUB_PAGES) {
      const restored = saved.map((item) => {
        const entry = { ...item, file: undefined, result: null };
        if ("result" in item && item.result) {
          try {
            const result = refreshBrowserShotReview(item.result);
            registerBrowserAnalysisSession(result);
            return { ...entry, result };
          } catch {
            return { ...entry, status: "error" as const, stage: "Review could not be restored", error: "Analyze the clip again to rebuild the result" };
          }
        }
        const unfinished = item.status === "queued" || item.status === "processing";
        if (item.kind === "example" && unfinished) {
          return { ...entry, status: "queued" as const, stage: "Ready to resume browser analysis" };
        }
        if (item.kind === "upload" && unfinished) {
          return { ...entry, status: "error" as const, progress: 0, stage: "Upload interrupted", error: HOSTED_UPLOAD_INTERRUPTED };
        }
        if (item.kind === "upload" && item.status === "done") {
          return { ...entry, status: "error" as const, stage: "Upload is available while this page is open", error: "This uploaded clip cannot be restored after a page reload" };
        }
        return entry;
      });
      setQueue(restored);
      setQueueHydrated(true);
      return;
    }
    const restored = saved.map((item): AnalysisQueueItem => {
      const entry = { ...item, file: undefined, result: null };
      if (item.status !== "queued" && item.status !== "processing") return entry;
      if (item.jobId) return { ...entry, status: "queued", stage: "Reconnecting to local analysis", error: null };
      if (item.kind === "example" && item.status === "queued") return entry;
      return {
        ...entry,
        status: "error",
        progress: 0,
        stage: "Analysis interrupted",
        error: item.kind === "upload"
          ? "This upload could not be resumed after reload · Add the video again"
          : "This example could not be resumed after reload · Choose it again",
      };
    });
    setQueue(restored);
    setQueueHydrated(true);
    restored.forEach((item) => {
      // The queue runner owns active jobs and is already polling their status.
      if (!item.jobId || item.status === "queued") return;
      fetchAnalysisJobWithRetries(item.jobId, signal)
        .then((state) => {
          if (signal.aborted) return;
          if (state.status === "done" && state.result) {
            updateAnalysisQueueItem(item.id, { status: "done", stage: "Analysis complete", progress: 100, result: state.result, error: null });
          } else if (state.status === "error" || state.status === "cancelled") {
            updateAnalysisQueueItem(item.id, { status: state.status, stage: state.stage, progress: 0, error: state.error });
          } else {
            updateAnalysisQueueItem(item.id, { status: "queued", stage: "Reconnected; analysis continues in the background", jobId: item.jobId, error: null });
          }
        })
        .catch((caught: unknown) => {
          if (signal.aborted) return;
          updateAnalysisQueueItem(item.id, { status: "error", stage: "Could not reconnect to analysis", error: caught instanceof Error ? caught.message : "Job status is unavailable" });
        });
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!queueHydrated) return;
    const storageKey = IS_GITHUB_PAGES ? HOSTED_QUEUE_STORAGE_KEY : QUEUE_STORAGE_KEY;
    const persisted = queue.map(({ file: _file, result, ...item }) => ({
      ...item,
      ...(IS_GITHUB_PAGES && item.kind === "example" ? { result } : {}),
    }));
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(persisted));
    } catch {
      // A large uploaded result should never block the queue or discard the
      // in-memory analysis when browser storage is unavailable or full.
    }
  }, [queue, queueHydrated]);

  async function processQueuedAnalysis(item: AnalysisQueueItem) {
    const controller = new AbortController();
    const { signal } = controller;
    queueControllersRef.current.set(item.id, controller);
    try {
      const analysisMode: ProcessingMode = isProcessingMode(item.processingMode) ? item.processingMode : "normal";
      const analysisShotMode: ShotMode = "free_throw";
      if (cancelledQueueItemsRef.current.has(item.id)) return;
      const stage = IS_GITHUB_PAGES ? "Starting browser analysis"
        : item.jobId ? "Reconnecting to local analysis" : "Starting analysis";
      updateAnalysisQueueItem(item.id, { status: "processing", stage, progress: 3, error: null });
      if (IS_GITHUB_PAGES) {
        const example = item.kind === "example" ? examples.find((candidate) => candidate.id === item.exampleId) : undefined;
        const source = item.file
          ?? example?.url
          // A restored Pages queue can start before the example manifest
          // request finishes; the filename is enough to resume the static
          // project asset without racing that request.
          ?? (item.kind === "example" ? new URL(`examples/${encodeURIComponent(item.filename)}`, document.baseURI).toString() : undefined);
        if (!source) throw new Error(item.kind === "upload" ? HOSTED_UPLOAD_INTERRUPTED : "This example is no longer available");
        const browserResult = await analyzeVideoInBrowser(
          source, item.filename, analysisMode, analysisShotMode, signal,
          (progress, stage) => {
            if (!signal.aborted) updateAnalysisQueueItem(item.id, { status: "processing", stage, progress, error: null });
          },
        );
        if (signal.aborted) {
          if (typeof source !== "string") URL.revokeObjectURL(browserResult.artifacts.original);
          return;
        }
        registerBrowserAnalysisSession(browserResult);
        updateAnalysisQueueItem(item.id, { status: "done", stage: "Analysis complete", progress: 100, result: browserResult, error: null });
        if (!reviewOpen.current) openAnalysis(browserResult);
        return;
      }
      const jobId = item.jobId ?? (item.kind === "example"
        ? await startExampleVideoAnalysis(item.exampleId ?? "", analysisMode, analysisShotMode)
        : item.file
          ? await startUploadedVideoAnalysis(item.file, analysisMode, analysisShotMode)
          : (() => { throw new Error("This upload was not started before the page closed"); })());
      jobIdsRef.current.set(item.id, jobId);
      if (cancelledQueueItemsRef.current.has(item.id)) {
        await cancelAnalysisJob(jobId).catch(() => undefined);
        return;
      }
      updateAnalysisQueueItem(item.id, { jobId });

      while (true) {
        const next = await fetchAnalysisJobWithRetries(jobId, signal);
        if (cancelledQueueItemsRef.current.has(item.id)) return;
        const rawProgress = next.frames_total
          ? Math.round((next.frames_done / next.frames_total) * 100)
          : 0;
        const rendering = /render|transcod|encod|finaliz/i.test(next.stage);
        // Rendering writes two full review videos and then transcodes them. Keep
        // that final phase visibly active without presenting a misleading 99%
        // plateau; completion is the only state that reaches 100%.
        const progress = next.status === "done"
          ? 100
          : rendering
            ? Math.min(98, Math.max(92, rawProgress ? 92 + Math.round(rawProgress * 0.06) : 94))
            : next.status === "processing"
              ? Math.min(90, Math.max(4, rawProgress))
              : 3;
        updateAnalysisQueueItem(item.id, {
          status: next.status === "error"
            ? "error"
            : next.status === "done"
              ? "done"
              : next.status === "cancelled"
                ? "cancelled"
                : "processing",
          stage: next.stage,
          progress,
          error: next.error,
        });
        if (next.status === "done" && next.result) {
          updateAnalysisQueueItem(item.id, { status: "done", stage: "Analysis complete", progress: 100, result: next.result, error: null });
          if (!reviewOpen.current) openAnalysis(next.result);
          return;
        }
        if (next.status === "cancelled") return;
        if (next.status === "error") throw new Error(next.error ?? "Analysis failed");
        await delay(WAIT_MS, signal);
      }
    } catch (caught) {
      if (cancelledQueueItemsRef.current.has(item.id)) return;
      const message = caught instanceof Error ? caught.message : "Analysis failed";
      updateAnalysisQueueItem(item.id, { status: "error", stage: "Analysis failed", error: message });
      setError(message);
    } finally {
      activeQueueItemsRef.current.delete(item.id);
      jobIdsRef.current.delete(item.id);
      queueControllersRef.current.delete(item.id);
      // The stopped row may already be gone and no longer trigger scheduling.
      if (cancelledQueueItemsRef.current.delete(item.id)) setQueueSlotRevision((revision) => revision + 1);
    }
  }

  useEffect(() => {
    const availableSlots = MAX_CONCURRENT_ANALYSES - activeQueueItemsRef.current.size;
    if (availableSlots <= 0) return;
    const nextItems = queue
      .filter((item) => item.status === "queued" && !activeQueueItemsRef.current.has(item.id))
      .slice(0, availableSlots);
    nextItems.forEach((item) => {
      activeQueueItemsRef.current.add(item.id);
      void processQueuedAnalysis(item);
    });
  }, [queue, queueSlotRevision]);

  function enqueueUploadedVideos(files: File[]) {
    if (!files.length) return;
    setError(null);
    setQueue((current) => [...current, ...files.map((file) => createQueuedAnalysis(file.name, file, undefined, processingMode, shotMode))]);
  }

  function enqueueExampleVideo(example: ExampleVideo) {
    setError(null);
    setQueue((current) => [...current, createQueuedAnalysis(example.filename, undefined, example.id, processingMode, shotMode)]);
  }

  function requestQueueCancellation(item: AnalysisQueueItem) {
    cancelledQueueItemsRef.current.add(item.id);
    queueControllersRef.current.get(item.id)?.abort();
    const jobId = item.jobId ?? jobIdsRef.current.get(item.id);
    if (jobId) void cancelAnalysisJob(jobId).catch(() => undefined);
  }

  function removeQueueItem(item: AnalysisQueueItem) {
    if (item.status === "processing" || activeQueueItemsRef.current.has(item.id)) requestQueueCancellation(item);
    setQueue((current) => current.filter((queuedItem) => queuedItem.id !== item.id));
    setHiddenQueueIds((current) => {
      if (!current.has(item.id)) return current;
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
  }

  function clearQueue() {
    const activeIds = new Set(activeQueueItemsRef.current);
    queue.forEach((item) => {
      if (item.status === "processing") activeIds.add(item.id);
    });
    setQueue((current) => current.filter((item) => activeIds.has(item.id)));
    setHiddenQueueIds(new Set());
  }

  function hideQueueItem(item: AnalysisQueueItem) {
    if (item.status === "processing") return;
    setHiddenQueueIds((current) => new Set(current).add(item.id));
  }

  function showHiddenQueueItems() {
    setHiddenQueueIds(new Set());
  }

  const queueActions = {
    hiddenIds: hiddenQueueIds,
    onFiles: enqueueUploadedVideos,
    onSelectResult: openCompletedAnalysis,
    onClear: clearQueue,
    onCancel: removeQueueItem,
    onDelete: removeQueueItem,
    onHide: hideQueueItem,
    onShowHidden: showHiddenQueueItems,
  };

  function openCompletedAnalysis(item: AnalysisQueueItem) {
    if (item.result) openAnalysis(item.result);
  }

  function openAnalysis(result: AnalysisSession) {
    reviewOpen.current = true;
    setSession(result);
    setReviewOpening((opening) => opening + 1);
    setSelectedShot(0);
    setReviewSeek(null);
    setMode("pose");
    setTab(result.shots.length ? "shot" : "overview");
    setError(null);
  }

  function handleSessionChange(next: AnalysisSession) {
    setSession((current) => current?.session.id === next.session.id ? next : current);
    setQueue((current) => current.map((item) => (
      item.result?.session.id === next.session.id ? { ...item, result: next } : item
    )));
  }

  function showHomePage() {
    reviewOpen.current = false;
    setTab("shot");
    changeWorkspace("analyzer");
    setSession(null);
    setReviewSeek(null);
    setError(null);
    setSelectedShot(0);
    setMode("pose");
  }

  const queuePanel = (
    <AnalysisQueue items={queue} {...queueActions} />
  );

  const shot = session?.shots[selectedShot] ?? null;
  const isJumpShot = session?.shot_mode === "jump_shot";
  const reviewKey = `${session?.session.id}:${reviewOpening}`;
  const analyzerView = session ? (
    <div className="analysis-review">
      <nav className="workspace-tabs" aria-label="Analysis views">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<BarChart3 size={17} />} label="Overview" />
        <TabButton active={tab === "shot"} onClick={() => setTab("shot")} icon={<CircleDot size={17} />} label={shot ? `Shot ${String(shot.id).padStart(2, "0")}` : "Shot"} />
        <TabButton active={tab === "tracking"} onClick={() => setTab("tracking")} icon={<Waypoints size={17} />} label="Tracking" />
      </nav>

      {tab === "overview" ? (
        <section className="overview-strip" aria-label="Session summary">
          <Summary label="Attempts" value={String(session.summary.attempts)} />
          <Summary label="Makes" value={String(session.summary.makes)} tone="make" />
          <Summary label={isJumpShot ? "Observed FG%" : "Observed FT%"} value={(isJumpShot ? session.summary.fg_pct : (session.summary.observed_ft_pct ?? session.summary.fg_pct)) === null ? "—" : `${(isJumpShot ? session.summary.fg_pct : (session.summary.observed_ft_pct ?? session.summary.fg_pct))?.toFixed(0)}%`} />
          <Summary label={isJumpShot ? "Three-point%" : "Future FT%"} value={isJumpShot ? (session.summary.observed_three_pct == null ? "—" : `${session.summary.observed_three_pct.toFixed(0)}%`) : (session.summary.predicted_ft_pct == null ? "Unavailable" : `${session.summary.predicted_ft_pct.toFixed(0)}%`)} />
          <Summary label="Best streak" value={String(session.summary.best_streak)} />
          <Summary label="Observation confidence" value={`${session.summary.average_confidence.toFixed(0)}%`} />
        </section>
      ) : null}
      {isJumpShot && session.summary.excluded_attempts ? <p className="warning-row" role="status">{session.summary.excluded_attempts} proposal(s) excluded from jump-shot statistics after review</p> : null}

      <main className="analysis-grid">
        <div className="analysis-main">
          <VideoWorkspace key={reviewKey} session={session} shot={shot} mode={mode} onMode={setMode} seekRequest={reviewSeek} active={workspace === "analyzer"} />
          <ShotSelector key={`shots:${reviewKey}`} session={session} selected={selectedShot} onSelect={(index) => {
            setSelectedShot(index);
            setReviewSeek({ time: shotPreviewStart(session.shots[index].release_time) });
            setTab("shot");
          }} />
          {session.warnings.length ? <div className="warning-row" role="status">{session.warnings.map((warning) => warning.replace(/[.!]+$/, "")).join(" · ")}</div> : null}
        </div>
        <aside className="analysis-side-workspace">
          <AnalysisQueue items={queue} compact activeSessionId={session.session.id} {...queueActions} />
          <div className={`analysis-detail-columns ${shot?.coaching ? "" : "analysis-detail-legacy"}`}>
            {shot?.coaching ? <CoachNotes shot={shot} /> : null}
            <ShotDataPanel session={session} shot={shot} tab={tab} onSessionChange={handleSessionChange} onSeekFrame={(frame) => setReviewSeek({ time: frame / Math.max(1, session.session.fps) })} />
          </div>
        </aside>
      </main>
    </div>
  ) : (
    <main className={`landing-layout ${queue.length ? "landing-has-queue" : "landing-empty"}`}>
      {queue.length ? queuePanel : null}
      <div className="landing-main">
        <VideoUpload
          error={error}
          onFiles={enqueueUploadedVideos}
          processingMode={processingMode}
          onProcessingModeChange={setProcessingMode}
          shotMode={shotMode}
          onShotModeChange={setShotMode}
        />
        <ExampleVideoLibrary examples={examples} loading={examplesLoading} error={examplesError} shotMode={shotMode} onSelect={enqueueExampleVideo} />
      </div>
    </main>
  );

  return (
    <div className={`app-shell ${workspace === "home" ? "home-app-shell" : workspace === "playbook" ? "playbook-app-shell" : workspace === "counterlab" ? "counter-lab-app-shell" : workspace === "shotform" ? "games-app-shell" : workspace === "freezefloor" ? "freeze-floor-app-shell" : workspace === "jumper" ? "jumper-app-shell" : session ? "analysis-session-shell" : ""}`}>
      <AppHeader filename={workspace === "analyzer" ? session?.session.filename : undefined} complete={Boolean(session && workspace === "analyzer")} onReset={showHomePage} onHome={() => { changeWorkspace("home"); window.scrollTo(0, 0); }} theme={theme} onThemeChange={setTheme} workspace={workspace} onWorkspaceChange={changeWorkspace} />
      {workspace === "home" ? <HomePage /> : null}
      {shotformHasOpened || workspace === "shotform" ? <div className={workspace === "shotform" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "shotform"}><Suspense fallback={<p role="status">Opening Shotform Jenga…</p>}><ShotformJenga active={workspace === "shotform"} /></Suspense></div> : null}
      <div className={workspace === "playbook" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "playbook"}>
        <PlaybookBoard active={workspace === "playbook"} view={playbookView} rolePlayerId={rolePlayerId} onViewChange={changePlaybookView} onTestInCounterLab={testInCounterLab} onDraftChange={setCounterLabPlay} requestedPlay={playbookRequest} />
      </div>
      {counterLabHasOpened || workspace === "counterlab" ? <div className={workspace === "counterlab" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "counterlab"}><Suspense fallback={<div className="counter-lab-loading" role="status">Loading Counter Lab…</div>}><CounterLab active={workspace === "counterlab"} currentDraft={counterLabPlay} requestedPlay={counterLabRequest} onOpenEditor={() => changeWorkspace("playbook")} onOpenInPlaybook={openSavedPlayInEditor} /></Suspense></div> : null}
      {freezeFloorHasOpened || workspace === "freezefloor" ? <div className={workspace === "freezefloor" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "freezefloor"}><Suspense fallback={<p role="status">Opening Freeze Floor…</p>}><FreezeFloor active={workspace === "freezefloor"} /></Suspense></div> : null}
      {jumperHasOpened || workspace === "jumper" ? <div className={workspace === "jumper" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "jumper"}><Suspense fallback={<p role="status">Opening Guess the Jumper…</p>}><JumperLab active={workspace === "jumper"} tab={jumperView} onTabChange={changeJumperView} /></Suspense></div> : null}
      <div className={workspace === "analyzer" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "analyzer"}>
        {analyzerView}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button type="button" className={active ? "is-active" : ""} onClick={onClick}>{icon}{label}</button>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: "make" }) {
  return <div><span>{label}</span><strong className={tone ? `text-${tone}` : ""}>{value}</strong></div>;
}
