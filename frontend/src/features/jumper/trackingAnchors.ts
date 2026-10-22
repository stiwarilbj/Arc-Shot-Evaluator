import type { PointPrompt, Track } from "./domain.ts";

export function hasBodySelection(prompt: PointPrompt | undefined) {
  return !!prompt?.box || prompt?.labels?.includes(1) === true;
}
export function shooterAnchors(tracks: Track[], target: number) {
  return tracks.find(track => track.id === target)?.prompts
    .filter(prompt => prompt.anchor === true && prompt.frame > 0 && hasBodySelection(prompt)) ?? [];
}
/** Nearest reliable causal anchor: future frames never enter forward memory. */
export function latestShooterAnchor(tracks: Track[], target: number, frame: number) {
  return shooterAnchors(tracks, target).reduce((latest, prompt) =>
    prompt.frame <= frame ? Math.max(latest, prompt.frame) : latest, 0);
}
export function setShooterAnchor(tracks: Track[], target: number, frame: number, confirmed: boolean): Track[] {
  const prompt = tracks.find(track => track.id === target)?.prompts.find(prompt => prompt.frame === frame);
  if (!prompt || frame <= 0 || (confirmed && !hasBodySelection(prompt)))
    throw Error("Add an Include point on the shooter at a clear later frame first");
  return tracks.map(track => track.id !== target ? track : {
    ...track, prompts: track.prompts.map(prompt => prompt.frame !== frame ? prompt : {
      ...prompt, anchor: confirmed || undefined,
    }),
  });
}
