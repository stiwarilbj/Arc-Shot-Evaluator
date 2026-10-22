export const PERSISTENCE_TIMEOUT_MS = 15_000;
export const PERSISTENCE_CHECK_TIMEOUT_MS = 5_000;

export class PersistenceDeadlineError extends Error {
  constructor() { super("The persistence request timed out. Your work is still in memory; retry when the server is available"); }
}

/** Includes body consumption; late noncooperative transports cannot settle the caller. */
export async function withPersistenceDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = PERSISTENCE_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new PersistenceDeadlineError()); controller.abort(); }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]); }
  finally { clearTimeout(timer); }
}
