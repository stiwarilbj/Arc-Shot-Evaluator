import { analyzeCounterLab } from "./counterLabEngine.ts";
import type { CounterLabRequest, CounterLabMessage, CounterLabFrame } from "./counterLabTypes.ts";

const cancelled = new Set<string>();
const details = new Map<string, Map<string, CounterLabFrame[]>>();
const post = (message: CounterLabMessage) => self.postMessage(message);
self.onmessage = (event: MessageEvent<CounterLabRequest>) => {
  const request = event.data;
  if (request.type === "cancel") { cancelled.add(request.id); return; }
  if (request.type === "details") {
    const traces = details.get(request.id);
    post({ ...request, original: traces?.get(`original:${request.key}`) ?? null,
      repaired: request.repairId === "original" ? null : traces?.get(`${request.repairId}:${request.key}`) ?? null });
    return;
  }
  cancelled.delete(request.id);
  details.clear();
  void analyzeCounterLab(request.draft, request.profiles, request.modes,
    (progress) => post({ type: "progress", id: request.id, ...progress }), () => cancelled.has(request.id),
    (results, traces) => { details.set(request.id, traces); post({ type: "baseline", id: request.id, results }); },
  ).then((analysis) => {
    if (cancelled.has(request.id)) return;
    details.set(request.id, analysis.detailTraces);
    post({ type: "complete", id: request.id, results: analysis.results, repairs: analysis.repairs });
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") { post({ type: "cancelled", id: request.id }); return; }
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : "The comparison could not finish. Try again." });
  });
};
export {};
