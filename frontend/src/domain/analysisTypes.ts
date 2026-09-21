export type ShotOutcome = "make" | "miss" | "review";
export type VideoMode = "original" | "annotated" | "pose";
export type WorkspaceTab = "overview" | "shot" | "tracking";
export type ThemeMode = "light" | "dark";
export type ProcessingMode = "normal" | "deep";
export type ShotMode = "free_throw" | "jump_shot";

export type PoseKeypoint = [x: number, y: number, confidence: number];

export interface BrowserPoseFrame {
  frame: number;
  keypoints: PoseKeypoint[];
  confidence: number;
}

export interface BrowserPoseOverlay {
  width: number;
  height: number;
  fps: number;
  frames: BrowserPoseFrame[];
}

export interface JumpPrediction {
  status: string;
  model: string | null;
  calibration_model?: string | null;
  cutoff: string;
  cutoff_ms_after_release?: number;
  cutoff_frame?: number;
  sample_size: number;
  probability: number | null;
  reason?: string;
  supported_cohort?: string | null;
}

export interface CourtCalibration {
  id?: string;
  preset: "nba" | "wnba" | "ncaa" | "fiba" | "high_school" | "custom" | "unknown";
  units?: "m" | "ft";
  image_points: number[][];
  world_points: number[][];
  basket_ground_image?: number[];
  uncertainty_m?: number;
  three_point_radius_m?: number;
  three_point_line_width_m?: number;
}

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
      frame_start?: number;
      frame_end?: number;
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
  observation_confidence?: number;
  confidence_label: "high" | "medium" | "review";
  shot_mode?: ShotMode;
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
  metric_availability?: Record<string, boolean>;
  metric_uncertainty?: Record<string, number | null>;
  evidence: {
    observed_ball_frames: number;
    tracked_frames: number;
    rim_track_confidence: number;
    pose_confidence: number;
    shooter_id?: string;
    shooting_hand?: "left" | "right" | "unknown";
    handedness_confidence?: number;
    temporal_mechanics?: {
      release_frame_uncertainty?: number | null;
      elbow_extension_timing_ms?: number | null;
      follow_through_duration_ms?: number | null;
      body_alignment_offset?: number | null;
      joint_motion_range_deg?: Record<string, number | null>;
    };
    crossing_frame: number | null;
    outcome_basis?: string;
    reappeared_below_rim?: boolean;
    reappearance_frame?: number | null;
    net_slowdown_ratio?: number | null;
    net_drag_confirmed?: boolean;
    mechanics_quality?: number | null;
    follow_through_quality?: number | null;
    trajectory_quality?: number | null;
    shot_quality?: number | null;
    miss_proximity?: number | null;
    predicted_ft_pct?: number | null;
    session_consistency_score?: number | null;
    prediction_status?: string;
    shot_type?: string;
    statistics_eligibility?: { status: string; reason?: string };
    motion_events?: {
      timing_available?: boolean;
      gather_frame?: number | null;
      loading_frame?: number | null;
      takeoff_frame?: number | null;
      release_frame?: number | null;
      landing_frame?: number | null;
      follow_through_end_frame?: number | null;
      follow_through_duration_ms?: number | null;
      release_after_takeoff_ms?: number | null;
      jump_height_projected_px?: number | null;
      motion_type?: string;
      uncertainty_frames?: number | null;
    };
    shooter_association_confidence?: number;
    distance?: {
      value: number | null;
      units: string;
      availability: boolean;
      method: string;
      uncertainty: number | null;
      shot_type?: string;
      basket_projection_basis?: string;
      calibration_quality?: string;
    };
    defenders?: Array<{
      id: string;
      role?: string;
      separation?: { value: number | null; units: string; availability: boolean; method: string; uncertainty: number | null };
      closing_speed?: { value: number | null; units: string; availability: boolean; method: string; uncertainty: number | null };
      approach_direction_deg?: number | null;
      body_orientation_deg?: number | null;
      arm_extension?: number | null;
      hand_elevation_relative?: number | null;
      hand_position_relative?: string;
      timing_available?: boolean;
      evidence_frames?: number[];
      uncertainty?: string;
    }>;
    team_assignments?: Record<string, "shooter" | "teammate" | "opponent" | "official" | "unknown">;
    player_height_m?: number | null;
    mechanics_assessment?: {
      status: string;
      overall: number | null;
      components: Record<string, number | string | null>;
      uncertainty?: number | null;
    };
    predictions?: {
      release?: JumpPrediction;
      release_plus_200ms?: JumpPrediction;
    };
    metric_availability?: Record<string, boolean>;
    metric_uncertainty?: Record<string, number | null>;
    measurement_space?: string;
    calibration_status?: string;
    correction?: {
      source: "local_user";
      updated_at?: string;
      fields: string[];
      comment?: string;
    };
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
    source_fps?: number | null;
    source_frame_count?: number | null;
    timing_preserved?: boolean;
    slow_motion_unknown?: boolean;
    source_timing?: {
      kind: string;
      mapping: string;
      fps: number;
      frame_count: number;
      unknown: boolean;
    };
  };
  summary: {
    attempts: number;
    makes: number;
    misses: number;
    review: number;
    fg_pct: number | null;
    observed_fg_pct?: number | null;
    observed_three_pct?: number | null;
    detected_attempts?: number;
    excluded_attempts?: number;
    observed_ft_pct?: number | null;
    predicted_ft_pct?: number | null;
    prediction_status?: string;
    prediction_model?: string | null;
    prediction_sample_size?: number;
    best_streak: number;
    average_confidence: number;
  };
  analysis_version?: string;
  models?: Record<string, string>;
  processing_mode?: ProcessingMode;
  shot_mode?: ShotMode;
  prediction?: {
    status: string;
    model: string | null;
    cutoff: number | null;
    sample_size: number;
  };
  jump_predictions?: {
    status: string;
    models: Record<string, string> | null;
    cutoffs: string[];
  };
  context?: { court_calibration?: CourtCalibration; player_heights?: Record<string, number>; shot_mode?: ShotMode };
  players?: Array<{ id: string; frame_start: number | null; frame_end: number | null; frames: number; confidence: number }>;
  corrections?: { count: number; source: string | null };
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
    scene_cut_count?: number;
    duplicate_frame_count?: number;
    timing_preserved?: boolean;
    source_fps?: number | null;
    source_frame_count?: number | null;
    messages: string[];
  };
  shots: ShotAnalysis[];
  warnings: string[];
  /** Optional static pose track used by the hosted review overlay. */
  pose_overlay?: BrowserPoseOverlay;
  artifacts: {
    original: string;
    source_original?: string;
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
  status: "queued" | "processing" | "done" | "error" | "cancelled";
  stage: string;
  frames_done: number;
  frames_total: number;
  updated_at?: number;
  error: string | null;
  result: AnalysisSession | null;
  processing_mode?: ProcessingMode;
  shot_mode?: ShotMode;
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
  supported_modes?: ShotMode[];
}

export type AnalysisQueueStatus = "queued" | "processing" | "done" | "error" | "cancelled";

export interface AnalysisQueueItem {
  id: string;
  filename: string;
  kind: "upload" | "example";
  file?: File;
  exampleId?: string;
  jobId?: string;
  status: AnalysisQueueStatus;
  stage: string;
  progress: number;
  result: AnalysisSession | null;
  error: string | null;
  processingMode: ProcessingMode;
  shotMode: ShotMode;
}
