import { useMemo } from "react";
import type { MaskWarning, Track } from "./domain";
import {
  nearestWarningFrame,
  warningFrames,
  warningKinds,
  warningLabels,
  warningRanges,
} from "./warningTimeline";

export default function MaskTimeline({
  warnings,
  count,
  frame,
  tracks,
  stale,
  disabled,
  onInspect,
}: {
  warnings: MaskWarning[];
  count: number;
  frame: number;
  tracks: Track[];
  stale: boolean;
  disabled: boolean;
  onInspect: (warning: MaskWarning, trackId?: number) => void;
}) {
  const lanes = useMemo(
    () =>
      warningKinds
        .map((kind) => {
          const frames = warningFrames(warnings, kind);
          return { kind, frames, ranges: warningRanges(frames) };
        })
        .filter((lane) => lane.frames.length),
    [warnings],
  );
  const current = warnings.filter((w) => w.frame === frame);
  const inspect = (kind: MaskWarning["kind"], position: number) => {
    const warning = warnings.find(
      (w) => w.kind === kind && w.frame === position,
    );
    if (warning) onInspect(warning);
  };
  return (
    <section
      className="jumper-mask-timeline"
      aria-label="Mask-quality timeline"
    >
      <strong>Frames to review{stale ? " · Previous run" : ""}</strong>
      <p className="jumper-caption">
        Review hints, not accuracy guarantees. Unmarked frames may still need
        correction.
        {warnings.some((w) => w.kind === "tracking_disagreement")
          ? " Forward/backward mismatch means two independent shooter tracks disagree. Inspect the shooter and add Include/Exclude points, or shorten the segment; these flags do not prove which pass is correct."
          : ""}
        {warnings.some((w) => w.kind === "refinement_uncertain")
          ? " Small-player detail uncertain means a close crop could not safely refine the visible outline. Inspect hands, feet and overlaps; add Include/Exclude points or choose a closer segment. Hidden details cannot be recovered."
          : ""}
        {warnings.some((w) => w.kind === "mask_joined")
          ? " Possible joined players means a mask may include a neighboring person. Inspect both tracks, add Include/Exclude points on the problem frame, and reprocess. Real occlusion can produce similar evidence; this is a review hint, not a confirmed identity error."
          : ""}
        {warnings.some(
          (w) =>
            w.kind === "correction_include_missed" ||
            w.kind === "correction_exclude_failed",
        )
          ? " A correction did not take effect in the final silhouettes. Inspect the flagged frame and track, adjust Include/Exclude points, and reprocess. Points check visible mask membership, not player identity or hidden limbs."
          : ""}
        {warnings.some((w) => w.kind === "memory_rejected")
          ? " An uncertain prediction was kept out of tracking memory. The actual frame remains visible for review; add a clear Include/Exclude correction or shorten the segment. Keeping earlier evidence does not guarantee the track stayed on the right person."
          : ""}
        {stale ? " Selections changed; reprocess to refresh these hints." : ""}
      </p>
      {lanes.length ? (
        <>
          <p className="jumper-caption">
            Click a colored marker to inspect it. Focus a row and use Left/Right
            to move between flagged frames.
          </p>
          <div className="jumper-warning-lanes">
            {lanes.map(({ kind, frames, ranges }) => (
              <button
                key={kind}
                type="button"
                className={`jumper-warning-lane jumper-warning-${kind}`}
                disabled={disabled}
                aria-label={`${warningLabels[kind]}: ${frames.length} flagged frame${frames.length === 1 ? "" : "s"}`}
                onClick={(event) => {
                  const rail = event.currentTarget
                    .querySelector("svg")!
                    .getBoundingClientRect();
                  const desired =
                    event.detail === 0
                      ? frame
                      : Math.max(
                          0,
                          Math.min(
                            count - 1,
                            ((event.clientX - rail.left) / rail.width) * count -
                              0.5,
                          ),
                        );
                  inspect(kind, nearestWarningFrame(frames, desired));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "ArrowRight"
                      ? (frames.find((f) => f > frame) ?? frames.at(-1)!)
                      : ([...frames].reverse().find((f) => f < frame) ??
                        frames[0]);
                  inspect(kind, next);
                }}
              >
                <span>
                  {warningLabels[kind]} <small>({frames.length})</small>
                </span>
                <svg
                  viewBox={`0 0 ${count} 20`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <rect
                    width={count}
                    height="20"
                    className="jumper-warning-rail"
                  />
                  {ranges.map((range) => (
                    <rect
                      key={range.start}
                      x={range.start}
                      y="4"
                      width={range.end - range.start + 1}
                      height="12"
                      fill="currentColor"
                    />
                  ))}
                  <path
                    d={`M${frame + 0.5} 0V20`}
                    stroke="var(--text)"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </button>
            ))}
          </div>
          <div className="jumper-warning-detail" aria-live="polite">
            {current.length ? (
              current.map((w, index) => (
                <div key={index}>
                  <span>
                    {warningLabels[w.kind]} · Frame {w.frame + 1} ·{" "}
                    {(w.frame / 30).toFixed(2)}s
                  </span>
                  {w.kind === "possible_camera_cut" ? (
                    <small>
                      Scene-wide hint; inspect the shooter and other players.
                    </small>
                  ) : null}
                  <div className="jumper-warning-tracks">
                    {w.track_ids?.length ? (
                      w.track_ids.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="button button-outline"
                          disabled={
                            disabled ||
                            !tracks.some((t) => t.id === id && !t.ignored)
                          }
                          onClick={() => onInspect(w, id)}
                        >
                          Inspect track {id}
                        </button>
                      ))
                    ) : (
                      <small>
                        {w.kind !== "possible_camera_cut"
                          ? "Specific track not recorded; check the selected player."
                          : ""}
                      </small>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <span>Frame {frame + 1}: no automatic hints recorded here.</span>
            )}
          </div>
        </>
      ) : (
        <p className="jumper-caption">
          No automatic hints recorded. Review the complete motion before saving.
        </p>
      )}
    </section>
  );
}
