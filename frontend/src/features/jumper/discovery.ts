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
  const ambiguous =
    pairs.some((pair) => !usedBoxes.has(pair.box)) ||
    boxes.some((_, i) => {
      const choices = pairs.filter((p) => p.box === i);
      return (
        choices.length > 1 &&
        Math.abs(choices[0].score - choices[1].score) < 0.1
      );
    });
  return { unmatched: boxes.filter((_, i) => !usedBoxes.has(i)), ambiguous };
}
