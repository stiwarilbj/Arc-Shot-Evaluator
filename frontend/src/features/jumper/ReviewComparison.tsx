import { outputFrameAtTime, sourceFrameTime, type SourceFrameMap } from "./sourceFrames";
import { useEffect, useRef, useState } from "react";

/** Only the masked element owns playback time. The source is an editing reference. */
export default function ReviewComparison({
  original,
  masked,
  start,
  duration,
  active,
  frameMap,
}: {
  original: string;
  masked: string;
  start: number;
  duration: number;
  active: boolean;
  frameMap?: SourceFrameMap;
}) {
  const source = useRef<HTMLVideoElement>(null);
  const output = useRef<HTMLVideoElement>(null);
  const wanted = useRef(false);
  const attempt = useRef(0);
  const buffering = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [sourceFailed, setSourceFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [view, setView] = useState<"masked" | "original">("masked");

  function stop() {
    attempt.current++;
    wanted.current = false;
    buffering.current = false;
    output.current?.pause();
    source.current?.pause();
    setTime(output.current?.currentTime ?? 0);
    setPlaying(false);
    setWaiting(false);
  }
  function align(displayTime?: number) {
    const a = source.current,
      b = output.current;
    if (a && b && !sourceFailed && a.readyState >= 1) {
      const target = Math.min(
        frameMap ? sourceFrameTime(frameMap, outputFrameAtTime(frameMap, displayTime ?? b.currentTime)) : start + b.currentTime,
        Math.max(0, a.duration - 0.001),
      );
      if (Math.abs(a.currentTime - target) > (frameMap ? 0.000002 : 1 / 30)) a.currentTime = target;
    }
  }
  async function play() {
    if (!active || document.hidden || failed) return;
    const a = source.current,
      b = output.current;
    if (!b) return;
    if (b.ended || b.currentTime >= duration - 0.01) b.currentTime = 0;
    align();
    const token = ++attempt.current;
    wanted.current = true;
    buffering.current = false;
    setWaiting(false);
    try {
      await Promise.all([
        b.play(),
        !frameMap && !sourceFailed && a ? a.play() : Promise.resolve(),
      ]);
      if (token !== attempt.current) return;
      if (!wanted.current || !active || document.hidden) {
        stop();
        return;
      }
      setPlaying(true);
    } catch {
      if (token !== attempt.current) return;
      // Pausing to wait for the other decoder can reject a pending play().
      // Keep the shared intent so canplay can resume both videos.
      if (buffering.current && wanted.current) return;
      stop();
      // A source decoding failure must not prevent reviewing the masked result.
      if (a?.error) setSourceFailed(true);
    }
  }
  function stalled() {
    if (!wanted.current) return;
    buffering.current = true;
    output.current?.pause();
    source.current?.pause();
    setWaiting(true);
  }
  function resume() {
    align();
    const a = source.current,
      b = output.current;
    if (
      buffering.current &&
      wanted.current &&
      b &&
      b.readyState >= 3 &&
      (sourceFailed || (a && a.readyState >= 3))
    )
      void play();
  }
  function seek(value: number) {
    stop();
    const b = output.current;
    if (!b) return;
    b.currentTime = Math.max(0, Math.min(duration, value));
    setTime(b.currentTime);
    align();
  }
  useEffect(() => {
    let raf = 0, videoCallback = 0;
    const originalElement = source.current;
    const maskedElement = output.current;
    const hasVideoClock = !!maskedElement && "requestVideoFrameCallback" in maskedElement;
    const displayedFrame: VideoFrameRequestCallback = (_now, metadata) => {
      align(metadata.mediaTime);
      if (maskedElement) videoCallback = maskedElement.requestVideoFrameCallback(displayedFrame);
    };
    if (frameMap && hasVideoClock) videoCallback = maskedElement!.requestVideoFrameCallback(displayedFrame);
    const tick = () => {
      const a = source.current,
        b = output.current;
      if (b) {
        if (!b.paused) setTime(b.currentTime);
        if (
          wanted.current &&
          !buffering.current &&
          a &&
          !sourceFailed &&
          !a.seeking &&
          !b.seeking
        ) {
          const drift = a.currentTime - start - b.currentTime;
          if (frameMap) { if (!hasVideoClock) align(); }
          else if (Math.abs(drift) > 0.04) align();
          else
            a.playbackRate =
              Math.abs(drift) > 0.015 ? (drift > 0 ? 0.97 : 1.03) : 1;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (videoCallback) maskedElement?.cancelVideoFrameCallback(videoCallback);
      attempt.current++;
      wanted.current = false;
      originalElement?.pause();
      maskedElement?.pause();
    };
  }, [original, masked, start, sourceFailed, frameMap]);
  useEffect(() => {
    const hidden = () => {
      if (!active || document.hidden) stop();
    };
    hidden();
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [active]);

  return (
    <div
      className="jumper-comparison"
      role="region"
      aria-label="Synchronized video review"
    >
      <p className="jumper-caption">
        Compare the same moment. Original footage is an editing reference only;
        saved and downloaded videos stay masked.
      </p>
      <div
        className="jumper-comparison-toggle"
        role="group"
        aria-label="Review view"
      >
        <button
          className="button button-outline"
          type="button"
          aria-pressed={view === "masked"}
          onClick={() => setView("masked")}
        >
          Masked
        </button>
        <button
          className="button button-outline"
          type="button"
          aria-pressed={view === "original"}
          onClick={() => setView("original")}
        >
          Original reference
        </button>
      </div>
      <div className="jumper-comparison-panes" data-view={view}>
        <figure className="jumper-comparison-original">
          <figcaption>Original · editing reference</figcaption>
          <video
            ref={source}
            src={original || undefined}
            className="jumper-video"
            muted
            playsInline
            preload="auto"
            aria-label="Original review reference"
            onLoadedMetadata={() => align()}
            onCanPlay={resume}
            onWaiting={stalled}
            onError={() => {
              setSourceFailed(true);
              stop();
            }}
          />
        </figure>
        <figure className="jumper-comparison-masked">
          <figcaption>Masked · saved output</figcaption>
          <video
            ref={output}
            src={masked || undefined}
            className="jumper-video"
            muted
            playsInline
            preload="auto"
            aria-label="Finished silhouette clip"
            onLoadedData={() => setReady(true)}
            onCanPlay={resume}
            onWaiting={stalled}
            onSeeking={() => align()}
            onSeeked={() => align()}
            onEnded={stop}
            onPause={() => {
              if (!buffering.current) stop();
            }}
            onError={() => {
              setFailed(true);
              stop();
            }}
          />
        </figure>
      </div>
      {sourceFailed && (
        <p role="status">
          Original reference could not play. You can still review and download
          the masked clip.
        </p>
      )}
      {failed && (
        <p role="alert">
          Masked preview could not play. Retry loading the review; your result
          is retained.
        </p>
      )}
      {(failed || sourceFailed) && (
        <button
          className="button button-outline"
          type="button"
          onClick={() => {
            stop();
            setFailed(false);
            setSourceFailed(false);
            setReady(false);
            source.current?.load();
            output.current?.load();
          }}
        >
          Retry review
        </button>
      )}
      <div className="jumper-comparison-controls">
        <button
          className="button button-outline"
          type="button"
          disabled={!ready || failed || !active}
          onClick={() => (wanted.current ? stop() : void play())}
        >
          {playing || waiting ? "Pause review" : "Play review"}
        </button>
        <label>
          Review position
          <input
            type="range"
            min={0}
            max={duration}
            step={1 / 30}
            value={Math.min(time, duration)}
            disabled={!ready || failed}
            onChange={(e) => seek(Number(e.target.value))}
            aria-valuetext={`${time.toFixed(2)} of ${duration.toFixed(2)} seconds`}
          />
        </label>
        <output aria-live="off">
          {time.toFixed(2)} / {duration.toFixed(2)} s
        </output>
      </div>
      <p className="jumper-caption" role="status">
        {waiting
          ? "Buffering comparison…"
          : !ready && !failed
            ? "Loading review…"
            : "Shared playback · 1× · seeking pauses both views"}
      </p>
    </div>
  );
}
