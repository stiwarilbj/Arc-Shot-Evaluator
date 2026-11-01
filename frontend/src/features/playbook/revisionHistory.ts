import { validateSavedPlaybook } from "./documentValidation.ts";
import type { PlaybookDocument } from "./types.ts";

export const PLAYBOOK_HISTORY_LIMIT = 8;
export type RevisionRef = { revision: string; checksum: string };
export type PlayRevision = RevisionRef & {
  version: 1; id: string; parent: RevisionRef | null;
  kind: "save" | "delete"; document: PlaybookDocument | null;
};
export type PlayHistory = { id: string; anchor: RevisionRef | null; entries: PlayRevision[] };
export type PlaybookRecovery = {
  id: string; integrity: "verified" | "damaged"; deleted: boolean | null;
  revisions: { revision: string; parent: string | null; checksum: string; valid: boolean; committed?: boolean | null; kind: "save" | "delete"; document?: PlaybookDocument }[];
};
export class HistoryVerificationUnavailableError extends Error {
  constructor() { super("Saved-play integrity verification is temporarily unavailable · Your stored data has been preserved; retry before attempting recovery"); }
}
export const HISTORY_ERROR = "Saved-play history failed its integrity check · Your stored data has been preserved · Use explicit recovery to copy a verified revision; no older drawing was loaded automatically";
export const validRevision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
export const validChecksum = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Stable key order; array order and every persisted document field remain significant. */
export function canonicalContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContent).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalContent((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error(HISTORY_ERROR);
  return result;
}
export async function contentChecksum(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalContent(value));
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  } catch { throw new HistoryVerificationUnavailableError(); }
}
export function sameRef(a: RevisionRef | null, b: RevisionRef | null): boolean {
  return a === null ? b === null : b !== null && a.revision === b.revision && a.checksum === b.checksum;
}
export async function verifyRevision(value: PlayRevision, id: string): Promise<void> {
  try {
    if (!value || value.version !== 1 || value.id !== id || !validRevision(value.revision) || !validChecksum(value.checksum)
      || (value.parent !== null && (!value.parent || !validRevision(value.parent.revision) || !validChecksum(value.parent.checksum)))
      || !["save", "delete"].includes(value.kind)) throw new Error();
    if (value.kind === "save") {
      validateSavedPlaybook(value.document);
      if (value.document.id !== id || (value.document.revision !== undefined && value.document.revision !== value.revision)) throw new Error();
    } else if (value.document !== null) throw new Error();
    const { checksum, ...payload } = value;
    if (await contentChecksum(payload) !== checksum) throw new Error();
  } catch (error) { if (error instanceof HistoryVerificationUnavailableError) throw error; throw new Error(HISTORY_ERROR); }
}
export async function appendRevision(history: PlayHistory, document: PlaybookDocument | null, revision: string): Promise<PlayHistory> {
  const previous = history.entries.at(-1) ?? history.anchor;
  const payload = { version: 1 as const, id: history.id, revision, parent: previous ? { revision: previous.revision, checksum: previous.checksum } : null,
    kind: document ? "save" as const : "delete" as const, document };
  const entry = { ...payload, checksum: await contentChecksum(payload) };
  const entries = [...history.entries, entry];
  const removed = entries.length > PLAYBOOK_HISTORY_LIMIT ? entries.shift()! : null;
  return { id: history.id, anchor: removed ? { revision: removed.revision, checksum: removed.checksum } : history.anchor, entries };
}
