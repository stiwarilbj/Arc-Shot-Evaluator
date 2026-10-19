import { WorkerJob } from "./workerJob";
import type { SourceFrameMap } from "./sourceFrames";
import { IS_GITHUB_PAGES } from "../../runtime";
export async function detectPeople(
  file: File,
  time: number,
  signal: AbortSignal,
  frameMap?: SourceFrameMap,
): Promise<number[][]> {
  signal.throwIfAborted();
  if (IS_GITHUB_PAGES)
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./detection.worker.ts", import.meta.url),
        { type: "module" },
      );
      const id = crypto.randomUUID();
      const job = new WorkerJob(worker, id, signal, reject);
      worker.onmessage = ({ data }) => {
        if (job.receive(data)) return;
        if (data.error) job.fail("failed", Error(data.error));
        else if (
          Array.isArray(data.boxes) &&
          data.boxes.length <= 20 &&
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
          { job.finish("completed"); resolve(data.boxes); }
        else job.fail("failed", Error("Invalid detection result"));
      };
      job.start({ id, file, time, frame_map: frameMap });
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
    const boxes = (await result.json()).boxes;
    if (!Array.isArray(boxes) || boxes.length > 20)
      throw Error(
        "More than 20 people detected. Trim closer or select players manually.",
      );
    return boxes;
  } finally {
    if (id) void fetch(`/api/jumper-lab/jobs/${id}`, { method: "DELETE" });
  }
}
