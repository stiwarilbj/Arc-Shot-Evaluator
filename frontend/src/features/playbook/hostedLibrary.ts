import { playbookContentKey } from "./playbookDraftSession.ts";
import { validateSavedPlaybook, validatePlaybookSaveResult } from "./documentValidation.ts";
import { appendRevision, canonicalContent, contentChecksum, HISTORY_ERROR, HistoryVerificationUnavailableError, PLAYBOOK_HISTORY_LIMIT, sameRef, validChecksum, validRevision, verifyRevision, type PlayHistory, type PlaybookRecovery } from "./revisionHistory.ts";
import type { PlaybookDocument } from "./types.ts";
export type CreationReceipt = { id: string; request: string; result: PlaybookDocument };
export type LegacyLibrary = { version: 1; plays: PlaybookDocument[]; creations: CreationReceipt[] };
type RevisionFields = { plays: PlaybookDocument[]; creations: CreationReceipt[]; histories: PlayHistory[]; checksum: string; preservedSources?: { content: string; checksum: string }[]; reservedIds?: string[] };
export type RevisionLibrary = RevisionFields & { version: 2; migration: { source: LegacyLibrary; checksum: string } };
export type BranchAwareLibrary = RevisionFields & { version: 3; migration: { source: RevisionLibrary; checksum: string } };
export type TimingAwareLibrary = RevisionFields & { version: 4; migration: { source: BranchAwareLibrary; checksum: string } };
export type ReadCoachAwareLibrary = RevisionFields & { version: 5; migration: { source: TimingAwareLibrary; checksum: string } };
export type HostedLibrary = LegacyLibrary | RevisionLibrary | BranchAwareLibrary | TimingAwareLibrary | ReadCoachAwareLibrary;
type RevisionedLibrary = Exclude<HostedLibrary, LegacyLibrary>;

