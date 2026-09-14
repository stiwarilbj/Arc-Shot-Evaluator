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
import type { AnalysisSession, ShotAnalysis, WorkspaceTab } from "../../domain/analysisTypes";
import { addManualShot, correctSavedShot } from "../../services/analysisApi";

interface ShotDataPanelProps {
  session: AnalysisSession;
  shot: ShotAnalysis | null;
  tab: WorkspaceTab;
  onSessionChange?: (session: AnalysisSession) => void;
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

export function ShotDataPanel({ session, shot, tab, onSessionChange }: ShotDataPanelProps) {
  const storageKey = shot ? `arc-note-v1:${session.session.id}:${shot.id}` : "";
  const [note, setNote] = useState("");
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [releaseFrameDraft, setReleaseFrameDraft] = useState(shot?.release_frame ?? 0);
  const [shooterDraft, setShooterDraft] = useState("");

  useEffect(() => {
    setNote(storageKey ? window.localStorage.getItem(storageKey) ?? "" : "");
    setCorrectionError(null);
    setReleaseFrameDraft(shot?.release_frame ?? 0);
    setShooterDraft(shot?.evidence.shooter_id ?? "");
  }, [shot?.evidence.shooter_id, shot?.release_frame, storageKey]);

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
          {shot.evidence.shooting_hand ? (
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
          <div className="flag-list">
            {(shot.flags.length ? shot.flags : ["No material tracking warnings"]).map((flag) => <p key={flag}>{flag}</p>)}
          </div>
        </section>
      ) : (
        <>
          <section className="rail-panel metric-panel">
            <Metric label="Release" result={releaseTime(shot.release_time)} />
            <Metric label="Entry angle" result={measured(shot.entry_angle_deg, shot.evidence.metric_uncertainty?.entry_angle_deg)} />
            <Metric label="Release speed" result={measured(shot.release_speed_ms, shot.evidence.metric_uncertainty?.release_speed_ms, " m/s", 1)} />
            <Metric label="Release height" result={measured(shot.release_height_m, shot.evidence.metric_uncertainty?.release_height_m, " m", 2)} />
            <Metric label="Arc peak" result={measured(shot.arc_peak_m, shot.evidence.metric_uncertainty?.arc_peak_m, " m", 2)} />
            <Metric label="Elbow extension" result={shot.evidence.temporal_mechanics?.elbow_extension_timing_ms == null ? "—" : `${shot.evidence.temporal_mechanics.elbow_extension_timing_ms.toFixed(0)} ms`} />
            <Metric label="Follow-through" result={shot.evidence.temporal_mechanics?.follow_through_duration_ms == null ? "—" : `${shot.evidence.temporal_mechanics.follow_through_duration_ms.toFixed(0)} ms`} />
            <Metric label="Future FT%" result={shot.evidence.predicted_ft_pct == null ? "Unavailable" : value(shot.evidence.predicted_ft_pct, "%", 0)} />
            {shot.evidence.predicted_ft_pct == null ? <p className="basis-note">Future probability is withheld until a model passes held-out calibration</p> : null}
          </section>
          <section className="rail-panel form-panel">
            <h3>Form at release</h3>
            {shot.evidence.shot_quality != null ? (
              <Metric label="Visible shot quality" result={`${Math.round(shot.evidence.shot_quality * 100)}%`} />
            ) : null}
            <Metric icon={<Angle size={15} />} label="Elbow" result={value(shot.form.elbow, "°", 0)} signal />
            <Metric icon={<Gauge size={15} />} label="Knee" result={value(shot.form.knee, "°", 0)} signal />
            <Metric icon={<Activity size={15} />} label="Shoulder" result={value(shot.form.shoulder, "°", 0)} signal />
            <Metric icon={<Ruler size={15} />} label="Hip" result={value(shot.form.hip, "°", 0)} signal />
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
        <button
          className="correction-save"
          type="button"
          onClick={() => {
            setCorrectionError(null);
            void correctSavedShot(session.session.id, shot.id, {
              release_frame: releaseFrameDraft,
              ...(shooterDraft.trim() ? { shooter_id: shooterDraft.trim() } : {}),
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
        {shot.evidence.correction ? <p className="basis-note">Locally corrected · model evidence remains in the export</p> : null}
        {correctionError ? <p className="error-message" role="alert">{correctionError}</p> : null}
      </section>

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
