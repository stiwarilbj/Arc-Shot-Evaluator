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
      "Your selection overlaps more than one detected player · Add another Include point on a part of the shooter away from the other player in the first frame",
    );
  if (!matches.length)
    throw new ShooterSelectionError(
      "Your points do not identify one detected player · Clear the first-frame points and click inside the shooter again · If detection keeps missing them, use manual selection under corrections and check the silhouette preview",
    );
  return [...matches[0]];
}

/** Associate detections using visible occupied pixels, never mask rectangles or
 * nearest players. Weak/competing evidence stays reviewable, not a new identity. */
function associatePeople(
  boxes: number[][],
  owners: Uint8Array,
  width: number,
  height: number,
) {
  const areas = new Uint32Array(256);
  for (const id of owners) if (id) areas[id]++;
  const pairs: { box: number; id: number; score: number }[] = [];
  const ambiguousTracks = new Set<number>();
  const uncertainBoxes = new Set<number>();
  boxes.forEach((box, index) => {
    // A pixel belongs to the box when its center is inside its half-open extent.
    // Identical rasterization in native processing avoids fractional-edge drift.
    const x1 = Math.max(0, Math.min(width, Math.ceil(box[0] * width - 0.5)));
    const y1 = Math.max(0, Math.min(height, Math.ceil(box[1] * height - 0.5)));
    const x2 = Math.max(x1, Math.min(width, Math.ceil(box[2] * width - 0.5)));
    const y2 = Math.max(y1, Math.min(height, Math.ceil(box[3] * height - 0.5)));
    const boxArea = (x2 - x1) * (y2 - y1);
    if (!boxArea) {
      uncertainBoxes.add(index);
      return;
    }
    const occupied = new Uint32Array(256);
    for (let y = y1; y < y2; y++)
      for (let x = x1; x < x2; x++) {
        const id = owners[y * width + x];
        if (id) occupied[id]++;
      }
    const weak: { id: number; score: number }[] = [];
    const strong: { box: number; id: number; score: number }[] = [];
    for (let id = 1; id < areas.length; id++) {
      const intersection = occupied[id];
      if (!intersection) continue;
      const score = intersection / (areas[id] + boxArea - intersection);
      const maskCoverage = intersection / areas[id];
      const boxCoverage = intersection / boxArea;
      // A tiny torso/limb fragment inside a large detection is not a body match.
      if (boxCoverage >= 0.1 && (score >= 0.25 || maskCoverage >= 0.65))
        strong.push({ box: index, id, score });
      else if (maskCoverage >= 0.1 || boxCoverage >= 0.1)
        weak.push({ id, score });
    }
    const best = Math.max(-1, ...strong.map((pair) => pair.score));
    const competing = weak.filter((pair) => best - pair.score < 0.1);
    if (competing.length) {
      uncertainBoxes.add(index);
      for (const pair of [...strong, ...competing]) ambiguousTracks.add(pair.id);
    }
    pairs.push(...strong);
  });
  pairs.sort((a, b) => b.score - a.score || a.box - b.box || a.id - b.id);
  const usedBoxes = new Set<number>(),
    usedTracks = new Set<number>();
  for (const pair of pairs)
    if (!usedBoxes.has(pair.box) && !usedTracks.has(pair.id)) {
      usedBoxes.add(pair.box);
      usedTracks.add(pair.id);
    }
  for (const pair of pairs)
    if (!usedBoxes.has(pair.box)) {
      ambiguousTracks.add(pair.id);
      uncertainBoxes.add(pair.box);
    }
  boxes.forEach((_, i) => {
    const choices = pairs.filter((p) => p.box === i);
    if (choices.length > 1 && choices[0].score - choices[1].score < 0.1) {
      uncertainBoxes.add(i);
      choices.forEach((p) => ambiguousTracks.add(p.id));
    }
  });
  return {
    unmatched: boxes.filter((_, i) => !usedBoxes.has(i) && !uncertainBoxes.has(i)),
    ambiguous: ambiguousTracks.size > 0 || uncertainBoxes.size > 0,
    ambiguousTracks: [...ambiguousTracks].sort((a, b) => a - b),
    confirmedTracks: [...usedTracks].filter((id) => !ambiguousTracks.has(id)),
  };
}

export function resolvePeople(
  boxes: number[][],
  owners: Uint8Array,
  width: number,
  height: number,
) {
  const { confirmedTracks: _, ...result } = associatePeople(
    boxes, owners, width, height,
  );
  return result;
}

/** Per-job presence ledger. Tracking memory, not a stale location or detection
 * order, must establish a returning identity. Keep recent timestamps for 1.5s;
 * expired entries remain small tombstones until evidence/correction resolves them. */
export class PeopleDiscovery {
  readonly lastSeen = new Map<number, number | null>();

  resolve(
    frame: number,
    boxes: number[][],
    owners: Uint8Array,
    width: number,
    height: number,
    tracks: readonly { id: number; prompts: readonly { frame: number }[] }[],
  ) {
    const { confirmedTracks, ...result } = associatePeople(
      boxes, owners, width, height,
    );
    const confirmed = new Set(confirmedTracks);
    const missing: number[] = [];
    for (const track of tracks) {
      // A future correction is not a missing person in earlier frames.
      if (track.prompts[0].frame > frame) continue;
      if (confirmed.has(track.id)) this.lastSeen.set(track.id, frame);
      else {
        const last = this.lastSeen.get(track.id);
        this.lastSeen.set(
          track.id,
          last != null && frame - last <= 45 ? last : null,
        );
        missing.push(track.id);
      }
    }
    if (result.unmatched.length && missing.length) {
      // A box alone cannot distinguish a return from an entrant. Do not re-prompt
      // an old identity or spend another track slot on a guess.
      result.unmatched = [];
      result.ambiguous = true;
      result.ambiguousTracks = [
        ...new Set([...result.ambiguousTracks, ...missing]),
      ].sort((a, b) => a - b);
    }
    return result;
  }
}
