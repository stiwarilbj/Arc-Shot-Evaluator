import { advanceSimulationState, createSimulationRun, editPausedSimulationMarker, getSimulationFrame, rebasePausedSimulation, setSimulationRunSettings, type SimulationRun } from "./simulation.ts";
import { getSimulationSessionInfo, seekSimulationSession } from "./simulationSession.ts";
import { parseSimulationCommand, type SimulationResponse } from "./playbookSimulationProtocol.ts";

/** One authoritative run per worker. Each operation is bounded to at most 50 ms
 * of simulation time; no timers or autonomous work continue after a pause. */
export function createPlaybookSimulationHost() {
  let run: SimulationRun | null = null;
  let sessionId = "", revision = -1, lastRequest = 0, playing = false;
  return (input: unknown): SimulationResponse => {
    const raw = input as Record<string, unknown> | null;
    const envelope = { sessionId: typeof raw?.sessionId === "string" ? raw.sessionId : "invalid", revision: Number.isSafeInteger(raw?.revision) ? raw!.revision as number : 0, requestId: Number.isSafeInteger(raw?.requestId) ? raw!.requestId as number : 1 };
    let accepted = false;
    try {
      const command = parseSimulationCommand(input);
      if (command.type === "start") {
        if (run) throw new Error("This worker already owns a session. Restart playback to create another");
        accepted = true;
        run = createSimulationRun(command.drawing, command.settings, undefined, { recordSession: true, seed: command.seed });
        sessionId = command.sessionId; revision = command.revision; lastRequest = command.requestId; playing = true;
      } else {
        if (!run || command.sessionId !== sessionId) throw new Error("This playback session is no longer active");
        if (command.requestId <= lastRequest || (command.type === "frame" ? command.revision !== revision : command.revision <= revision)) throw new Error("This playback command was superseded");
        accepted = true;
        lastRequest = command.requestId; revision = command.revision;
        if (command.type === "frame") { if (playing) advanceSimulationState(run, command.deltaMs); }
        else if (command.type === "playback") playing = command.playing;
        else if (command.type === "settings") setSimulationRunSettings(run, command.settings);
        else if (command.type === "seek") { playing = false; seekSimulationSession(run, command.timeMs); }
        else if (command.type === "edit") {
          playing = false;
          const r = command.relocation;
          if (r) editPausedSimulationMarker(run, r.type, r.id, r.point, command.drawing);
          else if (!rebasePausedSimulation(run, command.drawing)) throw new Error("This edit changes the actions or participants. Restart playback to apply it");
        }
      }
      if (run.elapsedMs >= run.durationMs) playing = false;
      return { ...envelope, type: "state", view: { frame: getSimulationFrame(run), settings: run.settings, durationMs: run.durationMs, session: getSimulationSessionInfo(run)!, playing } };
    } catch (error) {
      if (accepted) playing = false;
      return { ...envelope, type: "error", message: error instanceof Error ? error.message.slice(0, 512) : "Playback was interrupted. Restart to try again" };
    }
  };
}
