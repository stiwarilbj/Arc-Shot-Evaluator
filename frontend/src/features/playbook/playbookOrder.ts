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

// Match the native reader: ISO dates are UTC; date-times require an explicit
// zone. Reject overflow dates rather than relying on Date.parse normalization.
function timestampInstant(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2}))?$/.exec(value);
  if (!match || match[0] !== value) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "", zone = "Z"] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  let offset = 0;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 23 || minutes > 59) return null;
    offset = (hours * 60 + minutes) * (zone[0] === "+" ? 1 : -1);
  }
  return BigInt(date.getTime() - offset * 60_000) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

/** Newest instant first; invalid/missing dates last, then ascending ID. */
export function compareSavedPlaybooks(left: PlaybookDocument, right: PlaybookDocument): number {
  const leftTime = timestampInstant(left.updated_at), rightTime = timestampInstant(right.updated_at);
  if (leftTime === rightTime) return compareText(left.id, right.id);
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return leftTime > rightTime ? -1 : 1;
}
