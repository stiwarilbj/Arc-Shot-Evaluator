import type { AnalysisSession, ShotAnalysis, ShotMode } from "./analysisTypes";
import { browserReleasePose, BROWSER_MOTION_WINDOW_FLAG, VISIBLE_FORM_REVIEW_FLAG } from "./browserPose.ts";

const EXCLUDED_JUMP_SHOT_TYPES = new Set(["layup", "dunk", "pass", "pump_fake"]);

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

export function reviewJumpShotClassification(shot: ShotAnalysis, shotType: string): ShotAnalysis {
  const statisticsEligibility = EXCLUDED_JUMP_SHOT_TYPES.has(shotType)
    ? { status: "excluded", reason: "Non-jump attempt excluded from jump-shot statistics" }
    : shotType === "unknown" || shotType === "near_three_point_line_review"
      ? { status: "review", reason: "Shot subtype remains subject to review" }
      : { status: "eligible_pending_validation", reason: "Shot type set during review" };
  return {
    ...shot,
    evidence: { ...shot.evidence, shot_type: shotType, statistics_eligibility: statisticsEligibility },
  };
}

export function browserShotReview(sessionId: string, shots: ShotAnalysis[], shotMode?: ShotMode) {
  const isJumpShot = shotMode === "jump_shot";
  const counted = isJumpShot ? shots.filter((shot) => shot.evidence.statistics_eligibility?.status !== "excluded") : shots;
  const attempts = counted.length;
  const chronological = [...counted].sort((left, right) => left.release_frame - right.release_frame || left.id - right.id);
  let makes = 0;
  let misses = 0;
  let threePointMakes = 0;
  let threePointAttempts = 0;
  let streak = 0;
  let bestStreak = 0;
  let confidence = 0;
  for (const shot of chronological) {
    if (isJumpShot && shot.evidence.shot_type === "three_pointer"
        && (shot.outcome === "make" || shot.outcome === "miss")) {
      threePointAttempts += 1;
      if (shot.outcome === "make") threePointMakes += 1;
    }
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
    ...(isJumpShot ? {
      detected_attempts: shots.length,
      excluded_attempts: shots.length - attempts,
      observed_three_pct: threePointAttempts ? Number((threePointMakes / threePointAttempts * 100).toFixed(1)) : null,
    } : {}),
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

function reviewBrowserDefenders(shot: ShotAnalysis): ShotAnalysis {
  const { defender_ids: savedIds, defenders, detected_defenders: original, team_assignments: assignments } = shot.evidence;
  // Older browser corrections stored the labels as ID-only defender records.
  const legacyIds = savedIds === undefined && original === undefined
    && defenders?.every((defender) => typeof defender?.id === "string" && Object.keys(defender).length === 1)
    ? defenders.map(({ id }) => id) : undefined;
  const reviewedIds = savedIds ?? legacyIds;
  if (reviewedIds === undefined && assignments === undefined) return shot;

  const detected = original ?? (legacyIds ? [] : defenders ?? []);
  const allowedIds = reviewedIds === undefined ? undefined : new Set(reviewedIds);
  const reviewed = detected.flatMap((defender) => {
    if (allowedIds && !allowedIds.has(defender.id)) return [];
    const role = assignments && Object.hasOwn(assignments, defender.id) ? assignments[defender.id] : undefined;
    if (role === "teammate" || role === "official") return [];
    return [role === undefined ? defender : { ...defender, role }];
  });
  return {
    ...shot,
    evidence: { ...shot.evidence, defender_ids: reviewedIds, detected_defenders: detected, defenders: reviewed },
  };
}

export function refreshBrowserShotReview(session: AnalysisSession): AnalysisSession {
  const shots = session.shots.map((shot) => {
    let updated = reviewShotMotion(shot, session.session.fps);
    // The persisted motion-window flag also identifies generated shots in older browser reviews.
    if (session.pose_overlay && shot.flags.includes(BROWSER_MOTION_WINDOW_FLAG)) {
      const pose = browserReleasePose(session.pose_overlay, shot.release_time);
      const flags = updated.flags.filter((flag) => flag !== VISIBLE_FORM_REVIEW_FLAG);
      if (pose.evidence.shot_quality != null && pose.evidence.shot_quality < 0.45) flags.push(VISIBLE_FORM_REVIEW_FLAG);
      updated = {
        ...updated,
        form: pose.form,
        flags,
        evidence: {
          ...updated.evidence,
          ...pose.evidence,
          metric_availability: { ...updated.evidence.metric_availability, ...pose.evidence.metric_availability },
        },
      };
    }
    if ((session.shot_mode ?? shot.shot_mode) === "jump_shot") updated = reviewBrowserDefenders(updated);
    const type = updated.evidence.shot_type;
    // Older browser saves recorded the exclusion label without its eligibility.
    if (session.shot_mode === "jump_shot" && type && EXCLUDED_JUMP_SHOT_TYPES.has(type)
        && updated.evidence.statistics_eligibility?.status !== "excluded") {
      return reviewJumpShotClassification(updated, type);
    }
    return updated;
  });
  const { summary, shotArtifacts } = browserShotReview(session.session.id, shots, session.shot_mode);
  return { ...session, shots, summary, artifacts: { ...session.artifacts, ...shotArtifacts } };
}
