import { downloadProgress } from "./processingEstimate.ts";

/** Bound decoded response bytes, including cached bodies; headers are progress hints only. */
export async function checkedAsset(
  asset: { url: string; sha: string; maxBytes: number },
  progress: (done: number, fraction: number) => void,
  baseURL: string,
) {
  const url = new URL(asset.url, baseURL).href;
  let cache: Cache | undefined;
  try { cache = await caches.open("arc-jumper-models-v1"); } catch {}
  const cached = await cache?.match(url);
  const response = cached ?? await fetch(url);
  if (!response.ok || !response.body)
    throw Error(`Model download failed (${response.status}); retry Create.`);
  const reader = response.body.getReader();
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  const total = Number(response.headers.get("Content-Length") ?? 0);
  const encoding = response.headers.get("Content-Encoding");
  let done = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > asset.maxBytes - done) {
        try { await cache?.delete(url); } catch {}
        throw Error("Model exceeds its pinned size limit. Retry to download a fresh copy.");
      }
      done += chunk.value.byteLength;
      pieces.push(new Uint8Array(chunk.value));
      if (!cached) progress(done, downloadProgress(done, total, encoding));
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(done);
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
  if (hash !== asset.sha) {
    await cache?.delete(url);
    throw Error("Model integrity check failed. Retry to download a fresh copy.");
  }
  if (!cached) {
    try { await cache?.put(url, new Response(bytes)); } catch {
      /* Model works even when persistent cache is unavailable. */
    }
  }
  return bytes.buffer;
}
