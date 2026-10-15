import type { CourtPoint, PlaybookDocument, PlaybookDraft } from "./types.ts";

type SavedIdentity = Pick<PlaybookDocument, "id" | "created_at" | "updated_at">;
type PendingSave = { document: number; revision: number; draft: PlaybookDraft };

function withIdentity(draft: PlaybookDraft, saved: SavedIdentity): PlaybookDraft {
  return { ...draft, id: saved.id, created_at: saved.created_at, updated_at: saved.updated_at };
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
  return {
    get current() { return current; },
    get dirty() { return dirty; },
    edit(next: PlaybookDraft) {
      revision++;
      // Undo snapshots and in-progress drags may still carry the pre-save ID.
      current = identity ? withIdentity(next, identity) : next;
      dirty = baseline === null || contentKey(current) !== baseline;
      return current;
    },
    load(next: PlaybookDraft, unsavedCopy = false) {
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
      baseline = contentKey(saved);
      dirty = contentKey(current) !== baseline;
      return { draft: current, unchanged };
    },
    failSave(request: PendingSave) {
      if (pending !== request) return false;
      pending = null;
      return document === request.document;
    },
  };
}
