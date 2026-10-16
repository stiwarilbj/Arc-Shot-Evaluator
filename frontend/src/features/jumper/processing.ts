import { IS_GITHUB_PAGES } from "../../runtime";
import {
  MAX_BYTES,
  maskResult,
  validateMaskRequest,
  type MaskRequest,
  type MaskResult,
  type JobProgress,
  type WorkerResponse,
} from "./domain";
export async function processVideo(
  file: File,
  request: MaskRequest,
  progress: (value: JobProgress) => void,
  signal: AbortSignal,
): Promise<MaskResult> {
  validateMaskRequest(request);
  if (file.size > MAX_BYTES) throw Error("Files must be at most 100 MB");
  signal.throwIfAborted();
  if (IS_GITHUB_PAGES) {
    if (!("gpu" in navigator) || !("VideoEncoder" in globalThis))
      throw Error(
        "This editor needs WebGPU and video encoding. Guess and My Clips still work; use Chrome or the downloaded app to create clips.",
      );
    if (!(await navigator.gpu.requestAdapter()))
      throw Error(
        "WebGPU is unavailable on this device. Use the downloaded editor.",
      );
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./masking.worker.ts", import.meta.url),
        { type: "module" },
      );
      const id = crypto.randomUUID();
      const cleanup = () => {
        worker.terminate();
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new DOMException("Processing cancelled", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = () => {
        cleanup();
        reject(
          Error(
            "Masking worker stopped. Your source is unchanged; retry or use the downloaded editor.",
          ),
        );
      };
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (!data || data.id !== id) return;
        if (
          data.kind === "progress" &&
          Number.isFinite(data.progress) &&
          typeof data.stage === "string"
        )
          progress(data);
        else if (data.kind === "error" && typeof data.error === "string") {
          cleanup();
          reject(Error(data.error));
        } else if (data.kind === "done") {
          cleanup();
          if (maskResult(data.result)) resolve(data.result);
          else
            reject(
              Error(
                "The masking worker returned invalid videos. Retry processing.",
              ),
            );
        }
      };
      worker.postMessage({ kind: "process", id, file, request });
    });
  }
  let id: string | undefined;
  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(`/api/jumper-lab${path}`, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    if (!response.ok) {
      let message = `Local editor returned ${response.status}`;
      try {
        message = (await response.json()).detail ?? message;
      } catch {}
      throw Error(message);
    }
    return response;
  }
  try {
    progress({ stage: "Sending video to your local app", progress: 0 });
    const form = new FormData();
    form.set("file", file);
    id = (await (await api("/jobs", { method: "POST", body: form })).json()).id;
    await api(`/jobs/${id}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    while (true) {
      signal.throwIfAborted();
      const state = await (await api(`/jobs/${id}`)).json();
      progress({ stage: state.stage, progress: state.progress });
      if (state.status === "error")
        throw Error(state.error ?? "Local processing failed");
      if (state.status === "cancelled")
        throw new DOMException("Processing cancelled", "AbortError");
      if (state.status === "done") {
        const [highlight, quiz, reveal] = await Promise.all(
          ["highlight", "quiz", "reveal"].map(async (kind) =>
            (await api(`/jobs/${id}/output/${kind}`)).blob(),
          ),
        );
        const result = {
          highlight,
          quiz,
          reveal,
          duration: state.result.duration,
          warnings: state.result.warnings,
        };
        if (!maskResult(result))
          throw Error("Local editor returned invalid videos");
        return result;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Cancelled", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 600);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  } finally {
    if (id)
      void fetch(`/api/jumper-lab/jobs/${id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
  }
}
