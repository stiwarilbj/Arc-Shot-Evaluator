/** Order mutations by saved identity, including response validation. A failure
 * rejects its caller but cannot poison later operations or retain an idle key. */
export function createPlayMutationQueue() {
  const tails = new Map<string, Promise<void>>();
  return function enqueue<T>(id: string, mutate: () => T | Promise<T>): Promise<T> {
    const result = (tails.get(id) ?? Promise.resolve()).then(mutate);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(id, settled);
    void settled.then(() => { if (tails.get(id) === settled) tails.delete(id); });
    return result;
  };
}
