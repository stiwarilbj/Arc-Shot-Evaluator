import {
  MAX_LIBRARY_BYTES,
  MAX_PROJECTS,
  id,
  validateProject,
  type StoredProject,
} from "./types.ts";
const DB = "arc-freeze-floor-v1";
const OPEN_TIMEOUT_MS = 10_000;
export type UnavailableProject = { key: IDBValidKey; name?: string };
export type ProjectListing = {
  projects: StoredProject[];
  unavailable: UnavailableProject[];
};
export class ProjectConflictError extends Error {}
export function projectRevision(value: StoredProject): string {
  return value.revision === undefined
    ? `legacy:${value.project.updatedAt}`
    : `saved:${value.revision}`;
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    let abandoned = false,
      settled = false;
    const timeout = setTimeout(() => {
      abandoned = true;
      settled = true;
      reject(
        Error(
          "Private storage is not responding · Retry · Your current image remains available for PNG download",
        ),
      );
    }, OPEN_TIMEOUT_MS);
    const fail = (error: Error) => {
      if (settled) return;
      abandoned = true;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    r.onupgradeneeded = () => {
      r.result.createObjectStore("projects", { keyPath: "project.id" });
    };
    r.onerror = () =>
      fail(
        Error(
          "Private storage could not open · Your current image is still available",
        ),
      );
    r.onblocked = () => {
      fail(Error("Close another ARCade Hoops tab to open private storage"));
    };
    r.onsuccess = () => {
      if (abandoned || settled) {
        r.result.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
function valid(v: unknown): v is StoredProject {
  try {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const s = v as StoredProject;
    return (
      validateProject(s.project) &&
      (s.revision === undefined ||
        (typeof s.revision === "string" &&
          s.revision.length > 0 &&
          s.revision.length <= 100)) &&
      s.image instanceof Blob &&
      s.image.size > 0 &&
      s.image.size <= 20 * 1024 * 1024 &&
      s.image.type === "image/jpeg"
    );
  } catch {
    // Malformed nested values must remain unavailable, not interrupt the listing
    return false;
  }
}
export async function listProjects(): Promise<ProjectListing> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction("projects", "readonly"),
        r = t.objectStore("projects").openCursor();
      const projects: StoredProject[] = [],
        unavailable: UnavailableProject[] = [];
      r.onsuccess = () => {
        const cursor = r.result;
        if (!cursor) return;
        const value: unknown = cursor.value;
        if (valid(value)) projects.push(value);
        else {
          const name = (value as Partial<StoredProject> | null)?.project?.name;
          unavailable.push({
            key: cursor.primaryKey,
            name: typeof name === "string" ? name.trim().slice(0, 80) : undefined,
          });
        }
        cursor.continue();
      };
      t.oncomplete = () =>
        resolve({
          projects: projects.sort(
            (a, b) =>
              Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt) ||
              (a.project.id < b.project.id ? -1 : a.project.id > b.project.id ? 1 : 0),
          ),
          unavailable,
        });
      t.onerror = () =>
        reject(t.error || Error("Project listing was interrupted"));
      t.onabort = () =>
        reject(t.error || Error("Project listing was interrupted"));
    });
  } finally {
    db.close();
  }
}
export async function getProject(id: string): Promise<StoredProject | null> {
  const db = await open();
  let value: StoredProject | null = null;
  try {
    value = await new Promise<StoredProject | null>((resolve, reject) => {
      const tx = db.transaction("projects", "readonly"),
        request = tx.objectStore("projects").get(id);
      tx.oncomplete = () => {
        const value: unknown = request.result;
        if (value === undefined) resolve(null);
        else if (valid(value) && value.project.id === id) resolve(value);
        else
          reject(
            Error("Saved project is unavailable · Your current photograph remains open"),
          );
      };
      tx.onabort = () =>
        reject(tx.error || Error("Saved project loading was interrupted"));
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
  if (!value) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(value.image);
  } catch {
    throw Error(
      "Saved image could not be decoded · The record was kept for recovery, but image and coordinates could not be checked",
    );
  }
  try {
    if (
      bitmap.width !== value.project.width ||
      bitmap.height !== value.project.height
    )
      throw Error(
        "Saved image dimensions do not match the project · The record was kept for recovery because its image and coordinates may not match",
      );
  } finally {
    bitmap.close();
  }
  return value;
}
export async function saveProject(
  value: StoredProject,
  expectedRevision: string | null,
): Promise<string> {
  if (!valid(value))
    throw Error(
      "Project could not be validated · Current image remains available",
    );
  const check = await createImageBitmap(value.image);
  try {
    if (
      check.width !== value.project.width ||
      check.height !== value.project.height
    )
      throw Error("Saved image dimensions do not match the project");
  } finally {
    check.close();
  }
  const db = await open();
  const next = { ...value, revision: id() };
  try {
    return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite"),
        store = tx.objectStore("projects"),
        request = store.getAll();
      let failure: Error | undefined;
      const abortWith = (error: Error) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          reject(error);
        }
      };
      request.onsuccess = () => {
        const records: unknown = request.result;
        if (!Array.isArray(records) || !records.every(valid)) {
          abortWith(
            Error(
              "A saved entry could not be checked safely · No saved entries were changed · Your open project remains available",
            ),
          );
          return;
        }
        try {
          const checked = records as StoredProject[],
            stored = checked.find((s) => s.project.id === value.project.id),
            others = checked.filter((s) => s.project.id !== value.project.id);
          if (
            expectedRevision === null
              ? stored !== undefined
              : !stored || projectRevision(stored) !== expectedRevision
          ) {
            abortWith(
              new ProjectConflictError(
                `${stored ? "This project changed in another tab" : "This project was deleted"} · Your edits are still here · Download a PNG before reopening the saved project`,
              ),
            );
            return;
          }
          if (others.length >= MAX_PROJECTS) {
            abortWith(
              Error("Your 20-project library is full · Delete a project first"),
            );
            return;
          }
          const bytes =
            others.reduce(
              (s, v) =>
                s +
                v.image.size +
                new Blob([JSON.stringify(v.project)]).size,
              0,
            ) +
            value.image.size +
            new Blob([JSON.stringify(value.project)]).size;
          if (bytes > MAX_LIBRARY_BYTES) {
            abortWith(
              Error("Private library exceeds 200 MiB · Delete a project first"),
            );
            return;
          }
          store.put(next);
        } catch {
          abortWith(
            Error(
              "Saved library size or update could not be checked safely · No saved entries were changed · Your open project remains available",
            ),
          );
        }
      };
      tx.oncomplete = () => resolve(projectRevision(next));
      tx.onabort = () =>
        reject(
          failure ||
            Error("Could not save · Download a PNG or free browser storage"),
        );
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
export async function deleteProject(id: string, expectedRevision: string) {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite"),
        store = tx.objectStore("projects"),
        request = store.get(id);
      let failure: Error | undefined;
      request.onsuccess = () => {
        const stored: unknown = request.result;
        if (!valid(stored) || projectRevision(stored) !== expectedRevision) {
          failure = new ProjectConflictError(
            stored === undefined
              ? "This project was already deleted · Refresh the library before choosing another project"
              : "This project changed in another tab · The saved version was kept · Refresh and review the library before confirming deletion again",
          );
          tx.abort();
          return;
        }
        store.delete(id);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(failure || Error("Deletion did not finish · Retry"));
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
