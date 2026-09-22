import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { BarChart3, CircleDot, Waypoints } from "lucide-react";
import { CoachNotes } from "../features/analysis/CoachNotes";
import { ShotDataPanel } from "../features/analysis/ShotDataPanel";
import { ShotSelector } from "../features/analysis/ShotSelector";
import { VideoWorkspace } from "../features/analysis/VideoWorkspace";
import { AnalysisQueue } from "../features/queue/AnalysisQueue";
import { ExampleVideoLibrary } from "../features/upload/ExampleVideoLibrary";
import { VideoUpload } from "../features/upload/VideoUpload";
import { PlaybookBoard } from "../features/playbook/PlaybookBoard";
import { AppHeader, type AppWorkspace } from "../layout/AppHeader";
import { IS_GITHUB_PAGES } from "../runtime";
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
  WorkspaceTab,
} from "../domain/analysisTypes";

const PlayFinder = lazy(() => import("../features/playFinder/PlayFinder").then((module) => ({ default: module.PlayFinder })));

const WAIT_MS = 750;
const MAX_CONCURRENT_ANALYSES = 1;
const QUEUE_STORAGE_KEY = "arc-analysis-queue-v2";
const HOSTED_QUEUE_STORAGE_KEY = "arc-analysis-queue-pages-v1";
function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function fetchAnalysisJobWithRetries(jobId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fetchAnalysisJob(jobId);
    } catch (caught) {
      lastError = caught;
      // A busy local worker can briefly interrupt a fetch while the browser
      // is still connected. Retry those transport errors before surfacing a
      // real analysis/API error in the queue.
      if (!(caught instanceof TypeError) || attempt === 3) throw caught;
      await delay(350 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not read analysis status");
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
  const [queue, setQueue] = useState<AnalysisQueueItem[]>([]);
  const [hiddenQueueIds, setHiddenQueueIds] = useState<Set<string>>(new Set());
  const [examples, setExamples] = useState<ExampleVideo[]>([]);
  const [examplesLoading, setExamplesLoading] = useState(true);
  const [examplesError, setExamplesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedShot, setSelectedShot] = useState(0);
  const [reviewFrame, setReviewFrame] = useState<number | null>(null);
  const [mode, setMode] = useState<VideoMode>("pose");
  const [tab, setTab] = useState<WorkspaceTab>("shot");
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("normal");
  // Free throw is the safest default for a new launch; a selected mode is
  // captured into each queue item so changing it never mutates an active job.
  const [shotMode, setShotMode] = useState<ShotMode>("free_throw");
  const [workspace, setWorkspace] = useState<AppWorkspace>("analyzer");
  const [playFinderOpened, setPlayFinderOpened] = useState(false);
  const changeWorkspace = (next: AppWorkspace) => {
    if (next === "play-finder") setPlayFinderOpened(true);
    setWorkspace(next);
  };
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "dark";
    return window.localStorage.getItem("arc-theme-v2") === "light" ? "light" : "dark";
  });
  const activeQueueItemsRef = useRef<Set<string>>(new Set());
  const cancelledQueueItemsRef = useRef<Set<string>>(new Set());
  const jobIdsRef = useRef<Map<string, string>>(new Map());
  const [queueHydrated, setQueueHydrated] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("arc-theme-v2", theme);
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
    let cancelled = false;
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
        const storedResult = "result" in item && item.result ? item.result : null;
        if (storedResult) registerBrowserAnalysisSession(storedResult);
        const canResume = item.kind === "example" && !storedResult;
        const completedUpload = item.kind === "upload" && item.status === "done" && !storedResult;
        return {
          ...item,
          file: undefined,
          result: storedResult,
          status: canResume && (item.status === "queued" || item.status === "processing")
            ? "queued" as const
            : completedUpload
              ? "error" as const
              : item.status,
          stage: canResume && (item.status === "queued" || item.status === "processing")
            ? "Ready to resume browser analysis"
            : completedUpload
              ? "Upload is available while this page is open"
              : item.stage,
          error: completedUpload
            ? "This uploaded clip cannot be restored after a page reload"
            : item.error,
        };
      });
      setQueue(restored);
      setQueueHydrated(true);
      return () => {
        cancelled = true;
      };
    }
    const restored = saved.map((item) => ({
      ...item,
      file: undefined,
      result: null,
      status: item.jobId && (item.status === "queued" || item.status === "processing")
        ? "queued" as const
        : item.status,
      stage: item.jobId && (item.status === "queued" || item.status === "processing")
        ? "Reconnecting to local analysis"
        : item.stage,
      error: item.jobId ? item.error : item.status === "queued" ? "This upload was not started before the page closed" : item.error,
    }));
    setQueue(restored);
    setQueueHydrated(true);
    restored.forEach((item) => {
      if (!item.jobId) return;
      fetchAnalysisJobWithRetries(item.jobId)
        .then((state) => {
          if (cancelled) return;
          if (state.status === "done" && state.result) {
            updateAnalysisQueueItem(item.id, { status: "done", stage: "Analysis complete", progress: 100, result: state.result, error: null });
          } else if (state.status === "error" || state.status === "cancelled") {
            updateAnalysisQueueItem(item.id, { status: state.status, stage: state.stage, progress: 0, error: state.error });
          } else {
            updateAnalysisQueueItem(item.id, { status: "queued", stage: "Reconnected; analysis continues in the background", jobId: item.jobId, error: null });
          }
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          updateAnalysisQueueItem(item.id, { status: "error", stage: "Could not reconnect to analysis", error: caught instanceof Error ? caught.message : "Job status is unavailable" });
        });
    });
    return () => {
      cancelled = true;
    };
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
    try {
      // ARC's original review flow is the normal free-throw pass; keep every
      // queued clip on that path so the restored examples behave consistently.
      const analysisMode: ProcessingMode = "normal";
      const analysisShotMode: ShotMode = "free_throw";
      if (cancelledQueueItemsRef.current.has(item.id)) return;
      updateAnalysisQueueItem(item.id, { status: "processing", stage: IS_GITHUB_PAGES ? "Starting browser analysis" : "Starting analysis", progress: 3, error: null });
      if (IS_GITHUB_PAGES) {
        const example = item.kind === "example" ? examples.find((candidate) => candidate.id === item.exampleId) : undefined;
        const source = item.file
          ?? example?.url
          // A restored Pages queue can start before the example manifest
          // request finishes; the filename is enough to resume the static
          // project asset without racing that request.
          ?? (item.kind === "example" ? new URL(`examples/${encodeURIComponent(item.filename)}`, document.baseURI).toString() : undefined);
        if (!source) throw new Error("This example is no longer available");
        const browserResult = await analyzeVideoInBrowser(source, item.filename, analysisMode, analysisShotMode, (progress, stage) => {
          updateAnalysisQueueItem(item.id, { status: "processing", stage, progress, error: null });
        });
        registerBrowserAnalysisSession(browserResult);
        updateAnalysisQueueItem(item.id, { status: "done", stage: "Analysis complete", progress: 100, result: browserResult, error: null });
        setSession(browserResult);
        setSelectedShot(0);
        setReviewFrame(null);
        setMode("pose");
        setTab(browserResult.shots.length ? "shot" : "overview");
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
        const next = await fetchAnalysisJobWithRetries(jobId);
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
          setSession(next.result);
          setSelectedShot(0);
          setReviewFrame(null);
          setMode("pose");
          setTab(next.result.shots.length ? "shot" : "overview");
          return;
        }
        if (next.status === "cancelled") return;
        if (next.status === "error") throw new Error(next.error ?? "Analysis failed");
        await delay(WAIT_MS);
      }
    } catch (caught) {
      if (cancelledQueueItemsRef.current.has(item.id)) return;
      const message = caught instanceof Error ? caught.message : "Analysis failed";
      updateAnalysisQueueItem(item.id, { status: "error", stage: "Analysis failed", error: message });
      setError(message);
    } finally {
      activeQueueItemsRef.current.delete(item.id);
      jobIdsRef.current.delete(item.id);
      cancelledQueueItemsRef.current.delete(item.id);
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
  }, [queue]);

  function enqueueUploadedVideos(files: File[]) {
    if (!files.length) return;
    setError(null);
    setQueue((current) => [...current, ...files.map((file) => createQueuedAnalysis(file.name, file, undefined, "normal", "free_throw"))]);
  }

  function enqueueExampleVideo(example: ExampleVideo) {
    setError(null);
    setQueue((current) => [...current, createQueuedAnalysis(example.filename, undefined, example.id, "normal", "free_throw")]);
  }

  function requestQueueCancellation(item: AnalysisQueueItem) {
    cancelledQueueItemsRef.current.add(item.id);
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
    queue.forEach((item) => {
      if (item.status === "processing" || activeQueueItemsRef.current.has(item.id)) requestQueueCancellation(item);
    });
    setQueue([]);
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
    if (!item.result) return;
    setSession(item.result);
    setSelectedShot(0);
    setReviewFrame(null);
    setMode("pose");
    setTab(item.result.shots.length ? "shot" : "overview");
    setError(null);
  }

  function handleSessionChange(next: AnalysisSession) {
    setSession(next);
    if (IS_GITHUB_PAGES) {
      // Keep hosted corrections in the same durable queue record as the
      // original browser analysis so reopening the page preserves review work
      // just like a local session reconnect.
      setQueue((current) => current.map((item) => (
        item.result?.session.id === next.session.id ? { ...item, result: next } : item
      )));
      registerBrowserAnalysisSession(next);
    }
  }

  function showHomePage() {
    setWorkspace("analyzer");
    setSession(null);
    setReviewFrame(null);
    setError(null);
    setSelectedShot(0);
    setMode("pose");
    setTab("shot");
  }

  const queuePanel = (
    <AnalysisQueue items={queue} {...queueActions} />
  );

  const shot = session?.shots[selectedShot] ?? null;
  const isJumpShot = session?.shot_mode === "jump_shot";
  const analyzerView = session ? (
    <div className="analysis-session-shell">
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
          <VideoWorkspace session={session} shot={shot} mode={mode} onMode={setMode} seekFrame={reviewFrame} active={workspace === "analyzer"} />
          <ShotSelector session={session} selected={selectedShot} onSelect={(index) => {
            setSelectedShot(index);
            setReviewFrame(null);
            setTab("shot");
          }} />
          {session.warnings.length ? <div className="warning-row" role="status">{session.warnings.map((warning) => warning.replace(/[.!]+$/, "")).join(" · ")}</div> : null}
        </div>
        <aside className="analysis-side-workspace">
          <AnalysisQueue items={queue} compact {...queueActions} />
          <div className={`analysis-detail-columns ${shot?.coaching ? "" : "analysis-detail-legacy"}`}>
            {shot?.coaching ? <CoachNotes shot={shot} /> : null}
            <ShotDataPanel session={session} shot={shot} tab={tab} onSessionChange={handleSessionChange} onSeekFrame={setReviewFrame} />
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
    <div className={`app-shell ${workspace === "playbook" ? "playbook-app-shell" : workspace === "play-finder" ? "play-finder-app-shell" : session ? "analysis-session-shell" : ""}`}>
      <AppHeader filename={workspace === "analyzer" ? session?.session.filename : undefined} complete={Boolean(session && workspace === "analyzer")} onReset={showHomePage} theme={theme} onThemeChange={setTheme} workspace={workspace} onWorkspaceChange={changeWorkspace} />
      <div className={workspace === "playbook" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "playbook"}>
        <PlaybookBoard />
      </div>
      <div className={workspace === "analyzer" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "analyzer"}>
        {analyzerView}
      </div>
      {playFinderOpened ? <div className={workspace === "play-finder" ? "workspace-view workspace-view-active" : "workspace-view workspace-view-hidden"} aria-hidden={workspace !== "play-finder"}>
        <Suspense fallback={<div className="finder-loading" role="status">Loading Play Finder…</div>}><PlayFinder active={workspace === "play-finder"} /></Suspense>
      </div> : null}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button type="button" className={active ? "is-active" : ""} onClick={onClick}>{icon}{label}</button>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: "make" }) {
  return <div><span>{label}</span><strong className={tone ? `text-${tone}` : ""}>{value}</strong></div>;
}
