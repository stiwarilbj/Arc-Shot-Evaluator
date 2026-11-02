import { useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  Camera,
  Download,
  X,
  SkipBack,
  SkipForward,
} from "lucide-react";
import {
  captureVideoFrame,
  seekTime,
  validateVideoMetadata,
  VIDEO_STEP,
  videoTime,
  type CapturedFrame,
} from "./video.ts";

import type { VideoSample } from "./videoSamples.ts";

type Props = {
  file: File;
  active: boolean;
  sample?: VideoSample;
  onCapture: (frame: CapturedFrame) => void;
  onClose: () => void;
};
export function VideoFramePicker({
  file,
  active,
  sample,
  onCapture,
  onClose,
}: Props) {
  const video = useRef<HTMLVideoElement>(null),
    alive = useRef(false),
    capturingRef = useRef(false);
  const [ready, setReady] = useState(false),
    [frameReady, setFrameReady] = useState(false),
    [seeking, setSeeking] = useState(false),
    [capturing, setCapturing] = useState(false),
    [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [draft, setDraft] = useState("0"),
    [rate, setRate] = useState(1),
    [loop, setLoop] = useState(false),
    [error, setError] = useState("");
  const cancelledTime = useRef(false);
  useEffect(() => {
    alive.current = true;
    const element = video.current!,
      url = URL.createObjectURL(file);
    element.src = url;
    const timeout = setTimeout(() => {
      if (element.readyState < 2 && alive.current)
        setError(
          "The video could not decode · Try an MP4 with H264 video or a supported WebM",
        );
    }, 20000);
    const hidden = () => {
      if (document.hidden) {
        element.pause();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", hidden);
      element.pause();
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
    };
  }, [file]);
  useEffect(() => {
    if (!active) {
      video.current?.pause();
    }
  }, [active]);
  const sync = () => {
    if (!video.current || !alive.current) return;
    const n = video.current.currentTime;
    setPosition(n);
    setDraft(n.toFixed(2));
  };
  const seek = (n: number) => {
    const element = video.current,
      value = seekTime(n, duration);
    if (!element || value === null || capturingRef.current) return;
    element.pause();
    if (Math.abs(element.currentTime - value) > 0.00001) {
      setSeeking(true);
      element.currentTime = value;
    }
    setPosition(value);
    setDraft(value.toFixed(2));
  };
  async function capture(download = false) {
    if (!video.current || !active || document.hidden || capturingRef.current)
      return;
    capturingRef.current = true;
    setCapturing(true);
    setError("");
    try {
      const frame = await captureVideoFrame(video.current);
      if (!alive.current) return;
      if (download) {
        const url = URL.createObjectURL(frame.blob),
          link = document.createElement("a");
        link.href = url;
        link.download = `freeze-floor-frame-${frame.seconds.toFixed(2)}s.jpg`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } else onCapture(frame);
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "Frame capture failed · Try again",
        );
    } finally {
      capturingRef.current = false;
      if (alive.current) setCapturing(false);
    }
  }
  const unavailable = !ready || !active || capturing;
  return (
    <section className="ff-video-picker" aria-labelledby="ff-video-title">
      <div className="ff-section-head">
        <div>
          <h2 id="ff-video-title">Choose a video moment</h2>
          <p>
            Freeze one decoded frame · Each moment needs its own alignment
            review · MP4, WebM, or supported MOV · 100 MiB / 10 minutes
          </p>
        </div>
        <button aria-label="Close video picker" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {sample ? (
        <p className="ff-video-credit">
          <strong>{sample.name}</strong> ·{" "}
          <a href={sample.attribution.url} target="_blank" rel="noreferrer">
            Source: {sample.attribution.creator}
          </a>{" "}
          ·{" "}
          <a href={sample.licenseUrl} target="_blank" rel="noreferrer">
            {sample.attribution.license}
          </a>{" "}
          · Excerpt, muted and re-encoded · {sample.note}
        </p>
      ) : null}
      <video
        ref={video}
        muted
        playsInline
        preload="auto"
        aria-label="Local video preview"
        onLoadedMetadata={() => {
          const v = video.current!;
          try {
            validateVideoMetadata(v.videoWidth, v.videoHeight, v.duration);
            setDuration(v.duration);
            setReady(true);
            setError("");
          } catch (e) {
            v.pause();
            setReady(false);
            setFrameReady(false);
            setError((e as Error).message);
          }
        }}
        onLoadedData={() => {
          const v = video.current!;
          try {
            validateVideoMetadata(v.videoWidth, v.videoHeight, v.duration);
            setReady(true);
            setFrameReady(true);
            setError("");
            sync();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
        onError={() => {
          if (alive.current) {
            setReady(false);
            setFrameReady(false);
            setError(
              "This video cannot decode in your browser · Try an MP4 with H264 video or a supported WebM",
            );
          }
        }}
        onTimeUpdate={sync}
        onSeeking={() => {
          setSeeking(true);
          setFrameReady(false);
        }}
        onSeeked={() => {
          setSeeking(false);
          setFrameReady((video.current?.readyState ?? 0) >= 2);
          sync();
        }}
        onPlay={() => {
          if (!active || document.hidden || capturingRef.current)
            video.current?.pause();
          else {
            setPlaying(true);
          }
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          sync();
        }}
      />
      {error ? (
        <p role="alert" className="ff-error">
          {error}
        </p>
      ) : null}
      <div className="ff-video-controls">
        <button
          disabled={unavailable}
          onClick={() => {
            const v = video.current!;
            if (!v.paused) v.pause();
            else
              void v.play().catch(() => {
                if (alive.current)
                  setError(
                    "Playback could not start · Choose another moment or reopen the video",
                  );
              });
          }}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}{" "}
          {playing ? "Pause video" : "Play video"}
        </button>
        <button
          aria-label="Seek back one thirtieth of a second"
          disabled={unavailable || position <= 0}
          onClick={() => seek(position - VIDEO_STEP)}
        >
          <SkipBack size={16} /> −1/30 s
        </button>
        <button
          aria-label="Seek forward one thirtieth of a second"
          disabled={unavailable || position >= duration - VIDEO_STEP}
          onClick={() => seek(position + VIDEO_STEP)}
        >
          <SkipForward size={16} /> +1/30 s
        </button>
        <label>
          Speed
          <select
            aria-label="Video playback speed"
            value={rate}
            disabled={unavailable}
            onChange={(e) => {
              const r = Number(e.target.value);
              setRate(r);
              if (video.current) video.current.playbackRate = r;
            }}
          >
            {[0.25, 0.5, 1, 2].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={loop}
            disabled={unavailable}
            onChange={(e) => {
              setLoop(e.target.checked);
              if (video.current) video.current.loop = e.target.checked;
            }}
          />{" "}
          Loop video
        </label>
      </div>
      <div className="ff-video-seek">
        <input
          type="range"
          aria-label="Video moment"
          min={0}
          max={duration || 1}
          step={VIDEO_STEP}
          value={position}
          disabled={unavailable}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <label>
          Seconds
          <input
            type="number"
            aria-label="Video moment in seconds"
            onFocus={() => video.current?.pause()}
            min={0}
            max={duration}
            step={VIDEO_STEP}
            value={draft}
            disabled={unavailable}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (cancelledTime.current) {
                cancelledTime.current = false;
                setDraft(position.toFixed(2));
                return;
              }
              if (draft.trim() && Number.isFinite(Number(draft)))
                seek(Number(draft));
              else setDraft(position.toFixed(2));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelledTime.current = true;
                setDraft(position.toFixed(2));
                e.currentTarget.blur();
              }
            }}
          />
        </label>
        <output aria-live="off">
          {videoTime(position)} / {videoTime(duration)}
        </output>
      </div>
      <div className="ff-video-actions">
        <button
          className="ff-primary"
          disabled={unavailable || seeking || !frameReady}
          onClick={() => void capture()}
        >
          <Camera size={16} />
          {capturing ? "Capturing…" : "Use this frame"}
        </button>
        <button
          disabled={unavailable || seeking || !frameReady}
          onClick={() => void capture(true)}
        >
          <Download size={16} /> Download frame JPEG
        </button>
        <span className="ff-help">
          {seeking || !frameReady
            ? "Loading selected frame"
            : "Time steps are 1/30 s · Only the frozen image is saved, not your video"}
        </span>
      </div>
    </section>
  );
}
