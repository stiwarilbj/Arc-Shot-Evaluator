export type ShotOutcome = "make" | "miss" | "review";
export type VideoMode = "original" | "annotated" | "pose";
export type WorkspaceTab = "overview" | "shot" | "tracking";
export type ThemeMode = "light" | "dark";

export interface ShotCoaching {
  intro: string;
  limited: boolean;
  matched_source_count: number;
  tips: Array<{
    id: string;
    tone: "positive" | "action" | "consistency";
    text: string;
    evidence: {
      metric: string;
      label: string;
      value: string;
    } | null;
    source_ids: string[];
  }>;
  sources: Array<{
    id: string;
    title: string;
    publisher: string;
    url: string;
  }>;
}

export interface ShotAnalysis {
  id: number;
  outcome: ShotOutcome;
  confidence: number;
  confidence_label: "high" | "medium" | "review";
  release_frame: number;
  release_time: number;
  end_frame: number;
  release_speed_ms: number | null;
  release_height_m: number | null;
  entry_angle_deg: number | null;
  arc_peak_m: number | null;
  form: {
    elbow: number | null;
    knee: number | null;
    shoulder: number | null;
    hip: number | null;
  };
  flags: string[];
  evidence: {
    observed_ball_frames: number;
    tracked_frames: number;
    rim_track_confidence: number;
    pose_confidence: number;
    crossing_frame: number | null;
    outcome_basis?: string;
    reappeared_below_rim?: boolean;
    reappearance_frame?: number | null;
    net_slowdown_ratio?: number | null;
    net_drag_confirmed?: boolean;
  };
  coaching?: ShotCoaching;
}

export interface AnalysisSession {
  session: {
    id: string;
    filename: string;
    created_at: string;
    width: number;
    height: number;
    fps: number;
    frame_count: number;
    duration: number;
    local_only: boolean;
  };
  summary: {
    attempts: number;
    makes: number;
    misses: number;
    review: number;
    fg_pct: number | null;
    best_streak: number;
    average_confidence: number;
  };
  quality?: {
    tier: "good" | "limited" | "insufficient";
    score: number;
    orientation: "landscape" | "portrait" | "square";
    normalized: boolean;
    rim_coverage: number;
    pose_coverage: number;
    model_ball_coverage: number;
    ball_candidate_coverage: number;
    camera_motion: number;
    blur_score?: number;
    messages: string[];
  };
  shots: ShotAnalysis[];
  warnings: string[];
  artifacts: {
    original: string;
    annotated: string;
    pose: string;
    shots_jsonl: string;
    analysis_json: string;
    thumbnails: string[];
  };
}

export interface AnalysisJobState {
  id: string;
  filename: string;
  status: "queued" | "processing" | "done" | "error";
  stage: string;
  frames_done: number;
  frames_total: number;
  updated_at?: number;
  error: string | null;
  result: AnalysisSession | null;
}

export interface ExampleVideo {
  id: string;
  label: string;
  filename: string;
  url: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export type AnalysisQueueStatus = "queued" | "processing" | "done" | "error";

export interface AnalysisQueueItem {
  id: string;
  filename: string;
  kind: "upload" | "example";
  file?: File;
  exampleId?: string;
  status: AnalysisQueueStatus;
  stage: string;
  progress: number;
  result: AnalysisSession | null;
  error: string | null;
}