function validateUniquePlays(plays: unknown[]): void {
  const ids = new Set<string>();
  for (const play of plays) {
    validateSavedPlaybook(play);
    if (ids.has(play.id)) throw new Error("Duplicate saved play identity");
    ids.add(play.id);
  }
}
/** Parsing stays synchronous; checksums are verified before callers use revisioned storage. */
export function validateHostedLibrary(value: unknown): HostedLibrary {
  try {
    if (Array.isArray(value)) { validateUniquePlays(value); return { version: 1, plays: value, creations: [] }; }
    const library = value as HostedLibrary;
    if (!library || ![1, 2, 3, 4, 5].includes(library.version) || !Array.isArray(library.plays) || !Array.isArray(library.creations)) throw new Error();
    validateUniquePlays(library.plays);
    const ids = new Set<string>();
    for (const receipt of library.creations) {
      if (!receipt || !/^play-[a-f0-9]{32}$/.test(receipt.id) || ids.has(receipt.id) || typeof receipt.request !== "string") throw new Error();
      validatePlaybookSaveResult(receipt.result, { operation: "update", id: receipt.id });
      if (playbookContentKey(receipt.result) !== receipt.request) throw new Error();
      ids.add(receipt.id);
    }
    if (library.version !== 1) {
      const revisioned = library as RevisionedLibrary;
      if (!Array.isArray(revisioned.histories) || !revisioned.migration || !validChecksum(revisioned.checksum)) throw new Error();
    }
    if (library.version === 2 && validateHostedLibrary(library.migration.source).version !== 1) throw new Error();
    if (library.version === 3 && validateHostedLibrary(library.migration.source).version !== 2) throw new Error();
    if (library.version === 4 && validateHostedLibrary(library.migration.source).version !== 3) throw new Error();
    if (library.version === 5 && validateHostedLibrary(library.migration.source).version !== 4) throw new Error();
    return library;
  } catch { throw new Error("Saved plays could not be read. Your stored data has been preserved"); }
}
export async function verifyHostedLibrary(library: HostedLibrary): Promise<void> {
  if (library.version === 1) return;
  try {
    const { checksum, ...payload } = library;
    const source = validateHostedLibrary(library.migration.source);
    if (await contentChecksum(payload) !== checksum || await contentChecksum(library.migration.source) !== library.migration.checksum
      || source.version !== library.version - 1) throw new Error();
    if (source.version >= 2) await verifyHostedLibrary(source);
    if (library.reservedIds !== undefined && (!Array.isArray(library.reservedIds) || library.reservedIds.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)))) throw new Error();
    if (library.preservedSources !== undefined) {
      if (!Array.isArray(library.preservedSources)) throw new Error();
      for (const source of library.preservedSources) if (!source || typeof source.content !== "string" || await contentChecksum(source.content) !== source.checksum) throw new Error();
    }
    const ids = new Set<string>(), live = new Map(library.plays.map(play => [play.id, play]));
    for (const history of library.histories) {
      if (!history || typeof history.id !== "string" || ids.has(history.id) || !Array.isArray(history.entries) || !history.entries.length
        || history.entries.length > PLAYBOOK_HISTORY_LIMIT || (history.anchor !== null && (!validRevision(history.anchor?.revision) || !validChecksum(history.anchor?.checksum)))) throw new Error();
      ids.add(history.id);
      let parent = history.anchor;
      const revisions = new Set<string>();
      for (const entry of history.entries) {
        await verifyRevision(entry, history.id);
        if (revisions.has(entry.revision) || entry.revision === history.anchor?.revision || !sameRef(entry.parent, parent)) throw new Error();
        revisions.add(entry.revision); parent = entry;
      }
      const head = history.entries.at(-1)!;
      const play = live.get(history.id);
      if (head.kind === "delete" ? play !== undefined : !play || canonicalContent(play) !== canonicalContent(head.document)) throw new Error();
      live.delete(history.id);
    }
    if (live.size) throw new Error();
  } catch (error) { if (error instanceof HistoryVerificationUnavailableError) throw error; throw new Error(HISTORY_ERROR); }
}
export async function sealHostedLibrary(library: Omit<RevisionLibrary, "checksum">): Promise<RevisionLibrary> {
  return { ...library, checksum: await contentChecksum(library) };
}
async function sealBranchAwareLibrary(library: Omit<BranchAwareLibrary, "checksum">): Promise<BranchAwareLibrary> {
  return { ...library, checksum: await contentChecksum(library) };
}
async function sealTimingAwareLibrary(library: Omit<TimingAwareLibrary, "checksum">): Promise<TimingAwareLibrary> {
  return { ...library, checksum: await contentChecksum(library) };
}
async function sealReadCoachAwareLibrary(library: Omit<ReadCoachAwareLibrary, "checksum">): Promise<ReadCoachAwareLibrary> {
  return { ...library, checksum: await contentChecksum(library) };
}
async function upgradeToBranchAware(library: RevisionLibrary): Promise<BranchAwareLibrary> {
  return sealBranchAwareLibrary({ version: 3, plays: library.plays, creations: library.creations, histories: library.histories,
    migration: { source: library, checksum: await contentChecksum(library) },
    ...(library.preservedSources ? { preservedSources: library.preservedSources } : {}),
    ...(library.reservedIds ? { reservedIds: library.reservedIds } : {}) });
}
async function upgradeToTimingAware(library: BranchAwareLibrary): Promise<TimingAwareLibrary> {
  return sealTimingAwareLibrary({ version: 4, plays: library.plays, creations: library.creations, histories: library.histories,
    migration: { source: library, checksum: await contentChecksum(library) },
    ...(library.preservedSources ? { preservedSources: library.preservedSources } : {}),
    ...(library.reservedIds ? { reservedIds: library.reservedIds } : {}) });
}
async function upgradeToReadCoachAware(library: TimingAwareLibrary): Promise<ReadCoachAwareLibrary> {
  return sealReadCoachAwareLibrary({ version: 5, plays: library.plays, creations: library.creations, histories: library.histories,
    migration: { source: library, checksum: await contentChecksum(library) },
    ...(library.preservedSources ? { preservedSources: library.preservedSources } : {}),
    ...(library.reservedIds ? { reservedIds: library.reservedIds } : {}) });
}
export async function upgradeHostedLibrary(library: HostedLibrary): Promise<Exclude<HostedLibrary, LegacyLibrary>> {
  const hasTiming = (plays: PlaybookDocument[]) => plays.some((play) => [...play.arrows, ...(play.branches ?? []).flatMap((branch) => branch.continuation)].some((arrow) => arrow.timingPlan !== undefined));
  const hasReadCoach = (plays: PlaybookDocument[]) => plays.some((play) => Boolean(play.readCoach?.checkpoints.length));
  if (library.version === 5) return library;
  if (library.version === 4) return hasReadCoach(library.plays) ? upgradeToReadCoachAware(library) : library;
  if (library.version === 3) {
    const timed = hasTiming(library.plays) || hasReadCoach(library.plays) ? await upgradeToTimingAware(library) : null;
    const current = timed ?? library;
    return hasReadCoach(library.plays) && current.version === 4 ? upgradeToReadCoachAware(current) : current;
  }
  if (library.version === 2) {
    let upgraded: RevisionedLibrary = library.plays.some((play) => play.branches?.length) || hasTiming(library.plays) || hasReadCoach(library.plays) ? await upgradeToBranchAware(library) : library;
    if (upgraded.version === 3 && (hasTiming(upgraded.plays) || hasReadCoach(upgraded.plays))) upgraded = await upgradeToTimingAware(upgraded);
    return hasReadCoach(library.plays) && upgraded.version === 4 ? upgradeToReadCoachAware(upgraded) : upgraded;
  }
  const histories: PlayHistory[] = [];
  // Migration and the first change are committed together; the validated source
  // is retained verbatim as a recovery snapshot, even after history pruning.
  for (const play of library.plays) histories.push(await appendRevision({ id: play.id, anchor: null, entries: [] }, play, play.revision ?? crypto.randomUUID().replaceAll("-", "")));
  for (const receipt of library.creations) if (!library.plays.some(play => play.id === receipt.id)) {
    let history = await appendRevision({ id: receipt.id, anchor: null, entries: [] }, receipt.result, receipt.result.revision ?? crypto.randomUUID().replaceAll("-", ""));
    history = await appendRevision(history, null, crypto.randomUUID().replaceAll("-", ""));
    histories.push(history);
  }
  const source = library;
  const upgraded = await sealHostedLibrary({ version: 2, plays: source.plays, creations: source.creations, histories, migration: { source, checksum: await contentChecksum(source) } });
  let branchAware: RevisionedLibrary = upgraded.plays.some((play) => play.branches?.length) || hasTiming(upgraded.plays) || hasReadCoach(upgraded.plays) ? await upgradeToBranchAware(upgraded) : upgraded;
  if (branchAware.version === 3 && (hasTiming(branchAware.plays) || hasReadCoach(branchAware.plays))) branchAware = await upgradeToTimingAware(branchAware);
  return hasReadCoach(library.plays) && branchAware.version === 4 ? upgradeToReadCoachAware(branchAware) : branchAware;
}
export async function reviseHostedLibrary(library: Exclude<HostedLibrary, LegacyLibrary>, id: string, document: PlaybookDocument | null, creations = library.creations): Promise<Exclude<HostedLibrary, LegacyLibrary>> {
  const current = library.histories.find(history => history.id === id) ?? { id, anchor: null, entries: [] };
  if (current.entries.at(-1)?.kind === "delete") throw new Error("This play was explicitly deleted. Recover a separate copy instead");
  const history = await appendRevision(current, document, document?.revision ?? crypto.randomUUID().replaceAll("-", ""));
  const plays = [...(document ? [document] : []), ...library.plays.filter(play => play.id !== id)];
  const histories = [...library.histories.filter(item => item.id !== id), history];
  const extras = {
    ...(library.preservedSources ? { preservedSources: library.preservedSources } : {}),
    ...(library.reservedIds ? { reservedIds: library.reservedIds } : {}),
  };
  if (library.version === 5) return sealReadCoachAwareLibrary({ version: 5, plays, creations, histories, migration: library.migration, ...extras });
  if (library.version === 4) return plays.some((play) => Boolean(play.readCoach?.checkpoints.length))
    ? sealReadCoachAwareLibrary({ version: 5, plays, creations, histories, migration: { source: library, checksum: await contentChecksum(library) }, ...extras })
    : sealTimingAwareLibrary({ version: 4, plays, creations, histories, migration: library.migration, ...extras });
  if (library.version === 3) {
    const revised = await sealBranchAwareLibrary({ version: 3, plays, creations, histories, migration: library.migration, ...extras });
    const timed = plays.some((play) => [...play.arrows, ...(play.branches ?? []).flatMap((branch) => branch.continuation)].some((arrow) => arrow.timingPlan !== undefined));
    const readCoach = plays.some((play) => Boolean(play.readCoach?.checkpoints.length));
    const next = timed || readCoach ? await upgradeToTimingAware(revised) : revised;
    return readCoach && next.version === 4 ? upgradeToReadCoachAware(next) : next;
  }
  const revised = await sealHostedLibrary({ version: 2, plays, creations, histories, migration: library.migration, ...extras });
  const hasTiming = plays.some((play) => [...play.arrows, ...(play.branches ?? []).flatMap((branch) => branch.continuation)].some((arrow) => arrow.timingPlan !== undefined));
  const hasReadCoach = plays.some((play) => Boolean(play.readCoach?.checkpoints.length));
  let branchAware: RevisionedLibrary = plays.some((play) => play.branches?.length) || hasTiming || hasReadCoach ? await upgradeToBranchAware(revised) : revised;
  if (branchAware.version === 3 && (hasTiming || hasReadCoach)) branchAware = await upgradeToTimingAware(branchAware);
  return hasReadCoach && branchAware.version === 4 ? upgradeToReadCoachAware(branchAware) : branchAware;
}
/** Recovery never trusts a damaged head or silently selects an older drawing.
 * Independently checksummed revisions can only be copied to a fresh identity. */
