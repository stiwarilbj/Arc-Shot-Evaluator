import { IS_GITHUB_PAGES } from "../../runtime";
import { isProject, projectFrames, type EditProject } from "./editProject";
import { type EditedVideos } from "./editRenderer";
export async function exportEdits(
  base: Blob,
  project: EditProject,
  progress: (value: number) => void,
  signal: AbortSignal,
): Promise<EditedVideos> {
  if (!isProject(project)) throw Error("Invalid edit project");
  signal.throwIfAborted();
  try {
    return await new Promise<EditedVideos>((resolve, reject) => {
      const id = crypto.randomUUID(),
        worker = new Worker(new URL("./editing.worker.ts", import.meta.url), {
          type: "module",
        });
      const timer = setTimeout(() => {
        cleanup();
        reject(
          Error("Rendering timed out. Your previous result is preserved."),
        );
      }, 300000);
      const cleanup = () => {
        clearTimeout(timer);
        worker.terminate();
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new DOMException("Rendering cancelled", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = () => {
        cleanup();
        reject(
          Error("Video rendering stopped. Your previous result is preserved."),
        );
      };
      worker.onmessageerror = () => {
        cleanup();
        reject(
          Error(
            "The rendered response could not be read. Retry without masking again.",
          ),
        );
      };
      worker.onmessage = ({ data }) => {
        if (signal.aborted || data?.id !== id) return;
        if (data.kind === "progress" && Number.isFinite(data.progress))
          progress(data.progress);
        if (data.kind === "error") {
          cleanup();
          reject(Error(data.error));
        }
        if (data.kind === "done") {
          cleanup();
          if (
            ![data.result?.highlight, data.result?.clean].every(
              (v) =>
                v instanceof Blob &&
                v.size > 0 &&
                v.size <= 100 * 1024 * 1024 &&
                ["video/mp4", "video/webm"].includes(v.type),
            ) ||
            data.result.duration !== projectFrames(project) / 30
          )
            reject(Error("Invalid rendered video response"));
          else resolve(data.result);
        }
      };
      try {
        worker.postMessage({ kind: "render", id, base, project });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } catch (error) {
    if (signal.aborted || IS_GITHUB_PAGES) throw error;
    // The local fallback is queued and never initializes inference.
    const data = new FormData();
    data.set("base", base);
    data.set("project", JSON.stringify(project));
    const localSignal = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
    const response = await fetch("/api/jumper-lab/edits", {
      method: "POST",
      body: data,
      signal: localSignal,
    });
    if (!response.ok)
      throw Error((await response.json()).detail ?? "Local rendering failed");
    const { id } = await response.json();
    const started = performance.now();
    try {
      while (true) {
        if (performance.now() - started > 300000)
          throw Error("Local rendering timed out; retry a shorter edit.");
        localSignal.throwIfAborted();
        const stateResponse = await fetch(`/api/jumper-lab/edits/${id}`, {
          signal: localSignal,
        });
        if (!stateResponse.ok)
          throw Error("Local render status is unavailable");
        const state = await stateResponse.json();
        progress(state.progress ?? 0);
        if (state.error) throw Error(state.error);
        if (state.done) {
          const videos = await Promise.all(
            ["highlight", "clean"].map(async (kind) => {
              const r = await fetch(`/api/jumper-lab/edits/${id}/${kind}`, {
                signal: localSignal,
              });
              if (!r.ok) throw Error("Rendered video unavailable");
              return r.blob();
            }),
          );
          return {
            highlight: videos[0],
            clean: videos[1],
            duration: projectFrames(project) / 30,
          };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      void fetch(`/api/jumper-lab/edits/${id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
  }
}
