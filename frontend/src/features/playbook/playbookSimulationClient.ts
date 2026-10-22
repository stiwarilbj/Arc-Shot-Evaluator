import { parseSimulationResponse, type SimulationCommand, type SimulationResponse, type SimulationView, type SimulationRelocation } from "./playbookSimulationProtocol.ts";
import type { PlaybookDraft, SimulationSettings } from "./types.ts";

type CommandBody = SimulationCommand extends infer C ? C extends SimulationCommand ? Omit<C, "sessionId" | "revision" | "requestId"> : never : never;
type WorkerPort = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;
type Pending = { body: CommandBody; revision: number };
const MAX_PENDING_CONTROLS = 32;
export const MAX_PENDING_ADVANCE_MS = 100;

/** Display-side transport only: one outstanding message, bounded clock debt,
 * and adjacent replaceable controls coalesced before structured cloning. */
export function createPlaybookSimulationClient(options: {
  sessionId: string; onState: (view: SimulationView) => void; onFailure: (message: string) => void;
  createWorker?: () => WorkerPort; timeoutMs?: number;
}) {
  const worker = (options.createWorker ?? (() => new Worker(new URL("./playbookSimulation.worker.ts", import.meta.url), { type: "module" })))();
  let revision = 0, requestId = 0, disposed = false, wantedPlaying = false, debt = 0;
  let inFlight: SimulationCommand | null = null, timeout: ReturnType<typeof setTimeout> | undefined;
  const controls: Pending[] = [];

  function dispose() {
    if (disposed) return;
    disposed = true; debt = 0; controls.length = 0; inFlight = null; clearTimeout(timeout);
    worker.removeEventListener("message", receive); worker.removeEventListener("error", failed); worker.removeEventListener("messageerror", failed);
    worker.terminate();
  }
  function fail(message: string) { if (!disposed) { dispose(); queueMicrotask(() => options.onFailure(message)); } }
  function failed() { fail("Playback worker was interrupted. Your drawing and last frame are intact. Press Play to restart"); }
  function pump() {
    if (disposed || inFlight) return;
    let next = controls.shift();
    if (!next && wantedPlaying && debt > 0) {
      const deltaMs = Math.min(50, debt); debt -= deltaMs;
      next = { body: { type: "frame", deltaMs }, revision };
    }
    if (!next) return;
    inFlight = { ...next.body, sessionId: options.sessionId, revision: next.revision, requestId: ++requestId } as SimulationCommand;
    const sentRequest = inFlight.requestId;
    timeout = setTimeout(() => { if (inFlight?.requestId === sentRequest) fail("Playback worker stopped responding. Your drawing and last frame are intact. Press Play to restart"); }, options.timeoutMs ?? 10000);
    try { worker.postMessage(inFlight); } catch { failed(); }
  }
  function receive(event: Event) {
    if (disposed) return;
    const raw = (event as MessageEvent<unknown>).data as Partial<SimulationResponse> | null;
    // Late/duplicate responses cannot acknowledge a different outstanding
    // request, clear its deadline, or overwrite an edited frame.
    if (!raw || !inFlight || raw.sessionId !== options.sessionId || raw.requestId !== inFlight.requestId || raw.revision !== inFlight.revision) return;
    let response: SimulationResponse;
    try { response = parseSimulationResponse(raw); } catch { fail("Playback returned invalid data. Your drawing and last frame are intact. Press Play to restart"); return; }
    const current = response.revision === revision;
    inFlight = null; clearTimeout(timeout);
    // A failed superseded operation still makes future execution unsafe.
    if (response.type === "error") { fail(`${response.message} Your drawing and last frame are intact. Press Play to restart`); return; }
    if (current) {
      wantedPlaying = response.view.playing;
      if (!wantedPlaying) debt = 0;
      options.onState(response.view);
    }
    pump();
  }
  function control(body: CommandBody) {
    if (disposed) return;
    const pending = { body, revision: ++revision };
    const last = controls.at(-1);
    const sameEdit = body.type === "edit" && last?.body.type === "edit" && body.relocation?.type === last.body.relocation?.type && body.relocation?.id === last.body.relocation?.id;
    if (last && (sameEdit || body.type !== "edit" && body.type !== "start" && last.body.type === body.type)) controls[controls.length - 1] = pending;
    else controls.push(pending);
    if (controls.length > MAX_PENDING_CONTROLS) { fail("Too many pending playback edits. Your drawing is intact. Press Play to restart"); return; }
    pump();
  }
  worker.addEventListener("message", receive); worker.addEventListener("error", failed); worker.addEventListener("messageerror", failed);
  return {
    start(drawing: PlaybookDraft, settings: SimulationSettings, seed?: number) { wantedPlaying = true; control({ type: "start", drawing, settings, seed }); },
    playback(playing: boolean) { wantedPlaying = playing; debt = 0; control({ type: "playback", playing }); },
    settings(settings: SimulationSettings) { control({ type: "settings", settings }); },
    edit(drawing: PlaybookDraft, relocation?: SimulationRelocation) { wantedPlaying = false; debt = 0; control({ type: "edit", drawing, relocation }); },
    seek(timeMs: number) { wantedPlaying = false; debt = 0; control({ type: "seek", timeMs }); },
    advance(deltaMs: number) { if (!disposed && wantedPlaying && Number.isFinite(deltaMs) && deltaMs > 0) { debt = Math.min(MAX_PENDING_ADVANCE_MS, debt + Math.min(50, deltaMs)); pump(); } },
    dispose,
  };
}
export type PlaybookSimulationClient = ReturnType<typeof createPlaybookSimulationClient>;
