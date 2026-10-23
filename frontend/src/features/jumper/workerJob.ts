/** One owner for terminal state, cancellation acknowledgment and worker cleanup. */
export type TerminationReason = "completed" | "cancelled" | "failed" | "interrupted";
export class WorkerInterruptedError extends Error {
  readonly terminationReason = "interrupted";
  constructor(message = "Video operation interrupted: the worker stopped responding · Retry; your previous finished video is preserved") {
    super(message);
    this.name = "WorkerInterruptedError";
  }
}
export class WorkerJob {
  private termination?: TerminationReason;
  private started = false;
  private cancelling = false;
  private seen = performance.now();
  private timer: ReturnType<typeof setInterval>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private cancelTimer?: ReturnType<typeof setTimeout>;
  private visibility = () => { this.seen = performance.now(); };
  private worker: Worker;
  readonly id: string;
  private signal: AbortSignal;
  private reject: (error: unknown) => void;
  constructor(worker: Worker, id: string, signal: AbortSignal, reject: (error: unknown) => void, timeout?: number) {
    this.worker = worker;
    this.id = id;
    this.signal = signal;
    this.reject = reject;
    this.timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) { this.visibility(); return; }
      if (performance.now() - this.seen > 120000) {
        this.fail("interrupted", new WorkerInterruptedError());
      } else {
        try { worker.postMessage({ kind: "job-ping", id }); }
        catch { this.fail("interrupted", new WorkerInterruptedError()); }
      }
    }, 10000);
    if (timeout) this.deadlineTimer = setTimeout(() => this.fail("interrupted", new WorkerInterruptedError("Rendering timed out · Your previous result is preserved")), timeout);
    worker.onerror = () => this.fail("interrupted", new WorkerInterruptedError());
    worker.onmessageerror = () => this.fail("interrupted", new WorkerInterruptedError("The worker response could not be read · Retry; your previous result is preserved"));
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.visibility);
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  get reason() { return this.termination; }
  get active() { return this.termination === undefined; }
  start(message: unknown) {
    if (!this.active || this.signal.aborted) return;
    this.started = true;
    try { this.worker.postMessage(message); }
    catch { this.fail("interrupted", new WorkerInterruptedError("Could not send the video to the worker · Retry; your previous result is preserved")); }
  }
  private abort = () => {
    if (!this.active || this.cancelling) return;
    this.cancelling = true;
    if (!this.started) { this.cancelled(); return; }
    this.cancelTimer = setTimeout(() => this.fail("interrupted", new WorkerInterruptedError()), 2000);
    try { this.worker.postMessage({ kind: "job-cancel", id: this.id }); }
    catch { this.fail("interrupted", new WorkerInterruptedError()); }
  };
  private cancelled() {
    if (this.finish("cancelled")) this.reject(new DOMException("Processing cancelled", "AbortError"));
  }
  /** True means a control, stale, or post-cancellation message was consumed. */
  receive(data: { id?: string; kind?: string } | null | undefined) {
    if (!this.active || data?.id !== this.id) return true;
    this.seen = performance.now();
    if (data.kind === "job-cancelled") {
      if (this.cancelling) this.cancelled();
      return true;
    }
    return this.cancelling || data.kind === "job-pong";
  }
  finish(reason: TerminationReason) {
    if (!this.active) return false;
    this.termination = reason;
    clearInterval(this.timer);
    clearTimeout(this.cancelTimer);
    clearTimeout(this.deadlineTimer);
    this.signal.removeEventListener("abort", this.abort);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.visibility);
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
    this.worker.terminate();
    return true;
  }
  fail(reason: "failed" | "interrupted", error: unknown) {
    if (this.finish(reason)) this.reject(error);
  }
}
