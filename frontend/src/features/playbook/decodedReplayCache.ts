import type { CounterLabFrame } from "./counterLabTypes.ts";

type ReplaySelection = { id: string; key: string; repairId: string };
type DecodedReplay = { original: CounterLabFrame[]; repaired: CounterLabFrame[] | null };

// Account conservatively for decoded objects, slots and strings, including
// shared metadata only once within a comparison. Stop at the cache budget.
function replayBytes(value: unknown, limit: number, seen = new Set<object>()): number {
  if (typeof value === "string") return 32 + value.length * 2;
  if (value == null || typeof value !== "object") return 16;
  if (seen.has(value)) return 0;
  seen.add(value);
  let bytes = 128;
  for (const key of Object.keys(value)) {
    bytes += 32 + key.length * 2 + replayBytes((value as Record<string, unknown>)[key], limit - bytes, seen);
    if (bytes > limit) break;
  }
  return bytes;
}

/** Component-owned LRU of decoded, immutable traces for the current report. */
export function createDecodedReplayCache(maxBytes = 8 * 1024 * 1024, maxEntries = 4) {
  let analysisId: string | null = null, bytes = 0;
  const entries = new Map<string, { replay: DecodedReplay; bytes: number }>();
  const keyOf = (selection: ReplaySelection) => JSON.stringify([selection.id, selection.key, selection.repairId]);
  return {
    reset(id: string | null) {
      if (id === analysisId) return;
      analysisId = id;
      entries.clear(); bytes = 0;
    },
    get(selection: ReplaySelection): DecodedReplay | undefined {
      if (selection.id !== analysisId) return;
      const key = keyOf(selection), entry = entries.get(key);
      if (!entry) return;
      entries.delete(key); entries.set(key, entry);
      return entry.replay;
    },
    set(selection: ReplaySelection, replay: DecodedReplay) {
      if (selection.id !== analysisId || maxEntries <= 0 || (selection.repairId !== "original" && !replay.repaired)) return;
      const key = keyOf(selection);
      const size = 128 + key.length * 2 + replayBytes(replay, maxBytes - 128 - key.length * 2);
      if (size > maxBytes) return;
      // unpackReplay freezes its entire decoded graph; seal the returned root
      // arrays too. Playback creates interpolated copies, never mutates traces.
      Object.freeze(replay.original);
      if (replay.repaired) Object.freeze(replay.repaired);
      const retained = Object.freeze({ original: replay.original, repaired: replay.repaired });
      const previous = entries.get(key);
      if (previous) { bytes -= previous.bytes; entries.delete(key); }
      while (entries.size >= maxEntries || bytes + size > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        bytes -= entries.get(oldest)!.bytes;
        entries.delete(oldest);
      }
      entries.set(key, { replay: retained, bytes: size }); bytes += size;
    },
  };
}
