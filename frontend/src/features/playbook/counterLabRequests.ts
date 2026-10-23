import type { CounterLabMessage, CounterLabRequest } from "./counterLabTypes.ts";
import { COUNTER_LAB_DEFAULT_PROFILES, COUNTER_LAB_EXTRA_SCHEMES, COUNTER_LAB_EXTRA_STRATEGIES } from "./counterLabTypes.ts";
import { validateCounterLabInput } from "./counterLabEngine.ts";
import { validatePlaybookDocument } from "./documentValidation.ts";

const strategies = new Set<string>([...COUNTER_LAB_DEFAULT_PROFILES, ...COUNTER_LAB_EXTRA_STRATEGIES].map((profile) => profile.strategy));
const schemes = new Set(["man-to-man", ...COUNTER_LAB_EXTRA_SCHEMES.map((profile) => profile.scheme)]);
const modes = new Set(["scripted", "adaptive"]);
const kinds = new Set(["movement", "pass", "screen", "slip-screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"]);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const point = (value: unknown) => record(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
function requireField(valid: unknown, field: string): asserts valid {
  if (!valid) throw new Error(`Invalid Counter Lab request: ${field}`);
}

/** Check untrusted structured-clone input before changing worker ownership. */
export function parseCounterLabRequest(value: unknown): CounterLabRequest {
  requireField(record(value), "expected a message object");
  requireField(identifier(value.id), "analysis ID is required");
  switch (value.type) {
    case "cancel": case "release": return value as CounterLabRequest;
    case "details": {
      requireField(identifier(value.detailId), "detail request ID is required");
      requireField(identifier(value.repairId), "repair ID is required");
      const parts = typeof value.key === "string" ? value.key.split(":") : [];
      requireField(parts.length === 2 && identifier(parts[0]) && modes.has(parts[1]), "replay defense/mode key is invalid");
      return value as CounterLabRequest;
    }
    case "analyze": {
      requireField(Array.isArray(value.profiles) && value.profiles.length > 0, "defenses are required");
      for (const profile of value.profiles) {
        requireField(record(profile) && identifier(profile.id) && !profile.id.includes(":"), "defense ID is invalid");
        requireField(identifier(profile.label), "defense label is required");
        requireField(typeof profile.strategy === "string" && strategies.has(profile.strategy) && typeof profile.scheme === "string" && schemes.has(profile.scheme), "defense strategy or scheme is invalid");
      }
      requireField(new Set(value.profiles.map((profile) => profile.id)).size === value.profiles.length, "defense IDs must be unique");
      requireField(Array.isArray(value.modes) && value.modes.length > 0 && Array.from(value.modes).every((mode) => modes.has(mode)), "offense modes are invalid");
      requireField(new Set(value.modes).size === value.modes.length, "offense modes must be unique");
      const draft = value.draft;
      requireField(record(draft) && draft.version === 1 && identifier(draft.id) && typeof draft.name === "string" && typeof draft.defenders_visible === "boolean", "play document is invalid");
      requireField((draft.created_at == null || typeof draft.created_at === "string") && (draft.updated_at == null || typeof draft.updated_at === "string"), "play timestamps are invalid");
      requireField(Array.isArray(draft.players) && Array.isArray(draft.defenders) && Array.isArray(draft.arrows), "play rosters and actions are required");
      requireField(draft.ball === null || point(draft.ball), "ball position is invalid");
      for (const marker of [...draft.players, ...draft.defenders]) {
        requireField(record(marker) && point(marker) && Number.isInteger(marker.id), "player marker is invalid");
        requireField(marker.ratings == null || record(marker.ratings) && ["threePoint", "midrange", "finishing"].every((rating) => Number.isFinite((marker.ratings as Record<string, unknown>)[rating])), "player ratings are invalid");
        requireField(marker.badges == null || Array.isArray(marker.badges) && Array.from(marker.badges).every((badge) => typeof badge === "string"), "player badges are invalid");
      }
      for (const arrow of draft.arrows) {
        requireField(record(arrow) && identifier(arrow.id) && kinds.has(arrow.kind as string) && point(arrow.start) && point(arrow.end), "action is invalid");
        requireField(arrow.path == null || arrow.path === "straight" || arrow.path === "curve", "action path is invalid");
        requireField((arrow.control == null || point(arrow.control)) && (arrow.exit_target == null || point(arrow.exit_target)), "action route is invalid");
      }
      const request = value as Extract<CounterLabRequest, { type: "analyze" }>;
      // Timing constraints are executable input. Validate them at the worker
      // boundary before binding or preparing a deterministic trial.
      validatePlaybookDocument(request.draft);
      validateCounterLabInput(request.draft, request.profiles, request.modes);
      return request;
    }
    default: throw new Error("Invalid Counter Lab request: unknown message kind");
  }
}

/** An absent/invalid ID cannot correlate to an active request; never guess one. */
export function counterLabRequestError(value: unknown, error: unknown): Extract<CounterLabMessage, { type: "error" }> {
  return { type: "error", id: record(value) && identifier(value.id) ? value.id : "",
    ...(record(value) && value.type === "details" && identifier(value.detailId) ? { detailId: value.detailId } : {}),
    message: error instanceof Error ? error.message : "Invalid Counter Lab request · Try again" };
}
