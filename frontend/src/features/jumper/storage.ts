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
    .map(({ version, id, player, duration, createdAt, mime, quiz }) => ({
      version,
      id,
      player,
      duration,
      createdAt,
      mime,
      quiz,
    }))
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
    await transaction("clips", "readwrite", (store) => store.put(value));
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
  if (!clip(saved) || saved.id !== value.id)
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
  if (IS_GITHUB_PAGES)
    await transaction("clips", "readwrite", (store) => store.delete(id));
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
