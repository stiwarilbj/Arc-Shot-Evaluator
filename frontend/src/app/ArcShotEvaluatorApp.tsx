import { useEffect, useRef, useState } from "react";
import { BarChart3, CircleDot, Waypoints } from "lucide-react";
import { CoachNotes } from "../features/analysis/CoachNotes";
import { ShotDataPanel } from "../features/analysis/ShotDataPanel";
import { ShotSelector } from "../features/analysis/ShotSelector";
import { VideoWorkspace } from "../features/analysis/VideoWorkspace";
import { AnalysisQueue } from "../features/queue/AnalysisQueue";
import { ExampleVideoLibrary } from "../features/upload/ExampleVideoLibrary";
import { VideoUpload } from "../features/upload/VideoUpload";
import { AppHeader } from "../layout/AppHeader";
import {
  cancelAnalysisJob,
  fetchAnalysisJob,
  fetchExampleVideos,
  startExampleVideoAnalysis,
  startUploadedVideoAnalysis,
} from "../services/analysisApi";
import type {
  AnalysisQueueItem,
  AnalysisSession,
  ExampleVideo,
  ThemeMode,
  VideoMode,
  WorkspaceTab,
} from "../domain/analysisTypes";

const WAIT_MS = 750;
const MAX_CONCURRENT_ANALYSES = 2;
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

function createQueuedAnalysis(filename: string, file?: File, exampleId?: string): AnalysisQueueItem {
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
  };
}

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
  const [mode, setMode] = useState<VideoMode>("annotated");
  const [tab, setTab] = useState<WorkspaceTab>("shot");
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "dark";
    return window.localStorage.getItem("arc-theme-v2") === "light" ? "light" : "dark";
  });
  const activeQueueItemsRef = useRef<Set<string>>(new Set());
  const cancelledQueueItemsRef = useRef<Set<string>>(new Set());
  const jobIdsRef = useRef<Map<string, string>>(new Map());

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

  async function processQueuedAnalysis(item: AnalysisQueueItem) {
    try {
      if (cancelledQueueItemsRef.current.has(item.id)) return;
      updateAnalysisQueueItem(item.id, { status: "processing", stage: "Starting local analysis", progress: 3, error: null });
      const jobId = item.kind === "example"
        ? await startExampleVideoAnalysis(item.exampleId ?? "")
        : await startUploadedVideoAnalysis(item.file as File);
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
          setMode("annotated");
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
    setQueue((current) => [...current, ...files.map((file) => createQueuedAnalysis(file.name, file))]);
  }

  function enqueueExampleVideo(example: ExampleVideo) {
    setError(null);
    setQueue((current) => [...current, createQueuedAnalysis(example.filename, undefined, example.id)]);
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
    setMode("annotated");
    setTab(item.result.shots.length ? "shot" : "overview");
    setError(null);
  }

  function showHomePage() {
    setSession(null);
    setError(null);
    setSelectedShot(0);
    setMode("annotated");
    setTab("shot");
  }

  const queuePanel = (
    <AnalysisQueue items={queue} {...queueActions} />
  );

  if (!session) {
    return (
      <div className="app-shell">
        <AppHeader complete={false} onReset={showHomePage} theme={theme} onThemeChange={setTheme} />
        <main className={`landing-layout ${queue.length ? "landing-has-queue" : "landing-empty"}`}>
          {queue.length ? queuePanel : null}
          <div className="landing-main">
            <VideoUpload error={error} onFiles={enqueueUploadedVideos} />
            <ExampleVideoLibrary examples={examples} loading={examplesLoading} error={examplesError} onSelect={enqueueExampleVideo} />
          </div>
        </main>
      </div>
    );
  }

  const shot = session.shots[selectedShot] ?? null;
  return (
    <div className="app-shell analysis-session-shell">
      <AppHeader filename={session.session.filename} complete onReset={showHomePage} theme={theme} onThemeChange={setTheme} />
      <nav className="workspace-tabs" aria-label="Analysis views">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<BarChart3 size={17} />} label="Overview" />
        <TabButton active={tab === "shot"} onClick={() => setTab("shot")} icon={<CircleDot size={17} />} label={shot ? `Shot ${String(shot.id).padStart(2, "0")}` : "Shot"} />
        <TabButton active={tab === "tracking"} onClick={() => setTab("tracking")} icon={<Waypoints size={17} />} label="Tracking" />
      </nav>

      {tab === "overview" ? (
        <section className="overview-strip" aria-label="Session summary">
          <Summary label="Attempts" value={String(session.summary.attempts)} />
          <Summary label="Makes" value={String(session.summary.makes)} tone="make" />
          <Summary label="FG%" value={session.summary.fg_pct === null ? "—" : `${session.summary.fg_pct.toFixed(0)}%`} />
          <Summary label="Best streak" value={String(session.summary.best_streak)} />
          <Summary label="Confidence" value={`${session.summary.average_confidence.toFixed(0)}%`} />
        </section>
      ) : null}

      <main className="analysis-grid">
        <div className="analysis-main">
          <VideoWorkspace session={session} shot={shot} mode={mode} onMode={setMode} />
          <ShotSelector session={session} selected={selectedShot} onSelect={(index) => {
            setSelectedShot(index);
            setTab("shot");
          }} />
          {session.warnings.length ? <div className="warning-row" role="status">{session.warnings.join(" · ")}</div> : null}
        </div>
        <aside className="analysis-side-workspace">
          <AnalysisQueue items={queue} compact {...queueActions} />
          <div className={`analysis-detail-columns ${shot?.coaching ? "" : "analysis-detail-legacy"}`}>
            {shot?.coaching ? <CoachNotes shot={shot} /> : null}
            <ShotDataPanel session={session} shot={shot} tab={tab} />
          </div>
        </aside>
      </main>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button type="button" className={active ? "is-active" : ""} onClick={onClick}>{icon}{label}</button>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: "make" }) {
  return <div><span>{label}</span><strong className={tone ? `text-${tone}` : ""}>{value}</strong></div>;
}
