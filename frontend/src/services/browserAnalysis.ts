import type {
  AnalysisSession,
  BrowserPoseFrame,
  BrowserPoseOverlay,
  ProcessingMode,
  PoseKeypoint,
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

async function loadPoseOverlay(filename: string): Promise<BrowserPoseOverlay | undefined> {
  try {
    const url = new URL(`examples/pose-data/${encodeURIComponent(filename)}.json`, document.baseURI);
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const raw = (await response.json()) as Partial<BrowserPoseOverlay>;
    if (!Array.isArray(raw.frames) || !raw.frames.length) return undefined;
    const frames: BrowserPoseFrame[] = raw.frames
      .filter((item): item is BrowserPoseFrame => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as BrowserPoseFrame;
        return Number.isFinite(candidate.frame) && Array.isArray(candidate.keypoints) && candidate.keypoints.length >= 17;
      })
      .map((item) => ({
        frame: Math.max(0, Math.round(item.frame)),
        confidence: Number.isFinite(item.confidence) ? item.confidence : 0,
        keypoints: item.keypoints.map((point) => [Number(point[0]), Number(point[1]), Number(point[2])] as PoseKeypoint),
      }))
      .filter((item) => item.keypoints.every((point) => point.every(Number.isFinite)));
    if (!frames.length) return undefined;
    return {
      width: Number.isFinite(raw.width) ? Number(raw.width) : 1280,
      height: Number.isFinite(raw.height) ? Number(raw.height) : 720,
      fps: Number.isFinite(raw.fps) && Number(raw.fps) > 0 ? Number(raw.fps) : 30,
      frames,
    };
  } catch {
    // A user uploaded clip has no static track; the browser motion result
    // remains usable and the local Python path still provides full tracking.
    return undefined;
  }
}

function nearestPose(overlay: BrowserPoseOverlay | undefined, frame: number) {
  if (!overlay?.frames.length) return undefined;
  let best = overlay.frames[0];
  let distance = Math.abs(best.frame - frame);
  for (const candidate of overlay.frames) {
    const nextDistance = Math.abs(candidate.frame - frame);
    if (nextDistance < distance) {
      best = candidate;
      distance = nextDistance;
    }
  }
  return best;
}

function jointAngle(first: PoseKeypoint, middle: PoseKeypoint, last: PoseKeypoint) {
  if (first[2] < 0.16 || middle[2] < 0.16 || last[2] < 0.16) return null;
  const firstVector = [first[0] - middle[0], first[1] - middle[1]];
  const lastVector = [last[0] - middle[0], last[1] - middle[1]];
  const firstLength = Math.hypot(firstVector[0], firstVector[1]);
  const lastLength = Math.hypot(lastVector[0], lastVector[1]);
  if (!firstLength || !lastLength) return null;
  const cosine = clamp((firstVector[0] * lastVector[0] + firstVector[1] * lastVector[1]) / (firstLength * lastLength), -1, 1);
  return Math.round((Math.acos(cosine) * 180) / Math.PI * 10) / 10;
}

function formMetricsAtFrame(overlay: BrowserPoseOverlay | undefined, frame: number) {
  const pose = nearestPose(overlay, frame);
  if (!pose) return { form: { elbow: null, knee: null, shoulder: null, hip: null }, confidence: 0 };
  const sides = [
    [5, 7, 9, 11, 13, 15],
    [6, 8, 10, 12, 14, 16],
  ];
  const candidates = sides.map(([shoulder, elbow, wrist, hip, knee, ankle]) => ({
    elbow: jointAngle(pose.keypoints[shoulder], pose.keypoints[elbow], pose.keypoints[wrist]),
    knee: jointAngle(pose.keypoints[hip], pose.keypoints[knee], pose.keypoints[ankle]),
    shoulder: jointAngle(pose.keypoints[elbow], pose.keypoints[shoulder], pose.keypoints[hip]),
    hip: jointAngle(pose.keypoints[shoulder], pose.keypoints[hip], pose.keypoints[knee]),
  })).filter((candidate) => candidate.elbow != null);
  const form = candidates.length
    ? candidates.sort((left, right) => (right.elbow ?? 0) - (left.elbow ?? 0))[0]
    : { elbow: null, knee: null, shoulder: null, hip: null };
  return { form, confidence: pose.confidence };
}

function rangeQuality(value: number | null, minimum: number, maximum: number) {
  if (value == null) return null;
  if (value >= minimum && value <= maximum) return 1;
  const distance = value < minimum ? minimum - value : value - maximum;
  return clamp(1 - distance / 70, 0, 1);
}

