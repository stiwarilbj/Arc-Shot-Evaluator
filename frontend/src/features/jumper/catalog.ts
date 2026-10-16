import { player, type QuizClip } from "./domain";
export async function publicCatalog(signal: AbortSignal): Promise<QuizClip[]> {
  const base = `${import.meta.env.BASE_URL}jumper/catalog/`;
  const response = await fetch(`${base}availability.json`, { signal });
  if (!response.ok) throw Error("NBA collection status could not be loaded");
  const availability = await response.json();
  if (!availability || availability.version !== 1)
    throw Error("Unrecognized NBA collection version");
  if (availability.status === "unavailable") return [];
  if (availability.status !== "ready")
    throw Error("Unrecognized NBA collection status");
  const manifestResponse = await fetch(`${base}manifest.json`, { signal });
  if (!manifestResponse.ok) throw Error("NBA collection could not be loaded");
  const manifest = await manifestResponse.json();
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.players) ||
    !manifest.players.every(player) ||
    manifest.players.length < 60 ||
    !Array.isArray(manifest.clips) ||
    manifest.clips.length < 300
  )
    throw Error("NBA collection is incomplete");
  const people = new Map<string, import("./domain").Player>(
    manifest.players.map((value: import("./domain").Player) => [
      value.id,
      value,
    ]),
  );
  if (people.size !== manifest.players.length)
    throw Error("Duplicate NBA player identity");
  const ids = new Set<string>();
  return manifest.clips.map(
    (value: {
      id: string;
      player_id: string;
      duration: number;
      quiz: { file: string };
      reveal: { file: string };
    }) => {
      const person = people.get(value.player_id);
      if (
        !person ||
        !/^[a-f0-9]{32,64}$/.test(value.id) ||
        ids.has(value.id) ||
        !Number.isFinite(value.duration) ||
        value.duration < 3 ||
        value.duration > 6
      )
        throw Error("Invalid public clip");
      ids.add(value.id);
      for (const media of [value.quiz, value.reveal])
        if (!media || !/^[a-f0-9]{32}\.mp4$/.test(media.file))
          throw Error("Invalid public video path");
      return {
        id: value.id,
        player: person,
        duration: value.duration,
        quiz: `${base}${value.quiz.file}`,
        reveal: `${base}${value.reveal.file}`,
      };
    },
  );
}
