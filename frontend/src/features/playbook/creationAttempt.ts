/** Internal identity only: never part of a drawing or its undo history. */
export function newCreationId(): string {
  return `play-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export class CreationAttemptError extends Error {
  readonly retainAttempt: boolean;
  constructor(message: string, retainAttempt = true) { super(message); this.retainAttempt = retainAttempt; }
}
