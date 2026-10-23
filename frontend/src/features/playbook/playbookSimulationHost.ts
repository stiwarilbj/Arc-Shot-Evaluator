import { advanceSimulationState, assertReadCoachSnapshot, createReadCoachChoiceRun, createSimulationRun, editPausedSimulationMarker, getAuthoritativeSimulationFrame, getSimulationFrame, rebasePausedSimulation, setSimulationRunSettings, type SimulationRun } from "./simulation.ts";
import { captureSimulationSessionPrefix, getSimulationSessionInfo, restoreSimulationSession, seekSimulationSession } from "./simulationSession.ts";
import { parseSimulationCommand, type SimulationResponse } from "./playbookSimulationProtocol.ts";

/** One authoritative run per worker. Each operation is bounded to at most 50 ms
 * of simulation time; no timers or autonomous work continue after a pause. */
export function createPlaybookSimulationHost() {
  let run: SimulationRun | null = null;
  let sessionId = "", revision = -1, lastRequest = 0, playing = false, stopAtMs: number | null = null;
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
        sessionId = command.sessionId; revision = command.revision; lastRequest = command.requestId; playing = true; stopAtMs = null;
      } else if (command.type === "read-opening") {
        if (run) throw new Error("This worker already owns a session. Restart replay to create another");
        accepted = true;
        const candidate = restoreSimulationSession({ ...command.checkpoint.session, positionMs: 0 });
        seekSimulationSession(candidate, command.checkpoint.session.positionMs);
        assertReadCoachSnapshot(candidate, command.checkpoint.snapshot);
        seekSimulationSession(candidate, 0);
        run = candidate;
        sessionId = command.sessionId; revision = command.revision; lastRequest = command.requestId;
        stopAtMs = command.checkpoint.session.positionMs; playing = stopAtMs > 0;
      } else if (command.type === "read-choice") {
        if (run) throw new Error("This worker already owns a session. Restart replay to create another");
        accepted = true;
        const choice = command.checkpoint.choices.find((item) => item.id === command.choiceId);
        if (!choice) throw new Error("This answer continuation is unavailable");
        run = createReadCoachChoiceRun(command.checkpoint.session, choice, command.checkpoint.snapshot);
        sessionId = command.sessionId; revision = command.revision; lastRequest = command.requestId; playing = true; stopAtMs = null;
      } else {
        if (!run || command.sessionId !== sessionId) throw new Error("This playback session is no longer active");
        if (command.requestId <= lastRequest || (command.type === "frame" ? command.revision !== revision : command.revision <= revision)) throw new Error("This playback command was superseded");
        accepted = true;
        lastRequest = command.requestId; revision = command.revision;
        if (command.type === "frame") {
          if (playing) {
            const current = getSimulationSessionInfo(run)?.positionMs ?? run.elapsedMs;
            const elapsed = stopAtMs == null ? command.deltaMs : Math.max(0, Math.min(command.deltaMs, stopAtMs - current));
            if (elapsed > 0) advanceSimulationState(run, elapsed);
            if (stopAtMs != null && (getSimulationSessionInfo(run)?.positionMs ?? run.elapsedMs) >= stopAtMs - 1e-6) playing = false;
          }
        }
        else if (command.type === "playback") playing = command.playing;
        else if (command.type === "settings") setSimulationRunSettings(run, command.settings);
        else if (command.type === "seek") { playing = false; seekSimulationSession(run, command.timeMs); }
        else if (command.type === "capture") {
          playing = false;
          seekSimulationSession(run, getSimulationSessionInfo(run)?.positionMs ?? (run.elapsedMs + run.accumulatorMs));
          if (run.ballState.kind !== "held") throw new Error(run.ballState.kind === "pass-in-flight" || run.ballState.kind === "handoff-pending"
            ? "Wait for the catch, then pause to create a read checkpoint"
            : run.ballState.kind.startsWith("shot-") ? "Pause before the shot begins to create a read checkpoint" : "A read checkpoint needs a live ball handler");
          const session = captureSimulationSessionPrefix(run);
          return { ...envelope, type: "capture", capture: { session, frame: getAuthoritativeSimulationFrame(run) } };
        }
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
