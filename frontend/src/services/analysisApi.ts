import type { AnalysisJobState, AnalysisSession, ExampleVideo, ProcessingMode, ShotAnalysis, ShotMode } from "../domain/analysisTypes";
import { IS_GITHUB_PAGES } from "../runtime";

const browserSessions = new Map<string, AnalysisSession>();

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
    const url = new URL("examples/arc-demo.mp4", document.baseURI).toString();
    return [{
      id: "arc-demo",
      label: "ARC browser demo",
      filename: "arc-demo.mp4",
      url,
      duration: 6,
      width: 1280,
      height: 720,
      fps: 30,
      supported_modes: ["free_throw", "jump_shot"],
    }];
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
