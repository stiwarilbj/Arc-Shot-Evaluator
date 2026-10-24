import { getSimulationSessionInfo, restoreSimulationSession } from "./simulationSession.ts";
import { advanceExportRunTo } from "./simulationExport.ts";
import { validateReadCoachSessionRecord } from "./documentValidation.ts";
import type { getSimulationFrame } from "./simulation.ts";
import type { ReadCoachSessionRecord } from "./types.ts";

type ExportFrame = { atMs: number; frame: ReturnType<typeof getSimulationFrame> };
type Start = { type: "start"; jobId: string; session: ReadCoachSessionRecord; startMs: number; endMs: number; fps: number };
type Cancel = { type: "cancel"; jobId: string };
const cancelled = new Set<string>();
const port = self as DedicatedWorkerGlobalScope;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const isStartMessage = (value: unknown): value is Start => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Start>;
  return candidate.type === "start"
    && typeof candidate.jobId === "string"
    && typeof candidate.session === "object" && candidate.session !== null
    && typeof candidate.startMs === "number"
    && typeof candidate.endMs === "number"
    && typeof candidate.fps === "number";
};

port.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as Partial<Start> | Partial<Cancel> | null;
  if (message?.type === "cancel" && typeof message.jobId === "string") { cancelled.add(message.jobId); return; }
  if (!isStartMessage(message)) return;
  void (async () => {
    try {
      const { jobId } = message;
      const { session, startMs, endMs, fps } = message;
      if (!/^[a-f0-9-]{16,64}$/i.test(jobId)) throw new Error("Export job identity is invalid");
      validateReadCoachSessionRecord(session);
      if (!Number.isFinite(startMs) || startMs < 0 || !Number.isFinite(endMs) || endMs < startMs
        || ![1, 5, 10, 30].includes(fps)) throw new Error("Choose a valid export range and frame rate");
      const run = restoreSimulationSession(structuredClone(session));
      if (endMs > run.durationMs + 1e-6) throw new Error("The export range extends past the recorded possession");
      const frameDuration = 1000 / fps;
      const total = Math.floor((endMs - startMs) / frameDuration + 1e-8) + 1;
      if (total > 5400) throw new Error("This export contains too many frames · Shorten the range or choose a lower frame rate");
      const batch: ExportFrame[] = [];
      async function advanceTo(targetMs: number) {
        let now = getSimulationSessionInfo(run)?.positionMs ?? run.elapsedMs;
        if (targetMs < now - 1e-6) {
          advanceExportRunTo(run, targetMs, session.positionMs, session.hoop);
          now = getSimulationSessionInfo(run)?.positionMs ?? run.elapsedMs;
        }
        let chunks = 0;
        while (now + 1e-6 < targetMs) {
          advanceExportRunTo(run, Math.min(targetMs, now + 50), session.positionMs, session.hoop);
          now = getSimulationSessionInfo(run)?.positionMs ?? run.elapsedMs;
          if (cancelled.has(jobId)) throw new DOMException("Export cancelled", "AbortError");
          if (++chunks % 10 === 0) await pause();
        }
      }
      await advanceTo(startMs);
      for (let index = 0; index < total; index++) {
        if (cancelled.has(jobId)) { cancelled.delete(jobId); port.postMessage({ type: "cancelled", jobId }); return; }
        const atMs = index === total - 1 ? endMs : startMs + index * frameDuration;
        await advanceTo(atMs);
        const frame = advanceExportRunTo(run, atMs, session.positionMs, session.hoop);
        batch.push({ atMs, frame: structuredClone(frame) });
        if (batch.length >= 6 || index === total - 1) {
          port.postMessage({ type: "frames", jobId, frames: batch.splice(0), progress: (index + 1) / total });
          await pause();
        }
      }
      cancelled.delete(jobId); port.postMessage({ type: "done", jobId });
    } catch (error) {
      cancelled.delete(message.jobId);
      port.postMessage({ type: "error", jobId: message.jobId, message: error instanceof Error ? error.message : "Replay export could not be prepared" });
    }
  })();
});
