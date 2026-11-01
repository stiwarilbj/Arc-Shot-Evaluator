import { player, type QuizClip } from "./domain.ts";
export interface PublicCatalog {
  kind: "starter" | "complete" | null;
  clips: QuizClip[];
}
export function parsePublicManifest(
  manifest: unknown,
  base: string,
): PublicCatalog {
  if (!manifest || typeof manifest !== "object")
    throw Error("Invalid NBA collection");
  const value = manifest as Record<string, unknown>;
  const kind =
    value.collection_kind === undefined ? "complete" : value.collection_kind;
  if (kind !== "starter" && kind !== "complete")
    throw Error("Unknown NBA collection designation");
  if (
    value.version !== 1 ||
    typeof value.release !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.release) ||
    !Array.isArray(value.players) ||
    !value.players.every(
      (p) =>
        player(p) &&
        /^[a-z0-9][a-z0-9-]{0,99}$/.test(p.id) &&
        p.aliases.every((a: string) => a.trim()),
    ) ||
    !Array.isArray(value.clips)
  )
    throw Error("Invalid NBA collection");
  const minimum = kind === "starter" ? [2, 2] : [300, 60];
  if (
    value.clips.length < minimum[0] ||
    value.players.length < minimum[1] ||
    value.clip_count !== value.clips.length ||
    value.player_count !== value.players.length
  )
    throw Error("NBA collection is incomplete or has incorrect counts");
  const people = new Map(value.players.map((p) => [p.id, p]));
  if (people.size !== value.players.length)
    throw Error("Duplicate NBA player identity");
  const ids = new Set<string>(),
    events = new Set<string>(),
    videos = new Set<string>(),
    represented = new Set<string>();
  const clips: QuizClip[] = value.clips.map((clip) => {
    if (!clip || typeof clip !== "object") throw Error("Invalid public clip");
    const person = people.get(clip.player_id);
    if (
      !person ||
      typeof clip.id !== "string" ||
      !/^[a-f0-9]{32,64}$/.test(clip.id) ||
      ids.has(clip.id) ||
      clip.fps !== 30 ||
      !Number.isInteger(clip.frame_count) ||
      clip.frame_count < 90 ||
      clip.frame_count > 180 ||
      clip.duration !== clip.frame_count / 30
    )
      throw Error("Invalid public clip identity or timeline");
    const provenance = clip.provenance;
    const https = (url: unknown) => {
      if (typeof url !== "string") return false;
      try {
        const parsed = new URL(url);
        return (
          parsed.protocol === "https:" && !parsed.username && !parsed.password
        );
      } catch {
        return false;
      }
    };
    if (
      !provenance ||
      ![
        provenance.source_url,
        provenance.permission_url,
        provenance.identity_url,
      ].every(https) ||
      ![
        provenance.license,
        provenance.attribution,
        provenance.changes,
        clip.event_id,
      ].every((text) => typeof text === "string" && text.trim())
    )
      throw Error("Missing public clip attribution or evidence");
    const event = JSON.stringify([provenance.source_url, clip.event_id]);
    if (events.has(event)) throw Error("Duplicate source event");
    events.add(event);
    ids.add(clip.id);
    represented.add(person.id);
    for (const [kind, media] of [
      ["quiz", clip.quiz],
      ["reveal", clip.reveal],
      ["thumbnail", clip.thumbnail],
    ]) {
      const extension = kind === "thumbnail" ? "png" : "mp4";
      if (
        !media ||
        typeof media.file !== "string" ||
        !new RegExp(`^[a-f0-9]{32}\\.${extension}$`).test(media.file) ||
        !/^[a-f0-9]{64}$/.test(media.sha256) ||
        !Number.isSafeInteger(media.bytes) ||
        media.bytes <= 0
      )
        throw Error("Invalid public media metadata");
      if (kind !== "thumbnail") {
        if (videos.has(media.sha256)) throw Error("Duplicate public video");
        videos.add(media.sha256);
      }
    }
    return {
      id: clip.id,
      player: person,
      duration: clip.duration,
      quiz: `${base}${clip.quiz.file}`,
      reveal: `${base}${clip.reveal.file}`,
      provenance,
    };
  });
  if (represented.size !== people.size)
    throw Error("Every listed player needs a clip");
  return { kind, clips };
}
