import type { PlaybookArrow, PlaybookBranch, PlaybookDraft } from "./types.ts";
import { clonePlaybook } from "./types.ts";

export const MAX_PLAYBOOK_BRANCHES = 8;

/** Pocket insertions before an ending's fork belong to its shared opening. */
export function pocketInsertionBranchTarget(branchId: string | null, sharedBoundary: number | null, beforeSequence: number | null, insertShared: boolean): string | null {
  if (!branchId || insertShared || sharedBoundary !== null && beforeSequence !== null && beforeSequence < sharedBoundary) return null;
  return branchId;
}

export function sequenceOf(arrow: PlaybookArrow, index: number) {
  return Number.isInteger(arrow.sequence) ? arrow.sequence! : index + 1;
}

function orderedEntries(arrows: PlaybookArrow[]) {
  return arrows.map((arrow, index) => ({ arrow, index, sequence: sequenceOf(arrow, index) }))
    .sort((a, b) => a.sequence - b.sequence || a.index - b.index);
}

export function orderedActions(arrows: PlaybookArrow[]) {
  return orderedEntries(arrows).map(({ arrow }) => arrow);
}

export type ResolvedPlaybookPath = {
  play: PlaybookDraft;
  branch: PlaybookBranch | null;
  sharedCount: number;
  sharedIds: Set<string>;
};

/** Resolve a stable fork reference against the current Main action identities */
export function resolvePlaybookPath(source: PlaybookDraft, branchId: string | null = null): ResolvedPlaybookPath {
  const branch = branchId ? source.branches?.find((item) => item.id === branchId) ?? null : null;
  const play = clonePlaybook(source);
  delete play.branches;
  if (!branch) {
    play.arrows = orderedActions(source.arrows);
    play.spacingGates = source.spacingGates ? { version: 1, gates: source.spacingGates.gates.filter((gate) => gate.scope === "shared") } : undefined;
    play.baitPayoffs = source.baitPayoffs ? { version: 1, connections: source.baitPayoffs.connections.filter((item) => item.scope === "shared") } : undefined;
    return { play, branch: null, sharedCount: play.arrows.length, sharedIds: new Set(play.arrows.map((arrow) => arrow.id)) };
  }

  const mainEntries = orderedEntries(source.arrows);
  const main = mainEntries.map(({ arrow }) => arrow);
  const anchorIds = new Set(branch.fork.actionIds);
  const anchorSequences = mainEntries.flatMap(({ arrow, sequence }) => anchorIds.has(arrow.id) ? [sequence] : []);
  const cutoff = anchorSequences.length
    ? Math.min(...anchorSequences)
    : mainEntries.map(({ sequence }) => sequence).filter((sequence) => sequence >= branch.fork.sequence).sort((a, b) => a - b)[0]
      ?? Number.POSITIVE_INFINITY;
  const sharedEntries = Number.isFinite(cutoff) ? mainEntries.filter(({ sequence }) => sequence < cutoff) : mainEntries;
  const shared = sharedEntries.map(({ arrow }) => arrow);
  const sharedIds = new Set(shared.map((arrow) => arrow.id));
  // If a Main action is moved before the stable fork, the inherited Main copy
  // becomes authoritative and must not appear twice in the resolved path
  const continuation = orderedEntries(branch.continuation).filter(({ arrow }) => !sharedIds.has(arrow.id));
  const maxSharedSequence = sharedEntries.reduce((max, { sequence }) => Math.max(max, sequence), 0);
  const continuationGroups = [...new Set(continuation.map(({ sequence }) => sequence))];
  const rebasedSequence = new Map(continuationGroups.map((sequence, index) => [sequence, maxSharedSequence + index + 1]));
  const rebasedContinuation = continuation.map(({ arrow, sequence }) => ({
    ...arrow,
    sequence: rebasedSequence.get(sequence)!,
  }));
  play.arrows = [...shared, ...rebasedContinuation];
  const sharedGateIds = new Set(play.arrows.filter((arrow) => sharedIds.has(arrow.id)).map((arrow) => arrow.id));
  play.spacingGates = source.spacingGates ? { version: 1, gates: source.spacingGates.gates.filter((gate) =>
    gate.scope === "shared" ? sharedGateIds.has(gate.trigger.actionId) : gate.branchId === branch.id) } : undefined;
  const pathIds = new Set(play.arrows.map((arrow) => arrow.id));
  play.baitPayoffs = source.baitPayoffs ? { version: 1, connections: source.baitPayoffs.connections.filter((item) =>
    item.scope === "shared" ? pathIds.has(item.baitActionId) && pathIds.has(item.payoffActionId) && sharedIds.has(item.baitActionId) && sharedIds.has(item.payoffActionId)
      : item.branchId === branch.id) } : undefined;
  return { play, branch, sharedCount: shared.length, sharedIds: new Set(shared.map((arrow) => arrow.id)) };
}

