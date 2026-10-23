import { compareSavedPlaybooks } from "./playbookOrder.ts";
import { newCreationId, CreationAttemptError } from "./creationAttempt.ts";
import { validateHostedLibrary, verifyHostedLibrary, upgradeHostedLibrary, reviseHostedLibrary, inspectHostedRecovery, preserveDamagedLibrary, type HostedLibrary, type CreationReceipt } from "./hostedLibrary.ts";
import { withPersistenceDeadline, PersistenceDeadlineError, PERSISTENCE_CHECK_TIMEOUT_MS } from "./persistenceDeadline.ts";
import { playbookContentKey } from "./playbookDraftSession.ts";
import { createPlayMutationQueue } from "./playMutationQueue.ts";
import { normalizePlaybookPrecision } from "./documentPrecision.ts";
import { INVALID_PLAYBOOK_SAVE, validatePlaybookDocument, validateSavedPlaybook, validatePlaybookSaveResult, type PlaybookSaveIdentity } from "./documentValidation.ts";
import type { PlaybookDocument, PlaybookDraft } from "./types";
import { HISTORY_ERROR, HistoryVerificationUnavailableError, type PlaybookRecovery } from "./revisionHistory.ts";
import { IS_GITHUB_PAGES } from "../../runtime";
import { createSharedLibraryRead } from "./sharedLibraryRead.ts";
import { createParsedLibraryCache } from "./parsedLibraryCache.ts";
import { IncompletePlaybookLibraryError, readLibraryIssues } from "./libraryReadStatus.ts";
import { checkPlaybookJsonText, MAX_PLAYBOOK_JSON_BYTES, MAX_PLAYBOOK_LIBRARY_BYTES, readPlaybookJson, readPlaybookJsonText } from "./jsonIntake.ts";
export { IncompletePlaybookLibraryError } from "./libraryReadStatus.ts";

const LOCAL_STORAGE_KEY = "arc-playbooks-v1";
const SAVE_CONFLICT = "This play was changed by another tab or client. Your draft is still in memory. Save a copy or reopen the latest saved play before updating it";
// All tabs on this origin must finish the entire transaction before another
// writer reads the library. Never substitute an unsafe localStorage spin lock.
function withLibraryWrite<T>(write: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return Promise.reject(new Error("Safe browser storage is unavailable. Use a current browser over HTTPS or localhost and retry; your play is still in memory"));
  }
  return withPersistenceDeadline((signal) => navigator.locks.request(`${LOCAL_STORAGE_KEY}:write`, { mode: "exclusive", signal }, () => {
    signal.throwIfAborted();
    return write(signal);
  }));
}

class PersistenceResponseError extends Error { constructor(message: string, readonly status: number) { super(message); } }
class InvalidDeletionAcknowledgement extends Error {}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await readPlaybookJson(response).catch(() => ({ detail: "Request failed" })) as { detail?: string };
    throw new PersistenceResponseError(body.detail ?? `Request failed (${response.status})`, response.status);
  }
  return readPlaybookJson(response) as Promise<T>;
}

async function parseSave(response: Response, identity: PlaybookSaveIdentity): Promise<PlaybookDocument> {
  if (!response.ok) return parse<never>(response);
  let saved: unknown;
  try { saved = await readPlaybookJson(response); }
  catch { throw new Error(INVALID_PLAYBOOK_SAVE); }
  validatePlaybookSaveResult(saved, identity);
  return saved;
}

