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

interface ShotDataPanelProps {
  session: AnalysisSession;
  shot: ShotAnalysis | null;
  tab: WorkspaceTab;
}

function value(value: number | null, suffix = "°", digits = 1) {
  return value === null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function releaseTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

const OUTCOME = {
  make: { label: "MAKE", Icon: CheckCircle2 },
  miss: { label: "MISS", Icon: XCircle },
  review: { label: "REVIEW", Icon: TriangleAlert },
};

export function ShotDataPanel({ session, shot, tab }: ShotDataPanelProps) {
  const storageKey = shot ? `arc-note-v1:${session.session.id}:${shot.id}` : "";
  const [note, setNote] = useState("");

  useEffect(() => {
    setNote(storageKey ? window.localStorage.getItem(storageKey) ?? "" : "");
  }, [storageKey]);

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
        <div className="confidence"><strong>{Math.round(shot.confidence * 100)}%</strong><span>Confidence</span></div>
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
            <Metric label="Entry angle" result={value(shot.entry_angle_deg)} />
            <Metric label="Release speed" result={value(shot.release_speed_ms, " m/s", 1)} />
            <Metric label="Release height" result={value(shot.release_height_m, " m", 2)} />
            <Metric label="Arc peak" result={value(shot.arc_peak_m, " m", 2)} />
          </section>
          <section className="rail-panel form-panel">
            <h3>Form at release</h3>
            <Metric icon={<Angle size={15} />} label="Elbow" result={value(shot.form.elbow, "°", 0)} signal />
            <Metric icon={<Gauge size={15} />} label="Knee" result={value(shot.form.knee, "°", 0)} signal />
            <Metric icon={<Activity size={15} />} label="Shoulder" result={value(shot.form.shoulder, "°", 0)} signal />
            <Metric icon={<Ruler size={15} />} label="Hip" result={value(shot.form.hip, "°", 0)} signal />
          </section>
        </>
      )}

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
