import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { AnalysisSession, ShotAnalysis, VideoMode } from "../../domain/analysisTypes";

interface VideoWorkspaceProps {
  session: AnalysisSession;
  shot: ShotAnalysis | null;
  mode: VideoMode;
  onMode: (mode: VideoMode) => void;
}

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "00:00.00";
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function formatRate(rate: number) {
  return `${rate % 1 === 0 ? rate.toFixed(1) : rate}×`;
}

export function VideoWorkspace({ session, shot, mode, onMode }: VideoWorkspaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const resumeTimeRef = useRef(0);
  const resumePlaybackRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(session.session.duration);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const sources = session.artifacts;
  const source = sources[mode];
  const releasePercent = shot && duration ? (shot.release_time / duration) * 100 : 0;
  const orientation = session.session.height > session.session.width * 1.08
    ? "portrait"
    : session.session.width > session.session.height * 1.08
      ? "landscape"
      : "square";
  const mediaStyle = {
    "--media-ratio": `${session.session.width} / ${session.session.height}`,
  } as CSSProperties;

  useEffect(() => setMediaError(null), [source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackRate;
    video.muted = muted;
  }, [muted, playbackRate, source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !shot) return;
    const target = Math.max(0, shot.release_time - 0.7);
    resumeTimeRef.current = target;
    if (video.readyState >= 1) video.currentTime = target;
  }, [shot?.id, shot?.release_time]);

  const modes = useMemo(
    () => [
      { id: "original" as const, label: "Original" },
      { id: "annotated" as const, label: "Annotated" },
      { id: "pose" as const, label: "Pose" },
    ],
    [],
  );

  function switchMode(nextMode: VideoMode) {
    const video = videoRef.current;
    if (video) {
      resumeTimeRef.current = video.currentTime;
      resumePlaybackRef.current = !video.paused;
    }
    onMode(nextMode);
  }

  function seek(delta: number) {
    const video = videoRef.current;
    if (video) video.currentTime = Math.max(0, Math.min(video.duration || duration, video.currentTime + delta));
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (video.paused) await video.play();
      else video.pause();
    } catch {
      setMediaError("This video could not be played in the browser. Try the annotated MP4 export.");
    }
  }

  return (
    <section className="video-workspace" aria-label="Video analysis workspace">
      <div className={`media-frame media-${orientation}`} style={mediaStyle}>
        <video
          ref={videoRef}
          key={source}
          src={source}
          playsInline
          preload="metadata"
          onTimeUpdate={(event) => {
            resumeTimeRef.current = event.currentTarget.currentTime;
            setCurrentTime(event.currentTarget.currentTime);
          }}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            video.playbackRate = playbackRate;
            video.muted = muted;
            setDuration(video.duration || session.session.duration);
            video.currentTime = Math.min(resumeTimeRef.current, Math.max(0, video.duration - 0.05));
            if (resumePlaybackRef.current) {
              void video.play().catch(() => setMediaError("Playback could not resume after switching views."));
            }
          }}
          onError={() => setMediaError("This video stream could not be decoded by the browser.")}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        {mediaError ? <div className="media-error" role="alert">{mediaError}</div> : null}
        <div className="mode-switch" aria-label="Video view">
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              className={mode === item.id ? "is-active" : ""}
              aria-pressed={mode === item.id}
              onClick={() => switchMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="transport">
        <button className="icon-button play-button" type="button" onClick={() => void togglePlayback()} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
        </button>
        <button className="icon-button" type="button" onClick={() => seek(-10)} aria-label="Back 10 seconds"><RotateCcw size={17} /></button>
        <button className="icon-button" type="button" onClick={() => seek(10)} aria-label="Forward 10 seconds"><RotateCw size={17} /></button>
        <span className="timecode">{formatTime(currentTime)} / {formatTime(duration)}</span>
        <div className="timeline-wrap">
          <input
            className="timeline"
            aria-label="Video position"
            type="range"
            min={0}
            max={duration || 1}
            step={0.01}
            value={Math.min(currentTime, duration || 1)}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (videoRef.current) videoRef.current.currentTime = next;
              setCurrentTime(next);
            }}
            style={{ "--progress": `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties}
          />
          {shot ? <span className="release-marker" style={{ left: `${releasePercent}%` }} title={`Release ${formatTime(shot.release_time)}`} /> : null}
        </div>
        <label className="speed-control">
          <span className="sr-only">Playback speed</span>
          <select
            aria-label="Playback speed"
            value={playbackRate}
            onChange={(event) => setPlaybackRate(Number(event.currentTarget.value))}
          >
            {PLAYBACK_RATES.map((rate) => <option key={rate} value={rate}>{formatRate(rate)}</option>)}
          </select>
        </label>
        <button
          className="icon-button volume-button"
          type="button"
          aria-label={muted ? "Unmute video" : "Mute video"}
          aria-pressed={muted}
          title={muted ? "Unmute video" : "Mute video"}
          onClick={() => {
            const nextMuted = !muted;
            setMuted(nextMuted);
            if (videoRef.current) videoRef.current.muted = nextMuted;
          }}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Full screen"
          onClick={() => {
            void videoRef.current?.requestFullscreen().catch(() => setMediaError("Full screen is unavailable in this browser."));
          }}
        >
          <Maximize size={18} />
        </button>
      </div>
    </section>
  );
}
