import {
  MAX_LIBRARY_BYTES,
  MAX_PROJECTS,
  validateProject,
  type StoredProject,
} from "./types.ts";
const DB = "arc-freeze-floor-v1";
export type UnavailableProject = { key: IDBValidKey; name?: string };
export type ProjectListing = {
  projects: StoredProject[];
  unavailable: UnavailableProject[];
};
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    let abandoned = false;
    r.onupgradeneeded = () => {
      r.result.createObjectStore("projects", { keyPath: "project.id" });
    };
    r.onerror = () =>
      reject(
        Error(
          "Private storage could not open · Your current image is still available",
        ),
      );
    r.onblocked = () => {
      abandoned = true;
      reject(Error("Close another ARCade Hoops tab to open private storage"));
    };
    r.onsuccess = () => {
      if (abandoned) {
        r.result.close();
        return;
      }
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
function valid(v: unknown): v is StoredProject {
  const s = v as StoredProject;
  try {
    return (
      !!s &&
      validateProject(s.project) &&
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
              Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt),
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
export async function saveProject(value: StoredProject): Promise<void> {
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
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite"),
        store = tx.objectStore("projects"),
        request = store.getAll();
      let failure: Error | undefined;
      request.onsuccess = () => {
        const others = (request.result as StoredProject[]).filter(
          (s) => s.project?.id !== value.project.id,
        );
        if (others.length >= MAX_PROJECTS) {
          failure = Error(
            "Your 20-project library is full · Delete a project first",
          );
          tx.abort();
          return;
        }
        const bytes =
          others.reduce(
            (s, v) =>
              s +
              (v.image?.size || 0) +
              new Blob([JSON.stringify(v.project)]).size,
            0,
          ) +
          value.image.size +
          new Blob([JSON.stringify(value.project)]).size;
        if (bytes > MAX_LIBRARY_BYTES) {
          failure = Error(
            "Private library exceeds 200 MiB · Delete a project first",
          );
          tx.abort();
          return;
        }
        store.put(value);
      };
      tx.oncomplete = () => resolve();
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
export async function deleteProject(id: string) {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(Error("Deletion did not finish · Retry"));
      tx.onerror = () => {};
    });
  } finally {
    db.close();
  }
}
