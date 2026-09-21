import type { PlaybookDocument, PlaybookDraft } from "./types";

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: "Request failed" })) as { detail?: string };
    throw new Error(body.detail ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function fetchPlaybooks() {
  return fetch("/api/playbooks").then((response) => parse<PlaybookDocument[]>(response));
}

export function createPlaybook(playbook: PlaybookDraft) {
  return fetch("/api/playbooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(playbook),
  }).then((response) => parse<PlaybookDocument>(response));
}

export function updatePlaybook(playbook: PlaybookDraft) {
  return fetch(`/api/playbooks/${encodeURIComponent(playbook.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(playbook),
  }).then((response) => parse<PlaybookDocument>(response));
}

export function deletePlaybook(id: string) {
  return fetch(`/api/playbooks/${encodeURIComponent(id)}`, { method: "DELETE" }).then((response) => parse<{ deleted: boolean; id: string }>(response));
}
