import type {
  AnalysisSession,
  ProcessingMode,
  ShotAnalysis,
  ShotMode,
} from "../domain/analysisTypes";

export type BrowserAnalysisProgress = (progress: number, stage: string) => void;

type BrowserSource = File | string;

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `browser-${crypto.randomUUID()}`;
  return `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("This video could not be read in the browser")), 12_000);
    const finish = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("error", fail);
      reject(new Error("This video could not be read in the browser"));
    };
    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.load();
  });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve) => {
    const target = clamp(time, 0, Math.max(0, (video.duration || time) - 0.03));
    if (Math.abs(video.currentTime - target) < 0.02) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => {
      video.removeEventListener("seeked", finish);
      resolve();
    }, 1_500);
    const finish = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", finish);
      resolve();
    };
    video.addEventListener("seeked", finish, { once: true });
    video.currentTime = target;
  });
}

function frameDifference(previous: Uint8ClampedArray | null, current: Uint8ClampedArray) {
  if (!previous || previous.length !== current.length) return 0;
  let total = 0;
  const stride = 4 * 4;
  for (let index = 0; index < current.length; index += stride) {
    total += Math.abs(current[index] - previous[index]);
    total += Math.abs(current[index + 1] - previous[index + 1]);
    total += Math.abs(current[index + 2] - previous[index + 2]);
  }
  return total / ((current.length / stride) * 3 * 255);
}

function buildShot(
  id: number,
  time: number,
  fps: number,
  score: number,
  frameCount: number,
  shotMode: ShotMode,
): ShotAnalysis {
  const releaseFrame = Math.round(time * fps);
  const confidence = clamp(0.42 + score * 0.55, 0.42, 0.82);
  return {
    id,
    outcome: "review",
    confidence,
    observation_confidence: confidence,
    confidence_label: "review",
    shot_mode: shotMode,
    release_frame: releaseFrame,
    release_time: time,
    end_frame: Math.min(frameCount - 1, releaseFrame + Math.round(fps * 0.8)),
    release_speed_ms: null,
    release_height_m: null,
    entry_angle_deg: null,
    arc_peak_m: null,
    form: { elbow: null, knee: null, shoulder: null, hip: null },
    flags: ["Motion window ready for review"],
    metric_availability: {},
    evidence: {
      observed_ball_frames: 0,
      tracked_frames: Math.max(1, Math.round(fps * 0.8)),
      rim_track_confidence: 0,
      pose_confidence: 0,
      crossing_frame: null,
      outcome_basis: "Browser motion window; choose the visible outcome in Review this outcome",
      shot_type: shotMode === "jump_shot" ? "unknown" : "free_throw",
      statistics_eligibility: { status: "review", reason: "Confirm the attempt after watching the clip" },
      metric_availability: {},
    },
  };
}

function recomputeSummary(shots: ShotAnalysis[]) {
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

function dataUrl(value: unknown) {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value))}`;
}

export async function analyzeVideoInBrowser(
  source: BrowserSource,
  filename: string,
  processingMode: ProcessingMode,
  shotMode: ShotMode,
  onProgress: BrowserAnalysisProgress,
): Promise<AnalysisSession> {
  const sourceUrl = typeof source === "string" ? source : URL.createObjectURL(source);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = sourceUrl;
  onProgress(4, "Loading video");
  await waitForVideoMetadata(video);

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const fps = 30;
  const frameCount = Math.max(1, Math.round(duration * fps));
  const sampleCount = clamp(Math.round(duration * (processingMode === "deep" ? 4 : 2.5)), 12, 72);
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(320, width);
  canvas.height = Math.max(1, Math.round(canvas.width * (height / width)));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const motion: Array<{ time: number; score: number; thumbnail: string }> = [];
  let previous: Uint8ClampedArray | null = null;

  for (let index = 0; index < sampleCount; index += 1) {
    const time = duration * (index / Math.max(1, sampleCount - 1));
    await seekVideo(video, time);
    let score = 0;
    let thumbnail = "";
    if (context) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      score = frameDifference(previous, image.data);
      previous = image.data;
      thumbnail = canvas.toDataURL("image/jpeg", 0.72);
    }
    motion.push({ time, score, thumbnail });
    onProgress(10 + Math.round(((index + 1) / sampleCount) * 66), `Reading frame ${index + 1} of ${sampleCount}`);
  }

  const scores = motion.map((item) => item.score);
  const mean = scores.reduce((total, score) => total + score, 0) / Math.max(1, scores.length);
  const variance = scores.reduce((total, score) => total + (score - mean) ** 2, 0) / Math.max(1, scores.length);
  const threshold = mean + Math.max(0.012, Math.sqrt(variance) * 0.55);
  const candidates = motion
    .filter((item, index) => {
      const before = motion[index - 1]?.score ?? -1;
      const after = motion[index + 1]?.score ?? -1;
      return item.time > 0.35 && item.time < duration - 0.25 && item.score >= threshold && item.score >= before && item.score >= after;
    })
    .sort((left, right) => right.score - left.score);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.every((item) => Math.abs(item.time - candidate.time) > 0.9)) selected.push(candidate);
    if (selected.length === 5) break;
  }
  if (!selected.length) {
    const fallback = motion[Math.floor(motion.length / 2)] ?? { time: duration / 2, score: 0, thumbnail: "" };
    selected.push(fallback);
  }
  selected.sort((left, right) => left.time - right.time);
  onProgress(84, "Building shot review");
  const shots = selected.map((item, index) => buildShot(index + 1, item.time, fps, item.score, frameCount, shotMode));
  const sessionId = makeId();
  const summary = recomputeSummary(shots);
  const session: AnalysisSession = {
    session: {
      id: sessionId,
      filename,
      created_at: new Date().toISOString(),
      width,
      height,
      fps,
      frame_count: frameCount,
      duration,
      local_only: false,
      source_fps: fps,
      source_frame_count: frameCount,
      timing_preserved: true,
    },
    summary,
    analysis_version: "browser-motion-1",
    models: { motion: "ARC browser motion pass" },
    processing_mode: processingMode,
    shot_mode: shotMode,
    context: { shot_mode: shotMode },
    quality: {
      tier: "limited",
      score: 0.62,
      orientation: height > width * 1.08 ? "portrait" : width > height * 1.08 ? "landscape" : "square",
      normalized: false,
      rim_coverage: 0,
      pose_coverage: 0,
      model_ball_coverage: 0,
      ball_candidate_coverage: 0,
      camera_motion: clamp(mean * 8, 0, 1),
      messages: [],
    },
    shots,
    warnings: [],
    artifacts: {
      original: sourceUrl,
      source_original: sourceUrl,
      annotated: sourceUrl,
      pose: sourceUrl,
      shots_jsonl: dataUrl(shots),
      analysis_json: dataUrl({ session: sessionId, shots }),
      thumbnails: selected.map((item) => item.thumbnail).filter(Boolean),
    },
  };
  onProgress(100, "Analysis complete");
  return session;
}

