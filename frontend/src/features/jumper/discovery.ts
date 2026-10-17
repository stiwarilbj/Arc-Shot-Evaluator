/** A unique detected body can disambiguate a click that otherwise masks clothing. */
export function clickedPersonBox(boxes: number[][], point: number[]) {
  const matches = boxes.filter(
    (box) =>
      point[0] >= box[0] &&
      point[0] <= box[2] &&
      point[1] >= box[1] &&
      point[1] <= box[3],
  );
  return matches.length === 1 ? [...matches[0]] : undefined;
}

/** Expected selection problems are actionable, not model/processing failures. */
export class ShooterSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShooterSelectionError";
  }
}

/** All include points must identify the same body. Exclude points refine its mask,
 * not its box: overlapping boxes often contain part of the other player. */
export function requireShooterBox(
  boxes: number[][],
  points: number[][],
  labels: number[],
) {
  const included = points.filter((_, i) => labels[i] === 1);
  const matches = boxes.filter(
    (box) =>
      included.length > 0 &&
      included.every(
        (point) =>
          point[0] >= box[0] &&
          point[0] <= box[2] &&
          point[1] >= box[1] &&
          point[1] <= box[3],
      ),
  );
  if (matches.length > 1)
    throw new ShooterSelectionError(
      "Your selection overlaps more than one detected player. Add another Include point on a part of the shooter away from the other player in the first frame.",
    );
  if (!matches.length)
    throw new ShooterSelectionError(
      "Your points do not identify one detected player. Clear the first-frame points and click inside the shooter again. If detection keeps missing them, use manual selection under corrections and check the silhouette preview.",
    );
  return [...matches[0]];
}

/** Match detections one-to-one against recorded masks, never nearest players. */
export function resolvePeople(
  boxes: number[][],
  owners: Uint8Array,
  width: number,
  height: number,
) {
  const bounds = new Map<number, number[]>();
  for (let i = 0; i < owners.length; i++) {
    const id = owners[i];
    if (!id) continue;
    const x = (i % width) / width,
      y = Math.floor(i / width) / height;
    const b = bounds.get(id) ?? [1, 1, 0, 0];
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x + 1 / width);
    b[3] = Math.max(b[3], y + 1 / height);
    bounds.set(id, b);
  }
  const pairs: { box: number; id: number; score: number }[] = [];
  boxes.forEach((box, index) => {
    for (const [id, b] of bounds) {
      const intersection =
        Math.max(0, Math.min(b[2], box[2]) - Math.max(b[0], box[0])) *
        Math.max(0, Math.min(b[3], box[3]) - Math.max(b[1], box[1]));
      const a = (b[2] - b[0]) * (b[3] - b[1]),
        c = (box[2] - box[0]) * (box[3] - box[1]);
      const iou = intersection / (a + c - intersection),
        coverage = intersection / Math.min(a, c);
      if (iou >= 0.25 || coverage >= 0.65)
        pairs.push({ box: index, id, score: iou });
    }
  });
  pairs.sort((a, b) => b.score - a.score || a.box - b.box || a.id - b.id);
  const usedBoxes = new Set<number>(),
    usedTracks = new Set<number>();
  for (const pair of pairs)
    if (!usedBoxes.has(pair.box) && !usedTracks.has(pair.id)) {
      usedBoxes.add(pair.box);
      usedTracks.add(pair.id);
    }
  // Competing detections or near-equal assignments cannot establish identity.
  const ambiguousTracks = new Set<number>();
  for (const pair of pairs)
    if (!usedBoxes.has(pair.box)) ambiguousTracks.add(pair.id);
  boxes.forEach((_, i) => {
    const choices = pairs.filter((p) => p.box === i);
    if (
      choices.length > 1 &&
      Math.abs(choices[0].score - choices[1].score) < 0.1
    )
      choices.forEach((p) => ambiguousTracks.add(p.id));
  });
  return {
    unmatched: boxes.filter((_, i) => !usedBoxes.has(i)),
    ambiguous: ambiguousTracks.size > 0,
    ambiguousTracks: [...ambiguousTracks].sort((a, b) => a - b),
  };
}
