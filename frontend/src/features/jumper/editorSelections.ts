import type { Track } from "./domain";

export function needsSelection(track: Track | undefined): boolean {
  const initial = track?.prompts[0];
  return !initial || !(initial.box || initial.labels?.includes(1));
}

// Clearing correction points must retain the detector's initial box. Empty
// tracks remain selectable so the user can seed them again without losing IDs.
export function clearFramePoints(
  tracks: Track[],
  id: number,
  frame: number,
): Track[] {
  return tracks.map((track) =>
    track.id !== id
      ? track
      : {
          ...track,
          prompts: track.prompts.flatMap((prompt) =>
            prompt.frame !== frame
              ? [prompt]
              : prompt.box
                ? [{ frame, box: prompt.box }]
                : prompt === track.prompts[0] && track.prompts.length > 1
                  ? [{ frame }]
                  : [],
          ),
        },
  );
}
