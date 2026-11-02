import type { Contact } from "./types.ts";

function evidence(a: Contact, b: Contact) {
  const near = Math.hypot(a.image.x - b.image.x, a.image.y - b.image.y) < 0.035;
  if (!a.box || !b.box)
    return { possible: near, strong: false, overlap: undefined };
  const x = a.box,
    y = b.box;
  const intersection =
    Math.max(0, Math.min(x[2], y[2]) - Math.max(x[0], y[0])) *
    Math.max(0, Math.min(x[3], y[3]) - Math.max(x[1], y[1]));
  const overlap =
    intersection /
    ((x[2] - x[0]) * (x[3] - x[1]) +
      (y[2] - y[0]) * (y[3] - y[1]) - intersection);
  const withinBox = (c: Contact) =>
    c.image.x >= c.box![0] &&
    c.image.x <= c.box![2] &&
    c.image.y >= c.box![1] &&
    c.image.y <= c.box![3];
  return {
    possible: (near && overlap >= 0.25) || overlap >= 0.85,
    strong: near && overlap >= 0.85 && withinBox(a) && withinBox(b),
    overlap,
  };
}

export function mergeContactProposals(existing: Contact[], proposals: Contact[]) {
  // Compare against the original contacts, never against an earlier addition
  // from the same detection batch · Box agreement is a heuristic, not identity
  const pairs = proposals.map((p) => existing.map((c) => evidence(p, c)));
  const candidates = pairs.map((row) =>
    row.flatMap((e, i) => (e.strong ? [i] : [])),
  );
  const claims = existing.map(
    (_, i) => candidates.filter((c) => c.includes(i)).length,
  );
  const competes = (
    winner: ReturnType<typeof evidence>,
    other: ReturnType<typeof evidence>,
  ) =>
    other.possible &&
    (other.overlap === undefined || winner.overlap! - other.overlap < 0.15);
  const contacts = [...existing];
  const resolved: (Contact | undefined)[] = [];
  const review = new Set<string>();
  let omitted = 0;
  for (const [i, proposal] of proposals.entries()) {
    const matches = candidates[i];
    const match = matches[0];
    if (
      matches.length === 1 &&
      claims[match] === 1 &&
      !pairs[i].some((e, j) => j !== match && competes(pairs[i][match], e)) &&
      !pairs.some((row, k) => k !== i && competes(pairs[i][match], row[match]))
    ) {
      // Keep the original identity, corrected foot location, and grounding status
      resolved[i] = existing[match];
      continue;
    }
    let addition: Contact | undefined;
    if (contacts.length < 40) {
      addition = {
        ...proposal,
        label: String(Math.max(0, ...contacts.map((c) => Number(c.label) || 0)) + 1),
        status: "uncertain",
      };
      contacts.push(addition);
    } else omitted++;
    resolved[i] = addition;
    const possible = pairs[i].flatMap((e, j) =>
      e.possible ? [existing[j]] : [],
    );
    if (possible.length) {
      possible.forEach((c) => review.add(c.id));
      if (addition) review.add(addition.id);
    }
  }
  // A batch can contain separate overlapping people · Keep both and identify
  // uncertain associations for review instead of arbitrarily choosing one
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      if (evidence(proposals[i], proposals[j]).possible) {
        if (resolved[i]) review.add(resolved[i]!.id);
        if (resolved[j]) review.add(resolved[j]!.id);
      }
    }
  }
  const warnings: string[] = [];
  if (review.size) {
    const labels = contacts
      .filter((c) => review.has(c.id))
      .map((c) => c.label)
      .join(", ");
    const outcome = review.size === 1
      ? `Player ${labels} has an uncertain match`
      : `Players ${labels} remain separate`;
    warnings.push(
      `Player proposals need review · ${outcome} · Check nearby person boxes and remove any duplicate contacts`,
    );
  }
  if (omitted)
    warnings.push(
      `${omitted} player proposal${omitted === 1 ? "" : "s"} could not be added · Limit 40 contacts · Remove spectators and retry or add missing players manually`,
    );
  return { contacts, warnings };
}
