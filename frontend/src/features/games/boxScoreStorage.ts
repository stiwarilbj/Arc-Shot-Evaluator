import { createSession, validateSession, type PracticeSession } from "./boxScore.ts";

export const PRACTICE_KEY = "arc-box-score-error-hunt-v1";
type PracticeStorage = Pick<Storage, "getItem" | "setItem">;
const browserStorage = () => window.localStorage;
export function loadPractice(storage: () => PracticeStorage = browserStorage): { session: PracticeSession; storageAvailable: boolean } {
  let raw: string | null;
  try { raw = storage().getItem(PRACTICE_KEY); }
  catch { return { session: createSession(), storageAvailable: false }; }
  if (raw && raw.length <= 32_768) {
    try {
      const session: unknown = JSON.parse(raw);
      if (validateSession(session)) return { session, storageAvailable: true };
    } catch { /* An incompatible saved session must not prevent playing. */ }
  }
  return { session: createSession(), storageAvailable: true };
}
export function savePractice(session: PracticeSession, storage: () => PracticeStorage = browserStorage): boolean {
  try { storage().setItem(PRACTICE_KEY, JSON.stringify(session)); return true; }
  catch { return false; }
}
