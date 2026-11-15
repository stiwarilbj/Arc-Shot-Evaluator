import type {
  AnalysisSession,
  BrowserPoseFrame,
  BrowserPoseOverlay,
  ProcessingMode,
  PoseKeypoint,
  ShotAnalysis,
  ShotMode,
} from "../domain/analysisTypes";
import { browserSamplingPlan } from "../domain/analysisModes";
import { browserShotEndFrame, browserShotReview } from "../domain/shotReview";

export type BrowserAnalysisProgress = (progress: number, stage: string) => void;

type BrowserSource = File | string;

const VIDEO_READ_ERROR = "This browser couldn’t read the video · Try an H.264 MP4 or use the downloaded app";
const VIDEO_FRAME_ERROR = "This browser couldn’t load a video frame · Try again with an H.264 MP4 or use the downloaded app";

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `browser-${crypto.randomUUID()}`;
  return `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  event: "loadedmetadata" | "loadeddata" | "seeked",
  signal: AbortSignal,
  ready: () => boolean,
  start?: () => void,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(event, finish);
      video.removeEventListener("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const finish = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(event === "loadedmetadata" ? VIDEO_READ_ERROR : VIDEO_FRAME_ERROR));
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timeout = window.setTimeout(fail, event === "seeked" ? 5_000 : 12_000);
    video.addEventListener(event, finish);
    video.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    if (video.error) {
      fail();
      return;
    }
    try {
      if (start) start();
      else finish();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function hasDecodedFrame(video: HTMLVideoElement) {
  return !video.error && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

async function seekVideo(video: HTMLVideoElement, time: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const target = clamp(time, 0, Math.max(0, video.duration - 0.03));
  const atTarget = () => hasDecodedFrame(video) && Math.abs(video.currentTime - target) < 0.02;
  if (!atTarget()) {
    await waitForVideoEvent(video, "seeked", signal, atTarget, () => { video.currentTime = target; });
  }
  return video.currentTime;
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

async function loadPoseOverlay(filename: string, signal: AbortSignal): Promise<BrowserPoseOverlay | undefined> {
  try {
    const url = new URL(`examples/pose-data/${encodeURIComponent(filename)}.json`, document.baseURI);
    const response = await fetch(url, { signal });
    if (!response.ok) return undefined;
    const raw = (await response.json()) as Partial<BrowserPoseOverlay>;
    signal.throwIfAborted();
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
    signal.throwIfAborted();
    // Examples without a usable track still support motion review.
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
  const releaseFrame = Math.min(frameCount - 1, Math.round(time * fps));
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
    end_frame: browserShotEndFrame(releaseFrame, fps, frameCount),
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

export async function analyzeVideoInBrowser(
  source: BrowserSource,
  filename: string,
  processingMode: ProcessingMode,
  shotMode: ShotMode,
  signal: AbortSignal,
  onProgress: BrowserAnalysisProgress,
): Promise<AnalysisSession> {
  signal.throwIfAborted();
  const sourceUrl = typeof source === "string" ? source : URL.createObjectURL(source);
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  let completed = false;
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    onProgress(4, "Loading video");
    await waitForVideoEvent(
      video, "loadedmetadata", signal,
      () => video.readyState >= HTMLMediaElement.HAVE_METADATA,
      () => { video.src = sourceUrl; },
    );
    signal.throwIfAborted();

    const { duration, videoWidth: width, videoHeight: height } = video;
    if (!width || !height) throw new Error("This file doesn’t contain a readable video track · Choose a basketball video");
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(VIDEO_READ_ERROR);
    await waitForVideoEvent(video, "loadeddata", signal, () => hasDecodedFrame(video));
    signal.throwIfAborted();

    const poseOverlay = typeof source === "string" ? await loadPoseOverlay(filename, signal) : undefined;
    const fps = poseOverlay?.fps ?? 30;
    const poseFrameCount = poseOverlay?.frames.reduce((maximum, frame) => Math.max(maximum, frame.frame + 1), 0) ?? 0;
    const frameCount = Math.max(1, Math.round(duration * fps), poseFrameCount);
    const { sampleCount, candidateLimit } = browserSamplingPlan(processingMode, duration);
    canvas.width = Math.min(320, width);
    canvas.height = Math.max(1, Math.round(canvas.width * (height / width)));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Couldn’t start browser frame analysis · Reload or use the downloaded app");
    const motion: Array<{ time: number; score: number; thumbnail: string }> = [];
    let previous: Uint8ClampedArray | null = null;

    for (let index = 0; index < sampleCount; index += 1) {
      const target = duration * (index / Math.max(1, sampleCount - 1));
      const time = await seekVideo(video, target, signal);
      signal.throwIfAborted();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const score = frameDifference(previous, image.data);
      previous = image.data;
      const thumbnail = canvas.toDataURL("image/jpeg", 0.72);
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
      if (selected.length === candidateLimit) break;
    }
    if (!selected.length) {
      const fallback = motion[Math.floor(motion.length / 2)] ?? { time: duration / 2, score: 0, thumbnail: "" };
      selected.push(fallback);
    }
    selected.sort((left, right) => left.time - right.time);
    onProgress(84, "Building shot review");
    const shots = selected.map((item, index) => buildShot(index + 1, item.time, fps, item.score, frameCount, shotMode, poseOverlay));
    const sessionId = makeId();
    const { summary, shotArtifacts } = browserShotReview(sessionId, shots);
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
      models: { motion: "ARCade Hoops browser motion pass", pose: poseOverlay ? "ARCade Hoops pose overlay track" : "Unavailable for uploads" },
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
        ...shotArtifacts,
        thumbnails: selected.map((item) => item.thumbnail).filter(Boolean),
      },
    };
    onProgress(100, "Analysis complete");
    signal.throwIfAborted();
    completed = true;
    return session;
  } finally {
    video.removeAttribute("src");
    video.load();
    canvas.width = 0;
    canvas.height = 0;
    if (!completed && typeof source !== "string") URL.revokeObjectURL(sourceUrl);
  }
}