const queuePlayMutation = createPlayMutationQueue();
const CHANGE_EVENT = "arc-playbooks-changed";
const parseLibrary = createParsedLibraryCache(validateLibrary);
const parseHostedLibrary = createParsedLibraryCache(validateHostedLibrary);
function hasRevisionHistory(library: HostedLibrary): library is Exclude<HostedLibrary, { version: 1 }> {
  return library.version === 2 || library.version === 3 || library.version === 4 || library.version === 5;
}
const libraryReads = createSharedLibraryRead(async () => {
  const plays = IS_GITHUB_PAGES ? await readLocalPlaybooks() : await readRemotePlaybooks();
  return [...plays].sort(compareSavedPlaybooks);
});
async function readRemotePlaybooks(): Promise<PlaybookDocument[]> {
  return withPersistenceDeadline(async (signal) => {
    const response = await fetch("/api/playbooks", { signal, cache: "no-store" });
    if (!response.ok) await parse<never>(response);
    const plays = parseLibrary(await readPlaybookJsonText(response, MAX_PLAYBOOK_LIBRARY_BYTES));
    const issues = readLibraryIssues(response.headers);
    if (issues !== null) throw new IncompletePlaybookLibraryError(structuredClone([...plays].sort(compareSavedPlaybooks)), issues);
    return plays;
  });
}
const UNCERTAIN_SAVE = "The save response was interrupted and its outcome could not be confirmed. Your draft is still in memory. Retry when the server is available";
const UNCERTAIN_DELETE = "The delete response was interrupted and its outcome could not be confirmed. Refresh the saved library before retrying";

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
  const usesBranchExtension = playbook.branches !== undefined;
  const usesTimingExtension = [...playbook.arrows, ...(playbook.branches ?? []).flatMap((branch) => branch.continuation)].some((arrow) => arrow.timingPlan !== undefined);
  const requiredExtensions = [usesBranchExtension ? "branches-v1" : null, usesTimingExtension ? "timing-v1" : null, playbook.readCoach?.checkpoints.length ? "read-coach-v1" : null].filter((value): value is string => value !== null);
  try {
    return await withPersistenceDeadline(async (signal) => {
      if (requiredExtensions.length) {
        const capability = await fetch("/api/playbooks", { signal, cache: "no-store" });
        if (!capability.ok) await parse<never>(capability);
        const available = new Set((capability.headers.get("X-ARC-Playbook-Extensions") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
        if (requiredExtensions.some((extension) => !available.has(extension))) {
          throw new Error("This local server does not support every feature in this play yet. Update the downloaded app before saving it");
        }
      }
      const response = await fetch(identity.operation === "create" ? "/api/playbooks" : `/api/playbooks/${encodeURIComponent(id)}`, {
        method: identity.operation === "create" ? "POST" : "PUT", signal,
        headers: { "Content-Type": "application/json", ...(requiredExtensions.length ? { "X-ARC-Playbook-Extensions": requiredExtensions.join(",") } : {}), ...(identity.operation === "create" ? { "X-ARC-Create-ID": id } : { "If-Match": `"${playbook.revision ?? "legacy"}"` }) },
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
      try { acknowledgement = await readPlaybookJson(response); }
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
  } catch { throw new Error("Saved plays could not be read. Your stored data has been preserved"); }
  return value as PlaybookDocument[];
}
let verifiedHosted: { library: HostedLibrary; verification: Promise<void> } | undefined;
async function readLocalLibrary(): Promise<HostedLibrary> {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    const library = parseHostedLibrary(raw ?? "[]");
    if (verifiedHosted?.library !== library) {
      const verification = verifyHostedLibrary(library);
      verifiedHosted = { library, verification };
    }
    const pending = verifiedHosted;
    try { await pending.verification; }
    catch (error) {
      // Cache only successful verification. A transient crypto/resource failure
      // must not poison all later reads of otherwise unchanged stored bytes.
      if (verifiedHosted === pending) verifiedHosted = undefined;
      throw error;
    }
    return library;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Saved plays contain unreadable data. Your stored data has been preserved");
    if (error instanceof Error && error.message.includes("preserved")) throw error;
    throw new Error("Browser storage is unavailable. Allow site storage and retry; your play is still in memory");
  }
}
async function readLocalPlaybooks(): Promise<PlaybookDocument[]> {
  const library = await readLocalLibrary();
  if (hasRevisionHistory(library) && library.preservedSources?.length) throw new IncompletePlaybookLibraryError(structuredClone(library.plays), [{ file: "preserved-browser-library.json", kind: "invalid" }]);
  return library.plays;
}
async function writeLocalLibrary(library: HostedLibrary, signal: AbortSignal) {
  // Validate the complete migrated transaction before touching the existing key.
  await verifyHostedLibrary(library);
  const content = JSON.stringify(library);
  checkPlaybookJsonText(content, MAX_PLAYBOOK_LIBRARY_BYTES);
  signal.throwIfAborted();
  try { window.localStorage.setItem(LOCAL_STORAGE_KEY, content); }
  catch { throw new Error("This play could not be saved: browser storage is unavailable or full. Free some space and retry"); }
  // Acknowledgements cover the exact head, history, tombstones and receipts.
  if (window.localStorage.getItem(LOCAL_STORAGE_KEY) !== content) throw new Error("The save outcome could not be confirmed. Your draft is still in memory; refresh before retrying");
  announceChange();
}

async function persistLocalPlaybook(playbook: PlaybookDraft, id: string, identity: PlaybookSaveIdentity, signal: AbortSignal, receipt?: { id: string; request: string }): Promise<PlaybookDocument> {
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
    ...(playbook.branches !== undefined ? { branches: structuredClone(playbook.branches) } : {}),
    ...(playbook.readCoach !== undefined ? { readCoach: structuredClone(playbook.readCoach) } : {}),
  };
  validatePlaybookSaveResult(saved, identity);
  const library = await upgradeHostedLibrary(await readLocalLibrary());
  const creations: CreationReceipt[] = receipt ? [...library.creations, { ...receipt, result: saved }] : library.creations;
  await writeLocalLibrary(await reviseHostedLibrary(library, id, saved, creations), signal);
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
  checkPlaybookJsonText(JSON.stringify(playbook), MAX_PLAYBOOK_JSON_BYTES);
  const identity: PlaybookSaveIdentity = { operation: "create", sourceId: playbook.id };
  try {
    return await libraryReads.mutate(async () => {
      if (IS_GITHUB_PAGES) return withLibraryWrite(async (signal) => {
        const request = playbookContentKey({ ...playbook, version: 1, name: playbook.name.trim() });
        const library = await readLocalLibrary();
        const receipt = library.creations.find(item => item.id === creationId);
        if (receipt) {
          if (receipt.request !== request) throw new PersistenceResponseError("This creation attempt belongs to a different drawing", 409);
          return structuredClone(receipt.result);
        }
        if (library.plays.some(item => item.id === creationId) || (hasRevisionHistory(library) && (library.histories.some(item => item.id === creationId) || library.reservedIds?.includes(creationId)))) throw new PersistenceResponseError("This creation identity is already in use", 409);
        return persistLocalPlaybook({ ...playbook, created_at: undefined, updated_at: undefined }, creationId, identity, signal, { id: creationId, request });
      });
      const saved = await saveRemotePlay(playbook, identity, creationId);
      announceChange(); return saved;
    });
  } catch (error) {
    throw new CreationAttemptError(error instanceof Error ? error.message : "The create response could not be confirmed",
      !(error instanceof PersistenceResponseError && [400, 413, 422].includes(error.status)));
  }
}
export async function updatePlaybook(playbook: PlaybookDraft) {
  validatePlaybookDocument(playbook);
  playbook = normalizePlaybookPrecision(playbook);
  checkPlaybookJsonText(JSON.stringify(playbook), MAX_PLAYBOOK_JSON_BYTES);
  const identity: PlaybookSaveIdentity = { operation: "update", id: playbook.id };
  return libraryReads.mutate(() => queuePlayMutation(playbook.id, async () => {
    if (IS_GITHUB_PAGES) return withLibraryWrite(async (signal) => {
      const current = (await readLocalLibrary()).plays.find((item) => item.id === playbook.id);
      if (!current) throw new Error("Saved play not found");
      if (current.revision !== playbook.revision) throw new PersistenceResponseError(SAVE_CONFLICT, 409);
      return persistLocalPlaybook(playbook, playbook.id, identity, signal);
    });
    const saved = await saveRemotePlay(playbook, identity);
    announceChange(); return saved;
  }));
}
export async function deletePlaybook(id: string) {
  return libraryReads.mutate(() => queuePlayMutation(id, async () => {
    if (IS_GITHUB_PAGES) return withLibraryWrite(async (signal) => {
      const library = await upgradeHostedLibrary(await readLocalLibrary());
      if (library.histories.find(item => item.id === id)?.entries.at(-1)?.kind === "delete") return { deleted: true, id };
      if (!library.plays.some(item => item.id === id)) throw new Error("Saved play not found");
      await writeLocalLibrary(await reviseHostedLibrary(library, id, null), signal);
      return { deleted: true, id };
    });
    const deleted = await deleteRemotePlay(id);
    announceChange(); return deleted;
  }));
}

/** Recovery is explicit and always produces a new play. It never changes a
 * damaged source or removes a tombstone, including when the current head fails. */
export async function fetchPlaybookHistory(id: string): Promise<PlaybookRecovery> {
  if (IS_GITHUB_PAGES) {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw === null) throw new Error("Saved-play history not found");
    checkPlaybookJsonText(raw, MAX_PLAYBOOK_LIBRARY_BYTES);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error(HISTORY_ERROR); }
    const pending: unknown[] = [value];
    for (let inspected = 0; pending.length && inspected < 16; inspected++) {
      const candidate = pending.shift();
      const library = candidate as { histories?: { id: string }[]; preservedSources?: { content: string }[] };
      if (Array.isArray(library?.histories) && library.histories.some(item => item?.id === id)) {
        const result = await inspectHostedRecovery(candidate, id);
        return candidate === value ? result : { ...result, integrity: "damaged", deleted: null };
      }
      if (Array.isArray(library?.preservedSources)) for (const source of library.preservedSources) {
        if (!source || typeof source.content !== "string") continue;
        try { pending.push(JSON.parse(source.content)); } catch { /* Keep unreadable sources intact. */ }
      }
    }
    return inspectHostedRecovery(value, id);
  }
  const value = await withPersistenceDeadline(async signal => {
    const response = await fetch(`/api/playbooks/${encodeURIComponent(id)}/history`, { signal, cache: "no-store" });
    if (!response.ok) return parse<never>(response);
    return JSON.parse(await readPlaybookJsonText(response, MAX_PLAYBOOK_LIBRARY_BYTES)) as PlaybookRecovery;
  });
  if (!value || value.id !== id || !["verified", "damaged"].includes(value.integrity) || !Array.isArray(value.revisions)
    || (value.deleted !== null && typeof value.deleted !== "boolean")) throw new Error(HISTORY_ERROR);
  if (value.revisions.length > 32) throw new Error(HISTORY_ERROR);
  for (const revision of value.revisions) {
    if (!revision || typeof revision.revision !== "string" || typeof revision.checksum !== "string"
      || (revision.parent !== null && typeof revision.parent !== "string")
      || (revision.committed !== undefined && revision.committed !== null && typeof revision.committed !== "boolean")
      || typeof revision.valid !== "boolean" || !["save", "delete"].includes(revision.kind)) throw new Error(HISTORY_ERROR);
    if (revision.document) { validateSavedPlaybook(revision.document); if (!revision.valid || revision.document.id !== id) throw new Error(HISTORY_ERROR); }
  }
  return value;
}
export async function recoverPlaybookRevision(id: string, revision: string, creationId = newCreationId()): Promise<PlaybookDocument> {
  const history = await fetchPlaybookHistory(id);
  const entry = history.revisions.find(item => item.revision === revision && item.valid && item.document);
  if (!entry?.document) throw new Error("This revision could not be verified. Your stored data has been preserved");
  const draft = { ...entry.document, name: `${[...entry.document.name].slice(0, 68).join("")} (recovered)` };
  if (IS_GITHUB_PAGES && history.integrity === "damaged") {
    return libraryReads.mutate(() => withLibraryWrite(async signal => {
      // Re-read and revalidate under the writer lock. Never recover from an
      // obsolete inspection after a different tab commits or deletes a play.
      const latest = await fetchPlaybookHistory(id);
      const selected = latest.revisions.find(item => item.revision === revision && item.valid && item.document);
      if (!selected?.document || selected.checksum !== entry.checksum) throw new Error(HISTORY_ERROR);
      let library: HostedLibrary;
      try { library = await readLocalLibrary(); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("preserved") || error instanceof HistoryVerificationUnavailableError) throw error;
        const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
        if (raw === null) throw new Error(HISTORY_ERROR);
        library = await preserveDamagedLibrary(raw);
      }
      // A previous recovery may already have created the requested copy.
      const receipt = library.creations.find(item => item.id === creationId);
      if (receipt) {
        if (receipt.request !== playbookContentKey(draft)) throw new Error("This recovery identity belongs to a different drawing");
        return structuredClone(receipt.result);
      }
      if (!/^play-[a-f0-9]{32}$/.test(creationId) || creationId === id || library.plays.some(item => item.id === creationId)
        || (hasRevisionHistory(library) && (library.histories.some(item => item.id === creationId) || library.reservedIds?.includes(creationId)))) throw new Error("Invalid recovery identity");
      const now = new Date().toISOString();
      const saved: PlaybookDocument = { ...normalizePlaybookPrecision(draft), id: creationId, revision: newCreationId().slice(5), created_at: now, updated_at: now };
      validatePlaybookSaveResult(saved, { operation: "create", sourceId: id });
      const upgraded = await upgradeHostedLibrary(library);
      await writeLocalLibrary(await reviseHostedLibrary(upgraded, creationId, saved, [...upgraded.creations, { id: creationId, request: playbookContentKey(draft), result: saved }]), signal);
      return saved;
    }));
  }
  return createPlaybook(draft, creationId);
}

// Explicit maintenance access without changing the editor or its draft. Loaded
// with Playbook/Counter Lab; all methods retain the normal persistence guards.
if (typeof window !== "undefined") Object.defineProperty(window, "arcPlaybookRecovery", {
  configurable: true, value: Object.freeze({ history: fetchPlaybookHistory, recover: recoverPlaybookRevision }),
});
