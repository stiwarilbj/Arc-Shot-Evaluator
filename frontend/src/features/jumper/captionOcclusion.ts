import { captionLayout, captionPositions } from "./captionLayout.ts";
import { editFrame, type Caption, type EditProject } from "./editProject.ts";
import { framingRect } from "./framingGeometry.ts";

export type ShooterSample = { points: Float32Array };
export type ShooterMasks = {
  width: number;
  height: number;
  frames: ShooterSample[];
};
export type CaptionRisk = {
  id: string;
  frame: number;
  body: number;
  upper: number;
  suggestion?: Caption["position"];
};

/** Recover only the black silhouette core, never clothing or background colors. */
export function shooterSample(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): ShooterSample {
  const points: number[] = [];
  for (let i = 0; i < width * height; i++) {
    const at = i * 4;
    if (
      Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) < 24 &&
      pixels[at + 3] > 240
    )
      points.push(
        ((i % width) + 0.5) / width,
        (Math.floor(i / width) + 0.5) / height,
      );
  }
  return { points: new Float32Array(points) };
}

/** Caption backing counts as coverage too; transform exactly as the export crop. */
export function silhouetteCoverage(
  sample: ShooterSample,
  crop: ReturnType<typeof framingRect>,
  box: { x: number; y: number; width: number; height: number },
) {
  let visible = 0,
    top = Infinity,
    bottom = -Infinity;
  const points = sample.points;
  for (let i = 0; i < points.length; i += 2) {
    const x = (points[i] - crop.left) / crop.width;
    const y = (points[i + 1] - crop.top) / crop.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    visible++;
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  if (visible < 12) return { body: 0, upper: 0 };
  let covered = 0,
    upper = 0,
    upperCovered = 0;
  const upperEnd = top + (bottom - top) / 3;
  for (let i = 0; i < points.length; i += 2) {
    const x = (points[i] - crop.left) / crop.width;
    const y = (points[i + 1] - crop.top) / crop.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    const hit =
      x >= box.x &&
      x < box.x + box.width &&
      y >= box.y &&
      y < box.y + box.height;
    if (hit) covered++;
    if (y <= upperEnd) {
      upper++;
      if (hit) upperCovered++;
    }
  }
  return {
    body: covered / visible,
    upper: upper >= 4 ? upperCovered / upper : 0,
  };
}

/** Every edited frame is checked, including repeated/freezed source frames. */
export async function captionRisks(
  project: EditProject,
  masks: ShooterMasks,
  context: Parameters<typeof captionLayout>[0],
  signal: AbortSignal,
): Promise<CaptionRisk[]> {
  const result: CaptionRisk[] = [];
  for (const caption of project.captions) {
    const scores = captionPositions.map((position) => {
      const layout = captionLayout(context, masks.width, masks.height, {
        ...caption,
        position,
      });
      return {
        position,
        body: 0,
        upper: 0,
        frame: caption.start,
        score: 0,
        fits: layout.fits,
        box: {
          x: layout.x / masks.width,
          y: layout.y / masks.height,
          width: layout.width / masks.width,
          height: layout.boxHeight / masks.height,
        },
      };
    });
    for (let frame = caption.start; frame < caption.end; frame++) {
      signal.throwIfAborted();
      const state = editFrame(project, frame);
      const sample = masks.frames[state.source];
      if (!sample)
        throw Error("A source frame is missing from the silhouette check.");
      const crop = framingRect(state.framing);
      for (const score of scores) {
        const hit = silhouetteCoverage(sample, crop, score.box);
        const severity = Math.max(hit.body / 0.15, hit.upper / 0.15);
        if (severity > score.score)
          Object.assign(score, hit, { score: severity, frame });
      }
      if (frame % 30 === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const current = scores.find(
      (score) => score.position === caption.position,
    )!;
    if (current.score < 1) continue;
    const better = scores
      .filter(
        (score) =>
          score.position !== caption.position &&
          score.fits &&
          score.score < current.score * 0.7,
      )
      .sort((a, b) => a.score - b.score)[0];
    result.push({
      id: caption.id,
      frame: current.frame,
      body: current.body,
      upper: current.upper,
      suggestion: better?.position,
    });
  }
  return result;
}
