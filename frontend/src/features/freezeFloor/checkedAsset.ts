// Shared with the worker · Recover once from a rejected cached model response
const DOWNLOAD_IDLE_MS = 30_000;

function downloadDeadline(parent?: AbortSignal) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  const abort = () => {
    stop();
    controller.abort(parent?.reason);
  };
  const reset = () => {
    stop();
    if (!controller.signal.aborted)
      timer = setTimeout(() => {
        controller.abort(
          new DOMException(
            "Model download stalled · No data received for 30 seconds · Retry automatic proposals or use manual landmarks",
            "TimeoutError",
          ),
        );
      }, DOWNLOAD_IDLE_MS);
  };
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  else reset();
  return {
    signal: controller.signal,
    reset,
    stop,
    dispose() {
      stop();
      parent?.removeEventListener("abort", abort);
    },
  };
}

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
  const verify = async (
    response: Response,
    download?: ReturnType<typeof downloadDeadline>,
  ) => {
    const readSignal = download?.signal ?? signal;
    readSignal?.throwIfAborted();
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
    readSignal?.addEventListener("abort", abort, { once: true });
    try {
      if (readSignal?.aborted) abort();
      readSignal?.throwIfAborted();
      while (true) {
        const { done, value } = await reader.read();
        readSignal?.throwIfAborted();
        if (done) break;
        if (value.length) download?.reset();
        total += value.length;
        if (total > asset.bytes) {
          await reader.cancel().catch(() => {});
          throw Error("Model download exceeded its size limit");
        }
        chunks.push(value);
      }
      // Hashing and inference are processing time, not download inactivity
      download?.stop();
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
      readSignal?.throwIfAborted();
      if (digest !== asset.sha256)
        throw Error(
          "Model integrity check failed · Retry to download a verified copy",
        );
      return bytes;
    } finally {
      download?.stop();
      readSignal?.removeEventListener("abort", abort);
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
  const download = downloadDeadline(signal);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const response = await fetch(url, {
      signal: download.signal,
      cache: hit ? "reload" : "default",
    });
    bytes = await verify(response, download);
  } catch (e) {
    download.signal.throwIfAborted();
    throw e;
  } finally {
    download.dispose();
  }
  signal?.throwIfAborted();
  try {
    await cache?.put(url, new Response(bytes));
  } catch {}
  signal?.throwIfAborted();
  return bytes;
}
