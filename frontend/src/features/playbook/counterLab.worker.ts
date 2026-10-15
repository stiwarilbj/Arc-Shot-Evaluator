import { analyzeCounterLab } from "./counterLabEngine.ts";
import type { CounterLabRequest, CounterLabMessage, CounterLabFrame } from "./counterLabTypes.ts";
import { packReplay, replayResponse, type ReplayArchive } from "./counterLabReplayArchive.ts";

const cancelled = new Set<string>();
const active = new Set<string>();
const details = new Map<string, Map<string, ReplayArchive>>();
const post = (message: CounterLabMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
function storeDetails(id: string, traces: Map<string, CounterLabFrame[]>) {
  const stored = details.get(id) ?? new Map<string, ReplayArchive>();
  for (const [key, trace] of traces) if (!stored.has(key)) stored.set(key, packReplay(trace));
  details.set(id, stored);
}
self.onmessage = (event: MessageEvent<CounterLabRequest>) => {
  const request = event.data;
  if (request.type === "cancel") { if (active.has(request.id)) cancelled.add(request.id); return; }
  if (request.type === "release") { details.delete(request.id); return; }
  if (request.type === "details") {
    const traces = details.get(request.id);
    const original = traces?.get(`original:${request.key}`), repaired = request.repairId === "original" ? undefined : traces?.get(`${request.repairId}:${request.key}`);
    const a = original ? replayResponse(original) : null, b = repaired ? replayResponse(repaired) : null;
    post({ ...request, original: a?.archive ?? null, repaired: b?.archive ?? null }, [...(a?.transfer ?? []), ...(b?.transfer ?? [])]);
    return;
  }
  cancelled.delete(request.id);
  active.add(request.id);
  void analyzeCounterLab(request.draft, request.profiles, request.modes,
    (progress) => { if (!cancelled.has(request.id)) post({ type: "progress", id: request.id, ...progress }); }, () => cancelled.has(request.id),
    (results, traces) => { if (!cancelled.has(request.id)) { storeDetails(request.id, traces); post({ type: "baseline", id: request.id, results }); } },
  ).then((analysis) => {
    if (cancelled.has(request.id)) return;
    storeDetails(request.id, analysis.detailTraces);
    post({ type: "complete", id: request.id, results: analysis.results, repairs: analysis.repairs });
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") { post({ type: "cancelled", id: request.id }); return; }
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : "The comparison could not finish. Try again." });
  }).finally(() => { active.delete(request.id); cancelled.delete(request.id); });
};
export {};
