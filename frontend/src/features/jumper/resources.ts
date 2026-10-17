import type { MaskRequest } from "./domain";

const MIB = 1024 * 1024;
export interface ResourceEstimate {
  bytes: number;
  players: number;
  correctionFrames: number;
  largestBufferBytes: number;
}

/** Planning allowance, not an allocation measurement or a guarantee against OOM.
 * Keep this formula aligned with backend/jumper/resources.py. No cache hits assumed.
 * SAM runs at 1024px regardless of output size. Retain 16 recent memories/object,
 * every unique conditioning frame, and working attention tensors for one object.
 */
export function estimateResources(
  request: MaskRequest,
  width: number,
  height: number,
  sourceWidth = width,
  sourceHeight = height,
): ResourceEstimate {
  const frames = Math.ceil((request.end - request.start) * 30);
  const tracks = request.objects.filter(
    (o) => !o.ignored || request.auto_detect_others,
  );
  const counts = tracks.map((o) => new Set(o.prompts.map((p) => p.frame)).size);
  const players = Math.max(tracks.length, request.auto_detect_others ? 10 : 1);
  const corrections =
    counts.reduce((sum, count) => sum + count, 0) + players - tracks.length;
  const maxConditions = Math.max(1, ...counts);
  const memories = players * Math.min(16, frames) + corrections;
  const largestBufferBytes = Math.max(16 * MIB, (maxConditions + 6) * MIB);
  const bytes = Math.ceil(
    (1536 + 192 + (request.auto_detect_others ? 256 : 0)) * MIB +
      memories * 2.5 * MIB +
      (maxConditions + 6) * 8 * MIB +
      width * height * 48 +
      sourceWidth * sourceHeight * 16 +
      frames * width * height * 0.25,
  );
  return { bytes, players, correctionFrames: corrections, largestBufferBytes };
}

export function checkResources(
  estimate: ResourceEstimate,
  limits: {
    deviceMemoryGB?: number;
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
  } = {},
): void {
  const guidance =
    "Try a shorter segment, remove unnecessary tracks or correction frames in Corrections, or use the free downloaded editor on a device with more memory";
  const bufferLimit = Math.min(
    limits.maxBufferSize ?? Infinity,
    limits.maxStorageBufferBindingSize ?? Infinity,
  );
  if (
    Number.isFinite(bufferLimit) &&
    bufferLimit > 0 &&
    estimate.largestBufferBytes > bufferLimit
  )
    throw Error(
      `This tracking workload exceeds this device's GPU buffer limit. ${guidance}`,
    );
  // deviceMemory is rounded/capped physical capacity, NEVER available RAM. Only
  // reject clearly oversized jobs; unknown devices continue with normal errors.
  const capacity = limits.deviceMemoryGB;
  if (
    capacity !== undefined &&
    Number.isFinite(capacity) &&
    capacity > 0 &&
    estimate.bytes > capacity * 1024 ** 3 * 0.75
  )
    throw Error(
      `This clip needs an estimated ${(estimate.bytes / 1024 ** 3).toFixed(1)} GB of working memory, too much for this browser's reported capacity. ${guidance}`,
    );
}
