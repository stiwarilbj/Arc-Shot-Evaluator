import type { PlaybookDocument, PlaybookDraft } from "./types.ts";

type SavedIdentity = Pick<PlaybookDocument, "id" | "created_at" | "updated_at">;
type PendingSave = { document: number; revision: number; draft: PlaybookDraft };

function withIdentity(draft: PlaybookDraft, saved: SavedIdentity): PlaybookDraft {
  return { ...draft, id: saved.id, created_at: saved.created_at, updated_at: saved.updated_at };
}

/** Synchronous ownership checks also cover edits queued before React renders. */
export function createPlaybookDraftSession(initial: PlaybookDraft) {
  let current = initial;
  let document = 0;
  let revision = 0;
  let identity: SavedIdentity | null = null;
  let pending: PendingSave | null = null;
  return {
    get current() { return current; },
    edit(next: PlaybookDraft) {
      revision++;
      // Undo snapshots and in-progress drags may still carry the pre-save ID.
      current = identity ? withIdentity(next, identity) : next;
      return current;
    },
    load(next: PlaybookDraft) {
      document++;
      revision++;
      identity = null;
      current = next;
      return current;
    },
    beginSave(): PendingSave | null {
      if (pending) return null;
      pending = { document, revision, draft: structuredClone(current) };
      return pending;
    },
    isCurrent(request: PendingSave) {
      return document === request.document && revision === request.revision;
    },
    completeSave(request: PendingSave, saved: PlaybookDocument) {
      if (pending !== request) return null;
      pending = null;
      if (document !== request.document) return null;
      const unchanged = revision === request.revision;
      identity = { id: saved.id, created_at: saved.created_at, updated_at: saved.updated_at };
      current = unchanged ? structuredClone(saved) : withIdentity(current, identity);
      return { draft: current, unchanged };
    },
    failSave(request: PendingSave) {
      if (pending !== request) return false;
      pending = null;
      return document === request.document;
    },
  };
}