export function flattenPlaybookPath(source: PlaybookDraft, branchId: string | null = null, label?: string): PlaybookDraft {
  const resolved = resolvePlaybookPath(source, branchId).play;
  delete resolved.readCoach;
  delete resolved.roleCues;
  delete resolved.spacingGates;
  delete resolved.flipbooks;
  delete resolved.baitPayoffs;
  if (label) resolved.name = `${source.name} — ${label}`.slice(0, 80);
  return resolved;
}

/** Apply an edited flattened path back to its shared Main opening and private continuation */
export function applyEditedPath(source: PlaybookDraft, branchId: string | null, editedPath: PlaybookDraft, oldPath: ResolvedPlaybookPath): PlaybookDraft {
  const next = clonePlaybook(editedPath);
  const oldVisibleBaitPayoffIds = new Set(oldPath.play.baitPayoffs?.connections.map((item) => item.id) ?? []);
  const newVisibleBaitPayoffs = editedPath.baitPayoffs?.connections ?? [];
  const replaceBaitPayoffIds = new Set([...oldVisibleBaitPayoffIds, ...newVisibleBaitPayoffs.map((item) => item.id)]);
  next.baitPayoffs = source.baitPayoffs || editedPath.baitPayoffs
    ? { version: 1, connections: [...(source.baitPayoffs?.connections ?? []).filter((item) => !replaceBaitPayoffIds.has(item.id)), ...structuredClone(newVisibleBaitPayoffs)] }
    : undefined;
  const oldVisibleGateIds = new Set(oldPath.play.spacingGates?.gates.map((gate) => gate.id) ?? []);
  const newVisibleGates = editedPath.spacingGates?.gates ?? [];
  const replaceGateIds = new Set([...oldVisibleGateIds, ...newVisibleGates.map((gate) => gate.id)]);
  next.spacingGates = source.spacingGates || editedPath.spacingGates
    ? { version: 1, gates: [...(source.spacingGates?.gates ?? []).filter((gate) => !replaceGateIds.has(gate.id)), ...structuredClone(newVisibleGates)] }
    : undefined;
  if (!branchId || !oldPath.branch) {
    next.branches = source.branches ? structuredClone(source.branches) : undefined;
    next.arrows = editedPath.arrows;
    return next;
  }

  const sharedIds = oldPath.sharedIds;
  const editedById = new Map(editedPath.arrows.map((arrow) => [arrow.id, arrow]));
  next.arrows = source.arrows.flatMap((arrow) => {
    if (!sharedIds.has(arrow.id)) return [arrow];
    const updated = editedById.get(arrow.id);
    return updated ? [updated] : [];
  });
  const continuation = editedPath.arrows.filter((arrow) => !sharedIds.has(arrow.id));
  next.branches = (source.branches ?? []).map((branch) => branch.id === branchId ? { ...branch, continuation } : branch);
  return next;
}

export function branchActionStatus(path: PlaybookArrow[], main: PlaybookArrow[], actionId: string): "added" | "changed" | null {
  const current = path.find((arrow) => arrow.id === actionId);
  if (!current) return null;
  const original = main.find((arrow) => arrow.id === actionId);
  if (!original) return "added";
  const signature = (arrow: PlaybookArrow) => JSON.stringify({
    kind: arrow.kind, sequence: sequenceOf(arrow, 0), path: arrow.path ?? "straight", timing: arrow.timing ?? 1.2,
    start: arrow.start, end: arrow.end, control: arrow.control ?? null, exit_target: arrow.exit_target ?? null,
    actor_id: arrow.actor_id ?? null, recipient_id: arrow.recipient_id ?? null, screener_id: arrow.screener_id ?? null,
    handler_id: arrow.handler_id ?? null, cutter_id: arrow.cutter_id ?? null,
    timingPlan: arrow.timingPlan ?? null,
  });
  return signature(current) === signature(original) ? null : "changed";
}

export function createBranchFromAction(source: PlaybookDraft, selectedActionId: string, branchNumber: number): PlaybookBranch {
  const ordered = orderedActions(source.arrows);
  const selected = ordered.find((arrow) => arrow.id === selectedActionId);
  if (!selected) throw new Error("Choose a Main action before creating an ending");
  const selectedSyncId = selected.timingPlan?.syncId;
  const syncMembers = selectedSyncId ? ordered.filter((arrow) => arrow.timingPlan?.syncId === selectedSyncId) : [selected];
  const selectedSequence = Math.min(...syncMembers.map((arrow) => sequenceOf(arrow, ordered.indexOf(arrow))));
  const group = ordered.filter((arrow, index) => sequenceOf(arrow, index) === selectedSequence || selectedSyncId && arrow.timingPlan?.syncId === selectedSyncId);
  const groupIds = new Set(group.map((arrow) => arrow.id));
  const continuation = ordered.filter((arrow, index) => sequenceOf(arrow, index) >= selectedSequence || groupIds.has(arrow.id));
  return {
    id: `ending-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`}`,
    label: `Ending ${branchNumber}`,
    fork: { actionIds: group.map((arrow) => arrow.id), sequence: selectedSequence },
    continuation: structuredClone(continuation),
  };
}
