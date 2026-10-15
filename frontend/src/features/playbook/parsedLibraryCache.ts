/** Retain only the last successful JSON parse. Callers must still read the source
 * on every refresh; failures never fall back to previously cached documents. */
export function createParsedLibraryCache<T>(validate: (value: unknown) => T) {
  let cached: { content: string; value: T } | undefined;
  return (content: string): T => {
    if (cached?.content === content) return cached.value;
    const value = validate(JSON.parse(content));
    // Freeze once, on a cache miss. Public readers get mutable, independent
    // copies through sharedLibraryRead; internal persistence only reads these.
    const pending: unknown[] = [value];
    while (pending.length) {
      const item = pending.pop();
      if (item && typeof item === "object" && !Object.isFrozen(item)) {
        for (const child of Object.values(item)) pending.push(child);
        Object.freeze(item);
      }
    }
    cached = { content, value };
    return value;
  };
}
