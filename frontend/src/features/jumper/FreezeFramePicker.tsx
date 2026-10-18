import { useEffect, useMemo, useState } from "react";
import { CanvasSink } from "mediabunny";
import { openVideo } from "./media";
import { editFrame, type EditProject } from "./editProject";
import {
  nearbyFreezeFrames,
  freezeEdgeClarity,
  freezeClarityHint,
} from "./freezeFrames";

export default function FreezeFramePicker({
  base,
  project,
  frame,
  active,
  onSelect,
}: {
  base: Blob;
  project: EditProject;
  frame: number;
  active: boolean;
  onSelect: (frame: number) => void;
}) {
  const [anchor, setAnchor] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const candidates = useMemo(
    () => (anchor === null ? [] : nearbyFreezeFrames(project, anchor)),
    [project, anchor],
  );
  const key = candidates.map((candidate) => candidate.source).join(",");
  const [result, setResult] = useState<{
    base: Blob;
    key: string;
    images: { source: number; image: string; clarity: number }[];
    error?: boolean;
  } | null>(null);
  const open = anchor !== null;
  useEffect(() => {
    if (!active || !open) return;
    let cancelled = false;
    let input: Awaited<ReturnType<typeof openVideo>>["input"] | undefined;
    void (async () => {
      const opened = await openVideo(base);
      input = opened.input;
      if (cancelled) return;
      const [width, height] = await Promise.all([
        opened.track.getDisplayWidth(),
        opened.track.getDisplayHeight(),
      ]);
      if (cancelled) return;
      const scale = Math.min(1, 256 / Math.max(width, height));
      const sink = new CanvasSink(opened.track, {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        fit: "fill",
        poolSize: 1,
      });
      const images = [];
      for (const source of key.split(",").map(Number)) {
        const sample = await sink.getCanvas(source / 30 + 0.00001);
        if (cancelled) return;
        if (!sample) throw Error("Missing recorded frame");
        const canvas = document.createElement("canvas");
        canvas.width = sample.canvas.width;
        canvas.height = sample.canvas.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw Error("Frame preview unavailable");
        context.drawImage(sample.canvas, 0, 0);
        images.push({
          source,
          image: canvas.toDataURL("image/png"),
          clarity: freezeEdgeClarity(
            context.getImageData(0, 0, canvas.width, canvas.height).data,
            canvas.width,
            canvas.height,
          ),
        });
      }
      if (!cancelled) setResult({ base, key, images });
    })()
      .catch(() => {
        if (!cancelled) setResult({ base, key, images: [], error: true });
      })
      .finally(() => input?.dispose());
    return () => {
      cancelled = true;
      input?.dispose();
    };
    // A stable frame key avoids decoding again for captions, framing, or selection.
  }, [base, key, active, open, retry]);
  const current = result?.base === base && result.key === key ? result : null;
  const selectedSource = editFrame(project, frame).source;
  return (
    <div className="jumper-freeze-picker">
      <button
        aria-expanded={anchor !== null}
        disabled={!active}
        onClick={() => setAnchor((value) => (value === null ? frame : null))}
      >
        {anchor === null
          ? "Choose a nearby freeze frame"
          : "Hide nearby freeze frames"}
      </button>
      {anchor !== null ? (
        <section aria-label="Nearby freeze frames">
          <p className="jumper-caption">
            Recorded masked frames within ±0.20s of {(anchor / 30).toFixed(2)}s,
            kept inside its piece. Edge clarity is relative to these previews,
            not a measure of pose quality or original motion blur. Choose a
            readable pose, then Freeze at playhead.
          </p>
          <button disabled={!active} onClick={() => setAnchor(frame)}>
            Refresh around current playhead
          </button>
          {!current ? (
            <p role="status">Loading nearby recorded frames…</p>
          ) : current.error ? (
            <p role="status">
              Nearby previews unavailable. You can still freeze the playhead
              frame.{" "}
              <button
                disabled={!active}
                onClick={() => {
                  setResult(null);
                  setRetry((value) => value + 1);
                }}
              >
                Retry freeze previews
              </button>
            </p>
          ) : (
            <>
              <div
                className="jumper-freeze-options"
                role="group"
                aria-label="Choose recorded freeze frame"
              >
                {candidates.map((candidate) => {
                  const image = current.images.find(
                    (image) => image.source === candidate.source,
                  )!;
                  return (
                    <button
                      key={candidate.source}
                      disabled={!active}
                      aria-pressed={candidate.source === selectedSource}
                      onClick={() => onSelect(candidate.frame)}
                    >
                      <img
                        src={image.image}
                        alt={`Masked source frame ${candidate.source + 1}`}
                      />
                      <strong>
                        Frame {candidate.frame + 1} ·{" "}
                        {(candidate.frame / 30).toFixed(2)}s
                      </strong>
                      <span>Source frame {candidate.source + 1}</span>
                      <span>
                        {freezeClarityHint(
                          image.clarity,
                          current.images.map((image) => image.clarity),
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              {candidates.length === 1 ? (
                <p className="jumper-caption">
                  Only one distinct recorded frame is available here. Move into
                  a motion piece to compare nearby poses.
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
