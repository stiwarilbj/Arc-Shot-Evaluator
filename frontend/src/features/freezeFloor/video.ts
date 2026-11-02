import {
  MAX_PIXELS,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  type VideoFrameSource,
} from "./types.ts";
export const VIDEO_STEP = 1 / 30;
export type CapturedFrame = VideoFrameSource & {
  blob: Blob;
  width: number;
  height: number;
};
export function validateVideoFile(file: Pick<File, "size" | "type" | "name">) {
  if (!file.size) throw Error("The video file is empty");
  if (file.size > MAX_VIDEO_BYTES)
    throw Error("Choose a video no larger than 100 MiB");
  if (
    !file.type.startsWith("video/") &&
    !/\.(mp4|m4v|mov|webm)$/i.test(file.name)
  )
    throw Error("Choose an MP4, WebM, or MOV video supported by your browser");
}
export function validateVideoMetadata(
  width: number,
  height: number,
  duration: number,
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_PIXELS ||
    Math.max(width, height) > 32768
  )
    throw Error("Video frames must be no larger than 24 megapixels");
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > MAX_VIDEO_SECONDS
  )
    throw Error("Choose a finite video no longer than 10 minutes");
}
export function videoTime(seconds: number) {
  const hundredths = Math.round(seconds * 100);
  return `${Math.floor(hundredths / 6000)}:${((hundredths % 6000) / 100).toFixed(2).padStart(5, "0")}`;
}
export function seekTime(seconds: number, duration: number) {
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0)
    return null;
  // Seeking to the container's exact end can leave no decodable sample.
  return Math.max(
    0,
    Math.min(seconds, duration - Math.min(VIDEO_STEP, duration / 2)),
  );
}
export async function captureVideoFrame(
  video: HTMLVideoElement,
): Promise<CapturedFrame> {
  validateVideoMetadata(video.videoWidth, video.videoHeight, video.duration);
  if (
    video.seeking ||
    video.readyState < 2 ||
    !Number.isFinite(video.currentTime)
  )
    throw Error("Wait for the selected frame to finish loading");
  video.pause();
  const duration = video.duration,
    seconds = Math.min(duration, Math.max(0, video.currentTime));
  const scale = Math.min(
    1,
    2048 / Math.max(video.videoWidth, video.videoHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw Error("Frame capture is unavailable in this browser");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b
          ? resolve(b)
          : reject(Error("Frame capture failed · Try another moment")),
      "image/jpeg",
      0.92,
    ),
  );
  return {
    blob,
    width: canvas.width,
    height: canvas.height,
    seconds,
    duration,
  };
}
