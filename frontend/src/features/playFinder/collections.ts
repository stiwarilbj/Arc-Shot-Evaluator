import type { CollectionBackup, FilmCollection } from "./types";

const STORAGE_KEY = "arc-play-finder-collections-v1";

export function readCollections(): FilmCollection[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isCollection)) throw new Error("Saved collection data is unreadable");
    return parsed;
  } catch (error) {
    console.error("Could not read ARC Play Finder collections", error);
    return [];
  }
}

export function writeCollections(collections: FilmCollection[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collections));
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Browser storage is unavailable" };
  }
}

export function createCollection(name: string): FilmCollection {
  const now = new Date().toISOString();
  return { id: makeId(), name: name.trim(), clipIds: [], notesByClip: {}, createdAt: now, updatedAt: now };
}

export function duplicateCollection(collection: FilmCollection): FilmCollection {
  const now = new Date().toISOString();
  return { ...collection, id: makeId(), name: `${collection.name} copy`, clipIds: [...collection.clipIds], notesByClip: { ...collection.notesByClip }, createdAt: now, updatedAt: now };
}

export function exportCollections(collections: FilmCollection[]): CollectionBackup {
  return { version: 1, exportedAt: new Date().toISOString(), collections };
}

export function parseCollectionBackup(raw: string): FilmCollection[] {
  const parsed: unknown = JSON.parse(raw);
  const collections = Array.isArray(parsed) ? parsed : (parsed as Partial<CollectionBackup>)?.version === 1 ? (parsed as CollectionBackup).collections : null;
  if (!Array.isArray(collections) || !collections.every(isCollection)) throw new Error("This file is not a valid ARC Play Finder collection backup");
  return collections;
}

export function isCollection(value: unknown): value is FilmCollection {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FilmCollection>;
  return typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.clipIds)
    && item.clipIds.every((id) => typeof id === "string") && Boolean(item.notesByClip && typeof item.notesByClip === "object")
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `collection-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
