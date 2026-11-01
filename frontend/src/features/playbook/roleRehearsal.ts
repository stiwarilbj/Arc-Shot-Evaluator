import { authoredRoleActions, type ActionDiagnostic } from "./simulation.ts";
import type { PlaybookDraft, RoleCueLesson, RoleCueOverride, RoleCuePhase } from "./types.ts";

export type RoleCue = {
  key: string;
  playerId: number;
  actionId: string;
  sequence: number;
  phase: RoleCuePhase;
  text: string;
  signature: string;
  /** Accepts wording authored before signatures were narrowed to instruction meaning */
  legacySignature?: string;
  startAtMs: number;
  endAtMs: number;
  status: "waiting" | "active" | "completed" | "blocked";
  reviewWording: boolean;
  diagnostic?: ActionDiagnostic;
};

type Template = Omit<RoleCue, "status" | "reviewWording" | "diagnostic">;

function signature(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function actionRoleCues(play: PlaybookDraft): Template[] {
  const bindings = authoredRoleActions(play);
  const players = new Set(play.players.map((player) => player.id));
  const byId = new Map(bindings.map((item) => [item.actionId, item]));
  const output: Template[] = [];
  for (const action of bindings) {
    const { kind, actorId, recipientId, partnerId, arrow } = action;
    const participants = new Map<number, { phase: RoleCuePhase; text: string }>();
    const put = (id: number | null | undefined, phase: RoleCuePhase, text: string) => {
      if (id != null && players.has(id)) participants.set(id, { phase, text });
    };
    if (kind === "pass") {
      put(actorId, "pass", `Pass to Player ${recipientId ?? ""}`.trim());
      put(recipientId, "receive", `Receive the pass from Player ${actorId ?? ""}`.trim());
    } else if (kind === "handoff") {
      put(actorId, "handoff", `Handoff to Player ${recipientId ?? ""}`.trim());
      put(recipientId, "receive", `Receive the handoff from Player ${actorId ?? ""}`.trim());
    } else if (kind === "backdoor-cut") put(actorId, "cut", "Cut along the authored backdoor route");
    else if (kind === "off-ball-screen" || kind === "pin-down") {
      put(actorId, "screen", kind === "pin-down" ? "Set the pin-down screen" : "Set the off-ball screen");
      put(recipientId, "screen-use", "Use the screen along the authored route");
    } else if (kind === "screen" || kind === "slip-screen" || kind === "pick-roll" || kind === "pick-pop") {
      const screener = arrow.screener_id ?? actorId;
      const handler = arrow.handler_id ?? partnerId;
      if (kind === "slip-screen") put(screener, "roll", "Slip toward the rim");
      else if (kind === "pick-roll") put(screener, "roll", "Set the screen, then roll");
      else if (kind === "pick-pop") put(screener, "pop", "Set the screen, then pop to the exit spot");
      else put(screener, "screen", "Set the screen");
      put(handler, "screen-use", "Use the screen");
    } else put(actorId, "move", "Move along the authored route");

    const waits = arrow.timingPlan?.waits ?? [];
    const waitDescription = (wait: NonNullable<typeof waits>[number]) => {
      const source = byId.get(wait.actionId);
      const event = wait.event === "catch" ? "a confirmed catch" : wait.event === "screen-set" ? "the screen being set"
        : wait.event === "screen-use" ? "the screen being used" : wait.event === "complete" ? "the action completing"
          : wait.event === "start" ? "the action starting" : "the route point being reached";
      return source ? `Move ${source.sequence} ${event}` : `the required action ${event}`;
    };
    const dependency = waits.length ? ` · after ${waits.map(waitDescription).join(" and ")}` : "";
    // Wording needs review when its action, bound players, or prerequisites
    // change. Geometry and derived travel time can normalize slightly at save
    // time without changing the instruction, so they are excluded here.
    const actionSignature = signature({ kind, actorId, recipientId, partnerId,
      screenerId: arrow.screener_id ?? null, handlerId: arrow.handler_id ?? null, cutterId: arrow.cutter_id ?? null,
      syncId: arrow.timingPlan?.syncId ?? null,
      waits: waits.map((wait) => ({ actionId: wait.actionId, event: wait.event, playerId: wait.playerId ?? null,
        routeSegment: wait.routeSegment ?? null, progress: wait.progress ?? null })) });
    // Existing saved wording can keep its previous signature if the complete
    // authored action still matches its persisted source.
    const legacySignature = signature({ arrow: { ...arrow, sequence: undefined }, actorId, recipientId, partnerId,
      startAtMs: action.startAtMs, durationMs: action.durationMs, waits });
    for (const [playerId, role] of participants) {
      const text = `${role.text}${dependency}`;
      output.push({ key: `${playerId}:${action.actionId}:${role.phase}`, playerId, actionId: action.actionId, sequence: action.sequence,
        phase: role.phase, text, signature: actionSignature, legacySignature, startAtMs: action.startAtMs, endAtMs: action.startAtMs + action.durationMs });
      if (waits.length) {
        const waitText = `Wait until ${waits.map(waitDescription).join(" and ")}`;
        output.push({ key: `${playerId}:${action.actionId}:wait`, playerId, actionId: action.actionId, sequence: action.sequence,
          phase: "wait", text: waitText, signature: actionSignature, legacySignature, startAtMs: action.startAtMs, endAtMs: action.startAtMs + action.durationMs });
      }
    }
  }
  return output.sort((a, b) => a.startAtMs - b.startAtMs || a.sequence - b.sequence || a.playerId - b.playerId);
}

export function roleCueSignature(value: unknown) { return signature(value); }
export function authoredRoleCueTemplates(play: PlaybookDraft) { return actionRoleCues(play); }

function applicableOverride(overrides: RoleCueOverride[], cue: Template, branchId: string | null, shared: boolean) {
  const ending = !shared && branchId ? overrides.find((item) => item.scope === "ending" && item.branchId === branchId && item.playerId === cue.playerId && item.actionId === cue.actionId && item.phase === cue.phase) : undefined;
  if (ending) return ending;
  return shared ? overrides.find((item) => item.scope === "shared" && item.playerId === cue.playerId && item.actionId === cue.actionId && item.phase === cue.phase) : undefined;
}

export function buildRoleCues(play: PlaybookDraft, playerId: number, branchId: string | null, sharedIds: Set<string>, diagnostics: ActionDiagnostic[], nowMs: number, lesson: RoleCueLesson | undefined = play.roleCues): RoleCue[] {
  const templates = actionRoleCues(play).filter((cue) => cue.playerId === playerId);
  if (!templates.length) {
    const marker = play.players.find((item) => item.id === playerId);
    if (!marker) return [];
    const cue: Template = { key: `${playerId}:stationary:hold`, playerId, actionId: "stationary", sequence: 0, phase: "hold", text: "Hold position", signature: signature({ playerId, x: marker.x, y: marker.y }), startAtMs: 0, endAtMs: Number.MAX_SAFE_INTEGER };
    templates.push(cue);
  }
  const byAction = new Map(diagnostics.map((item) => [item.actionId, item]));
  return templates.map((template) => {
    const shared = template.actionId === "stationary" || sharedIds.has(template.actionId);
    const override = applicableOverride(lesson?.cues ?? [], template, branchId, shared);
    const diagnostic = byAction.get(template.actionId);
    let status: RoleCue["status"] = "waiting";
    if (diagnostic && ["obstructed", "conflict", "interrupted"].includes(diagnostic.phase)) status = "blocked";
    else if (template.phase === "wait" && diagnostic?.startedAtMs != null) status = "completed";
    else if (template.phase === "hold") status = "active";
    else if (template.phase === "receive" && diagnostic?.transfer) {
      status = diagnostic.transfer.outcome.kind === "caught" ? "completed"
        : diagnostic.transfer.outcome.kind === "failed" || diagnostic.transfer.outcome.kind === "interrupted" ? "blocked" : "waiting";
    } else if (diagnostic?.phase === "completed") status = "completed";
    else if (diagnostic && ["approach", "set", "use", "release", "transfer"].includes(diagnostic.phase)) status = "active";
    else if (diagnostic?.phase === "pending") status = "waiting";
    else if (nowMs >= template.startAtMs && nowMs < template.endAtMs) status = "active";
    const transferAt = diagnostic?.transfer?.outcome.kind === "caught" || diagnostic?.transfer?.outcome.kind === "failed" || diagnostic?.transfer?.outcome.kind === "interrupted"
      ? diagnostic.transfer.outcome.atMs : undefined;
    const startAtMs = template.phase === "receive" && transferAt !== undefined ? transferAt : diagnostic?.startedAtMs ?? template.startAtMs;
    const endAtMs = diagnostic?.completedAtMs ?? (template.phase === "receive" && transferAt !== undefined ? transferAt : template.endAtMs);
    return { ...template, text: override?.text ?? template.text, startAtMs, endAtMs, status,
      reviewWording: Boolean(override && override.signature !== template.signature && override.signature !== template.legacySignature), ...(diagnostic ? { diagnostic } : {}) };
  });
}

