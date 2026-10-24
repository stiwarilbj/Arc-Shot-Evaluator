import { parseCounterLabRequest, counterLabRequestError } from "./counterLabRequests.ts";
import { analyzeCounterLab, analyzeCounterLabDilemma } from "./counterLabEngine.ts";
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
type DilemmaOwner = { id: string; dilemmaId: string; cancelled: boolean; archives: Map<string, import("./counterLabReplayArchive.ts").ReplayArchive>; detailId: string | null };
const dilemmaOwners = new Map<string, DilemmaOwner>();
const dilemmaKey = (id: string, dilemmaId: string) => `${id}\u0000${dilemmaId}`;
self.onmessage = (event: MessageEvent<unknown>) => {
  let request: CounterLabRequest;
  try { request = parseCounterLabRequest(event.data); }
  catch (error: unknown) { post(counterLabRequestError(event.data, error)); return; }
  if (request.type === "cancel") { lifecycle.cancel(request.id); return; }
  if (request.type === "release") {
    detailQueue.release(request.id); lifecycle.release(request.id);
    for (const [key, owner] of dilemmaOwners) if (owner.id === request.id) { owner.cancelled = true; dilemmaOwners.delete(key); }
    return;
  }
  if (request.type === "dilemma-cancel") {
    const key = dilemmaKey(request.id, request.dilemmaId);
    const owner = dilemmaOwners.get(key);
    if (owner) { owner.cancelled = true; dilemmaOwners.delete(key); }
    return;
  }
  if (request.type === "dilemma-details") {
    const owner = dilemmaOwners.get(dilemmaKey(request.id, request.dilemmaId));
    if (!owner || owner.cancelled) { post({ type: "dilemma-error", id: request.id, dilemmaId: request.dilemmaId, detailId: request.detailId, message: "This Dilemma replay has expired · Run the comparison again" }); return; }
    owner.detailId = request.detailId;
    const archive = owner.archives.get(request.choice);
    if (!archive) {
      post({ type: "dilemma-error", id: request.id, dilemmaId: request.dilemmaId, detailId: request.detailId,
        message: "This commitment replay is unavailable · Run the three choices again" });
      return;
    }
    const response = replayResponse(archive);
    if (owner.detailId !== request.detailId || owner.cancelled || dilemmaOwners.get(dilemmaKey(request.id, request.dilemmaId)) !== owner) return;
    post({ type: "dilemma-details", id: request.id, dilemmaId: request.dilemmaId, detailId: request.detailId, choice: request.choice, archive: response.archive }, response.transfer);
    return;
  }
  if (request.type === "dilemma") {
    const key = dilemmaKey(request.id, request.dilemmaId);
    const previous = dilemmaOwners.get(key);
    if (previous) previous.cancelled = true;
    const owner: DilemmaOwner = { id: request.id, dilemmaId: request.dilemmaId, cancelled: false, archives: new Map(), detailId: null };
    dilemmaOwners.set(key, owner);
    void analyzeCounterLabDilemma(request.draft, request.profile, request.mode, request.configuration, request.seed,
      (progress) => { if (!owner.cancelled && dilemmaOwners.get(key) === owner) post({ type: "dilemma-progress", id: request.id, dilemmaId: request.dilemmaId, ...progress }); },
      () => owner.cancelled,
    ).then((analysis) => {
      if (owner.cancelled || dilemmaOwners.get(key) !== owner) return;
      owner.archives = new Map([...analysis.archives].map(([choice, archive]) => [choice, archive]));
      post({ type: "dilemma-complete", id: request.id, dilemmaId: request.dilemmaId, summaries: analysis.summaries });
    }).catch((error: unknown) => {
      if (owner.cancelled || dilemmaOwners.get(key) !== owner) { post({ type: "dilemma-cancelled", id: request.id, dilemmaId: request.dilemmaId }); return; }
      post({ type: "dilemma-error", id: request.id, dilemmaId: request.dilemmaId, message: error instanceof Error ? error.message : "The Dilemma comparison failed · Retry it" });
    });
    return;
  }
  if (request.type === "details") {
    detailQueue.request(request);
    return;
  }
  detailQueue.release(request.id);
  const owner = lifecycle.start(request.id);
  void analyzeCounterLab(request.draft, request.profiles, request.modes,
    (progress) => { if (lifecycle.canPublish(owner)) post({ type: "progress", id: request.id, ...progress }); }, () => lifecycle.shouldCancel(owner),
    (results, archives) => { if (lifecycle.store(owner, archives) && lifecycle.canPublish(owner)) post({ type: "baseline", id: request.id, results }); },
  ).then((analysis) => {
    if (!lifecycle.store(owner, analysis.detailArchives) || !lifecycle.canPublish(owner)) return;
    post({ type: "complete", id: request.id, results: analysis.results, repairs: analysis.repairs });
  }).catch((error: unknown) => {
    if (!lifecycle.owns(owner)) return;
    if (error instanceof DOMException && error.name === "AbortError") { post({ type: "cancelled", id: request.id }); return; }
    if (!lifecycle.canPublish(owner)) return;
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : "The comparison could not finish · Try again" });
  }).finally(() => { lifecycle.finish(owner); });
};
export {};
