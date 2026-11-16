import type { AnalysisSession, ShotAnalysis } from "./analysisTypes";

export function isReleaseFrame(frame: number, frameCount: number) {
  return Number.isSafeInteger(frame) && frame >= 0 && frame < frameCount;
}

export function releaseFrameError(frameCount: number) {
  return `Enter a whole release frame from 0 to ${frameCount - 1}`;
}

export function browserShotEndFrame(releaseFrame: number, fps: number, frameCount: number) {
  return Math.min(frameCount - 1, releaseFrame + Math.round(fps * 0.8));
}

function jsonDownload(value: unknown) {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value))}`;
}

export function browserShotReview(sessionId: string, shots: ShotAnalysis[]) {
  const attempts = shots.length;
  const chronological = [...shots].sort((left, right) => left.release_frame - right.release_frame || left.id - right.id);
  let makes = 0;
  let misses = 0;
  let streak = 0;
  let bestStreak = 0;
  let confidence = 0;
  for (const shot of chronological) {
    if (shot.outcome === "make") {
      makes += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else if (shot.outcome === "miss") {
      misses += 1;
      streak = 0;
    }
    confidence += shot.observation_confidence ?? shot.confidence;
  }
  const decided = makes + misses;
  const observed = decided ? Number((makes / decided * 100).toFixed(1)) : null;
  const summary: AnalysisSession["summary"] = {
    attempts,
    makes,
    misses,
    review: attempts - decided,
    fg_pct: observed,
    observed_fg_pct: observed,
    observed_ft_pct: observed,
    predicted_ft_pct: null,
    best_streak: bestStreak,
    average_confidence: attempts ? Number((confidence / attempts * 100).toFixed(1)) : 0,
  };
  return {
    summary,
    shotArtifacts: {
      shots_jsonl: jsonDownload(shots),
      analysis_json: jsonDownload({ session: sessionId, shots }),
    },
  };
}

export function reviewShotMotion(shot: ShotAnalysis, fps: number, takeoffFrame?: number | null): ShotAnalysis {
  const events = shot.evidence.motion_events;
  if (takeoffFrame === undefined && (!events || events.release_frame == null || events.release_frame === shot.release_frame)) return shot;
  const takeoff = takeoffFrame === undefined ? events?.takeoff_frame ?? null : takeoffFrame;
  function interval(start: number | null, end: number | null | undefined) {
    return start != null && end != null && end >= start && events?.timing_available !== false && fps > 0
      ? Number(((end - start) / fps * 1000).toFixed(1))
      : null;
  }
  const motion = {
    ...events,
    takeoff_frame: takeoff,
    release_frame: shot.release_frame,
    release_after_takeoff_ms: interval(takeoff, shot.release_frame),
    follow_through_duration_ms: interval(shot.release_frame, events?.follow_through_end_frame ?? events?.landing_frame),
  };
  const mechanics = shot.evidence.mechanics_assessment;
  return {
    ...shot,
    evidence: {
      ...shot.evidence,
      motion_events: motion,
      ...(mechanics?.components ? { mechanics_assessment: { ...mechanics, components: {
        ...mechanics.components,
        release_after_takeoff_ms: motion.release_after_takeoff_ms,
        follow_through_duration_ms: motion.follow_through_duration_ms,
      } } } : {}),
    },
  };
}

export function refreshBrowserShotReview(session: AnalysisSession): AnalysisSession {
  const shots = session.shots.map((shot) => reviewShotMotion(shot, session.session.fps));
  const { summary, shotArtifacts } = browserShotReview(session.session.id, shots);
  return { ...session, shots, summary, artifacts: { ...session.artifacts, ...shotArtifacts } };
}
