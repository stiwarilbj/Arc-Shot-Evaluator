import { playbookContentKey } from "./playbookDraftSession.ts";
import { validateSavedPlaybook, validatePlaybookSaveResult } from "./documentValidation.ts";
import type { PlaybookDocument } from "./types.ts";
export type CreationReceipt = { id: string; request: string; result: PlaybookDocument };
export type HostedLibrary = { version: 1; plays: PlaybookDocument[]; creations: CreationReceipt[] };

function validateUniquePlays(plays: unknown[]): void {
  const ids = new Set<string>();
  for (const play of plays) {
    validateSavedPlaybook(play);
    if (ids.has(play.id)) throw new Error("Duplicate saved play identity");
    ids.add(play.id);
  }
}

/** Legacy arrays load unchanged. Receipts and plays share one atomic storage
 * value, so a failed write cannot leave a receipt for an unsaved document. */
export function validateHostedLibrary(value: unknown): HostedLibrary {
  try {
    if (Array.isArray(value)) { validateUniquePlays(value); return { version: 1, plays: value, creations: [] }; }
    const library = value as HostedLibrary;
    if (!library || library.version !== 1 || !Array.isArray(library.plays) || !Array.isArray(library.creations)) throw new Error();
    validateUniquePlays(library.plays);
    const ids = new Set<string>();
    for (const receipt of library.creations) {
      if (!receipt || !/^play-[a-f0-9]{32}$/.test(receipt.id) || ids.has(receipt.id) || typeof receipt.request !== "string") throw new Error();
      validatePlaybookSaveResult(receipt.result, { operation: "update", id: receipt.id });
      if (playbookContentKey(receipt.result) !== receipt.request) throw new Error();
      ids.add(receipt.id);
    }
    return library;
  } catch { throw new Error("Saved plays could not be read. Your stored data has been preserved."); }
}
