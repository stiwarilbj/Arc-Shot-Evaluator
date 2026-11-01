import type { PlaybookDocument } from "./types.ts";

export type PlaybookReadIssue = { file: string; kind: "invalid" | "unavailable" | "unknown" };

/** Healthy entries are diagnostic data, never an ordinary complete refresh.
 * Existing workspace error handlers retain their last loaded library. */
export class IncompletePlaybookLibraryError extends Error {
  readonly complete = false;
  constructor(readonly availablePlays: PlaybookDocument[], readonly issues: PlaybookReadIssue[]) {
    const reasons = [
      issues.some((issue) => issue.kind === "invalid") ? "Some saved files contain invalid documents" : "",
      issues.some((issue) => issue.kind === "unavailable") ? "Some saved files are temporarily unavailable; retry when storage is available" : "",
      issues.some((issue) => issue.kind === "unknown") || !issues.length ? "Some saved files could not be read; retry the refresh" : "",
    ].filter(Boolean).join(" ");
    super(`Saved library refresh is incomplete · ${reasons} Previously loaded plays have been kept · Stored files have not been changed`);
  }
}

export function readLibraryIssues(headers: Headers): PlaybookReadIssue[] | null {
  const status = headers.get("X-ARC-Playbook-Status");
  const warnings = headers.get("X-ARC-Playbook-Warnings");
  const raw = headers.get("X-ARC-Playbook-Issues");
  if (status !== "partial" && (status === null || status === "complete") && warnings === null && raw === null) return null;
  if (raw !== null) {
    try {
      const issues: unknown = JSON.parse(raw);
      if (!Array.isArray(issues) || !issues.length) throw new Error();
      return issues.map((issue: unknown): PlaybookReadIssue => {
        if (!issue || typeof issue !== "object" || !("file" in issue) || typeof issue.file !== "string" || !issue.file
          || !("kind" in issue) || (issue.kind !== "invalid" && issue.kind !== "unavailable")) throw new Error();
        return { file: issue.file, kind: issue.kind };
      });
    } catch { /* An unusable warning must never make a partial list complete. */ }
  }
  // Older servers only send the warnings header, without a reason category.
  return (warnings?.split(",").map((file) => file.trim()).filter(Boolean) ?? []).map((file) => ({ file, kind: "unknown" }));
}
