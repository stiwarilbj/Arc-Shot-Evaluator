import { editFrame, pieceFrames, type EditProject } from "./editProject.ts";

/** Stay inside the current piece: never offer deleted footage across a cut. */
export function nearbyFreezeFrames(project: EditProject, frame: number) {
  const hit = editFrame(project, frame);
  const index = project.pieces.findIndex((piece) => piece.id === hit.piece.id);
  const start = project.pieces
    .slice(0, index)
    .reduce((sum, piece) => sum + pieceFrames(piece), 0);
  const end = start + pieceFrames(hit.piece) - 1;
  const anchor = Math.max(start, Math.min(end, Math.floor(frame)));
  const unique = new Map<number, { frame: number; source: number }>();
  // Insert the actual playhead last so repeated slow-motion samples retain it.
  for (const offset of [-6, -3, 3, 6, 0]) {
    const candidate = Math.max(start, Math.min(end, anchor + offset));
    const source = editFrame(project, candidate).source;
    unique.set(source, { frame: candidate, source });
  }
  return [...unique.values()].sort((a, b) => a.frame - b.frame);
}

/** Contrast-weighted edge acutance, not a pose/readability or source-blur score. */
export function freezeEdgeClarity(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (width < 2 || height < 2 || pixels.length !== width * height * 4) return 0;
  let contrast = 0,
    energy = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const at = (y * width + x) * 4;
      const value = (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3;
      for (const next of [at + 4, at + width * 4]) {
        const difference = Math.abs(
          value - (pixels[next] + pixels[next + 1] + pixels[next + 2]) / 3,
        );
        contrast += difference;
        energy += difference * difference;
      }
    }
  }
  return contrast ? energy / contrast / 255 : 0;
}

export function freezeClarityHint(score: number, scores: number[]) {
  const max = Math.max(...scores),
    min = Math.min(...scores);
  if (max < 0.01) return "No clear edges";
  if (max - min <= max * 0.08) return "Similar edge clarity";
  return score >= max * 0.92
    ? "Sharper edges"
    : score <= max * 0.7
      ? "Softer edges"
      : "Moderate edge clarity";
}
