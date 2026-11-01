/** Job-local, lossless masks only. Never persisted, shared, or published. */
export const EXPORT_CHECKPOINT_BYTES = 96 * 1024 * 1024;
export const EXPORT_CHECKPOINT_TTL = 10 * 60 * 1000;
const VERSION = 1;
type Mask = { raw: Uint8Array } | { runs: Uint32Array };

export class ExportCheckpoint {
  private version = VERSION;
  private masks: Mask[] = [];
  private bytes = 0;
  private completed: number | undefined;
  private available = true;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly start: number;
  readonly fps: number;
  private limit: number;
  constructor(
    width: number,
    height: number,
    count: number,
    start: number,
    fps = 30,
    limit = EXPORT_CHECKPOINT_BYTES,
  ) {
    this.width = width;
    this.height = height;
    this.count = count;
    this.start = start;
    this.fps = fps;
    this.limit = limit;
    if (
      !Number.isInteger(width) ||
      width < 2 ||
      width > 1280 ||
      !Number.isInteger(height) ||
      height < 2 ||
      height > 720 ||
      !Number.isInteger(count) ||
      count < 2 ||
      count > 450 ||
      !Number.isFinite(start) ||
      start < 0 ||
      fps !== 30
    )
      throw Error("Invalid export checkpoint timeline");
  }
  add(frame: number, owners: Uint8Array) {
    if (!this.available) return;
    if (
      this.completed !== undefined ||
      frame !== this.masks.length ||
      owners.length !== this.width * this.height
    )
      throw Error("Invalid export checkpoint frame");
    let runs = 1;
    for (let i = 1; i < owners.length; i++)
      if (owners[i] !== owners[i - 1]) runs++;
    const size = Math.min(owners.length, runs * 4);
    if (this.bytes + size > this.limit) {
      // Optional optimization: oversized jobs keep their normal streaming export.
      this.clear();
      return;
    }
    let mask: Mask;
    if (runs * 4 >= owners.length) mask = { raw: owners.slice() };
    else {
      const values = new Uint32Array(runs);
      let length = 1,
        run = 0;
      for (let i = 1; i <= owners.length; i++) {
        if (i < owners.length && owners[i] === owners[i - 1]) length++;
        else {
          values[run++] = length * 256 + owners[i - 1];
          length = 1;
        }
      }
      mask = { runs: values };
    }
    this.masks.push(mask);
    this.bytes += size;
  }
  seal(now = performance.now()) {
    if (this.available && this.masks.length === this.count) {
      this.completed = now;
      if (this.expiry !== undefined) clearTimeout(this.expiry);
      this.expiry = setTimeout(() => this.clear(), EXPORT_CHECKPOINT_TTL);
    } else this.clear();
  }
  ready(now = performance.now()) {
    return (
      this.available &&
      this.version === VERSION &&
      this.completed !== undefined &&
      now >= this.completed &&
      now - this.completed <= EXPORT_CHECKPOINT_TTL &&
      this.masks.length === this.count &&
      this.bytes <= this.limit
    );
  }
  frame(index: number, now = performance.now()): Uint8Array {
    if (
      !this.ready(now) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.count
    )
      throw Error(
        "Export checkpoint expired or incompatible · Process the clip again",
      );
    const mask = this.masks[index],
      pixels = this.width * this.height;
    if ("raw" in mask) {
      if (mask.raw.length !== pixels)
        throw Error("Invalid export checkpoint mask");
      return mask.raw.slice();
    }
    const result = new Uint8Array(pixels);
    let offset = 0;
    for (const run of mask.runs) {
      const length = Math.floor(run / 256);
      if (!length || offset + length > pixels)
        throw Error("Invalid export checkpoint run");
      result.fill(run & 255, offset, offset + length);
      offset += length;
    }
    if (offset !== pixels) throw Error("Incomplete export checkpoint mask");
    return result;
  }
  clear() {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.available = false;
    this.masks = [];
    this.bytes = 0;
    this.completed = undefined;
  }
}

/** Retry only the export closure; callers have already finished tracking. */
export async function retryExport<T>(
  first: () => Promise<T>,
  retry: () => Promise<T>,
  valid: () => boolean,
): Promise<T> {
  try {
    return await first();
  } catch (error) {
    if (!valid()) throw error;
    return retry();
  }
}