export async function inspectHostedRecovery(value: unknown, id: string): Promise<PlaybookRecovery> {
  const library = value as RevisionLibrary;
  let verified = false;
  try { validateHostedLibrary(value); await verifyHostedLibrary(library); verified = true; } catch (error) { if (error instanceof HistoryVerificationUnavailableError) throw error; /* Preserve every damaged record in storage. */ }
  if (library?.version !== 2 && library?.version !== 3 && library?.version !== 4 && library?.version !== 5 || !Array.isArray(library.histories)) throw new Error(HISTORY_ERROR);
  const history = library.histories.find(item => item?.id === id);
  if (!history || !Array.isArray(history.entries)) throw new Error("Saved-play history not found");
  if (history.entries.length > 32) throw new Error(HISTORY_ERROR);
  const revisions: PlaybookRecovery["revisions"] = [];
  for (const entry of history.entries) {
    let valid = false;
    try { await verifyRevision(entry, id); valid = true; } catch (error) { if (error instanceof HistoryVerificationUnavailableError) throw error; /* Report damage without returning an unverified document. */ }
    revisions.push({ revision: String(entry?.revision ?? ""), parent: entry?.parent?.revision ?? null, checksum: String(entry?.checksum ?? ""), valid,
      kind: entry?.kind === "delete" ? "delete" : "save", ...(valid && entry.document ? { document: structuredClone(entry.document) } : {}) });
  }
  return { id, integrity: verified ? "verified" : "damaged", deleted: verified ? history.entries.at(-1)?.kind === "delete" : null, revisions };
}

/** Explicit corruption recovery keeps the exact unreadable transaction, reserves
 * all of its known identities, and starts an independent recovery-copy library.
 * No uncertain current document or deletion is promoted to a live head. */
export async function preserveDamagedLibrary(raw: string): Promise<RevisionLibrary> {
  const value = JSON.parse(raw) as Partial<RevisionLibrary>;
  const reserved = new Set<string>();
  for (const collection of [value.plays, value.histories, value.creations, Array.isArray(value.reservedIds) ? value.reservedIds.map(id => ({ id })) : []]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) if (item && typeof item.id === "string" && /^[a-z0-9][a-z0-9-]{7,63}$/.test(item.id)) reserved.add(item.id);
  }
  const source: LegacyLibrary = { version: 1, plays: [], creations: [] };
  return sealHostedLibrary({ version: 2, plays: [], creations: [], histories: [], migration: { source, checksum: await contentChecksum(source) },
    preservedSources: [{ content: raw, checksum: await contentChecksum(raw) }], reservedIds: [...reserved].sort() });
}
