import { newCreationId } from "./creationAttempt.ts";
import type { CourtPoint, PlaybookDocument, PlaybookDraft } from "./types.ts";

type SavedIdentity = Pick<PlaybookDocument, "id" | "created_at" | "updated_at" | "revision">;
type PendingSave = { document: number; revision: number; draft: PlaybookDraft; creationId?: string };

function withSavedRevision(draft: PlaybookDraft, revision: string | undefined): PlaybookDraft {
  if (draft.revision === revision) return draft;
  const next = { ...draft };
  if (revision === undefined) delete next.revision;
  else next.revision = revision;
  return next;
}

function withIdentity(draft: PlaybookDraft, saved: SavedIdentity): PlaybookDraft {
  return withSavedRevision({ ...draft, id: saved.id, created_at: saved.created_at, updated_at: saved.updated_at }, saved.revision);
}

/** Only persisted content matters; IDs, timestamps, and presentation state do not. */
export function playbookContentKey(draft: PlaybookDraft): string {
  const point = (value?: CourtPoint | null) => value ? [value.x, value.y] : null;
  return JSON.stringify([
    draft.version, draft.name, draft.defenders_visible,
    draft.players.map((player) => [player.id, point(player),
      player.ratings?.threePoint ?? 3, player.ratings?.midrange ?? 3, player.ratings?.finishing ?? 3,
      [...(player.badges ?? [])].sort()]),
    draft.defenders.map((defender) => [defender.id, point(defender), [...(defender.badges ?? [])].sort()]),
    point(draft.ball),
    draft.arrows.map((arrow, index) => [arrow.id, arrow.kind, point(arrow.start), point(arrow.end),
      arrow.sequence ?? index + 1, arrow.path ?? "straight", point(arrow.control), arrow.timing ?? 1.2,
      arrow.actor_id ?? null, arrow.recipient_id ?? null, arrow.screener_id ?? null,
      arrow.cutter_id ?? null, arrow.handler_id ?? null, point(arrow.exit_target)]),
    (draft.branches ?? []).map((branch) => [branch.id, branch.label, branch.fork.actionIds, branch.fork.sequence,
      branch.continuation.map((arrow, index) => [arrow.id, arrow.kind, point(arrow.start), point(arrow.end),
        arrow.sequence ?? index + 1, arrow.path ?? "straight", point(arrow.control), arrow.timing ?? 1.2,
        arrow.actor_id ?? null, arrow.recipient_id ?? null, arrow.screener_id ?? null,
        arrow.cutter_id ?? null, arrow.handler_id ?? null, point(arrow.exit_target)])]),
    draft.readCoach ?? null,
  ]);
}

/** Synchronous ownership checks also cover edits queued before React renders. */
export function createPlaybookDraftSession(initial: PlaybookDraft, contentKey = playbookContentKey) {
  let current = initial;
  let baseline: string | null = contentKey(initial);
  let dirty = false;
  let document = 0;
  let revision = 0;
  let identity: SavedIdentity | null = null;
  let pending: PendingSave | null = null;
  let retryCreation: PendingSave | null = null;
  return {
    get current() { return current; },
    get dirty() { return dirty; },
    edit(next: PlaybookDraft) {
      revision++;
      // Undo snapshots and in-progress drags may still carry the pre-save ID.
      current = identity ? withIdentity(next, identity) : withSavedRevision(next, current.revision);
      dirty = baseline === null || contentKey(current) !== baseline;
      return current;
    },
    load(next: PlaybookDraft, unsavedCopy = false) {
      retryCreation = null;
      document++;
      revision++;
      identity = null;
      current = next;
      baseline = unsavedCopy ? null : contentKey(next);
      dirty = unsavedCopy;
      return current;
    },
    beginSave(): PendingSave | null {
      if (pending) return null;
      pending = retryCreation ?? { document, revision, draft: structuredClone(current), ...(current.id.startsWith("draft-") ? { creationId: newCreationId() } : {}) };
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
      retryCreation = null;
      identity = { id: saved.id, created_at: saved.created_at, updated_at: saved.updated_at, revision: saved.revision };
      current = unchanged ? structuredClone(saved) : withIdentity(current, identity);
      baseline = contentKey(saved);
      dirty = contentKey(current) !== baseline;
      return { draft: current, unchanged };
    },
    failSave(request: PendingSave, retainCreation = false) {
      if (pending !== request) return false;
      pending = null;
      if (document === request.document) retryCreation = retainCreation && request.creationId ? request : null;
      return document === request.document;
    },
  };
}
