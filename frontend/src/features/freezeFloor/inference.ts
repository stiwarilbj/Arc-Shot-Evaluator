import { id, validResponse, type InferenceResponse } from "./types.ts";
export async function analyzePhoto(
  blob: Blob,
  imageId: string,
  revision: number,
  signal: AbortSignal,
  onProgress: (s: string) => void,
): Promise<Extract<InferenceResponse, { type: "result" }>> {
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(blob);
  if (signal.aborted) {
    bitmap.close();
    signal.throwIfAborted();
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./inference.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (e) {
    bitmap.close();
    throw e;
  }
  const jobId = id();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (
      error?: unknown,
      value?: Extract<InferenceResponse, { type: "result" }>,
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    const abort = () =>
      finish(new DOMException("Processing cancelled", "AbortError"));
    const timeout = setTimeout(
      () =>
        finish(
          Error(
            "Automatic analysis took too long · Retry or use manual alignment",
          ),
        ),
      180000,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      bitmap.close();
      abort();
      return;
    }
    worker.onerror = () =>
      finish(Error("Image worker interrupted · Retry or use manual alignment"));
    worker.onmessageerror = () =>
      finish(Error("Image worker returned an unreadable response"));
    worker.onmessage = (e) => {
      if (!validResponse(e.data)) {
        finish(Error("Image worker returned invalid predictions"));
        return;
      }
      const r = e.data;
      if (r.imageId !== imageId || r.jobId !== jobId || r.revision !== revision)
        return;
      if (r.type === "progress") onProgress(r.message);
      else if (r.type === "error") finish(Error(r.message));
      else finish(undefined, r);
    };
    try {
      worker.postMessage(
        { type: "analyze", imageId, jobId, revision, image: bitmap },
        [bitmap],
      );
    } catch (e) {
      bitmap.close();
      finish(e);
    }
  });
}
