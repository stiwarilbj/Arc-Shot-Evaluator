import type { AnalysisJobState, AnalysisSession, ExampleVideo, ProcessingMode, ShotAnalysis, ShotMode } from "../domain/analysisTypes";
import { IS_GITHUB_PAGES } from "../runtime";

const browserSessions = new Map<string, AnalysisSession>();

// GitHub Pages cannot run the FastAPI vision worker, but it can serve the
// same project-local clips that power the local landing page. Keep this list
// explicit so the hosted build brings back the full Celtics/Pelicans set and
// the three named free-throw clips without depending on a remote API.
const HOSTED_EXAMPLES: Array<Omit<ExampleVideo, "url">> = [
  { id: "example-1", label: "Celtics vs Pelicans · Clip 01", filename: "20.0-26.0.mp4", duration: 30.23, width: 640, height: 360, fps: 29.97, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-2", label: "Celtics vs Pelicans · Clip 02", filename: "9d07df92-9175-9d5f-0b91-5ded80044c3e_1280x720.mp4", duration: 7.05, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-3", label: "Celtics vs Pelicans · Clip 03", filename: "70b413a5-8796-119b-f09d-a60370eff456_1280x720.mp4", duration: 7.05, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-4", label: "Celtics vs Pelicans · Clip 04", filename: "195d59e5-bee1-0f97-3f5d-25144f1dba0e_1280x720.mp4", duration: 7.08, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-5", label: "Celtics vs Pelicans · Clip 05", filename: "500ed956-1d96-21c6-0901-2444bace171d_1280x720.mp4", duration: 6.58, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-6", label: "Celtics vs Pelicans · Clip 06", filename: "5927dc9e-af89-0ed3-ab1f-8a0acdfdf7be_1280x720.mp4", duration: 7.03, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-7", label: "Celtics vs Pelicans · Clip 07", filename: "6780e35b-0ddf-cba1-a979-1c2634c51eea_1280x720.mp4", duration: 9.13, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-8", label: "Celtics vs Pelicans · Clip 08", filename: "a9dbfe7f-11d3-b580-fefc-dc310cdd9e0d_1280x720.mp4", duration: 9.35, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-9", label: "Celtics vs Pelicans · Clip 09", filename: "a090504f-62b8-9820-fb69-58fecfd5fe12_1280x720.mp4", duration: 8.03, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-10", label: "Celtics vs Pelicans · Clip 10", filename: "aa7dbd16-c28f-b2a5-9a73-264418c65c4b_1280x720.mp4", duration: 6.05, width: 1280, height: 720, fps: 60, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-11", label: "Free throw · Short clip", filename: "YTDown.com_Shorts_This-free-throw_Media_Sq5yS3L56Ek_001_1080p.mp4", duration: 13.18, width: 1080, height: 1920, fps: 29.97, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-12", label: "Free throw · Kevin Durant", filename: "YTDown.com_YouTube_Kevin-Durant-shooting-free-throws_Media_-qySIh0H1Ug_001_720p.mp4", duration: 12.97, width: 1280, height: 720, fps: 30, supported_modes: ["free_throw", "jump_shot"] },
  { id: "example-13", label: "Free throw · LeBron and Steph", filename: "YTDown.com_YouTube_LeBron-Jokes-After-Steph-Misses-Free-Thr_Media_welHDbZ0KBY_001_720p.mp4", duration: 31.70, width: 1280, height: 720, fps: 29.97, supported_modes: ["free_throw", "jump_shot"] },
];

export function registerBrowserAnalysisSession(session: AnalysisSession) {
  browserSessions.set(session.session.id, session);
}

function browserSession(sessionId: string) {
  const session = browserSessions.get(sessionId);
  if (!session) throw new Error("This browser analysis is no longer open");
  return session;
}

function updateBrowserAnalysisSession(sessionId: string, update: (session: AnalysisSession) => AnalysisSession) {
  const next = update(browserSession(sessionId));
  browserSessions.set(sessionId, next);
  return next;
}

function browserSummary(shots: AnalysisSession["shots"]) {
  const makes = shots.filter((shot) => shot.outcome === "make").length;
  const misses = shots.filter((shot) => shot.outcome === "miss").length;
  const review = shots.filter((shot) => shot.outcome === "review").length;
  const attempts = shots.length;
  return {
    attempts,
    makes,
    misses,
    review,
    fg_pct: attempts ? (makes / attempts) * 100 : null,
    observed_fg_pct: attempts ? (makes / attempts) * 100 : null,
    observed_ft_pct: attempts ? (makes / attempts) * 100 : null,
    predicted_ft_pct: null,
    best_streak: 0,
    average_confidence: attempts
      ? shots.reduce((total, shot) => total + (shot.observation_confidence ?? shot.confidence), 0) / attempts
      : 0,
  };
}

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
  if (IS_GITHUB_PAGES) {
    if (signal?.aborted) throw new DOMException("The example request was aborted", "AbortError");
    return HOSTED_EXAMPLES.map((example) => ({
      ...example,
      url: new URL(`examples/${encodeURIComponent(example.filename)}`, document.baseURI).toString(),
    }));
  }
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
  if (IS_GITHUB_PAGES) {
    return updateBrowserAnalysisSession(sessionId, (session) => {
      const shots = session.shots.map((shot) => {
        if (shot.id !== shotId) return shot;
        const updated: ShotAnalysis = {
          ...shot,
          outcome: correction.outcome ?? shot.outcome,
          confidence_label: correction.outcome === "review" ? "review" : shot.confidence_label,
          release_frame: correction.release_frame ?? shot.release_frame,
          release_time: correction.release_frame == null ? shot.release_time : correction.release_frame / session.session.fps,
          evidence: {
            ...shot.evidence,
            shooter_id: correction.shooter_id ?? shot.evidence.shooter_id,
            shooting_hand: correction.shooting_hand ?? shot.evidence.shooting_hand,
            shot_type: correction.shot_type ?? shot.evidence.shot_type,
            defenders: correction.defender_ids
              ? correction.defender_ids.filter(Boolean).map((id) => ({ id }))
              : shot.evidence.defenders,
            team_assignments: correction.team_assignments ?? shot.evidence.team_assignments,
            player_height_m: correction.player_height_m ?? shot.evidence.player_height_m,
            correction: { source: "local_user", updated_at: new Date().toISOString(), fields: Object.keys(correction), comment: correction.comment },
          },
        };
        return updated;
      });
      return { ...session, shots, summary: browserSummary(shots) };
    });
  }
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
  if (IS_GITHUB_PAGES) {
    return updateBrowserAnalysisSession(sessionId, (session) => {
      const nextId = Math.max(0, ...session.shots.map((shot) => shot.id)) + 1;
      const releaseFrame = Math.max(0, Math.round(attempt.release_frame));
      const shot: AnalysisSession["shots"][number] = {
        id: nextId,
        outcome: attempt.outcome,
        confidence: 1,
        observation_confidence: 1,
        confidence_label: attempt.outcome === "review" ? "review" : "high",
        shot_mode: session.shot_mode,
        release_frame: releaseFrame,
        release_time: releaseFrame / session.session.fps,
        end_frame: Math.min(session.session.frame_count - 1, releaseFrame + Math.round(session.session.fps * 0.8)),
        release_speed_ms: null,
        release_height_m: null,
        entry_angle_deg: null,
        arc_peak_m: null,
        form: { elbow: null, knee: null, shoulder: null, hip: null },
        flags: ["Added in browser review"],
        evidence: {
          observed_ball_frames: 0,
          tracked_frames: 0,
          rim_track_confidence: 0,
          pose_confidence: 0,
          crossing_frame: null,
          outcome_basis: "Added manually in browser review",
          statistics_eligibility: { status: "review" },
        },
      };
      const shots = [...session.shots, shot];
      return { ...session, shots, summary: browserSummary(shots) };
    });
  }
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
  if (IS_GITHUB_PAGES) {
    return updateBrowserAnalysisSession(sessionId, (session) => ({
      ...session,
      context: { ...session.context, ...context, shot_mode: context.shot_mode ?? session.context?.shot_mode },
    }));
  }
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
