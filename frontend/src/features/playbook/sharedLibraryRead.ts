/** Share only in-flight reads. Writes form a barrier for stale read responses. */
export function createSharedLibraryRead<T>(load: () => Promise<T> | T) {
  type Pending = { revision: number; promise: Promise<T> };
  let revision = 0, writes = 0;
  let pending: Pending | undefined, writeDone: Promise<void> | undefined, finishWrites: (() => void) | undefined;
  function invalidate() { revision++; pending = undefined; }
  async function current(): Promise<T> {
    if (writeDone) { await writeDone; return current(); }
    if (!pending) {
      const entry: Pending = { revision, promise: Promise.resolve().then(load) };
      pending = entry;
      entry.promise = entry.promise.finally(() => { if (pending === entry) pending = undefined; });
    }
    const entry = pending;
    try {
      const value = await entry.promise;
      return entry.revision === revision && !writeDone ? value : current();
    } catch (error) {
      if (entry.revision !== revision || writeDone) return current();
      throw error;
    }
  }
  return {
    read: async () => structuredClone(await current()),
    invalidate,
    async mutate<R>(write: () => Promise<R> | R): Promise<R> {
      if (writes++ === 0) writeDone = new Promise<void>((resolve) => { finishWrites = resolve; });
      invalidate();
      try { return await write(); }
      finally {
        invalidate();
        if (--writes === 0) { writeDone = undefined; finishWrites?.(); finishWrites = undefined; }
      }
    },
  };
}
