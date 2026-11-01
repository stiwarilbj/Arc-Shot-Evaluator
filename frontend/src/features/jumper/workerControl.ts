/** Control messages stay separate from inference/rendering request validation. */
export function installWorkerControl(scope: {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(value: unknown): void;
}) {
  scope.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data?.id !== "string" || !["job-ping", "job-cancel"].includes(data.kind)) return;
    event.stopImmediatePropagation();
    scope.postMessage({ id: data.id, kind: data.kind === "job-ping" ? "job-pong" : "job-cancelled" });
  });
}
