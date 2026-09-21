import type { PlaybookDocument, PlaybookDraft } from "./types";
import { IS_GITHUB_PAGES } from "../../runtime";

const LOCAL_STORAGE_KEY = "arc-playbooks-v1";

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: "Request failed" })) as { detail?: string };
    throw new Error(body.detail ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function readLocalPlaybooks(): PlaybookDocument[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value as PlaybookDocument[] : [];
  } catch {
    return [];
  }
}

function writeLocalPlaybooks(playbooks: PlaybookDocument[]) {
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(playbooks));
}

function localId() {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 12)
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `local-${suffix}`;
}

function persistLocalPlaybook(playbook: PlaybookDraft, id = playbook.id.startsWith("draft-") ? localId() : playbook.id): PlaybookDocument {
  const now = new Date().toISOString();
  const saved: PlaybookDocument = {
    version: 1,
    id,
    name: playbook.name.trim() || "Untitled play",
    created_at: playbook.created_at ?? now,
    updated_at: now,
    defenders_visible: playbook.defenders_visible,
    players: structuredClone(playbook.players),
    defenders: structuredClone(playbook.defenders),
    ball: playbook.ball ? structuredClone(playbook.ball) : null,
    arrows: structuredClone(playbook.arrows),
  };
  const current = readLocalPlaybooks().filter((item) => item.id !== id);
  writeLocalPlaybooks([saved, ...current]);
  return saved;
}

export function fetchPlaybooks() {
  if (IS_GITHUB_PAGES) return Promise.resolve(readLocalPlaybooks());
  return fetch("/api/playbooks").then((response) => parse<PlaybookDocument[]>(response));
}

export function createPlaybook(playbook: PlaybookDraft) {
  if (IS_GITHUB_PAGES) return Promise.resolve(persistLocalPlaybook(playbook));
  return fetch("/api/playbooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(playbook),
  }).then((response) => parse<PlaybookDocument>(response));
}

export function updatePlaybook(playbook: PlaybookDraft) {
  if (IS_GITHUB_PAGES) {
    const current = readLocalPlaybooks();
    if (!current.some((item) => item.id === playbook.id)) return Promise.reject(new Error("Saved play not found"));
    return Promise.resolve(persistLocalPlaybook(playbook));
  }
  return fetch(`/api/playbooks/${encodeURIComponent(playbook.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(playbook),
  }).then((response) => parse<PlaybookDocument>(response));
}

export function deletePlaybook(id: string) {
  if (IS_GITHUB_PAGES) {
    writeLocalPlaybooks(readLocalPlaybooks().filter((item) => item.id !== id));
    return Promise.resolve({ deleted: true, id });
  }
  return fetch(`/api/playbooks/${encodeURIComponent(id)}`, { method: "DELETE" }).then((response) => parse<{ deleted: boolean; id: string }>(response));
}
