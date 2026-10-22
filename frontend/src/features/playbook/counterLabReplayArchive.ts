import type { CounterLabFrame } from "./counterLabTypes.ts";

/** Lossless value tables: repeated metadata/geometry is stored once. All numeric
 * values, including clocks and coordinates, remain IEEE 754 doubles. */
export type ReplayArchive = {
  version: 1; strings: string[];
  roots: ArrayBuffer; offsets: ArrayBuffer; tokens: ArrayBuffer; numbers: ArrayBuffer;
};

export function packReplay(frames: CounterLabFrame[]): ReplayArchive {
  const strings: string[] = [], numbers: number[] = [], tokens: number[] = [], offsets: number[] = [];
  const stringIds = new Map<string, number>(), nodes = new Map<string, number>(), objects = new WeakMap<object, number>();
  const visiting = new WeakSet<object>();
  function stringId(value: string) {
    let id = stringIds.get(value);
    if (id === undefined) { id = strings.length; strings.push(value); stringIds.set(value, id); }
    return id;
  }
  function encode(value: unknown): number {
    if (value && typeof value === "object") {
      const previous = objects.get(value); if (previous !== undefined) return previous;
      if (visiting.has(value)) throw new Error("Replay contains cyclic data");
      visiting.add(value);
    }
    let code: number[], signature: string;
    if (value === null) { code = [0]; signature = "null"; }
    else if (value === undefined) { code = [1]; signature = "undefined"; }
    else if (typeof value === "boolean") { code = [value ? 3 : 2]; signature = String(value); }
    else if (typeof value === "number") {
      signature = `n:${Object.is(value, -0) ? "-0" : String(value)}`;
      const previous = nodes.get(signature); if (previous !== undefined) return previous;
      code = [4, numbers.length]; numbers.push(value);
    } else if (typeof value === "string") { code = [5, stringId(value)]; signature = `s:${code[1]}`; }
    else if (Array.isArray(value)) {
      code = [6, value.length, ...Array.from(value, encode)]; signature = code.join(",");
    } else if (typeof value === "object") {
      const keys = Object.keys(value);
      code = [7, keys.length];
      for (const key of keys) code.push(stringId(key), encode((value as Record<string, unknown>)[key]));
      signature = code.join(",");
    } else throw new Error("Replay contains unsupported data");
    let id = nodes.get(signature);
    if (id === undefined) {
      id = offsets.length; offsets.push(tokens.length);
      for (const token of code) tokens.push(token);
      nodes.set(signature, id);
    }
    if (value && typeof value === "object") { objects.set(value, id); visiting.delete(value); }
    return id;
  }
  const roots = frames.map(encode);
  return { version: 1, strings, roots: new Uint32Array(roots).buffer, offsets: new Uint32Array(offsets).buffer,
    tokens: new Uint32Array(tokens).buffer, numbers: new Float64Array(numbers).buffer };
}

export function unpackReplay(archive: ReplayArchive): CounterLabFrame[] {
  if (archive.version !== 1) throw new Error("Unsupported replay format");
  const offsets = new Uint32Array(archive.offsets), tokens = new Uint32Array(archive.tokens), numbers = new Float64Array(archive.numbers);
  const nodes: unknown[] = [];
  const invalid = () => { throw new Error("Replay data is incomplete. Retry loading the replay"); };
  for (let id = 0; id < offsets.length; id++) {
    let cursor = offsets[id]; const end = offsets[id + 1] ?? tokens.length;
    const read = () => cursor < end ? tokens[cursor++] : invalid();
    const reference = () => { const ref = read(); return ref < id ? nodes[ref] : invalid(); };
    const string = () => { const ref = read(); return ref < archive.strings.length ? archive.strings[ref] : invalid(); };
    let value: unknown;
    switch (read()) {
      case 0: value = null; break;
      case 1: value = undefined; break;
      case 2: value = false; break;
      case 3: value = true; break;
      case 4: { const ref = read(); value = ref < numbers.length ? numbers[ref] : invalid(); break; }
      case 5: value = string(); break;
      case 6: { const count = read(); const array = []; for (let i = 0; i < count; i++) array.push(reference()); value = array; break; }
      case 7: {
        const count = read(); const entries: Array<[string, unknown]> = [];
        for (let i = 0; i < count; i++) entries.push([string(), reference()]);
        value = Object.fromEntries(entries); break;
      }
      default: invalid();
    }
    if (cursor !== end) invalid();
    // Shared values cannot be changed through another sample's reference.
    if (value && typeof value === "object") Object.freeze(value);
    nodes.push(value);
  }
  return Array.from(new Uint32Array(archive.roots), (id) => {
    if (id >= nodes.length || !nodes[id] || typeof nodes[id] !== "object") return invalid();
    return nodes[id] as CounterLabFrame;
  });
}

/** Transfer only dedicated outgoing copies; the worker's archive stays reusable. */
export function replayResponse(archive: ReplayArchive) {
  const copy: ReplayArchive = { ...archive, roots: archive.roots.slice(0), offsets: archive.offsets.slice(0), tokens: archive.tokens.slice(0), numbers: archive.numbers.slice(0) };
  return { archive: copy, transfer: [copy.roots, copy.offsets, copy.tokens, copy.numbers] };
}
