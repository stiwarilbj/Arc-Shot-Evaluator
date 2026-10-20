import { compareSavedPlaybooks } from "./playbookOrder.ts";
import { newCreationId, CreationAttemptError } from "./creationAttempt.ts";
import { validateHostedLibrary, type HostedLibrary, type CreationReceipt } from "./hostedLibrary.ts";
import { withPersistenceDeadline, PersistenceDeadlineError, PERSISTENCE_CHECK_TIMEOUT_MS } from "./persistenceDeadline.ts";
import { playbookContentKey } from "./playbookDraftSession.ts";
import { createPlayMutationQueue } from "./playMutationQueue.ts";
import { normalizePlaybookPrecision } from "./documentPrecision.ts";
import { INVALID_PLAYBOOK_SAVE, validatePlaybookDocument, validateSavedPlaybook, validatePlaybookSaveResult, type PlaybookSaveIdentity } from "./documentValidation.ts";
import type { PlaybookDocument, PlaybookDraft } from "./types";
import { IS_GITHUB_PAGES } from "../../runtime";
import { createSharedLibraryRead } from "./sharedLibraryRead.ts";
import { createParsedLibraryCache } from "./parsedLibraryCache.ts";
import { IncompletePlaybookLibraryError, readLibraryIssues } from "./libraryReadStatus.ts";
export { IncompletePlaybookLibraryError } from "./libraryReadStatus.ts";

const LOCAL_STORAGE_KEY = "arc-playbooks-v1";
const SAVE_CONFLICT = "This play was changed by another tab or client. Your draft is still in memory. Save a copy or reopen the latest saved play before updating it.";
// All tabs on this origin must finish the entire transaction before another
// writer reads the library. Never substitute an unsafe localStorage spin lock.
function withLibraryWrite<T>(write: () => T): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return Promise.reject(new Error("Safe browser storage is unavailable. Use a current browser over HTTPS or localhost and retry; your play is still in memory."));
  }
  return withPersistenceDeadline((signal) => navigator.locks.request(`${LOCAL_STORAGE_KEY}:write`, { mode: "exclusive", signal }, () => {
    signal.throwIfAborted();
    return write();
  }));
}

