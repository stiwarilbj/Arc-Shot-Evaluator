/** Retain the latest input, with at most one scheduled display update. */
export function createFrameBatch<T>(apply: (value: T) => void,
  requestFrame: (callback: () => void) => number,
  cancelFrame: (id: number) => void) {
  let frame: number | null = null;
  let pending: { value: T } | null = null;
  const flush = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    const next = pending;
    pending = null;
    if (next) apply(next.value);
  };
  return {
    queue(value: T) {
      pending = { value };
      if (frame === null) frame = requestFrame(flush);
    },
    flush(value?: T) {
      if (value !== undefined) pending = { value };
      flush();
    },
    cancel() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      pending = null;
    },
  };
}
