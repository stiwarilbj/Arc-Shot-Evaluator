import {
  validateMaskRequest,
  type MaskRequest,
  type PointPrompt,
} from "./domain.ts";
import { requireShooterBox } from "./discovery.ts";

type Detect = (
  file: File,
  time: number,
  signal: AbortSignal,
) => Promise<number[][]>;

/** Keep only the last resolved seed per source, never inference data or video frames. */
export class ShooterSelectionCache {
  private seeds = new WeakMap<File, { key: string; prompt: PointPrompt }>();

  async resolve(
    file: File,
    request: MaskRequest,
    detect: Detect,
    signal: AbortSignal,
  ): Promise<MaskRequest> {
    validateMaskRequest(request);
    signal.throwIfAborted();
    const resolved = structuredClone(request);
    if (resolved.auto_detect_others) {
      const target = resolved.objects.find(
        (track) => track.id === resolved.target_id,
      )!;
      const seed = target.prompts[0];
      const point = seed.points?.find((_, index) => seed.labels?.[index] === 1);
      if (!seed.box && point) {
        // The preview's short end time and later corrections do not change the
        // starting image. Both jobs must reuse exactly this same resolved seed.
        const key = JSON.stringify([resolved.start, target.id, seed]);
        const cached = this.seeds.get(file);
        if (cached?.key === key)
          target.prompts[0] = structuredClone(cached.prompt);
        else {
          const boxes = await detect(file, resolved.start, signal);
          signal.throwIfAborted();
          seed.box = requireShooterBox(boxes, seed.points!, seed.labels!);
          validateMaskRequest(resolved);
          this.seeds.set(file, { key, prompt: structuredClone(seed) });
        }
      }
    }
    // Only verified automatic seeds (or explicitly manual selections) reach tracking.
    resolved.shooter_selection_resolved = true;
    return resolved;
  }
}
