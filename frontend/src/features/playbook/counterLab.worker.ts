import { analyzeCounterLab } from "./counterLabEngine.ts";
import type { CounterLabRequest, CounterLabMessage } from "./counterLabTypes.ts";
import { replayResponse } from "./counterLabReplayArchive.ts";
import { createCounterLabDetailQueue } from "./counterLabDetailQueue.ts";
import { createCounterLabAnalysisLifecycle } from "./counterLabAnalysisLifecycle.ts";

const lifecycle = createCounterLabAnalysisLifecycle();
const post = (message: CounterLabMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
const detailQueue = createCounterLabDetailQueue((request) => {
  const original = lifecycle.archive(request.id, `original:${request.key}`), repaired = request.repairId === "original" ? undefined : lifecycle.archive(request.id, `${request.repairId}:${request.key}`);
  const a = original ? replayResponse(original) : null, b = repaired ? replayResponse(repaired) : null;
  post({ ...request, original: a?.archive ?? null, repaired: b?.archive ?? null }, [...(a?.transfer ?? []), ...(b?.transfer ?? [])]);
});
self.onmessage = (event: MessageEvent<CounterLabRequest>) => {
  const request = event.data;
  if (request.type === "cancel") { lifecycle.cancel(request.id); return; }
  if (request.type === "release") { detailQueue.release(request.id); lifecycle.release(request.id); return; }
  if (request.type === "details") {
    detailQueue.request(request);
    return;
  }
  detailQueue.release(request.id);
  const owner = lifecycle.start(request.id);
  void analyzeCounterLab(request.draft, request.profiles, request.modes,
    (progress) => { if (lifecycle.canPublish(owner)) post({ type: "progress", id: request.id, ...progress }); }, () => lifecycle.shouldCancel(owner),
    (results, traces) => { if (lifecycle.store(owner, traces) && lifecycle.canPublish(owner)) post({ type: "baseline", id: request.id, results }); },
  ).then((analysis) => {
    if (!lifecycle.store(owner, analysis.detailTraces) || !lifecycle.canPublish(owner)) return;
    post({ type: "complete", id: request.id, results: analysis.results, repairs: analysis.repairs });
  }).catch((error: unknown) => {
    if (!lifecycle.owns(owner)) return;
    if (error instanceof DOMException && error.name === "AbortError") { post({ type: "cancelled", id: request.id }); return; }
    if (!lifecycle.canPublish(owner)) return;
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : "The comparison could not finish. Try again." });
  }).finally(() => { lifecycle.finish(owner); });
};
export {};
