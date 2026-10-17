import { useEffect, useState } from "react";
import type { JobProgress, Track } from "./domain";
import { ShooterSelectionError } from "./discovery";
import { preview } from "./media";
import { useBlobUrl } from "./JumperLab";

/** A separate short first-frame check; never becomes an approved or saved result. */
export default function ShooterPreview({
  file,
  start,
  end,
  track,
  automatic,
  active,
  paused,
}: {
  file: File;
  start: number;
  end: number;
  track?: Track;
  automatic: boolean;
  active: boolean;
  paused: boolean;
}) {
  const seed = track?.prompts.find((p) => p.frame === 0);
  const signature = JSON.stringify(seed);
  const [requested, setRequested] = useState(true);
  const [image, setImage] = useState<Blob | null>(null);
  const [status, setStatus] = useState("");
  const [retry, setRetry] = useState(0);
  const url = useBlobUrl(image);
  useEffect(() => {
    setRequested(true);
    setImage(null);
    setStatus("");
  }, [file, start, end, track?.id, signature, automatic]);
  useEffect(() => {
    if (
      image ||
      !requested ||
      !active ||
      paused ||
      !seed ||
      !track ||
      !(seed.box || seed.labels?.includes(1))
    )
      return;
    const abort = new AbortController();
    setImage(null);
    setStatus("Checking your selected shooter…");
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { prepareShooterSelection, processVideo } =
            await import("./processing");
          const report = (update: JobProgress) => {
            if (!abort.signal.aborted) setStatus(update.stage);
          };
          const request = await prepareShooterSelection(
            file,
            {
              start,
              end: Math.min(end, start + 0.1),
              target_id: track.id,
              objects: [{ id: track.id, prompts: [seed] }],
              auto_detect_others: automatic,
              presentation: "silhouette",
            },
            report,
            abort.signal,
          );
          const result = await processVideo(
            file,
            { ...request, auto_detect_others: false },
            report,
            abort.signal,
          );
          if (result.warnings.some((w) => w.frame === 0))
            throw Error(
              "The shooter could not be isolated in the starting frame; move the point inside the player",
            );
          const frame = await preview(result.quiz, 0, abort.signal);
          if (!abort.signal.aborted) {
            setImage(frame);
            setStatus(
              "Check the black outline is your shooter. Other players are hidden in this selection check. Full-clip tracking still needs review.",
            );
          }
        } catch (error) {
          if (!abort.signal.aborted)
            setStatus(
              error instanceof ShooterSelectionError
                ? error.message
                : `Selection check unavailable: ${String(error)}. You can adjust your selection or retry.`,
            );
        }
      })();
    }, 500);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
    // Only the first-frame seed affects this check; later corrections do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    file,
    start,
    end,
    track?.id,
    signature,
    automatic,
    requested,
    active,
    paused,
    retry,
    image,
  ]);
  if (!seed || !(seed.box || seed.labels?.includes(1))) return null;
  return (
    <div className="jumper-selection-check">
      <p className="jumper-caption">
        A short starting-frame check confirms your selection before the full
        clip. First use downloads the free masking model.
      </p>
      <div className="jumper-toolbar">
        <strong>Confirm your shooter</strong>
        <button
          type="button"
          className="button button-outline"
          disabled={paused}
          onClick={() => {
            setImage(null);
            setRequested(true);
            setRetry((v) => v + 1);
          }}
        >
          {" "}
          {requested
            ? "Retry silhouette preview"
            : "Preview shooter silhouette"}
        </button>
      </div>
      {!requested ? (
        <p className="jumper-caption">
          Check just the starting frame before processing the clip. The first
          check downloads the free masking model if needed.
        </p>
      ) : (
        <>
          {url ? (
            <img
              className="jumper-shooter-preview"
              src={url}
              alt="First-frame silhouette of the selected shooter"
            />
          ) : null}
          <p className="jumper-caption" role="status">
            {paused ? "Selection check paused during processing." : status}
          </p>
          {!url && !paused ? (
            <button
              type="button"
              className="button button-outline"
              onClick={() => setRequested(false)}
            >
              Cancel selection check
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
