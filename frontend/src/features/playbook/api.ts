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

const CHANGE_EVENT = "arc-playbooks-changed";
export function subscribePlaybooks(listener: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === LOCAL_STORAGE_KEY || event.key === null) listener(); };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(CHANGE_EVENT, listener); window.removeEventListener("storage", onStorage); };
}
function announceChange() { window.dispatchEvent(new Event(CHANGE_EVENT)); }
function validateLibrary(value: unknown): PlaybookDocument[] {
  if (!Array.isArray(value) || value.some((play) => !play || typeof play.id !== "string" || typeof play.name !== "string" || !Array.isArray(play.players) || !Array.isArray(play.defenders) || !Array.isArray(play.arrows))) throw new Error("Saved plays could not be read. Your stored data has been preserved.");
  return value as PlaybookDocument[];
}
function readLocalPlaybooks(): PlaybookDocument[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? validateLibrary(JSON.parse(raw)) : [];
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Saved plays contain unreadable data. Your stored data has been preserved.");
    throw new Error(error instanceof Error && error.message.includes("preserved") ? error.message : "Browser storage is unavailable. Allow site storage and retry; your play is still in memory.");
  }
}
function writeLocalPlaybooks(playbooks: PlaybookDocument[]) {
  try { window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(playbooks)); }
  catch { throw new Error("This play could not be saved: browser storage is unavailable or full. Free some space and retry."); }
  announceChange();
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

export async function fetchPlaybooks() {
  if (IS_GITHUB_PAGES) return readLocalPlaybooks();
  return validateLibrary(await fetch("/api/playbooks").then((response) => parse<unknown>(response)));
}
export async function createPlaybook(playbook: PlaybookDraft) {
  if (IS_GITHUB_PAGES) return persistLocalPlaybook({ ...playbook, created_at: undefined, updated_at: undefined }, localId());
  const saved = await fetch("/api/playbooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(playbook) }).then((response) => parse<PlaybookDocument>(response));
  announceChange(); return saved;
}
export async function updatePlaybook(playbook: PlaybookDraft) {
  if (IS_GITHUB_PAGES) {
    if (!readLocalPlaybooks().some((item) => item.id === playbook.id)) throw new Error("Saved play not found");
    return persistLocalPlaybook(playbook);
  }
  const saved = await fetch(`/api/playbooks/${encodeURIComponent(playbook.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(playbook) }).then((response) => parse<PlaybookDocument>(response));
  announceChange(); return saved;
}
export async function deletePlaybook(id: string) {
  if (IS_GITHUB_PAGES) { writeLocalPlaybooks(readLocalPlaybooks().filter((item) => item.id !== id)); return { deleted: true, id }; }
  const deleted = await fetch(`/api/playbooks/${encodeURIComponent(id)}`, { method: "DELETE" }).then((response) => parse<{ deleted: boolean; id: string }>(response));
  announceChange(); return deleted;
}
