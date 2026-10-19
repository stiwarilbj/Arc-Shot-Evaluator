/** Live Web Lock ownership survives paused timers and ends when its worker/tab exits.
 * Never infer abandonment from a missed heartbeat. Without Web Locks, skip sweeping.
 */
const ownerKey = (name: string) => `arc-jumper-private-media:${name}`;

export function retainTemporaryMedia(name: string): Promise<() => void> {
  if (!globalThis.navigator?.locks)
    return Promise.reject(Error("Temporary media ownership unavailable"));
  return new Promise((resolve, reject) => {
    void navigator.locks.request(ownerKey(name), async () => {
      await new Promise<void>((done) => resolve(done));
    }).catch(reject);
  });
}

export function removeTemporaryDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      // Keep ownership while a legacy connection blocks deletion. Releasing it
      // here would allow an old queued delete to run after a new owner arrives.
    } catch (error) { reject(error); }
  });
}

export async function discardAbandonedMedia(name: string): Promise<boolean> {
  if (!globalThis.navigator?.locks) return false;
  return navigator.locks.request(ownerKey(name), { ifAvailable: true }, async (owner) => {
    if (!owner) return false;
    try { await removeTemporaryDatabase(name); return true; }
    catch { return false; }
  });
}