class PersistenceResponseError extends Error { constructor(message: string, readonly status: number) { super(message); } }
class InvalidDeletionAcknowledgement extends Error {}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: "Request failed" })) as { detail?: string };
    throw new PersistenceResponseError(body.detail ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

async function parseSave(response: Response, identity: PlaybookSaveIdentity): Promise<PlaybookDocument> {
  if (!response.ok) return parse<never>(response);
  let saved: unknown;
  try { saved = await response.json(); }
  catch { throw new Error(INVALID_PLAYBOOK_SAVE); }
  validatePlaybookSaveResult(saved, identity);
  return saved;
}

const queuePlayMutation = createPlayMutationQueue();
const CHANGE_EVENT = "arc-playbooks-changed";
const parseLibrary = createParsedLibraryCache(validateLibrary);
const parseHostedLibrary = createParsedLibraryCache(validateHostedLibrary);
const libraryReads = createSharedLibraryRead(async () => {
  const plays = IS_GITHUB_PAGES ? readLocalPlaybooks() : await readRemotePlaybooks();
  return [...plays].sort(compareSavedPlaybooks);
});
async function readRemotePlaybooks(): Promise<PlaybookDocument[]> {
  return withPersistenceDeadline(async (signal) => {
    const response = await fetch("/api/playbooks", { signal, cache: "no-store" });
    if (!response.ok) await parse<never>(response);
    const plays = parseLibrary(await response.text());
    const issues = readLibraryIssues(response.headers);
    if (issues !== null) throw new IncompletePlaybookLibraryError(structuredClone([...plays].sort(compareSavedPlaybooks)), issues);
    return plays;
  });
}
const UNCERTAIN_SAVE = "The save response was interrupted and its outcome could not be confirmed. Your draft is still in memory. Retry when the server is available.";
const UNCERTAIN_DELETE = "The delete response was interrupted and its outcome could not be confirmed. Refresh the saved library before retrying.";

async function checkRemotePlay(id: string): Promise<PlaybookDocument | null> {
  return withPersistenceDeadline(async (signal) => {
    const response = await fetch(`/api/playbooks/${encodeURIComponent(id)}`, { signal, cache: "no-store" });
    if (response.status === 404) return null;
    return parseSave(response, { operation: "update", id });
  }, PERSISTENCE_CHECK_TIMEOUT_MS);
}

async function saveRemotePlay(playbook: PlaybookDraft, identity: PlaybookSaveIdentity, creationId?: string): Promise<PlaybookDocument> {
  // Identify this POST before sending it, so recovery never guesses which copy
  // was saved or repeats a write. The backend replays matching create receipts.
  const id = identity.operation === "create" ? creationId! : identity.id;
  try {
    return await withPersistenceDeadline(async (signal) => {
      const response = await fetch(identity.operation === "create" ? "/api/playbooks" : `/api/playbooks/${encodeURIComponent(id)}`, {
        method: identity.operation === "create" ? "POST" : "PUT", signal,
        headers: { "Content-Type": "application/json", ...(identity.operation === "create" ? { "X-ARC-Create-ID": id } : { "If-Match": `"${playbook.revision ?? "legacy"}"` }) },
        body: JSON.stringify(playbook),
      });
      const saved = await parseSave(response, identity);
      if (identity.operation === "create" && saved.id !== id) throw new Error(INVALID_PLAYBOOK_SAVE);
      return saved;
    });
  } catch (error) {
    if (!(error instanceof PersistenceDeadlineError || error instanceof TypeError)) throw error;
    try {
      const saved = await checkRemotePlay(id);
      if (saved && playbookContentKey(saved) === playbookContentKey({ ...playbook, version: 1, name: playbook.name.trim() })) return saved;
    } catch { /* Verification failure cannot prove the write failed. */ }
    throw new Error(UNCERTAIN_SAVE);
  }
}

async function deleteRemotePlay(id: string) {
  try {
    return await withPersistenceDeadline(async (signal) => {
      const response = await fetch(`/api/playbooks/${encodeURIComponent(id)}`, { method: "DELETE", signal });
      if (!response.ok) return parse<never>(response);
      let acknowledgement: unknown;
      try { acknowledgement = await response.json(); }
      catch { throw new InvalidDeletionAcknowledgement(); }
      if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
        || !("deleted" in acknowledgement) || acknowledgement.deleted !== true
        || !("id" in acknowledgement) || acknowledgement.id !== id) {
        throw new InvalidDeletionAcknowledgement();
      }
      return { deleted: true, id };
    });
  } catch (error) {
    if (!(error instanceof PersistenceDeadlineError || error instanceof TypeError || error instanceof InvalidDeletionAcknowledgement)) throw error;
    try { if (await checkRemotePlay(id) === null) return { deleted: true, id }; }
    catch { /* Preserve uncertainty when the read also fails or times out. */ }
    throw new Error(UNCERTAIN_DELETE);
  }
}

let subscriptions = 0;
const onStorage = (event: StorageEvent) => {
  if (event.key === LOCAL_STORAGE_KEY || event.key === null) announceChange();
};
export function subscribePlaybooks(listener: () => void) {
  if (subscriptions++ === 0) window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => { window.removeEventListener(CHANGE_EVENT, listener); if (--subscriptions === 0) window.removeEventListener("storage", onStorage); };
}
function announceChange() { libraryReads.invalidate(); window.dispatchEvent(new Event(CHANGE_EVENT)); }
function validateLibrary(value: unknown): PlaybookDocument[] {
  try {
    if (!Array.isArray(value)) throw new Error("Invalid library");
    value.forEach(validateSavedPlaybook);
  } catch { throw new Error("Saved plays could not be read. Your stored data has been preserved."); }
  return value as PlaybookDocument[];
}
function readLocalLibrary(): HostedLibrary {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return parseHostedLibrary(raw || "[]");
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Saved plays contain unreadable data. Your stored data has been preserved.");
    throw new Error(error instanceof Error && error.message.includes("preserved") ? error.message : "Browser storage is unavailable. Allow site storage and retry; your play is still in memory.");
  }
}
function readLocalPlaybooks(): PlaybookDocument[] { return readLocalLibrary().plays; }
function writeLocalPlaybooks(playbooks: PlaybookDocument[], creations = readLocalLibrary().creations) {
  try { window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ version: 1, plays: playbooks, creations })); }
  catch { throw new Error("This play could not be saved: browser storage is unavailable or full. Free some space and retry."); }
  announceChange();
}