function formQuality(form: { elbow: number | null; knee: number | null; shoulder: number | null; hip: number | null }) {
  const values = [
    rangeQuality(form.elbow, 65, 125),
    rangeQuality(form.knee, 125, 195),
    rangeQuality(form.shoulder, 20, 105),
    rangeQuality(form.hip, 125, 205),
  ].filter((value): value is number => value != null);
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0.62;
}

function buildShot(
  id: number,
  time: number,
  fps: number,
  score: number,
  frameCount: number,
  shotMode: ShotMode,
  poseOverlay?: BrowserPoseOverlay,
): ShotAnalysis {
  const releaseFrame = Math.round(time * fps);
  const pose = formMetricsAtFrame(poseOverlay, poseOverlay ? Math.round(time * poseOverlay.fps) : releaseFrame);
  const visibleQuality = formQuality(pose.form);
  // The hosted pass is intentionally conservative. Motion alone should not
  // make a difficult or poorly formed attempt look certain; static pose data
  // gives the Pages build the same quality signal the local review exposes.
  const confidence = clamp(
    (0.42 + score * 0.55)
      * (0.7 + 0.3 * clamp(pose.confidence, 0, 1))
      * (0.62 + 0.38 * visibleQuality),
    0.22,
    0.86,
  );
  const flags = ["Motion window ready for review"];
  if (visibleQuality < 0.45) flags.push("Visible form needs review");
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
    form: pose.form,
    flags,
    metric_availability: {},
    evidence: {
      observed_ball_frames: 0,
      tracked_frames: Math.max(1, Math.round(fps * 0.8)),
      rim_track_confidence: 0,
      pose_confidence: pose.confidence,
      shot_quality: visibleQuality,
      mechanics_quality: visibleQuality,
      crossing_frame: null,
      outcome_basis: "Browser motion window; choose the visible outcome in Review this outcome",
      shot_type: shotMode === "jump_shot" ? "unknown" : "free_throw",
      statistics_eligibility: { status: "review", reason: "Confirm the attempt after watching the clip" },
      metric_availability: {
        elbow: pose.form.elbow != null,
        knee: pose.form.knee != null,
        shoulder: pose.form.shoulder != null,
        hip: pose.form.hip != null,
      },
    },
  };
}

function recomputeSummary(shots: ShotAnalysis[]) {
  const makes = shots.filter((shot) => shot.outcome === "make").length;
  const misses = shots.filter((shot) => shot.outcome === "miss").length;
  const review = shots.filter((shot) => shot.outcome === "review").length;
  const attempts = shots.length;
  let bestStreak = 0;
  let currentStreak = 0;
  for (const shot of shots) {
    if (shot.outcome === "make") currentStreak += 1;
    else currentStreak = 0;
    bestStreak = Math.max(bestStreak, currentStreak);
  }
  return {
    attempts,
    makes,
    misses,
    review,
    fg_pct: attempts ? (makes / attempts) * 100 : null,
    observed_fg_pct: attempts ? (makes / attempts) * 100 : null,
    observed_ft_pct: attempts ? (makes / attempts) * 100 : null,
    predicted_ft_pct: null,
    best_streak: bestStreak,
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
  const poseOverlay = typeof source === "string" ? await loadPoseOverlay(filename) : undefined;
  const fps = poseOverlay?.fps ?? 30;
  const poseFrameCount = poseOverlay?.frames.reduce((maximum, frame) => Math.max(maximum, frame.frame + 1), 0) ?? 0;
  const frameCount = Math.max(1, Math.round(duration * fps), poseFrameCount);
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
  const shots = selected.map((item, index) => buildShot(index + 1, item.time, fps, item.score, frameCount, shotMode, poseOverlay));
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
    analysis_version: "browser-motion-2",
    models: { motion: "ARC browser motion pass", pose: poseOverlay ? "ARC pose overlay track" : "Unavailable for uploads" },
    processing_mode: processingMode,
    shot_mode: shotMode,
    context: { shot_mode: shotMode },
    quality: {
      tier: "limited",
      score: 0.62,
      orientation: height > width * 1.08 ? "portrait" : width > height * 1.08 ? "landscape" : "square",
      normalized: false,
      rim_coverage: 0,
      pose_coverage: poseOverlay ? clamp(poseOverlay.frames.length / Math.max(1, frameCount), 0, 1) : 0,
      model_ball_coverage: 0,
      ball_candidate_coverage: 0,
      camera_motion: clamp(mean * 8, 0, 1),
      messages: [],
    },
    shots,
    warnings: [],
    pose_overlay: poseOverlay,
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
