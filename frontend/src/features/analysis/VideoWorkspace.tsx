import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { AnalysisSession, BrowserPoseFrame, BrowserPoseOverlay, ShotAnalysis, VideoMode } from "../../domain/analysisTypes";
import { ArcSelect } from "../../components/ArcSelect";

interface VideoWorkspaceProps {
  session: AnalysisSession;
  shot: ShotAnalysis | null;
  mode: VideoMode;
  onMode: (mode: VideoMode) => void;
  seekFrame?: number | null;
  active?: boolean;
}

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "00:00.00";
  const hundredths = Math.round(Math.max(0, value) * 100);
  const minutes = Math.floor(hundredths / 6000);
  const seconds = Math.floor(hundredths / 100) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
}

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const FULLSCREEN_UNAVAILABLE = "Full screen is unavailable in this browser";

const POSE_LINKS: Array<[number, number]> = [
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
];

function poseAngle(first: [number, number, number], middle: [number, number, number], last: [number, number, number]) {
  if (first[2] < 0.16 || middle[2] < 0.16 || last[2] < 0.16) return null;
  const a = [first[0] - middle[0], first[1] - middle[1]];
  const b = [last[0] - middle[0], last[1] - middle[1]];
  const lengths = Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]);
  if (!lengths) return null;
  const cosine = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / lengths));
  return Math.round((Math.acos(cosine) * 180) / Math.PI);
}

function nearestBrowserPose(overlay: BrowserPoseOverlay, frame: number): BrowserPoseFrame | undefined {
  let best = overlay.frames[0];
  let distance = Math.abs(best.frame - frame);
  for (const candidate of overlay.frames) {
    const nextDistance = Math.abs(candidate.frame - frame);
    if (nextDistance < distance) {
      best = candidate;
      distance = nextDistance;
    }
  }
  return best;
}

function formatRate(rate: number) {
  return `${rate % 1 === 0 ? rate.toFixed(1) : rate}×`;
}

