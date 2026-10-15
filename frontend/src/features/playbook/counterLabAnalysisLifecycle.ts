import type { CounterLabFrame } from "./counterLabTypes.ts";
import { packReplay, type ReplayArchive } from "./counterLabReplayArchive.ts";

type AnalysisOwner = {
  id: string;
  active: boolean;
  cancelled: boolean;
  archives: Map<string, ReplayArchive>;
};

/** Async callbacks retain an owner, never permission to recreate an ID's state. */
export function createCounterLabAnalysisLifecycle() {
  const owners = new Map<string, AnalysisOwner>();
  const owns = (owner: AnalysisOwner) => owners.get(owner.id) === owner;
  const canPublish = (owner: AnalysisOwner) => owns(owner) && owner.active && !owner.cancelled;
  function release(id: string) {
    const owner = owners.get(id);
    if (!owner) return;
    owners.delete(id);
    owner.active = false;
    owner.cancelled = true;
    owner.archives.clear();
  }
  return {
    start(id: string) {
      release(id);
      const owner: AnalysisOwner = { id, active: true, cancelled: false, archives: new Map() };
      owners.set(id, owner);
      return owner;
    },
    owns,
    canPublish,
    shouldCancel: (owner: AnalysisOwner) => !canPublish(owner),
    cancel(id: string) {
      const owner = owners.get(id);
      if (owner?.active) owner.cancelled = true;
    },
    finish(owner: AnalysisOwner) {
      if (!owns(owner)) return;
      owner.active = false;
      // Failed/cancelled requests without a report need no retained entry.
      if (!owner.archives.size) owners.delete(owner.id);
    },
    release,
    archive: (id: string, key: string) => owners.get(id)?.archives.get(key),
    store(owner: AnalysisOwner, traces: Map<string, CounterLabFrame[]>) {
      if (!canPublish(owner)) return false;
      for (const [key, trace] of traces) {
        if (!canPublish(owner)) return false;
        if (!owner.archives.has(key)) owner.archives.set(key, packReplay(trace));
      }
      return true;
    },
  };
}
