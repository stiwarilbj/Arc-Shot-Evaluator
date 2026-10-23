import { IS_GITHUB_PAGES } from "../../runtime.ts";
import { validatePocketAction, type PocketActionDocument } from "./pocketActions.ts";

const DB_NAME = "arc-pocket-actions-v1";
const STORE = "pockets";
const CHANGE_EVENT = "arc-pocket-actions-changed";
let database: Promise<IDBDatabase> | undefined;
let channel: BroadcastChannel | undefined;

function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onerror = () => { database = undefined; reject(request.error ?? Error("Pocket storage is unavailable")); };
    request.onblocked = () => { database = undefined; reject(Error("Close other ARCade Hoops tabs to open pocket storage")); };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
  }));
}

function requestValue<T>(store: string, mode: IDBTransactionMode, operation: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result!);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? Error("Pocket storage operation failed"));
  }));
}

async function api(path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(`/api/pocket-actions${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(15000), cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw Error("Pocket storage took too long to respond · Retry when the local app is available");
    throw error;
  }
  if (!response.ok) {
    let detail = `Pocket storage returned ${response.status}`;
    try { detail = ((await response.json()) as { detail?: string }).detail ?? detail; } catch { /* Keep status detail */ }
    throw Error(detail);
  }
  return response;
}

function validateList(value: unknown): PocketActionDocument[] {
  if (!Array.isArray(value)) throw Error("Pocket library response is invalid");
  const ids = new Set<string>();
  for (const item of value) {
    validatePocketAction(item);
    if (ids.has(item.id)) throw Error("Pocket library contains duplicate identities");
    ids.add(item.id);
  }
  return value as PocketActionDocument[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function announceChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
  if (typeof BroadcastChannel !== "undefined") {
    channel ??= new BroadcastChannel(DB_NAME);
    channel.postMessage("changed");
  }
}

export function subscribePocketActions(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, listener);
  channel ??= typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(DB_NAME) : undefined;
  if (channel) channel.addEventListener("message", listener);
  return () => { window.removeEventListener(CHANGE_EVENT, listener); channel?.removeEventListener("message", listener); };
}

export async function listPocketActions(): Promise<PocketActionDocument[]> {
  const value = IS_GITHUB_PAGES
    ? await requestValue<unknown[]>(STORE, "readonly", (store) => store.getAll())
    : await (await api("")).json();
  return validateList(value).filter((item) => !item.starter).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function createPocketAction(value: PocketActionDocument): Promise<PocketActionDocument> {
  validatePocketAction(value);
  const candidate = structuredClone(value);
  if (IS_GITHUB_PAGES) {
    const database = await db();
    const saved = await new Promise<PocketActionDocument>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const read = store.get(candidate.id);
      let result: PocketActionDocument | undefined;
      let failure: Error | undefined;
      read.onsuccess = () => {
        const existing = read.result as PocketActionDocument | undefined;
        if (existing) {
          const comparable = (document: PocketActionDocument) => canonicalJson(Object.fromEntries(Object.entries(document).filter(([key]) => !["revision", "createdAt", "updatedAt"].includes(key))));
          if (comparable(existing) !== comparable(candidate)) {
            failure = Error("This pocket identity already contains different content");
            transaction.abort();
            return;
          }
          result = existing;
          return;
        }
        result = candidate;
        store.add(candidate);
      };
      transaction.oncomplete = () => resolve(result!);
      transaction.onerror = transaction.onabort = () => reject(failure ?? transaction.error ?? Error("Pocket save failed"));
    });
    validatePocketAction(saved);
    announceChange();
    return saved;
  } else {
    const saved: unknown = await (await api("", { method: "POST", headers: { "Content-Type": "application/json", "X-ARC-Create-ID": candidate.id }, body: JSON.stringify(candidate) })).json();
    validatePocketAction(saved);
    if (saved.id !== candidate.id) throw Error("Pocket save returned a different identity");
    announceChange();
    return saved;
  }
  announceChange();
  return candidate;
}

export async function updatePocketAction(value: PocketActionDocument, expectedRevision: string): Promise<PocketActionDocument> {
  validatePocketAction(value);
  const candidate = structuredClone(value);
  if (IS_GITHUB_PAGES) {
    const database = await db();
    const result = await new Promise<PocketActionDocument>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const read = store.get(candidate.id);
      let saved: PocketActionDocument | undefined;
      read.onsuccess = () => {
        const existing = read.result as PocketActionDocument | undefined;
        if (!existing || existing.revision !== expectedRevision) { transaction.abort(); reject(Error("This pocket changed in another tab · Reload it before saving")); return; }
        saved = { ...candidate, createdAt: existing.createdAt, updatedAt: new Date().toISOString(), revision: crypto.randomUUID().replaceAll("-", "") };
        store.put(saved);
      };
      transaction.oncomplete = () => resolve(saved!);
      transaction.onerror = transaction.onabort = () => { if (saved === undefined) reject(transaction.error ?? Error("Pocket update failed")); };
    });
    announceChange();
    return result;
  }
  const saved: unknown = await (await api(`/${encodeURIComponent(candidate.id)}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": `"${expectedRevision}"` }, body: JSON.stringify(candidate) })).json();
  validatePocketAction(saved);
  if (saved.id !== candidate.id) throw Error("Pocket update returned a different identity");
  announceChange();
  return saved;
}

export async function deletePocketAction(id: string): Promise<void> {
  if (!/^pocket-[a-z0-9-]{8,72}$/.test(id)) throw Error("Invalid pocket identity");
  if (IS_GITHUB_PAGES) {
    await requestValue(STORE, "readwrite", (store) => store.delete(id));
  } else {
    const value: unknown = await (await api(`/${encodeURIComponent(id)}`, { method: "DELETE" })).json();
    if (!value || typeof value !== "object" || (value as { deleted?: unknown }).deleted !== true || (value as { id?: unknown }).id !== id) throw Error("Pocket deletion could not be confirmed · Refresh the library before retrying");
  }
  announceChange();
}
