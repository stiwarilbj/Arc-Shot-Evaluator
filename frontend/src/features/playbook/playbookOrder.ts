import type { PlaybookDocument } from "./types";

// Code-point order agrees with Python and is independent of browser locale.
function compareText(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

/** Preserve timestamp-text ordering; break ties by ascending document ID. */
export function compareSavedPlaybooks(left: PlaybookDocument, right: PlaybookDocument): number {
  const leftTime = typeof left.updated_at === "string" ? left.updated_at : "";
  const rightTime = typeof right.updated_at === "string" ? right.updated_at : "";
  return compareText(rightTime, leftTime) || compareText(left.id, right.id);
}