function persistLocalPlaybook(playbook: PlaybookDraft, id: string, identity: PlaybookSaveIdentity, receipt?: { id: string; request: string }): PlaybookDocument {
  const now = new Date().toISOString();
  const saved: PlaybookDocument = {
    version: 1,
    revision: newCreationId().slice(5),
    id,
    name: playbook.name.trim() || "Untitled play",
    created_at: playbook.created_at ?? now,
    updated_at: now,
    defenders_visible: playbook.defenders_visible,
    players: structuredClone(playbook.players),
    defenders: structuredClone(playbook.defenders),
    ball: playbook.ball ? structuredClone(playbook.ball) : null,
    arrows: structuredClone(playbook.arrows),
  };
  validatePlaybookSaveResult(saved, identity);
  const current = readLocalPlaybooks().filter((item) => item.id !== id);
  const creations: CreationReceipt[] = receipt ? [...readLocalLibrary().creations, { ...receipt, result: saved }] : readLocalLibrary().creations;
  writeLocalPlaybooks([saved, ...current], creations);
  return saved;
}

export async function fetchPlaybooks() {
  try { return await libraryReads.read(); }
  catch (error) {
    if (error instanceof IncompletePlaybookLibraryError) {
      // Shared in-flight reads must not share mutable warning snapshots.
      throw new IncompletePlaybookLibraryError(structuredClone(error.availablePlays), structuredClone(error.issues));
    }
    throw error;
  }
}
export async function createPlaybook(playbook: PlaybookDraft, creationId = newCreationId()) {
  validatePlaybookDocument(playbook);
  if (!/^play-[a-f0-9]{32}$/.test(creationId) || creationId === playbook.id) throw new Error("Invalid creation identity");
  playbook = normalizePlaybookPrecision(playbook);
  const identity: PlaybookSaveIdentity = { operation: "create", sourceId: playbook.id };
  try {
    return await libraryReads.mutate(async () => {
      if (IS_GITHUB_PAGES) return withLibraryWrite(() => {
        const request = playbookContentKey({ ...playbook, version: 1, name: playbook.name.trim() });
        const library = readLocalLibrary();
        const receipt = library.creations.find(item => item.id === creationId);
        if (receipt) {
          if (receipt.request !== request) throw new PersistenceResponseError("This creation attempt belongs to a different drawing.", 409);
          return structuredClone(receipt.result);
        }
        if (library.plays.some(item => item.id === creationId)) throw new PersistenceResponseError("This creation identity is already in use.", 409);
        return persistLocalPlaybook({ ...playbook, created_at: undefined, updated_at: undefined }, creationId, identity, { id: creationId, request });
      });
      const saved = await saveRemotePlay(playbook, identity, creationId);
      announceChange(); return saved;
    });
  } catch (error) {
    throw new CreationAttemptError(error instanceof Error ? error.message : "The create response could not be confirmed.",
      !(error instanceof PersistenceResponseError && [400, 422].includes(error.status)));
  }
}
export async function updatePlaybook(playbook: PlaybookDraft) {
  validatePlaybookDocument(playbook);
  playbook = normalizePlaybookPrecision(playbook);
  const identity: PlaybookSaveIdentity = { operation: "update", id: playbook.id };
  return libraryReads.mutate(() => queuePlayMutation(playbook.id, async () => {
    if (IS_GITHUB_PAGES) return withLibraryWrite(() => {
      const current = readLocalPlaybooks().find((item) => item.id === playbook.id);
      if (!current) throw new Error("Saved play not found");
      if (current.revision !== playbook.revision) throw new PersistenceResponseError(SAVE_CONFLICT, 409);
      return persistLocalPlaybook(playbook, playbook.id, identity);
    });
    const saved = await saveRemotePlay(playbook, identity);
    announceChange(); return saved;
  }));
}
export async function deletePlaybook(id: string) {
  return libraryReads.mutate(() => queuePlayMutation(id, async () => {
    if (IS_GITHUB_PAGES) return withLibraryWrite(() => { writeLocalPlaybooks(readLocalPlaybooks().filter((item) => item.id !== id)); return { deleted: true, id }; });
    const deleted = await deleteRemotePlay(id);
    announceChange(); return deleted;
  }));
}
