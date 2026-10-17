import type { Track } from "./domain.ts";

function contains(box: number[], point: number[]) {
  return (
    box[0] <= point[0] && point[0] <= box[2] &&
    box[1] <= point[1] && point[1] <= box[3]
  );
}
function intersection(a: number[], b: number[]) {
  return (
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  );
}
function iou(a: number[], b: number[]) {
  const common = intersection(a, b);
  return common / (
    (a[2] - a[0]) * (a[3] - a[1]) +
    (b[2] - b[0]) * (b[3] - b[1]) - common
  );
}

/** Detection proposes new tracks; it never rewrites an existing identity or seed.
 * Require one-to-one starting-frame evidence before adding distinct people. */
export function mergeDetectedPeople(
  tracks: Track[],
  target: number,
  boxes: number[][],
) {
  const unchanged = (message: string) => ({ tracks, added: 0, message });
  if (!tracks.some((track) => track.id === target && !track.ignored))
    return unchanged(
      "Click the shooter in the first frame before finding other people.",
    );
  if (boxes.some((box) =>
    box.length !== 4 ||
    box.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
    box[0] >= box[2] || box[1] >= box[3],
  ))
    throw Error("Invalid person detections. Your selections were kept.");
  const claimed = new Set<number>();
  for (const track of tracks) {
    const seed = track.prompts.find((prompt) => prompt.frame === 0);
    const points = seed?.points?.filter((_, i) => seed.labels?.[i] === 1) ?? [];
    const candidates = boxes.flatMap((box, index) =>
      seed && (seed.box || points.length) &&
      points.every((point) => contains(box, point)) &&
      (!seed.box || iou(box, seed.box) >= 0.5) ? [index] : [],
    );
    if (candidates.length !== 1 || claimed.has(candidates[0]))
      return unchanged(
        `Track ${track.id} could not be matched safely in the first frame. Your shooter and corrections were kept. Adjust its starting selection or add people manually.`,
      );
    claimed.add(candidates[0]);
  }
  // Overlapping proposals may be duplicate detections or competing identities.
  // Leave those to explicit correction instead of inventing new tracks.
  const distinct = boxes.flatMap((box, index) =>
    !claimed.has(index) &&
    !boxes.some((other, j) => j !== index && intersection(box, other) > 0)
      ? [box] : [],
  );
  const skipped = boxes.length - claimed.size - distinct.length;
  if (
    tracks.length + distinct.length > 20 ||
    tracks.reduce((n, t) => n + t.prompts.length, 0) + distinct.length > 128
  )
    return unchanged(
      "Adding these detections would exceed the track or correction limit. Your selections were kept; remove unwanted tracks or shorten the clip.",
    );
  const used = new Set(tracks.map((track) => track.id));
  let next = 1;
  const additions = distinct.map((box) => {
    while (used.has(next)) next++;
    const id = next++;
    used.add(id);
    return { id, prompts: [{ frame: 0, box: [...box] }] };
  });
  return {
    tracks: additions.length ? [...tracks, ...additions] : tracks,
    added: additions.length,
    message: `Added ${additions.length} new people. Your shooter and corrections were kept.${skipped ? ` ${skipped} overlapping detections were not added; select missing people manually.` : ""} Review detections for spectators and false positives.`,
  };
}
