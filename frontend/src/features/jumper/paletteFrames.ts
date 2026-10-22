import {
  retainTemporaryMedia,
  discardAbandonedMedia,
  removeTemporaryDatabase,
} from "./temporaryMedia.ts";

/** Lossless job-local owner maps for clip-wide palette assignment. No source pixels.
 * Small jobs stay in RAM; larger jobs spill to temporary IndexedDB records.
 * Only one decoded owner map is loaded at a time. */
export type PackedLabels = Uint8Array | Uint32Array;
export function packLabels(labels: Uint8Array): PackedLabels {
  let runs = 1;
  for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) runs++;
  if (runs * 4 >= labels.length) return labels.slice();
  const packed = new Uint32Array(runs);
  let start = 0, at = 0;
  for (let i = 1; i <= labels.length; i++) {
    if (i < labels.length && labels[i] === labels[start]) continue;
    packed[at++] = (i - start) * 256 + labels[start];
    start = i;
  }
  return packed;
}
export function unpackLabels(packed: PackedLabels, size: number): Uint8Array {
  if (packed instanceof Uint8Array) {
    if (packed.length !== size) throw Error("Invalid palette mask");
    return packed.slice();
  }
  if (!(packed instanceof Uint32Array)) throw Error("Missing palette mask");
  const labels = new Uint8Array(size);
  let offset = 0;
  for (const run of packed) {
    const length = Math.floor(run / 256);
    if (!length || offset + length > size) throw Error("Invalid palette mask");
    labels.fill(run & 255, offset, offset + length);
    offset += length;
  }
  if (offset !== size) throw Error("Incomplete palette mask");
  return labels;
}
// Versioned namespace: older scratch DBs did not participate in ownership locks.
// Their age cannot prove abandonment, so the new sweep leaves them alone.
const PREFIX = "arc-jumper-palette-temp-v2-";
const MEMORY_LIMIT = 16 * 1024 * 1024;
const FALLBACK_LIMIT = 96 * 1024 * 1024;
const EXPIRED = 24 * 60 * 60 * 1000;
function discard(name: string, release?: () => void) {
  void removeTemporaryDatabase(name).catch(() => {}).finally(() => release?.());
}
export class PaletteFrames {
  private memory = new Map<number, PackedLabels>();
  private bytes = 0;
  private count = 0;
  private db: IDBDatabase | undefined;
  private closed = false;
  private unavailable = false;
  private releaseOwnership: (() => void) | undefined;
  private name = `${PREFIX}${Date.now()}-${crypto.randomUUID()}`;
  private size: number;
  private expected: number;
  private limit: number;
  constructor(size: number, expected: number, limit = MEMORY_LIMIT) {
    this.size = size;
    this.expected = expected;
    this.limit = limit;
    if (!Number.isInteger(size) || size < 1 || size > 1280 * 720 ||
        !Number.isInteger(expected) || expected < 1 || expected > 450)
      throw Error("Invalid palette timeline");
  }
  private async spill() {
    if (this.unavailable || this.db) return;
    try {
      // Claim before opening storage. A suspended worker retains the lock; a
      // terminated worker loses it automatically. Unsupported browsers use RAM.
      this.releaseOwnership = await retainTemporaryMedia(this.name);
      if (this.closed) throw Error("Palette job closed");
      // Age only selects candidates; an exclusive ownership check permits removal.
      if (indexedDB.databases) for (const entry of await indexedDB.databases()) {
        if (entry.name?.startsWith(PREFIX) &&
            Date.now() - Number(entry.name.slice(PREFIX.length).split('-')[0]) > EXPIRED)
          void discardAbandonedMedia(entry.name).catch(() => {});
      }
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open(this.name, 1);
        let expired = false;
        const timer = setTimeout(() => { expired = true; reject(Error("Temporary mask storage unavailable")); }, 5000);
        opening.onupgradeneeded = () => opening.result.createObjectStore("frames");
        opening.onerror = () => { clearTimeout(timer); reject(opening.error); };
        opening.onsuccess = () => {
          clearTimeout(timer);
          if (this.closed || expired) { opening.result.close(); discard(this.name); reject(Error("Palette job closed")); }
          else resolve(opening.result);
        };
      });
      this.db.onversionchange = () => this.db?.close();
      for (const [frame, labels] of this.memory) await this.store(frame, labels);
      this.memory.clear(); this.bytes = 0;
    } catch {
      this.db?.close(); this.db = undefined;
      if (typeof indexedDB !== "undefined") discard(this.name, this.releaseOwnership);
      else this.releaseOwnership?.();
      this.releaseOwnership = undefined;
      this.unavailable = true;
    }
  }
  private store(frame: number, labels?: PackedLabels): Promise<PackedLabels> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("frames", labels ? "readwrite" : "readonly");
      const request = labels ? tx.objectStore("frames").put(labels, frame) : tx.objectStore("frames").get(frame);
      const timer = setTimeout(() => {
        try { tx.abort(); } catch { reject(Error("Temporary mask storage timed out")); }
      }, 10000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(labels ?? request.result); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(Error("Temporary mask storage failed. Free device storage or shorten the clip")); };
    });
  }
  async add(frame: number, labels: Uint8Array) {
    if (this.closed || frame !== this.count || labels.length !== this.size || frame >= this.expected)
      throw Error("Invalid palette frame order");
    const packed = packLabels(labels);
    if (this.bytes + packed.byteLength > this.limit) await this.spill();
    if (this.db) await this.store(frame, packed);
    else {
      if (this.bytes + packed.byteLength > FALLBACK_LIMIT)
        throw Error("Temporary mask storage unavailable. Allow browser storage or shorten the clip");
      this.memory.set(frame, packed); this.bytes += packed.byteLength;
    }
    this.count++;
  }
  ready() { return !this.closed && this.count === this.expected; }
  async frame(frame: number) {
    if (!this.ready() || !Number.isInteger(frame) || frame < 0 || frame >= this.count)
      throw Error("Palette frames incomplete or unavailable");
    return unpackLabels(this.db ? await this.store(frame) : this.memory.get(frame)!, this.size);
  }
  close() {
    this.closed = true; this.memory.clear(); this.bytes = 0;
    this.db?.close(); this.db = undefined;
    if (typeof indexedDB !== "undefined") discard(this.name, this.releaseOwnership);
    else this.releaseOwnership?.();
    this.releaseOwnership = undefined;
  }
}
