// Shared with the worker; rejection evicts only the corrupt model response.
export async function checkedAsset(
  url: string,
  asset: { sha256: string; bytes: number },
) {
  let cache: Cache | undefined;
  try {
    cache = await caches.open("arc-freeze-floor-models-v1");
  } catch {}
  let hit: Response | undefined;
  try {
    hit = await cache?.match(url);
  } catch {
    cache = undefined;
  }
  const removeRejectedHit = async () => {
    if (hit) {
      try {
        await cache?.delete(url);
      } catch {}
    }
  };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const response = hit ?? (await fetch(url));
    if (!response.ok)
      throw Error(
        "Model download failed · Retry automatic alignment or use manual landmarks",
      );
    const reader = response.body?.getReader();
    if (!reader) throw Error("Model download was empty");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > asset.bytes) {
          await reader.cancel();
          throw Error("Model download exceeded its size limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (x) => x.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== asset.sha256)
      throw Error(
        "Model integrity check failed · Retry to download a verified copy",
      );
  } catch (e) {
    await removeRejectedHit();
    throw e;
  }
  if (!hit) {
    try {
      await cache?.put(url, new Response(bytes));
    } catch {}
  }
  return bytes;
}
