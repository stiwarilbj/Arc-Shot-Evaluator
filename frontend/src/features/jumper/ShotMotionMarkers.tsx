import { useMemo, useState } from "react";
import { editFrame, type EditProject, type ShotMarker } from "./editProject";
import {
  shotMarkerKinds,
  shotMarkerNames,
  shotMotionWarnings,
} from "./shotMarkers";

export default function ShotMotionMarkers({
  project,
  frame,
  onSet,
  onPreview,
  onInspect,
}: {
  project: EditProject;
  frame: number;
  onSet: (kind: ShotMarker, source: number | undefined) => void;
  onPreview: (source: number) => void;
  onInspect: (edited: number) => void;
}) {
  const [cursor, setCursor] = useState<number | null>(null);
  const source = Math.max(
    0,
    Math.min(
      project.baseFrames - 1,
      cursor ?? editFrame(project, frame).source,
    ),
  );
  const warnings = useMemo(() => shotMotionWarnings(project), [project]);
  function seek(value: number) {
    if (!Number.isFinite(value)) return;
    const next = Math.max(
      0,
      Math.min(project.baseFrames - 1, Math.round(value)),
    );
    setCursor(next);
    onPreview(next);
  }
  return (
    <details className="jumper-shot-markers">
      <summary>Protect shooting motion (optional)</summary>
      <p className="jumper-caption">
        Mark Gather, Release, and Finish on the masked source timeline. These
        reference frames stay fixed when pieces move or are cut. Warnings are
        advice only; you can keep any edit. Source time begins at the masked
        segment, not the original upload.
      </p>
      <label>
        Source time for shot markers (s)
        <input
          type="number"
          aria-label="Shot marker source time"
          min={0}
          max={(project.baseFrames - 1) / 30}
          step={1 / 30}
          value={(source / 30).toFixed(2)}
          onChange={(event) => seek(Number(event.target.value) * 30)}
        />
      </label>
      <input
        type="range"
        aria-label="Shot marker source frame"
        min={0}
        max={project.baseFrames - 1}
        step={1}
        value={source}
        onChange={(event) => seek(Number(event.target.value))}
      />
      <p className="jumper-caption">
        Source frame {source + 1} · {(source / 30).toFixed(2)}s. Preview before
        marking.
      </p>
      <button onClick={() => seek(editFrame(project, frame).source)}>
        Use edited playhead for markers
      </button>
      <div className="jumper-shot-marker-list">
        {shotMarkerKinds.map((kind) => {
          const marked = project.shotMarkers?.[kind];
          return (
            <div
              key={kind}
              role="group"
              aria-label={`${shotMarkerNames[kind]} marker`}
            >
              <button
                onClick={() => {
                  onSet(kind, source);
                  onPreview(source);
                }}
              >
                {marked === undefined ? "Mark" : "Update"}{" "}
                {shotMarkerNames[kind]} here
              </button>
              {marked === undefined ? (
                <span>{shotMarkerNames[kind]} not marked</span>
              ) : (
                <>
                  <button onClick={() => seek(marked)}>
                    {shotMarkerNames[kind]} · {(marked / 30).toFixed(2)}s ·
                    Source frame {marked + 1}
                  </button>
                  <button onClick={() => onSet(kind, undefined)}>
                    Remove {shotMarkerNames[kind]} marker
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="jumper-caption">
        Mark at least two stages to check cuts between them. These are your
        reference points, not automatic pose detection. Markers never appear in
        downloads or quizzes.
      </p>
      <div aria-live="polite">
        {warnings.map((warning) => (
          <div className="jumper-notice" key={warning.id}>
            <p>{warning.message}</p>
            {warning.source !== undefined ? (
              <button onClick={() => seek(warning.source!)}>
                Inspect marked source frame {warning.source + 1}
              </button>
            ) : null}
            {warning.edited !== undefined ? (
              <button onClick={() => onInspect(warning.edited!)}>
                Inspect cut at {(warning.edited / 30).toFixed(2)}s
              </button>
            ) : null}
          </div>
        ))}
        {project.shotMarkers &&
        Object.keys(project.shotMarkers).length > 0 &&
        !warnings.length ? (
          <p className="jumper-caption">
            No marker-based interruptions detected. Review the complete motion
            yourself.
          </p>
        ) : null}
      </div>
    </details>
  );
}
