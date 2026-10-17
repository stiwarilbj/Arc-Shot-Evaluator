import { unstableMask, type MaskExtent, type MaskWarning } from "./domain.ts";

type Extent = MaskExtent & { bounds: number[] };
type Track = { id: number; ignored?: boolean; prompts: readonly { frame: number }[] };
type State = { previous?: Extent; exiting: boolean; exited: boolean; shrink?: Extent; shrinkFrame?: number };

/** Measure final, mutually exclusive visible masks, including gray players. */
export function maskExtents(owners: Uint8Array, width: number, height: number) {
  const extents = new Map<number, Extent>();
  for (let i = 0; i < owners.length; i++) {
    const id = owners[i];
    if (!id) continue;
    const x = i % width, y = Math.floor(i / width);
    let value = extents.get(id);
    if (!value) {
      value = { area: 0, x: 0, y: 0, bounds: [width, height, 0, 0] };
      extents.set(id, value);
    }
    value.area++;
    value.x += x;
    value.y += y;
    value.bounds[0] = Math.min(value.bounds[0], x);
    value.bounds[1] = Math.min(value.bounds[1], y);
    value.bounds[2] = Math.max(value.bounds[2], x + 1);
    value.bounds[3] = Math.max(value.bounds[3], y + 1);
  }
  for (const value of extents.values()) {
    value.x /= value.area * width;
    value.y /= value.area * height;
    value.bounds = value.bounds.map((v, i) => v / (i % 2 ? height : width));
  }
  return extents;
}

// A clipped mask alone is insufficient: require observed outward motion.
function leaving(a: Extent, b: Extent, width: number, height: number) {
  const mx = Math.max(2 / width, 0.015), my = Math.max(2 / height, 0.015);
  const horizontal = (b.bounds[3] - b.bounds[1]) >= (a.bounds[3] - a.bounds[1]) * 0.8 && Math.abs(b.y - a.y) <= 0.05;
  const vertical = (b.bounds[2] - b.bounds[0]) >= (a.bounds[2] - a.bounds[0]) * 0.8 && Math.abs(b.x - a.x) <= 0.05;
  if (b.area > a.area * 1.15) return false;
  return (horizontal && (
    (a.bounds[0] <= mx && b.bounds[0] <= 1 / width && b.x < a.x - 0.5 / width) ||
    (a.bounds[2] >= 1 - mx && b.bounds[2] >= 1 - 1 / width && b.x > a.x + 0.5 / width)
  )) || (vertical && (
    (a.bounds[1] <= my && b.bounds[1] <= 1 / height && b.y < a.y - 0.5 / height) ||
    (a.bounds[3] >= 1 - my && b.bounds[3] >= 1 - 1 / height && b.y > a.y + 0.5 / height)
  ));
}

function shrunk(a: Extent, b: Extent) {
  return b.area / a.area < 0.65 ||
    (b.bounds[3] - b.bounds[1]) / (a.bounds[3] - a.bounds[1]) < 0.75 ||
    (b.bounds[2] - b.bounds[0]) / (a.bounds[2] - a.bounds[0]) < 0.55;
}

/** Bounded per-job history; warnings carry the affected player's stable ID. */
export class MaskQuality {
  private states = new Map<number, State>();

  inspect(frame: number, owners: Uint8Array, width: number, height: number,
    tracks: readonly Track[], target: number): MaskWarning[] {
    const extents = maskExtents(owners, width, height);
    const warnings: MaskWarning[] = [];
    for (const track of tracks) {
      if (track.ignored || frame < track.prompts[0].frame) continue;
      const state = this.states.get(track.id) ?? { exiting: false, exited: false };
      const current = extents.get(track.id), previous = state.previous;
      if (!current) {
        state.exited ||= state.exiting;
        if (!state.exited) warnings.push({ frame, kind: track.id === target ? "target_lost" : "player_lost", track_ids: [track.id] });
        state.previous = undefined;
        state.exiting = false;
        state.shrink = undefined;
      } else {
        const exit = !!previous && leaving(previous, current, width, height);
        if (previous && !exit && unstableMask(previous, current)) {
          warnings.push({ frame, kind: "tracking_unstable", track_ids: [track.id] });
          state.shrink = undefined;
        } else if (previous && !exit && shrunk(state.shrink ?? previous, current)) {
          // Confirm on a second frame; retain the first affected review frame.
          if (state.shrink) {
            if (state.shrinkFrame !== undefined)
              warnings.push({ frame: state.shrinkFrame, kind: "tracking_unstable", track_ids: [track.id] });
            state.shrinkFrame = undefined;
            warnings.push({ frame, kind: "tracking_unstable", track_ids: [track.id] });
          } else {
            state.shrink = previous;
            state.shrinkFrame = frame;
          }
        } else state.shrink = undefined;
        state.previous = current;
        state.exiting = exit;
        state.exited = false;
      }
      this.states.set(track.id, state);
    }
    return warnings;
  }
}
