import { parsePublicManifest, type PublicCatalog } from "./publicManifest";
export async function publicCatalog(
  signal: AbortSignal,
): Promise<PublicCatalog> {
  const base = `${import.meta.env.BASE_URL}jumper/catalog/`;
  const response = await fetch(`${base}availability.json`, { signal });
  if (!response.ok) throw Error("NBA collection status could not be loaded");
  const availability = await response.json();
  if (!availability || availability.version !== 1)
    throw Error("Unrecognized NBA collection version");
  if (availability.status === "unavailable") return { kind: null, clips: [] };
  if (
    availability.status !== "ready" ||
    typeof availability.release !== "string" ||
    !availability.release.trim()
  )
    throw Error("Unrecognized NBA collection status");
  const manifestResponse = await fetch(`${base}manifest.json`, { signal });
  if (!manifestResponse.ok) throw Error("NBA collection could not be loaded");
  const manifest = await manifestResponse.json();
  if (manifest.release !== availability.release)
    throw Error("NBA collection release mismatch");
  return parsePublicManifest(manifest, base);
}
