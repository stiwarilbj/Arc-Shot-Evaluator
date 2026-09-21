import { useEffect, useState } from "react";
import {
  Activity,
  Angle,
  CheckCircle2,
  CircleDot,
  Code2,
  Download,
  Gauge,
  Ruler,
  ScanLine,
  TriangleAlert,
  Waypoints,
  XCircle,
} from "lucide-react";
import type { AnalysisSession, ShotAnalysis, WorkspaceTab, CourtCalibration } from "../../domain/analysisTypes";
import { addManualShot, correctSavedShot, updateSessionContext } from "../../services/analysisApi";

interface ShotDataPanelProps {
  session: AnalysisSession;
  shot: ShotAnalysis | null;
  tab: WorkspaceTab;
  onSessionChange?: (session: AnalysisSession) => void;
  onSeekFrame?: (frame: number) => void;
}

function value(value: number | null, suffix = "°", digits = 1) {
  return value === null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function measured(value: number | null, uncertainty: number | null | undefined, suffix = "°", digits = 1) {
  if (value === null) return "—";
  const formatted = `${value.toFixed(digits)}${suffix}`;
  return uncertainty != null && uncertainty >= 0.3 ? `${formatted} · estimated` : formatted;
}

function releaseTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

function parseFrame(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

const OUTCOME = {
  make: { label: "MAKE", Icon: CheckCircle2 },
  miss: { label: "MISS", Icon: XCircle },
  review: { label: "REVIEW", Icon: TriangleAlert },
};

export function ShotDataPanel({ session, shot, tab, onSessionChange, onSeekFrame }: ShotDataPanelProps) {
  const storageKey = shot ? `arc-note-v1:${session.session.id}:${shot.id}` : "";
  const [note, setNote] = useState("");
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [releaseFrameDraft, setReleaseFrameDraft] = useState(shot?.release_frame ?? 0);
  const [shooterDraft, setShooterDraft] = useState("");
  const [takeoffFrameDraft, setTakeoffFrameDraft] = useState(shot?.evidence.motion_events?.takeoff_frame ?? 0);
  const [shootingHandDraft, setShootingHandDraft] = useState<"left" | "right" | "unknown">(shot?.evidence.shooting_hand ?? "unknown");
  const [shotTypeDraft, setShotTypeDraft] = useState(shot?.evidence.shot_type ?? "unknown");
  const [defenderIdsDraft, setDefenderIdsDraft] = useState("");
  const [teamAssignmentsDraft, setTeamAssignmentsDraft] = useState(() => JSON.stringify(shot?.evidence.team_assignments ?? {}, null, 0));
  const [playerHeightDraft, setPlayerHeightDraft] = useState("");
  const [courtPreset, setCourtPreset] = useState<CourtCalibration["preset"]>(session.context?.court_calibration?.preset ?? "unknown");
  const [imagePointsDraft, setImagePointsDraft] = useState(() => JSON.stringify(session.context?.court_calibration?.image_points ?? [], null, 0));
  const [worldPointsDraft, setWorldPointsDraft] = useState(() => JSON.stringify(session.context?.court_calibration?.world_points ?? [], null, 0));
  const [basketGroundDraft, setBasketGroundDraft] = useState(() => JSON.stringify(session.context?.court_calibration?.basket_ground_image ?? [], null, 0));
  const [contextError, setContextError] = useState<string | null>(null);

  useEffect(() => {
    setNote(storageKey ? window.localStorage.getItem(storageKey) ?? "" : "");
    setCorrectionError(null);
    setReleaseFrameDraft(shot?.release_frame ?? 0);
    setShooterDraft(shot?.evidence.shooter_id ?? "");
    setTakeoffFrameDraft(shot?.evidence.motion_events?.takeoff_frame ?? 0);
    setShootingHandDraft(shot?.evidence.shooting_hand ?? "unknown");
    setShotTypeDraft(shot?.evidence.shot_type ?? "unknown");
    setDefenderIdsDraft((shot?.evidence.defenders ?? []).map((defender) => defender.id).join(", "));
    setTeamAssignmentsDraft(JSON.stringify(shot?.evidence.team_assignments ?? {}, null, 0));
    setPlayerHeightDraft(shot?.evidence.player_height_m == null ? "" : String(shot.evidence.player_height_m));
    setCourtPreset(session.context?.court_calibration?.preset ?? "unknown");
    setImagePointsDraft(JSON.stringify(session.context?.court_calibration?.image_points ?? [], null, 0));
    setWorldPointsDraft(JSON.stringify(session.context?.court_calibration?.world_points ?? [], null, 0));
    setBasketGroundDraft(JSON.stringify(session.context?.court_calibration?.basket_ground_image ?? [], null, 0));
    setContextError(null);
  }, [session.context?.court_calibration, shot?.evidence.defenders, shot?.evidence.motion_events?.takeoff_frame, shot?.evidence.player_height_m, shot?.evidence.shot_type, shot?.evidence.shooter_id, shot?.evidence.shooting_hand, shot?.evidence.team_assignments, shot?.release_frame, storageKey]);

  if (!shot) {
    return (
      <aside className="shot-data-panel empty-evidence">
        <CircleDot size={24} />
        <strong>No complete shot attempt found</strong>
        {session.quality ? (
          <span className={`quality-pill quality-${session.quality.tier}`}>
            {session.quality.tier} footage · {Math.round(session.quality.score * 100)}%
          </span>
        ) : null}
        <p>
          {session.quality?.messages[0]
            ?? "Review the warning below the video, then try a clip with the shooter, rim, and arc visible."}
        </p>
        <section className="rail-panel correction-panel empty-correction-panel">
          <h3>Add a missed attempt</h3>
          <p className="basis-note">Use the frame number where the ball leaves the hand. The detector evidence stays unchanged.</p>
          <label className="correction-field">
            <span>Release frame</span>
            <input
              type="number"
              min={0}
              step={1}
              value={releaseFrameDraft}
              onChange={(event) => setReleaseFrameDraft(parseFrame(event.currentTarget.value))}
            />
          </label>
          <button
            className="correction-save"
            type="button"
            onClick={() => {
              setCorrectionError(null);
              void addManualShot(session.session.id, { outcome: "miss", release_frame: releaseFrameDraft })
                .then((updated) => onSessionChange?.(updated))
                .catch((caught: unknown) => setCorrectionError(caught instanceof Error ? caught.message : "Could not add attempt"));
            }}
          >
            Add missed attempt
          </button>
          {correctionError ? <p className="error-message" role="alert">{correctionError}</p> : null}
        </section>
      </aside>
    );
  }

  const outcome = OUTCOME[shot.outcome];
  const OutcomeIcon = outcome.Icon;
  const isJumpShot = (session.shot_mode ?? shot.shot_mode) === "jump_shot";
  return (
    <aside className="shot-data-panel" aria-label={`Shot ${shot.id} evidence`}>
      <h2>Shot {String(shot.id).padStart(2, "0")}</h2>
      <section className={`outcome-panel outcome-${shot.outcome}`}>
        <div className="outcome-title"><OutcomeIcon size={25} /><strong>{outcome.label}</strong></div>
        <div className="confidence"><strong>{Math.round((shot.observation_confidence ?? shot.confidence) * 100)}%</strong><span>Observation confidence</span></div>
      </section>

      {tab === "tracking" ? (
        <section className="rail-panel tracking-panel">
          <h3>Tracking evidence</h3>
          {session.quality ? (
            <Metric
              icon={<Gauge size={15} />}
              label="Footage quality"
              result={`${session.quality.tier} · ${Math.round(session.quality.score * 100)}%`}
            />
          ) : null}
          {isJumpShot ? (
            <>
              <Metric label="Shot type" result={shot.evidence.shot_type?.replaceAll("_", " ") ?? "Unknown · review"} />
              <Metric label="Shooting hand" result={shot.evidence.shooting_hand ?? "Unknown"} />
              <Metric
                icon={<Ruler size={15} />}
                label="Takeoff distance"
                result={shot.evidence.distance?.availability && shot.evidence.distance.value != null
                  ? `${shot.evidence.distance.value.toFixed(2)} ${shot.evidence.distance.units}${shot.evidence.distance.uncertainty != null ? ` ± ${shot.evidence.distance.uncertainty.toFixed(2)}` : ""}${shot.evidence.distance.calibration_quality === "projected_basket_assumption_review" ? " · review" : ""}`
                  : "Unavailable · calibrate court"}
              />
              <Metric label="Motion" result={shot.evidence.motion_events?.motion_type?.replaceAll("_", " ") ?? "Unknown"} />
              <Metric label="Release after takeoff" result={shot.evidence.motion_events?.release_after_takeoff_ms == null ? "Unavailable" : `${shot.evidence.motion_events.release_after_takeoff_ms.toFixed(0)} ms`} />
              <Metric label="Defenders tracked" result={String(shot.evidence.defenders?.length ?? 0)} />
              <p className="basis-note">{shot.evidence.statistics_eligibility?.reason ?? "Shot subtype remains subject to review."}</p>
              <div className="event-links" aria-label="Jump-shot evidence frames">
                <h4>Evidence frames</h4>
                {[
                  ["Preparation", shot.evidence.motion_events?.gather_frame],
                  ["Takeoff", shot.evidence.motion_events?.takeoff_frame],
                  ["Release", shot.evidence.motion_events?.release_frame ?? shot.release_frame],
                  ["Contest", shot.evidence.defenders?.[0]?.evidence_frames?.[0]],
                  ["Rim interaction", shot.evidence.crossing_frame ?? undefined],
                  ["Landing", shot.evidence.motion_events?.landing_frame],
                ].map(([label, frame]) => (
                  <button key={label} type="button" className="evidence-link" disabled={typeof frame !== "number"} onClick={() => {
                    if (typeof frame === "number") onSeekFrame?.(frame);
                  }}>
                    {label}<span>{typeof frame === "number" ? `Frame ${frame}` : "Unavailable"}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <Metric icon={<ScanLine size={15} />} label="Ball coverage" result={`${shot.evidence.observed_ball_frames} / ${shot.evidence.tracked_frames}`} />
          <Metric
            icon={<CircleDot size={15} />}
            label="Rim track"
            result={`${Math.round((session.quality?.rim_coverage ?? shot.evidence.rim_track_confidence) * 100)}%`}
          />
          {session.quality?.blur_score !== undefined ? (
            <Metric
              icon={<ScanLine size={15} />}
              label="Blur resilience"
              result={`${Math.round(session.quality.blur_score * 100)}%`}
            />
          ) : null}
          <Metric icon={<Activity size={15} />} label="Pose confidence" result={`${Math.round(shot.evidence.pose_confidence * 100)}%`} />
          {session.session.timing_preserved === false ? (
            <Metric label="Source timing" result="Converted · speed unavailable" />
          ) : null}
          {shot.evidence.shooting_hand && !isJumpShot ? (
            <Metric
              label="Shooting hand"
              result={shot.evidence.shooting_hand === "unknown"
                ? "Unknown"
                : `${shot.evidence.shooting_hand} · ${Math.round((shot.evidence.handedness_confidence ?? 0) * 100)}%`}
            />
          ) : null}
          {shot.evidence.calibration_status ? (
            <Metric label="Measurement basis" result={shot.evidence.measurement_space === "rim_relative_2d" ? "Rim-scaled 2D" : "Unavailable"} />
          ) : null}
          {shot.evidence.crossing_frame !== null ? (
            <Metric
              icon={<Waypoints size={15} />}
              label="Net evidence"
              result={
                shot.evidence.net_drag_confirmed
                  ? "Drag Confirmed"
                  : shot.evidence.reappeared_below_rim
                    ? "Reappeared"
                    : "Review"
              }
            />
          ) : null}
          {shot.evidence.outcome_basis ? <p className="basis-note">{shot.evidence.outcome_basis}</p> : null}
          {isJumpShot && shot.evidence.defenders?.length ? (
            <div className="defender-evidence">
              <h4>Defender context</h4>
              {shot.evidence.defenders.map((defender) => (
                <div className="defender-row" key={defender.id}>
                  <span>{defender.id}</span>
                  <strong>{defender.separation?.value == null ? "—" : `${defender.separation.value.toFixed(0)} px`}</strong>
                  <small>{defender.closing_speed?.value == null ? "closing speed unavailable" : `${defender.closing_speed.value.toFixed(0)} px/s`} · {defender.arm_extension == null ? "arm unknown" : `arm ${defender.arm_extension.toFixed(2)}`} · {defender.body_orientation_deg == null ? "body unknown" : `body ${defender.body_orientation_deg.toFixed(0)}°`}{defender.timing_available === false ? " · timing unknown" : ""}</small>
                </div>
              ))}
              <p className="basis-note">Opponent identity and world-unit separation require court/team review.</p>
            </div>
          ) : isJumpShot ? <p className="basis-note">No reliable defender track was found; this does not imply an open shot.</p> : null}
          <div className="flag-list">
            {(shot.flags.length ? shot.flags : ["No material tracking warnings"]).map((flag) => <p key={flag}>{flag}</p>)}
          </div>
        </section>
      ) : (
        <>
          <section className="rail-panel metric-panel">
            {isJumpShot ? (
              <>
                <Metric label="Release" result={releaseTime(shot.release_time)} />
                <Metric label="Shot distance" result={shot.evidence.distance?.availability && shot.evidence.distance.value != null ? `${shot.evidence.distance.value.toFixed(2)} ${shot.evidence.distance.units}` : "Unavailable"} />
                <Metric label="Takeoff" result={shot.evidence.motion_events?.takeoff_frame == null ? "Unavailable" : `frame ${shot.evidence.motion_events.takeoff_frame}`} />
                <Metric label="Landing" result={shot.evidence.motion_events?.landing_frame == null ? "Unavailable" : `frame ${shot.evidence.motion_events.landing_frame}`} />
                <Metric label="Mechanics quality" result={shot.evidence.mechanics_assessment?.overall == null ? "Unavailable · validation pending" : `${Math.round(shot.evidence.mechanics_assessment.overall * 100)}%`} />
                <Metric label="Chance at release" result={shot.evidence.predictions?.release?.probability == null ? "Unavailable · validation pending" : `${Math.round(shot.evidence.predictions.release.probability * 100)}%`} />
                <Metric label="Chance after 200 ms" result={shot.evidence.predictions?.release_plus_200ms?.probability == null ? "Unavailable · validation pending" : `${Math.round(shot.evidence.predictions.release_plus_200ms.probability * 100)}%`} />
                <p className="basis-note">Probability is withheld until a jump-shot model is trained and calibrated on held-out players and venues.</p>
              </>
            ) : null}
            {!isJumpShot ? <>
            <Metric label="Release" result={releaseTime(shot.release_time)} />
            <Metric label="Entry angle" result={measured(shot.entry_angle_deg, shot.evidence.metric_uncertainty?.entry_angle_deg)} />
            <Metric label="Release speed" result={measured(shot.release_speed_ms, shot.evidence.metric_uncertainty?.release_speed_ms, " m/s", 1)} />
            <Metric label="Release height" result={measured(shot.release_height_m, shot.evidence.metric_uncertainty?.release_height_m, " m", 2)} />
            <Metric label="Arc peak" result={measured(shot.arc_peak_m, shot.evidence.metric_uncertainty?.arc_peak_m, " m", 2)} />
            <Metric label="Elbow extension" result={shot.evidence.temporal_mechanics?.elbow_extension_timing_ms == null ? "—" : `${shot.evidence.temporal_mechanics.elbow_extension_timing_ms.toFixed(0)} ms`} />
            <Metric label="Follow-through" result={shot.evidence.temporal_mechanics?.follow_through_duration_ms == null ? "—" : `${shot.evidence.temporal_mechanics.follow_through_duration_ms.toFixed(0)} ms`} />
            <Metric label="Future FT%" result={shot.evidence.predicted_ft_pct == null ? "Unavailable" : value(shot.evidence.predicted_ft_pct, "%", 0)} />
            {shot.evidence.predicted_ft_pct == null ? <p className="basis-note">Future probability is withheld until a model passes held-out calibration</p> : null}
            </> : null}
          </section>
          <section className="rail-panel form-panel">
            <h3>{isJumpShot ? "Pose at release" : "Form at release"}</h3>
            {isJumpShot ? <p className="basis-note">Joint angles are descriptive observations; no jump-shot grade is reported before blinded coaching validation.</p> : null}
            {shot.evidence.shot_quality != null ? (
              <Metric label="Visible shot quality" result={`${Math.round(shot.evidence.shot_quality * 100)}%`} />
            ) : null}
            <Metric icon={<Angle size={15} />} label="Elbow" result={value(shot.form.elbow, "°", 0)} signal />
            <Metric icon={<Gauge size={15} />} label="Knee" result={value(shot.form.knee, "°", 0)} signal />
            <Metric icon={<Activity size={15} />} label="Shoulder" result={value(shot.form.shoulder, "°", 0)} signal />
            <Metric icon={<Ruler size={15} />} label="Hip" result={value(shot.form.hip, "°", 0)} signal />
            {isJumpShot && shot.evidence.mechanics_assessment?.components ? Object.entries(shot.evidence.mechanics_assessment.components).map(([key, item]) => (
              <Metric key={key} label={key.replaceAll("_", " ")} result={item == null ? "—" : typeof item === "number" ? `${item.toFixed(0)}${key.includes("ms") ? " ms" : ""}` : String(item)} />
            )) : null}
          </section>
        </>
      )}

      <section className="rail-panel correction-panel">
        <h3>Review this outcome</h3>
        <p className="basis-note">Observation confidence describes what the video shows. Form quality does not change it.</p>
        <div className="correction-actions" role="group" aria-label="Correct shot outcome">
          {(["make", "miss", "review"] as const).map((nextOutcome) => (
            <button
              key={nextOutcome}
              type="button"
              className={shot.outcome === nextOutcome ? "is-selected" : ""}
              onClick={() => {
                setCorrectionError(null);
                void correctSavedShot(session.session.id, shot.id, { outcome: nextOutcome })
                  .then((updated) => onSessionChange?.(updated))
                  .catch((caught: unknown) => setCorrectionError(caught instanceof Error ? caught.message : "Could not save correction"));
              }}
            >
              {nextOutcome.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="correction-field">
          <span>Release frame</span>
          <input
            type="number"
            min={0}
            step={1}
            value={releaseFrameDraft}
            onChange={(event) => setReleaseFrameDraft(parseFrame(event.currentTarget.value))}
          />
        </label>
        <label className="correction-field">
          <span>Shooter label (optional)</span>
          <input
            type="text"
            placeholder="e.g. player-1"
            value={shooterDraft}
            onChange={(event) => setShooterDraft(event.currentTarget.value)}
          />
        </label>
        {isJumpShot ? (
          <>
            <label className="correction-field">
              <span>Shot classification</span>
              <select value={shotTypeDraft} onChange={(event) => setShotTypeDraft(event.currentTarget.value)}>
                <option value="unknown">Unknown / review</option>
                <option value="three_pointer">Three-pointer</option>
                <option value="mid_range">Mid-range</option>
                <option value="near_three_point_line_review">Near line / review</option>
                <option value="layup">Layup (exclude)</option>
                <option value="dunk">Dunk (exclude)</option>
                <option value="pass">Pass (exclude)</option>
                <option value="pump_fake">Pump fake (exclude)</option>
              </select>
            </label>
            <label className="correction-field">
              <span>Takeoff frame</span>
              <input type="number" min={0} step={1} value={takeoffFrameDraft} onChange={(event) => setTakeoffFrameDraft(parseFrame(event.currentTarget.value))} />
            </label>
            <label className="correction-field">
              <span>Shooting hand</span>
              <select value={shootingHandDraft} onChange={(event) => setShootingHandDraft(event.currentTarget.value as "left" | "right" | "unknown")}>
                <option value="unknown">Unknown</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label className="correction-field">
              <span>Defender track labels</span>
              <input type="text" placeholder="player-2, player-3" value={defenderIdsDraft} onChange={(event) => setDefenderIdsDraft(event.currentTarget.value)} />
            </label>
            <label className="correction-field">
              <span>Team / role assignments JSON</span>
              <textarea value={teamAssignmentsDraft} onChange={(event) => setTeamAssignmentsDraft(event.currentTarget.value)} placeholder='{"player-2":"opponent","player-3":"official"}' />
            </label>
            <label className="correction-field">
              <span>Shooter height (m, optional)</span>
              <input type="number" min={0.5} max={2.8} step={0.01} placeholder="e.g. 1.98" value={playerHeightDraft} onChange={(event) => setPlayerHeightDraft(event.currentTarget.value)} />
            </label>
          </>
        ) : null}
        <button
          className="correction-save"
          type="button"
          onClick={() => {
            setCorrectionError(null);
            let teamAssignments: Record<string, "shooter" | "teammate" | "opponent" | "official" | "unknown"> | undefined;
            if (isJumpShot && teamAssignmentsDraft.trim()) {
              try {
                const parsed = JSON.parse(teamAssignmentsDraft) as unknown;
                if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.entries(parsed).some(([, role]) => !["shooter", "teammate", "opponent", "official", "unknown"].includes(String(role)))) {
                  throw new Error("Assignments must map track labels to valid roles");
                }
                teamAssignments = parsed as Record<string, "shooter" | "teammate" | "opponent" | "official" | "unknown">;
              } catch (caught) {
                setCorrectionError(caught instanceof Error ? caught.message : "Team assignments must be valid JSON");
                return;
              }
            }
            void correctSavedShot(session.session.id, shot.id, {
              release_frame: releaseFrameDraft,
              ...(shooterDraft.trim() ? { shooter_id: shooterDraft.trim() } : {}),
              ...(isJumpShot ? {
                takeoff_frame: takeoffFrameDraft,
                shot_type: shotTypeDraft,
                shooting_hand: shootingHandDraft,
                defender_ids: defenderIdsDraft.split(",").map((item) => item.trim()).filter(Boolean),
                ...(teamAssignments ? { team_assignments: teamAssignments } : {}),
                ...(playerHeightDraft.trim() ? { player_height_m: Number(playerHeightDraft) } : {}),
              } : {}),
            })
              .then((updated) => onSessionChange?.(updated))
              .catch((caught: unknown) => setCorrectionError(caught instanceof Error ? caught.message : "Could not save correction"));
          }}
        >
          Save timing / shooter correction
        </button>
        <button
          className="correction-save"
          type="button"
          onClick={() => {
            setCorrectionError(null);
            void addManualShot(session.session.id, { outcome: "miss", release_frame: releaseFrameDraft })
              .then((updated) => onSessionChange?.(updated))
              .catch((caught: unknown) => setCorrectionError(caught instanceof Error ? caught.message : "Could not add attempt"));
          }}
        >
          Add missed attempt at this frame
        </button>
        {shot.evidence.correction ? <p className="basis-note">Correction saved · model evidence remains in the export</p> : null}
        {correctionError ? <p className="error-message" role="alert">{correctionError}</p> : null}
      </section>

      {isJumpShot ? (
        <section className="rail-panel correction-panel calibration-panel">
          <h3>Court setup</h3>
          <p className="basis-note">Four floor landmarks let ARC turn projected feet into a court-plane distance. Coordinates are source-video pixels and court metres.</p>
          <label className="correction-field">
            <span>Court rules</span>
            <select value={courtPreset} onChange={(event) => setCourtPreset(event.currentTarget.value as CourtCalibration["preset"])}>
              <option value="unknown">Unknown</option>
              <option value="nba">NBA / WNBA</option>
              <option value="ncaa">NCAA</option>
              <option value="fiba">FIBA</option>
              <option value="high_school">High school</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="correction-field">
            <span>Image points JSON</span>
            <textarea value={imagePointsDraft} onChange={(event) => setImagePointsDraft(event.currentTarget.value)} placeholder="[[x1,y1],[x2,y2],[x3,y3],[x4,y4]]" />
          </label>
          <label className="correction-field">
            <span>Court points JSON (metres)</span>
            <textarea value={worldPointsDraft} onChange={(event) => setWorldPointsDraft(event.currentTarget.value)} placeholder="[[0,0],[10,0],[10,15],[0,15]]" />
          </label>
          <label className="correction-field">
            <span>Basket ground projection JSON</span>
            <textarea value={basketGroundDraft} onChange={(event) => setBasketGroundDraft(event.currentTarget.value)} placeholder="[x, y] (optional; rim center is review-only)" />
          </label>
          <button
            className="correction-save"
            type="button"
            onClick={() => {
              setContextError(null);
              try {
                const imagePoints = JSON.parse(imagePointsDraft) as unknown;
                const worldPoints = JSON.parse(worldPointsDraft) as unknown;
                const basketGround = JSON.parse(basketGroundDraft) as unknown;
                if (!Array.isArray(imagePoints) || imagePoints.length !== 4 || !Array.isArray(worldPoints) || worldPoints.length !== 4) throw new Error("Use four [x, y] points in each field");
                if (basketGround !== null && basketGround !== undefined && (!Array.isArray(basketGround) || basketGround.length !== 0 && basketGround.length !== 2)) throw new Error("Basket projection must be [x, y] or empty");
                void updateSessionContext(session.session.id, {
                  court_calibration: {
                    preset: courtPreset,
                    units: "m",
                    image_points: imagePoints as number[][],
                    world_points: worldPoints as number[][],
                    ...(Array.isArray(basketGround) && basketGround.length === 2 ? { basket_ground_image: basketGround as number[] } : {}),
                  },
                }).then((updated) => onSessionChange?.(updated)).catch((caught: unknown) => setContextError(caught instanceof Error ? caught.message : "Could not save court setup"));
              } catch (caught) {
                setContextError(caught instanceof Error ? caught.message : "Court points must be valid JSON");
              }
            }}
          >
            Save court setup
          </button>
          {contextError ? <p className="error-message" role="alert">{contextError}</p> : null}
        </section>
      ) : null}

      <section className="rail-panel notes-panel">
        <h3>Shot {String(shot.id).padStart(2, "0")} notes</h3>
        <textarea
          aria-label="Shot notes"
          placeholder="Add a note…"
          value={note}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setNote(next);
            window.localStorage.setItem(storageKey, next);
          }}
        />
      </section>
      <section className="rail-panel export-panel">
        <h3>Export</h3>
        {session.artifacts.source_original ? <a href={session.artifacts.source_original} download><Download size={16} />Source original</a> : null}
        <a href={session.artifacts.annotated} download><Download size={16} />Annotated MP4</a>
        <a href={session.artifacts.shots_jsonl} download><Code2 size={16} />Shot data JSON</a>
      </section>
    </aside>
  );
}

function Metric({ label, result, icon, signal = false }: { label: string; result: string; icon?: React.ReactNode; signal?: boolean }) {
  return (
    <div className="metric-row">
      <span>{icon}{label}</span>
      <strong>{result}{signal && result !== "—" ? <i aria-label="available" /> : null}</strong>
    </div>
  );
}
