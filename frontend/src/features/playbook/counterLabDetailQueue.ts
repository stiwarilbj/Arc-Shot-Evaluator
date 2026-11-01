import type { CounterLabRequest } from "./counterLabTypes.ts";

type DetailRequest = Extract<CounterLabRequest, { type: "details" }>;

/** Keep only the latest selection before preparing dedicated transfer buffers. */
export function createCounterLabDetailQueue(respond: (request: DetailRequest) => void) {
  let pending: DetailRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    request(request: DetailRequest) {
      pending = request;
      // Yield to queued worker messages, rather than a microtask that would run
      // before the next selection message can supersede this one.
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        const latest = pending;
        pending = null;
        timer = undefined;
        if (latest) respond(latest);
      }, 0);
    },
    release(id: string) {
      if (pending?.id !== id) return;
      pending = null;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
