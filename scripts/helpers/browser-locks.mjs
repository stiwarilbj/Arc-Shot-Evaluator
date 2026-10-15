// In-memory Web Locks stand-in for Node API tests; browser tests exercise native locks.
export function installBrowserLocks() {
  const tails = new Map();
  const locks = { request(name, _options, callback) {
    const result = (tails.get(name) ?? Promise.resolve()).then(callback);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(name, settled);
    void settled.then(() => { if (tails.get(name) === settled) tails.delete(name); });
    return result;
  } };
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: locks });
  return locks;
}
