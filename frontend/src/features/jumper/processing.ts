import { WorkerJob } from "./workerJob";
import { sameFrameMap } from "./sourceFrames";
import { sourceFrameMap } from "./sourceFrameMedia";
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
import { ShooterSelectionCache } from "./shooterSelection";
import { confirmedShooterFrame } from "./trackingCheck";

const shooterSelections = new ShooterSelectionCache();

export async function prepareShooterSelection(
  file: File,
  request: MaskRequest,
  progress: (value: JobProgress) => void,
  signal: AbortSignal,
): Promise<MaskRequest> {
  validateMaskRequest(request);
  if (file.size > MAX_BYTES) throw Error("Files must be at most 100 MB");

  request = { ...request, frame_map: request.frame_map ?? await sourceFrameMap(file, request.start, request.end, signal) };
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
  }
  return shooterSelections.resolve(
    file,
    request,
    async (source, time, abort) => {
      progress({ stage: "Finding your selected shooter's body", progress: 0 });
      const { detectPeople } = await import("./detection");
      return detectPeople(source, time, abort, request.frame_map);
    },
    signal,
  );
}

export async function processVideo(
  file: File,
  request: MaskRequest,
  progress: (value: JobProgress) => void,
  signal: AbortSignal,
): Promise<MaskResult> {
  request = await prepareShooterSelection(file, request, progress, signal);
  signal.throwIfAborted();
  const anchor = request.verify_shooter
    ? confirmedShooterFrame(request.objects, request.target_id)
    : undefined;
  const matchesCheck = (result: MaskResult) =>
    sameFrameMap(result.frame_map, request.frame_map) &&
    (anchor === undefined
      ? result.tracking_check === undefined
      : result.tracking_check?.anchor_frame === anchor &&
        result.tracking_check.target_id === request.target_id);
  if (IS_GITHUB_PAGES) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const worker = new Worker(
        new URL("./masking.worker.ts", import.meta.url),
        { type: "module" },
      );
      const id = crypto.randomUUID();
      const job = new WorkerJob(worker, id, signal, reject);
      const fail = (error: unknown) => job.fail("failed", error);
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (job.receive(data)) return;
        if (
          data.kind === "progress" &&
          Number.isFinite(data.progress) &&
          data.progress >= 0 &&
          data.progress <= 1 &&
          typeof data.stage === "string"
        )
          progress(data);
        else if (data.kind === "error" && typeof data.error === "string") {
          fail(Error(data.error));
        } else if (data.kind === "done") {
          if (
            maskResult(data.result) &&
            matchesCheck(data.result) &&
            (!request.presentation?.startsWith("silhouette") ||
              (data.result.highlight === data.result.quiz &&
                data.result.quiz === data.result.reveal)) &&
            (!request.auto_detect_others ||
              data.result.objects?.some(
                (o) => o.id === request.target_id && !o.ignored,
              ))
          )
            { job.finish("completed"); resolve(data.result); }
          else
            fail(
              Error(
                "The masking worker returned invalid videos. Retry processing.",
              ),
            );
        } else
          fail(
            Error(
              "The masking worker returned an invalid response. Retry processing.",
            ),
          );
      };
      job.start({ kind: "process", id, file, request });
    });
  }
  let id: string | undefined;
  async function api(path: string, init: RequestInit = {}) {
    signal.throwIfAborted();
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
    signal.throwIfAborted();
    progress({ stage: "Sending video to your local app", progress: 0 });
    const form = new FormData();
    form.set("file", file);
    id = (await (await api("/jobs", { method: "POST", body: form })).json()).id;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) {
      id = undefined;
      throw Error(
        "Local editor returned an invalid upload identity. Retry uploading.",
      );
    }
    await api(`/jobs/${id}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    while (true) {
      signal.throwIfAborted();
      const state: {
        id: string;
        status: string;
        stage: string;
        progress: number;
        error?: string;
        result?: Pick<
          MaskResult,
          "objects" | "duration" | "warnings" | "tracking_check" | "frame_map"
        >;
      } = await (await api(`/jobs/${id}`)).json();
      if (
        !state ||
        state.id !== id ||
        ![
          "uploaded",
          "queued",
          "processing",
          "error",
          "cancelled",
          "done",
        ].includes(state.status) ||
        typeof state.stage !== "string" ||
        !Number.isFinite(state.progress) ||
        state.progress < 0 ||
        state.progress > 1
      )
        throw Error(
          "Local editor returned an invalid job update. Retry processing.",
        );
      progress({ stage: state.stage, progress: state.progress });
      if (state.status === "error")
        throw Error(state.error ?? "Local processing failed");
      if (state.status === "cancelled")
        throw new DOMException("Processing cancelled", "AbortError");
      if (state.status === "done") {
        if (!state.result || typeof state.result !== "object")
          throw Error(
            "Local editor returned an incomplete result. Retry processing.",
          );
        const kinds = request.presentation?.startsWith("silhouette")
          ? ["quiz"]
          : ["highlight", "quiz", "reveal"];
        const values = await Promise.all(
          kinds.map(async (kind) =>
            (await api(`/jobs/${id}/output/${kind}`)).blob(),
          ),
        );
        const result = {
          highlight: values[0],
          quiz: values[1] ?? values[0],
          reveal: values[2] ?? values[0],
          objects: state.result.objects,
          duration: state.result.duration,
          warnings: state.result.warnings,
          tracking_check: state.result.tracking_check,
          frame_map: state.result.frame_map,
        };
        if (
          !maskResult(result) ||
          !matchesCheck(result) ||
          (request.auto_detect_others &&
            !result.objects?.some(
              (o: { id: number; ignored?: boolean }) =>
                o.id === request.target_id && !o.ignored,
            ))
        )
          throw Error("Local editor returned invalid videos");
        return result;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(new DOMException("Cancelled", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 600);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
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
