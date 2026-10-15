import type { CounterLabResult } from "./counterLabTypes.ts";
import { packReplay, unpackReplay, type ReplayArchive } from "./counterLabReplayArchive.ts";

// Bump when simulation, diagnostic, or replay semantics change. This cache is
// memory-only, so a new worker/build also starts with an empty cache.
const ENGINE_VERSION = 1;

/** Canonical typed values avoid collisions for undefined, null, NaN and -0. */
export function counterLabTrialKey(...inputs: unknown[]): string | undefined {
  const ancestors = new Set<object>();
  function encode(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
    if (value === undefined) return ["undefined"];
    if (typeof value !== "object" || ancestors.has(value)) throw new Error("Unsupported cache input");
    ancestors.add(value);
    let encoded: unknown;
    if (Array.isArray(value)) encoded = ["array", Array.from(value, encode)];
    else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      encoded = ["object", Object.keys(value).sort().map((key) => [key, encode((value as Record<string, unknown>)[key])])];
    } else throw new Error("Unsupported cache input");
    ancestors.delete(value);
    return encoded;
  }
  try {
    const key = JSON.stringify(encode([ENGINE_VERSION, ...inputs]));
    return key.length <= 65_536 ? key : undefined;
  } catch {
    // Unusual legacy inputs can still run, but cannot be reused safely.
    return undefined;
  }
}

// Conservatively account for strings, property/array slots and object overhead.
// Stop counting oversized results early; never serialize or retain them.
function retainedBytes(value: unknown, limit: number, seen = new Set<object>()): number {
  if (typeof value === "string") return 32 + value.length * 2;
  if (value == null || typeof value !== "object") return 16;
  if (value instanceof ArrayBuffer) return 128 + value.byteLength;
  if (seen.has(value)) return 0;
  seen.add(value);
  let bytes = 128;
  for (const key of Object.keys(value)) {
    bytes += 32 + key.length * 2 + retainedBytes((value as Record<string, unknown>)[key], limit - bytes, seen);
    if (bytes > limit) break;
  }
  return bytes;
}

// A default analysis has up to nine variants × twelve matchups. Avoid evicting
// that entire working set solely because of the entry count; the byte cap wins.
export function createCompletedTrialCache(maxBytes = 16 * 1024 * 1024, maxEntries = 128) {
  const entries = new Map<string, { summary: Omit<CounterLabResult, "trace">; replay: ReplayArchive; bytes: number }>();
  let bytes = 0;
  function read(key: string | undefined): CounterLabResult | undefined {
    const cached = key === undefined ? undefined : entries.get(key);
    if (cached && key !== undefined) {
      entries.delete(key); entries.set(key, cached);
      return { ...structuredClone(cached.summary), trace: structuredClone(unpackReplay(cached.replay)) };
    }
  }
  function store(key: string | undefined, result: CounterLabResult): CounterLabResult {
    if (key === undefined || maxEntries <= 0) return result;
    const { trace, ...summary } = result;
    const replay = packReplay(trace);
    const size = key.length * 2 + retainedBytes({ summary, replay }, maxBytes - key.length * 2);
    if (size > maxBytes) return result;
    const copy = structuredClone(summary);
    const previous = entries.get(key);
    if (previous) { bytes -= previous.bytes; entries.delete(key); }
    while (entries.size >= maxEntries || bytes + size > maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      bytes -= entries.get(oldest)!.bytes;
      entries.delete(oldest);
    }
    entries.set(key, { summary: copy, replay, bytes: size }); bytes += size;
    return result;
  }
  const reuse = (key: string | undefined, compute: () => CounterLabResult): CounterLabResult => read(key) ?? store(key, compute());
  // Store only resolved, successful computations; never retain an in-flight or
  // rejected trial. Concurrent requests keep independent cancellation ownership.
  reuse.async = async (key: string | undefined, compute: () => Promise<CounterLabResult>): Promise<CounterLabResult> => read(key) ?? store(key, await compute());
  return reuse;
}
