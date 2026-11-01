import type { Caption } from "./editProject";

export type CaptionPart = "move" | "start" | "end";
export type CaptionSnapTarget = { frame: number; label: string };
export type CaptionSnapGuide = CaptionSnapTarget & {
  edge: "start" | "end";
  snapped: boolean;
};

/** Freeze these targets when dragging begins; never snap a caption to itself. */
export function captionSnapTargets(
  captions: Pick<Caption, "id" | "start" | "end">[],
  cuts: number[],
  playhead: number,
  exclude: string,
): CaptionSnapTarget[] {
  const targets = [
    ...cuts.map((frame, i) => ({ frame, label: `Cut ${i + 1}` })),
    { frame: playhead, label: "Playhead" },
    ...captions.flatMap((caption, i) =>
      caption.id === exclude
        ? []
        : [
            { frame: caption.start, label: `Caption ${i + 1} start` },
            { frame: caption.end, label: `Caption ${i + 1} end` },
          ],
    ),
  ];
  return targets.filter(
    (target, i) => targets.findIndex((t) => t.frame === target.frame) === i,
  );
}

/** Only reachable destinations qualify. A wider guide radius previews the snap. */
export function alignCaption(
  interval: Pick<Caption, "start" | "end">,
  part: CaptionPart,
  frames: number,
  targets: CaptionSnapTarget[],
  snapDistance: number,
  guideDistance: number,
): {
  interval: Pick<Caption, "start" | "end">;
  guide: CaptionSnapGuide | null;
} {
  const edges: ("start" | "end")[] =
    part === "move" ? ["start", "end"] : [part];
  let best:
    | { distance: number; interval: typeof interval; guide: CaptionSnapGuide }
    | undefined;
  for (const edge of edges)
    for (const target of targets) {
      const delta = target.frame - interval[edge];
      const distance = Math.abs(delta);
      if (distance > guideDistance || (best && distance >= best.distance))
        continue;
      const aligned = shiftCaption(interval, part, delta, frames);
      if (aligned[edge] !== target.frame) continue;
      best = {
        distance,
        interval: aligned,
        guide: { ...target, edge, snapped: distance <= snapDistance },
      };
    }
  return {
    interval: best?.guide.snapped ? best.interval : interval,
    guide: best?.guide ?? null,
  };
}

/** Integer edited frames; end is exclusive. Moving preserves duration at bounds. */
export function shiftCaption(
  caption: Pick<Caption, "start" | "end">,
  part: CaptionPart,
  delta: number,
  frames: number,
) {
  const offset = Math.round(delta);
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));
  if (part === "move") {
    const duration = caption.end - caption.start;
    const start = clamp(caption.start + offset, 0, frames - duration);
    return { start, end: start + duration };
  }
  return part === "start"
    ? {
        start: clamp(caption.start + offset, 0, caption.end - 1),
        end: caption.end,
      }
    : {
        start: caption.start,
        end: clamp(caption.end + offset, caption.start + 1, frames),
      };
}
