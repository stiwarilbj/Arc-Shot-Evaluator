import { IS_GITHUB_PAGES } from "../../runtime";
export async function detectPeople(
  file: File,
  time: number,
  signal: AbortSignal,
): Promise<number[][]> {
  signal.throwIfAborted();
  if (IS_GITHUB_PAGES)
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./detection.worker.ts", import.meta.url),
        { type: "module" },
      );
      const cleanup = () => {
        worker.terminate();
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = () => {
        cleanup();
        reject(Error("Detection failed; add players manually."));
      };
      worker.onmessage = ({ data }) => {
        cleanup();
        if (data.error) reject(Error(data.error));
        else if (
          Array.isArray(data.boxes) &&
          data.boxes.every(
            (b: unknown) =>
              Array.isArray(b) &&
              b.length === 4 &&
              b.every(
                (n) =>
                  typeof n === "number" &&
                  Number.isFinite(n) &&
                  n >= 0 &&
                  n <= 1,
              ),
          )
        )
          resolve(data.boxes);
        else reject(Error("Invalid detection result"));
      };
      worker.postMessage({ file, time });
    });
  let id: string | undefined;
  try {
    const form = new FormData();
    form.set("file", file);
    const uploaded = await fetch("/api/jumper-lab/jobs", {
      method: "POST",
      body: form,
      signal,
    });
    if (!uploaded.ok) throw Error("Could not upload for detection");
    id = (await uploaded.json()).id;
    const result = await fetch(
      `/api/jumper-lab/jobs/${id}/people?time=${time}`,
      { signal },
    );
    if (!result.ok) throw Error("Detection unavailable; add players manually");
    return (await result.json()).boxes;
  } finally {
    if (id) void fetch(`/api/jumper-lab/jobs/${id}`, { method: "DELETE" });
  }
}
