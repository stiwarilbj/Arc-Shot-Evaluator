import type { PlaybookDraft } from "./types.ts";
import { analyzeCounterLab } from "./counterLabEngine.ts";
import type { CounterLabAnalysis } from "./counterLabEngine.ts";
import type { CounterLabFrame, CounterLabMode, CounterLabProfile } from "./counterLabTypes.ts";

type AnalyzeRequest = { type: "analyze"; id: string; draft: PlaybookDraft; profiles: CounterLabProfile[]; modes: CounterLabMode[] };
type DetailRequest = { type: "details"; id: string; key: string; repairId: string };
type CancelRequest = { type: "cancel"; id: string };
type Request = AnalyzeRequest | DetailRequest | CancelRequest;
type Summary = { type: "complete"; id: string; results: CounterLabAnalysis["results"]; repairs: CounterLabAnalysis["repairs"] }
  | { type: "details"; id: string; key: string; original: CounterLabFrame[] | null; repaired: CounterLabFrame[] | null }
  | { type: "progress"; id: string; completed: number; total: number; label: string }
  | { type: "error"; id: string; message: string };

const cancelled = new Set<string>();
const details = new Map<string, Map<string, CounterLabFrame[]>>();
const post = (message: Summary) => self.postMessage(message);

async function analyze(request: AnalyzeRequest) {
  cancelled.delete(request.id);
  details.clear();
  const analysis = await analyzeCounterLab(
    request.draft,
    request.profiles,
    request.modes,
    (progress) => post({ type: "progress", id: request.id, ...progress }),
    () => cancelled.has(request.id),
  );
  if (cancelled.has(request.id)) return;
  details.set(request.id, analysis.detailTraces);
  post({ type: "complete", id: request.id, results: analysis.results, repairs: analysis.repairs });
}

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelled.add(request.id);
    return;
  }
  if (request.type === "details") {
    const saved = details.get(request.id);
    const original = saved?.get(`original:${request.key}`) ?? null;
    const repaired = request.repairId === "original" ? original : saved?.get(`${request.repairId}:${request.key}`) ?? null;
    post({ type: "details", id: request.id, key: request.key, original, repaired });
    return;
  }
  void analyze(request).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : "Counter Lab could not run this comparison." });
  });
};

export {};
