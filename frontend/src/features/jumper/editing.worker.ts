/// <reference lib="webworker" />
import { isProject } from "./editProject";
import { renderEdits } from "./editRenderer";
const scope = self as unknown as DedicatedWorkerGlobalScope;
let running = false;
scope.onmessage = async ({ data }) => {
  if (
    running ||
    !data ||
    data.kind !== "render" ||
    typeof data.id !== "string" ||
    !isProject(data.project) ||
    !(data.base instanceof Blob)
  ) {
    scope.postMessage({
      kind: "error",
      id: data?.id,
      error: "Invalid edit-render request",
    });
    return;
  }
  running = true;
  try {
    const result = await renderEdits(data.base, data.project, (progress) =>
      scope.postMessage({ kind: "progress", id: data.id, progress }),
    );
    scope.postMessage({ kind: "done", id: data.id, result });
  } catch (error) {
    scope.postMessage({ kind: "error", id: data.id, error: String(error) });
  } finally {
    running = false;
  }
};
