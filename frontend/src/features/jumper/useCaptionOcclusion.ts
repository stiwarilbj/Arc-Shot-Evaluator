import { useEffect, useState } from "react";
import { CanvasSink } from "mediabunny";
import { openVideo } from "./media";
import { loadEditFont } from "./editFont";
import {
  captionRisks,
  shooterSample,
  type ShooterMasks,
  type CaptionRisk,
} from "./captionOcclusion";
import type { EditProject } from "./editProject";

/** Local, bounded mask-core cache. It lives only as long as this editor instance. */
export function useCaptionOcclusion(
  base: Blob,
  project: EditProject,
  active: boolean,
) {
  const [retry, setRetry] = useState(0);
  const [decodeFailure, setDecodeFailure] = useState<Blob | null>(null);
  const [cache, setCache] = useState<{
    base: Blob;
    masks: ShooterMasks;
  } | null>(null);
  const [state, setState] = useState<{
    base: Blob;
    project: EditProject;
    risks: CaptionRisk[];
    status: string;
    failed?: boolean;
  } | null>(null);
  const needed = active && project.captions.length > 0;
  const baseFrames = project.baseFrames;
  const baseProfile = project.baseProfile;
  useEffect(() => {
    if (!needed || baseProfile !== "palette" || cache?.base === base) return;
    const abort = new AbortController();
    let dispose: (() => void) | undefined;
    void (async () => {
      try {
        const { input, track } = await openVideo(base);
        dispose = () => input.dispose();
        abort.signal.throwIfAborted();
        const width = await track.getDisplayWidth(),
          height = await track.getDisplayHeight();
        const scale = Math.min(1, 192 / Math.max(width, height));
        const canvas = new OffscreenCanvas(
          Math.max(1, Math.round(width * scale)),
          Math.max(1, Math.round(height * scale)),
        );
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context || baseFrames > 450)
          throw Error("Silhouette check unavailable for this base video");
        const sink = new CanvasSink(track, {
          width: canvas.width,
          height: canvas.height,
          fit: "fill",
          poolSize: 1,
        });
        const frames: ShooterMasks["frames"] = [];
        let bytes = 0;
        for (let frame = 0; frame < baseFrames; frame++) {
          abort.signal.throwIfAborted();
          const sample = await sink.getCanvas(frame / 30);
          abort.signal.throwIfAborted();
          if (!sample) throw Error("Could not read a silhouette frame");
          context.drawImage(sample.canvas, 0, 0);
          const mask = shooterSample(
            context.getImageData(0, 0, canvas.width, canvas.height).data,
            canvas.width,
            canvas.height,
          );
          bytes += mask.points.byteLength;
          if (bytes > 16 * 1024 * 1024)
            throw Error("Silhouette cache limit exceeded");
          frames.push(mask);
          if (frame % 15 === 0)
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (!frames.some((frame) => frame.points.length >= 24))
          throw Error("No readable shooter silhouette");
        if (!abort.signal.aborted)
          setCache({ base, masks: { width, height, frames } });
      } catch {
        if (!abort.signal.aborted) setDecodeFailure(base);
      } finally {
        dispose?.();
      }
    })();
    return () => {
      abort.abort();
      dispose?.();
    };
    // Project edits reuse masks; only a new base or retry requires decoding.
  }, [base, baseFrames, needed, retry, cache?.base, baseProfile]);
  useEffect(() => {
    if (!needed || baseProfile !== "palette" || cache?.base !== base) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await loadEditFont();
          abort.signal.throwIfAborted();
          const context = new OffscreenCanvas(1, 1).getContext("2d");
          if (!context) throw Error("No canvas");
          const risks = await captionRisks(
            project,
            cache.masks,
            context,
            abort.signal,
          );
          if (!abort.signal.aborted)
            setState({
              base,
              project,
              risks,
              status:
                "Silhouette overlap checked · Review hints only: hands and release are not identified",
            });
        } catch {
          if (!abort.signal.aborted)
            setState({
              base,
              project,
              risks: [],
              status: "Caption overlap check unavailable · Review manually",
              failed: true,
            });
        }
      })();
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [base, project, needed, cache, retry, baseProfile]);
  if (decodeFailure === base)
    return {
      risks: [],
      status:
        "Caption overlap check unavailable · Review the shooting motion manually",
      retry: () => {
        setDecodeFailure(null);
        setRetry((value) => value + 1);
      },
    };
  if (project.baseProfile !== "palette")
    return {
      risks: [],
      status:
        "Automatic caption checks are unavailable for legacy bases · Review placement manually",
      retry: undefined,
    };
  return {
    risks: state?.base === base && state.project === project ? state.risks : [],
    status:
      state?.base === base && state.project === project
        ? state.status
        : "Checking captions against the shooter silhouette…",
    retry: state?.failed
      ? () => {
          setState(null);
          setRetry((value) => value + 1);
        }
      : undefined,
  };
}
