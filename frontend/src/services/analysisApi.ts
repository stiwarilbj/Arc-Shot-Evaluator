import type { AnalysisJobState, AnalysisSession, ExampleVideo, ProcessingMode, ShotMode } from "../domain/analysisTypes";
import { IS_GITHUB_PAGES } from "../runtime";

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ detail: "Request failed" }))) as {
      detail?: string;
    };
    throw new Error(body.detail ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchExampleVideos(signal?: AbortSignal): Promise<ExampleVideo[]> {
  if (IS_GITHUB_PAGES) return [];
  return parseJsonResponse<ExampleVideo[]>(await fetch("/api/examples", { signal }));
}

export async function startUploadedVideoAnalysis(
  file: File,
  mode: ProcessingMode = "normal",
  shotMode: ShotMode = "free_throw",
): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const result = await parseJsonResponse<{ job_id: string }>(
    await fetch(`/api/jobs?mode=${encodeURIComponent(mode)}&shot_mode=${encodeURIComponent(shotMode)}`, { method: "POST", body }),
  );
  return result.job_id;
}

export async function startExampleVideoAnalysis(
  exampleId: string,
  mode: ProcessingMode = "normal",
  shotMode: ShotMode = "free_throw",
): Promise<string> {
  const result = await parseJsonResponse<{ job_id: string }>(
    await fetch(`/api/examples/${encodeURIComponent(exampleId)}/jobs?mode=${encodeURIComponent(mode)}&shot_mode=${encodeURIComponent(shotMode)}`, { method: "POST" }),
  );
  return result.job_id;
}

export async function correctSavedShot(
  sessionId: string,
  shotId: number,
  correction: {
    outcome?: "make" | "miss" | "review";
    release_frame?: number;
    shooter_id?: string;
    shooting_hand?: "left" | "right" | "unknown";
    shot_type?: string;
    takeoff_frame?: number;
    defender_ids?: string[];
    team_assignments?: Record<string, "shooter" | "teammate" | "opponent" | "official" | "unknown">;
    player_height_m?: number;
    comment?: string;
  },
): Promise<AnalysisSession> {
  return parseJsonResponse<AnalysisSession>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/shots/${shotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(correction),
    }),
  );
}

export async function addManualShot(
  sessionId: string,
  attempt: { outcome: "make" | "miss" | "review"; release_frame: number },
): Promise<AnalysisSession> {
  return parseJsonResponse<AnalysisSession>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/shots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt),
    }),
  );
}

export async function updateSessionContext(
  sessionId: string,
  context: { shot_mode?: ShotMode; court_calibration?: import("../domain/analysisTypes").CourtCalibration; player_heights?: Record<string, number> },
): Promise<AnalysisSession> {
  return parseJsonResponse<AnalysisSession>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context),
    }),
  );
}

export async function reanalyzeSession(
  sessionId: string,
  mode: ProcessingMode = "normal",
  shotMode?: ShotMode,
): Promise<string> {
  const query = new URLSearchParams({ mode });
  if (shotMode) query.set("shot_mode", shotMode);
  const result = await parseJsonResponse<{ job_id: string }>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reanalysis?${query.toString()}`, { method: "POST" }),
  );
  return result.job_id;
}

export async function fetchAnalysisJob(jobId: string, signal?: AbortSignal): Promise<AnalysisJobState> {
  return parseJsonResponse<AnalysisJobState>(await fetch(`/api/jobs/${jobId}`, { signal }));
}

export async function cancelAnalysisJob(jobId: string): Promise<AnalysisJobState> {
  return parseJsonResponse<AnalysisJobState>(
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }),
  );
}
