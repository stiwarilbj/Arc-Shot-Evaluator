// Shared with the worker · Recover once from a rejected cached model response
export async function checkedAsset(
  url: string,
  asset: { sha256: string; bytes: number },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let cache: Cache | undefined;
  try {
    cache = await caches.open("arc-freeze-floor-models-v1");
  } catch {}
  signal?.throwIfAborted();
  let hit: Response | undefined;
  try {
    hit = await cache?.match(url);
  } catch {
    cache = undefined;
  }
  signal?.throwIfAborted();
  const verify = async (response: Response) => {
    signal?.throwIfAborted();
    if (!response.ok)
      throw Error(
        "Model download failed · Retry automatic alignment or use manual landmarks",
      );
    const reader = response.body?.getReader();
    if (!reader) throw Error("Model download was empty");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      signal?.throwIfAborted();
      while (true) {
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        total += value.length;
        if (total > asset.bytes) {
          await reader.cancel().catch(() => {});
          throw Error("Model download exceeded its size limit");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (x) => x.toString(16).padStart(2, "0"),
      ).join("");
      signal?.throwIfAborted();
      if (digest !== asset.sha256)
        throw Error(
          "Model integrity check failed · Retry to download a verified copy",
        );
      return bytes;
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  };
  if (hit) {
    try {
      const bytes = await verify(hit);
      signal?.throwIfAborted();
      return bytes;
    } catch (e) {
      signal?.throwIfAborted();
      if (e instanceof Error && e.name === "AbortError") throw e;
      try {
        await cache?.delete(url);
      } catch {}
      signal?.throwIfAborted();
    }
  }
  // A fresh failure is final · Do not recursively retry an unverified download
  const response = await fetch(url, {
    signal,
    cache: hit ? "reload" : "default",
  });
  const bytes = await verify(response);
  signal?.throwIfAborted();
  try {
    await cache?.put(url, new Response(bytes));
  } catch {}
  signal?.throwIfAborted();
  return bytes;
}