export function VideoWorkspace({ session, shot, mode, onMode, seekFrame = null, active = true }: VideoWorkspaceProps) {
  const workspaceRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const poseCanvasRef = useRef<HTMLCanvasElement>(null);
  const resumeTimeRef = useRef(Math.max(0, (shot?.release_time ?? 0) - 0.7));
  const resumePlaybackRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(session.session.duration);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const sources = session.artifacts;
  const overlay = session.pose_overlay?.frames.length ? session.pose_overlay : undefined;
  const modes: Array<{ id: VideoMode; label: string }> = [];
  if (overlay || (sources.pose && sources.pose !== sources.original)) modes.push({ id: "pose", label: "Pose" });
  if (sources.annotated && sources.annotated !== sources.original && sources.annotated !== sources.pose) {
    modes.push({ id: "annotated", label: "Annotated" });
  }
  modes.push({ id: "original", label: "Original" });
  const view = modes.some((item) => item.id === mode) ? mode : modes[0].id;
  const source = sources[view];
  const showPose = view === "pose" && Boolean(overlay);
  const releasePercent = shot && duration ? Math.max(0, Math.min(100, (shot.release_time / duration) * 100)) : 0;
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || seekFrame == null) return;
    const target = Math.max(0, seekFrame / Math.max(1, session.session.fps));
    video.currentTime = Math.min(target, video.duration || session.session.duration);
    setCurrentTime(video.currentTime);
  }, [seekFrame, session.session.duration, session.session.fps]);

  useEffect(() => {
    function pauseWhenHidden() {
      if (active && !document.hidden) return;
      resumePlaybackRef.current = false;
      videoRef.current?.pause();
      setPlaying(false);
    }
    pauseWhenHidden();
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, [active]);

  useEffect(() => {
    function updateFullscreen() {
      setFullscreen(document.fullscreenElement === workspaceRef.current);
    }
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = poseCanvasRef.current;
    if (!active || !showPose || !overlay || !video || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const render = () => {
      if (document.hidden) return;
      const displayWidth = video.clientWidth;
      const displayHeight = video.clientHeight;
      if (!displayWidth || !displayHeight) return;
      const pixelRatio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(displayWidth * pixelRatio));
      const height = Math.max(1, Math.round(displayHeight * pixelRatio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.resetTransform();
      context.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(displayWidth / overlay.width, displayHeight / overlay.height);
      const offsetX = (displayWidth - overlay.width * scale) / 2;
      const offsetY = (displayHeight - overlay.height * scale) / 2;
      context.setTransform(pixelRatio * scale, 0, 0, pixelRatio * scale, pixelRatio * offsetX, pixelRatio * offsetY);
      const frame = nearestBrowserPose(overlay, Math.round((video.currentTime || 0) * overlay.fps));
      if (frame) {
        const points = frame.keypoints;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.strokeStyle = "rgba(249, 115, 22, .92)";
        context.lineWidth = Math.max(2, overlay.width / 500);
        for (const [first, second] of POSE_LINKS) {
          const a = points[first];
          const b = points[second];
          if (!a || !b || a[2] < 0.16 || b[2] < 0.16) continue;
          context.beginPath();
          context.moveTo(a[0], a[1]);
          context.lineTo(b[0], b[1]);
          context.stroke();
        }
        // Continue the forearm and lower-leg lines a short distance so the
        // release and follow-through direction stays legible frame to frame.
        context.save();
        context.setLineDash([8, 7]);
        context.strokeStyle = "rgba(255, 184, 108, .78)";
        for (const [joint, end] of [[7, 9], [8, 10], [13, 15], [14, 16]] as const) {
          const start = points[joint];
          const finish = points[end];
          if (!start || !finish || start[2] < 0.16 || finish[2] < 0.16) continue;
          const length = Math.hypot(finish[0] - start[0], finish[1] - start[1]);
          if (!length) continue;
          const extension = Math.min(length * 0.42, overlay.height * 0.08);
          const x = finish[0] + ((finish[0] - start[0]) / length) * extension;
          const y = finish[1] + ((finish[1] - start[1]) / length) * extension;
          context.beginPath();
          context.moveTo(finish[0], finish[1]);
          context.lineTo(x, y);
          context.stroke();
        }
        context.restore();
        for (const [index, label] of [[7, "E"], [8, "E"], [13, "K"], [14, "K"]] as const) {
          const point = points[index];
          const side = index === 7 || index === 13 ? 0 : 1;
          const first = side === 0 ? points[5] : points[6];
          const last = index === 7 ? points[9] : index === 8 ? points[10] : index === 13 ? points[15] : points[16];
          const angle = point && first && last ? poseAngle(first, point, last) : null;
          if (!point || angle == null || point[2] < 0.16) continue;
          const text = `${label} ${angle}°`;
          context.font = `${Math.max(11, overlay.width / 95)}px ui-monospace, monospace`;
          const textWidth = context.measureText(text).width;
          const textX = point[0] + (side ? 8 : -textWidth - 8);
          const textY = point[1] - 8;
          context.fillStyle = "rgba(13, 15, 16, .84)";
          context.fillRect(textX - 4, textY - 13, textWidth + 8, 17);
          context.fillStyle = "#fff1e3";
          context.fillText(text, textX, textY);
        }
        context.fillStyle = "rgba(13, 15, 16, .8)";
        context.fillRect(14, 14, 142, 23);
        context.fillStyle = "#ffd2a3";
        context.font = `${Math.max(10, overlay.width / 120)}px ui-monospace, monospace`;
        context.fillText("POSE + JOINT ANGLES", 21, 30);
      }
    };
    let frameCallback: number | undefined;
    const scheduleRender = () => {
      render();
      frameCallback = video.requestVideoFrameCallback(scheduleRender);
    };
    const resize = new ResizeObserver(render);
    resize.observe(video);
    video.addEventListener("loadeddata", render);
    video.addEventListener("seeked", render);
    if (video.requestVideoFrameCallback) {
      frameCallback = video.requestVideoFrameCallback(scheduleRender);
    } else {
      video.addEventListener("timeupdate", render);
    }
    document.addEventListener("visibilitychange", render);
    render();
    return () => {
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
      resize.disconnect();
      video.removeEventListener("loadeddata", render);
      video.removeEventListener("seeked", render);
      video.removeEventListener("timeupdate", render);
      document.removeEventListener("visibilitychange", render);
    };
  }, [active, overlay, showPose, source]);

  function switchMode(nextMode: VideoMode) {
    const video = videoRef.current;
    if (video && source !== sources[nextMode]) {
      resumeTimeRef.current = video.currentTime;
      resumePlaybackRef.current = !video.paused;
      setPlaying(false);
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
    } catch (error) {
      if (videoRef.current !== video || (error instanceof DOMException && error.name === "AbortError")) return;
      setMediaError("This video could not be played in the browser");
    }
  }

  async function toggleFullscreen() {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    try {
      if (document.fullscreenElement === workspace) {
        await document.exitFullscreen();
      } else if (workspace.requestFullscreen) {
        await workspace.requestFullscreen();
        setMediaError((error) => error === FULLSCREEN_UNAVAILABLE ? null : error);
      } else {
        setMediaError(FULLSCREEN_UNAVAILABLE);
      }
    } catch {
      setMediaError(FULLSCREEN_UNAVAILABLE);
    }
  }

  return (
    <section ref={workspaceRef} className="video-workspace" aria-label="Video analysis workspace">
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
            const target = Math.min(resumeTimeRef.current, video.duration || session.session.duration);
            video.currentTime = target;
            setCurrentTime(target);
            const shouldResume = resumePlaybackRef.current;
            resumePlaybackRef.current = false;
            if (shouldResume && active && !document.hidden) {
              void video.play().catch((error: unknown) => {
                if (videoRef.current === video && !(error instanceof DOMException && error.name === "AbortError")) {
                  setMediaError("Playback could not resume after switching views");
                }
              });
            }
          }}
          onError={() => setMediaError("This video stream could not be decoded by the browser")}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        {showPose ? <canvas ref={poseCanvasRef} className="pose-overlay-canvas" aria-hidden="true" /> : null}
        {mediaError ? <div className="media-error" role="alert">{mediaError}</div> : null}
        {modes.length > 1 ? (
          <div className="mode-switch" role="group" aria-label="Video view">
            {modes.map((item) => (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? "is-active" : ""}
                aria-pressed={view === item.id}
                onClick={() => switchMode(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
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
        <div className="speed-control">
          <ArcSelect
            ariaLabel="Playback speed"
            className="arc-select--compact video-speed-select"
            value={String(playbackRate)}
            options={PLAYBACK_RATES.map((rate) => ({ value: String(rate), label: formatRate(rate) }))}
            onValueChange={(value) => setPlaybackRate(Number(value))}
          />
        </div>
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
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>
    </section>
  );
}
