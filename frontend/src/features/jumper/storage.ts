import { IS_GITHUB_PAGES } from "../../runtime";
import {
  attempt,
  clip,
  type Attempt,
  type Clip,
  type PersonalClip,
  type Variant,
} from "./domain";
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("arc-jumper-v1", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("clips", { keyPath: "id" });
      database.createObjectStore("attempts", { keyPath: "id" });
      database.createObjectStore("state");
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error ?? Error("Browser storage is unavailable"));
    };
    request.onblocked = () => {
      database = undefined;
      reject(Error("Close other ARC tabs to upgrade clip storage"));
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
  }));
}
async function transaction<T>(
  store: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(store, mode);
    const result = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(result.result);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? Error("Storage operation failed"));
  });
}
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/jumper-lab${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    let message = `Clip storage returned ${response.status}`;
    try {
      message = (await response.json()).detail ?? message;
    } catch {}
    throw Error(message);
  }
  return response;
}
export async function listClips(): Promise<Clip[]> {
  const value: unknown = IS_GITHUB_PAGES
    ? await transaction("clips", "readonly", (store) => store.getAll())
    : await (await api("/media")).json();
  if (!Array.isArray(value) || !value.every(clip))
    throw Error("Saved clip metadata could not be read");
  return value
    .map(
      ({
        version,
        id,
        player,
        duration,
        createdAt,
        mime,
        quiz,
        presentation,
      }) => ({
        version,
        id,
        player,
        duration,
        createdAt,
        mime,
        quiz,
        ...(presentation ? { presentation } : {}),
      }),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
}
export async function saveClip(value: PersonalClip): Promise<Clip> {
  if (
    !clip(value) ||
    !value.highlight.size ||
    (value.quiz && (!value.quizVideo?.size || !value.reveal?.size))
  )
    throw Error("Complete videos are required before saving");
  if (IS_GITHUB_PAGES) {
    await mutateClips((store) => store.put(value));
    return value;
  }
  const data = new FormData();
  const { highlight, quizVideo, reveal, ...metadata } = value;
  data.set("metadata", JSON.stringify(metadata));
  data.set("highlight", highlight);
  if (quizVideo) data.set("quiz", quizVideo);
  if (reveal) data.set("reveal", reveal);
  const saved: unknown = await (
    await api("/media", { method: "POST", body: data })
  ).json();
  if (
    !clip(saved) ||
    saved.id !== value.id ||
    saved.presentation !== value.presentation ||
    saved.quiz !== value.quiz
  )
    throw Error("The saved clip could not be verified");
  return saved;
}
export async function videoBlob(id: string, kind: Variant): Promise<Blob> {
  if (!IS_GITHUB_PAGES)
    return (await api(`/media/${encodeURIComponent(id)}/${kind}`)).blob();
  const value = (await transaction("clips", "readonly", (store) =>
    store.get(id),
  )) as PersonalClip | undefined;
  if (!clip(value)) throw Error("Clip is unavailable");
  const blob = kind === "quiz" ? value.quizVideo : value[kind];
  if (!(blob instanceof Blob) || !blob.size)
    throw Error("Video is unavailable");
  return blob;
}
export async function deleteClip(id: string) {
  if (IS_GITHUB_PAGES) await mutateClips((store) => store.delete(id));
  else await api(`/media/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function readAttempts(): Promise<Attempt[]> {
  const values = await transaction("attempts", "readonly", (store) =>
    store.getAll(),
  );
  if (!Array.isArray(values) || !values.every(attempt))
    throw Error("Quiz history is damaged");
  return values;
}
export async function saveAttempt(value: Attempt) {
  if (!attempt(value)) throw Error("Invalid quiz answer");
  const database = await db();
  return await new Promise<Attempt>((resolve, reject) => {
    const tx = database.transaction("attempts", "readwrite");
    const store = tx.objectStore("attempts");
    let recorded = value;
    const existing = store.get(value.id);
    existing.onsuccess = () => {
      if (existing.result) {
        if (!attempt(existing.result)) {
          tx.abort();
          return;
        }
        recorded = existing.result;
      } else store.add(value);
    };
    tx.oncomplete = () => resolve(recorded);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? Error("Answer could not be recorded"));
  });
}
export async function getState<T>(key: string): Promise<T | undefined> {
  return transaction("state", "readonly", (store) => store.get(key));
}
export async function putState(key: string, value: unknown) {
  await transaction("state", "readwrite", (store) => store.put(value, key));
}

export interface BrowserLibrarySnapshot {
  clips: PersonalClip[];
  attempts: Attempt[];
  revision: number;
}
function revision(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw Error("Clip storage revision is damaged");
  return value as number;
}
async function mutateClips(work: (store: IDBObjectStore) => void) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(["clips", "state"], "readwrite");
    const read = tx.objectStore("state").get("libraryRevision");
    read.onsuccess = () => {
      try {
        work(tx.objectStore("clips"));
        tx.objectStore("state").put(
          revision(read.result) + 1,
          "libraryRevision",
        );
      } catch {
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? Error("Clip storage update failed"));
  });
}
export async function browserLibrarySnapshot(
  withHistory: boolean,
): Promise<BrowserLibrarySnapshot> {
  const database = await db();
  const value = await new Promise<BrowserLibrarySnapshot>((resolve, reject) => {
    const tx = database.transaction(["clips", "attempts", "state"], "readonly");
    const clips = tx.objectStore("clips").getAll(),
      rev = tx.objectStore("state").get("libraryRevision");
    const history = withHistory ? tx.objectStore("attempts").getAll() : null;
    tx.oncomplete = () => {
      try {
        resolve({
          clips: clips.result,
          attempts: history?.result ?? [],
          revision: revision(rev.result),
        });
      } catch (error) {
        reject(error);
      }
    };
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? Error("Could not read library backup"));
  });
  if (!value.clips.every(clip) || !value.attempts.every(attempt))
    throw Error("Saved library is damaged");
  return value;
}
export async function commitBrowserRestore(
  clips: PersonalClip[],
  history: Attempt[],
  expectedRevision: number,
) {
  if (!clips.every(clip) || !history.every(attempt))
    throw Error("Invalid restored library");
  const database = await db();
  return new Promise<{
    added: number;
    historyAdded: number;
    historySkipped: number;
  }>((resolve, reject) => {
    const tx = database.transaction(
      ["clips", "attempts", "state"],
      "readwrite",
    );
    let error: unknown,
      historyAdded = 0,
      historySkipped = 0;
    const read = tx.objectStore("state").get("libraryRevision");
    read.onsuccess = () => {
      try {
        if (revision(read.result) !== expectedRevision)
          throw Error(
            "The library changed during restore. Retry the same backup; no clips were replaced.",
          );
        for (const value of clips) tx.objectStore("clips").add(value);
        for (const value of history) {
          const store = tx.objectStore("attempts"),
            existing = store.get(value.id);
          existing.onsuccess = () => {
            try {
              if (existing.result !== undefined) historySkipped++;
              else {
                store.add(value);
                historyAdded++;
              }
            } catch (caught) {
              error = caught;
              tx.abort();
            }
          };
        }
        if (clips.length)
          tx.objectStore("state").put(expectedRevision + 1, "libraryRevision");
      } catch (caught) {
        error = caught;
        tx.abort();
      }
    };
    tx.oncomplete = () =>
      resolve({ added: clips.length, historyAdded, historySkipped });
    tx.onerror = tx.onabort = () =>
      reject(
        error ??
          tx.error ??
          Error("Restore could not be saved; no changes were committed"),
      );
  });
}
export async function exportLocalLibrary(): Promise<Blob> {
  return (await api("/backup", { signal: AbortSignal.timeout(180000) })).blob();
}
export async function restoreLocalLibrary(
  archive: Blob,
): Promise<{ added: number; skipped: number }> {
  const data = new FormData();
  data.set("file", archive, "arc-jumper-backup.zip");
  const result: unknown = await (
    await api("/backup", {
      method: "POST",
      body: data,
      signal: AbortSignal.timeout(180000),
    })
  ).json();
  const v = result as { added: number; skipped: number };
  if (
    !v ||
    !Number.isInteger(v.added) ||
    v.added < 0 ||
    !Number.isInteger(v.skipped) ||
    v.skipped < 0
  )
    throw Error(
      "Restore response could not be verified. Retry the same backup safely.",
    );
  return v;
}

export async function restoreAttemptHistory(history: Attempt[]) {
  if (!history.every(attempt)) throw Error("Invalid restored history");
  const database = await db();
  return new Promise<{ historyAdded: number; historySkipped: number }>(
    (resolve, reject) => {
      const tx = database.transaction("attempts", "readwrite"),
        store = tx.objectStore("attempts");
      let historyAdded = 0,
        historySkipped = 0,
        error: unknown;
      for (const value of history) {
        const read = store.get(value.id);
        read.onsuccess = () => {
          try {
            if (read.result !== undefined) historySkipped++;
            else {
              store.add(value);
              historyAdded++;
            }
          } catch (caught) {
            error = caught;
            tx.abort();
          }
        };
      }
      tx.oncomplete = () => resolve({ historyAdded, historySkipped });
      tx.onerror = tx.onabort = () =>
        reject(
          error ?? tx.error ?? Error("Guessing history could not be restored"),
        );
    },
  );
}

export async function localLibraryIndex(): Promise<unknown> {
  return (
    await api("/backup/index", { signal: AbortSignal.timeout(180000) })
  ).json();
}
