import { validHands } from "./ballAttachments.ts";
/** Private, disposable inference inputs. Never masks, identities, or tracking memory. */
export const FRAME_CACHE_BYTES = 192 * 1024 * 1024;
const MAX_ENTRIES = 1024;
export const FRAME_CACHE_TTL = 60 * 60 * 1000;
interface Entry {
  key: string;
  scope: string;
  bytes: number;
  touched: number;
}
export function admission(
  entries: Entry[],
  scope: string,
  bytes: number,
  now: number,
  limit = FRAME_CACHE_BYTES,
) {
  const removed = entries.filter((e) => now - e.touched > FRAME_CACHE_TTL);
  const remaining = entries.filter((e) => !removed.includes(e));
  let count = remaining.length;
  let used = remaining.reduce((sum, e) => sum + e.bytes, 0);
  // Preserve the current clip's early frames: cycling a clip larger than the
  // budget through an ordinary LRU would evict every frame before it is reused.
  for (const entry of remaining
    .filter((e) => e.scope !== scope)
    .sort((a, b) => a.touched - b.touched)) {
    if (used + bytes <= limit && count < MAX_ENTRIES) break;
    used -= entry.bytes;
    count--;
    removed.push(entry);
  }
  return {
    removed,
    fits: bytes > 0 && used + bytes <= limit && count < MAX_ENTRIES,
  };
}
export async function contentHash(bytes: BufferSource) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(Error("Cache unavailable"));
    }, 5000);
    value.onsuccess = () => {
      clearTimeout(timer);
      if (expired) {
        if (value.result instanceof IDBDatabase) value.result.close();
      } else resolve(value.result);
    };
    value.onerror = () => {
      clearTimeout(timer);
      reject(value.error);
    };
  });
}
export class FrameCache {
  private db: IDBDatabase;
  private scope: string;
  private available = true;
  private constructor(db: IDBDatabase, scope: string) {
    this.db = db;
    this.scope = scope;
  }
  static async open(
    file: Blob,
    settings: unknown,
  ): Promise<FrameCache | undefined> {
    try {
      const scope = await contentHash(
        new TextEncoder().encode(
          JSON.stringify([
            await contentHash(await file.arrayBuffer()),
            settings,
          ]),
        ),
      );
      const opening = indexedDB.open("arc-jumper-frame-cache-v1", 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("meta", { keyPath: "key" });
        opening.result.createObjectStore("values");
      };
      const db = await request(opening);
      db.onversionchange = () => db.close();
      return new FrameCache(db, scope);
    } catch {
      return undefined;
    }
  }
  close() {
    this.db.close();
  }
  async get<T>(name: string): Promise<T | undefined> {
    if (!this.available) return;
    try {
      const tx = this.db.transaction(["meta", "values"], "readwrite");
      const key = this.scope + ":" + name;
      const meta = (await request(tx.objectStore("meta").get(key))) as
        | Entry
        | undefined;
      if (!meta) return;
      if (Date.now() - meta.touched > FRAME_CACHE_TTL) {
        tx.objectStore("meta").delete(key);
        tx.objectStore("values").delete(key);
        return;
      }
      tx.objectStore("meta").put({ ...meta, touched: Date.now() });
      return await request(tx.objectStore("values").get(key));
    } catch {
      this.available = false;
      return undefined;
    }
  }
  async canPut(name: string, bytes: number) {
    if (!this.available) return false;
    try {
      const tx = this.db.transaction("meta", "readonly");
      const entries = (await request(
        tx.objectStore("meta").getAll(),
      )) as Entry[];
      return admission(
        entries.filter((e) => e.key !== this.scope + ":" + name),
        this.scope,
        bytes,
        Date.now(),
      ).fits;
    } catch {
      this.available = false;
      return false;
    }
  }
  async put(name: string, value: unknown, bytes: number) {
    if (!this.available) return;
    try {
      const tx = this.db.transaction(["meta", "values"], "readwrite");
      const completion = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          try {
            tx.abort();
          } catch {}
          resolve(false);
        }, 5000);
        tx.oncomplete = () => {
          clearTimeout(timer);
          resolve(true);
        };
        tx.onabort = tx.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      const meta = tx.objectStore("meta"),
        values = tx.objectStore("values");
      const key = this.scope + ":" + name;
      const entries = (await request(meta.getAll())) as Entry[];
      const plan = admission(
        entries.filter((e) => e.key !== key),
        this.scope,
        bytes,
        Date.now(),
      );
      for (const entry of plan.removed) {
        meta.delete(entry.key);
        values.delete(entry.key);
      }
      if (plan.fits) {
        meta.put({ key, scope: this.scope, bytes, touched: Date.now() });
        values.put(value, key);
      }
      if (!(await completion)) this.available = false;
    } catch {
      this.available = false;
      /* Storage denial/quota/errors only disable this optimization. */
    }
  }
}
export interface CachedFeatures {
  dims: number[];
  data: Float32Array;
}
const SHAPES: Record<string, number[]> = {
  feats0: [1, 32, 256, 256],
  feats1: [1, 64, 128, 128],
  feats2: [1, 256, 64, 64],
  pos2: [1, 256, 64, 64],
};
export function validFeatures(
  value: unknown,
): value is Record<string, CachedFeatures> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== Object.keys(SHAPES).length
  )
    return false;
  return Object.entries(SHAPES).every(([key, dims]) => {
    const item = (value as Record<string, CachedFeatures>)[key];
    return (
      item &&
      Array.isArray(item.dims) &&
      JSON.stringify(item.dims) === JSON.stringify(dims) &&
      item.data instanceof Float32Array &&
      item.data.length === dims.reduce((a, b) => a * b, 1) &&
      item.data.every(Number.isFinite)
    );
  });
}
export function validDetections(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (b) =>
        Array.isArray(b) &&
        b.length === 4 &&
        b.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
        b[0] < b[2] &&
        b[1] < b[3],
    )
  );
}

/** Wrist rows must refer uniquely to retained boxes; missing pose evidence is valid. */
export function validDetectionEvidence(
  value: unknown,
): value is { boxes: number[][]; hands: number[][] } {
  if (!value || typeof value !== "object") return false;
  const { boxes, hands } = value as { boxes?: unknown; hands?: unknown };
  if (!validDetections(boxes) || !validHands(hands)) return false;
  const retained = new Set(boxes.map(box => JSON.stringify(box)));
  const seen = new Set<string>();
  return hands.every(row => {
    const box = JSON.stringify(row.slice(0, 4));
    if (!retained.has(box) || seen.has(box)) return false;
    seen.add(box);
    return true;
  });
}
