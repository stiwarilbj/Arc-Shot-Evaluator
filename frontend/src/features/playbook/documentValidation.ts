import type { PlaybookArrow, PlaybookDocument, PlaybookDraft } from "./types.ts";
import { resolvePlaybookPath } from "./playbookBranches.ts";

// Version-1 persistence contract. Keep in sync with backend/api/playbooks.py;
// both implementations run the same shared document examples in tests.
const kinds = new Set(["movement", "pass", "screen", "slip-screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"]);
const offenseBadges = new Set(["playmaker", "off-dribble-creator", "deep-range", "catch-and-shoot", "slasher", "rim-finisher", "cutter", "screen-setter", "roll-threat", "post-scorer"]);
const defenseBadges = new Set(["lockdown", "paint-protector", "helper"]);
const timingEvents = new Set(["start", "complete", "catch", "screen-set", "screen-use", "route-point"]);
const routePhases = new Set(["main", "approach", "use", "release"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function check(valid: unknown, message: string): asserts valid { if (!valid) throw new Error(message); }
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
function point(value: unknown) {
  check(object(value) && [value.x, value.y].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100), "Court positions must contain numeric x and y from 0 to 100");
}

/** Validate without normalizing or mutating valid drawings, including legacy v1 defaults. */
export function validatePlaybookDocument(value: unknown, shouldValidateTimingEdges = true): void {
  check(object(value), "Playbook must be an object");
  check(value.version === undefined || value.version === 1, "Only version-1 plays are supported");
  check(value.revision === undefined || typeof value.revision === "string" && /^[0-9a-f]{32}(?![\s\S])/.test(value.revision), "Invalid saved revision");
  const name = value.name === undefined ? "Untitled play" : value.name;
  check(typeof name === "string" && name.trim().length > 0 && Array.from(name.trim()).length <= 80, "Play name must be 1–80 characters");
  check(value.defenders_visible === undefined || typeof value.defenders_visible === "boolean", "defenders_visible must be boolean");
  const players = value.players === undefined ? [] : value.players;
  const defenders = value.defenders === undefined ? [] : value.defenders;
  for (const [roster, badges, offense] of [[players, offenseBadges, true], [defenders, defenseBadges, false]] as const) {
    check(Array.isArray(roster) && roster.length <= 5, "Each team must contain at most five markers");
    const ids = new Set<number>();
    for (const marker of roster) {
      check(object(marker) && integer(marker.id) && marker.id > 0 && !ids.has(marker.id), "Marker IDs must be unique positive safe integers within each team");
      ids.add(marker.id); point(marker);
      if (offense) {
        const ratings = marker.ratings === undefined ? {} : marker.ratings;
        check(object(ratings), "Player ratings must be an object");
        for (const key of ["threePoint", "midrange", "finishing"]) {
          const rating = ratings[key] === undefined ? 3 : ratings[key];
          check(integer(rating) && rating >= 1 && rating <= 5, "Player ratings must be integers from 1 to 5");
        }
      }
      const selected = marker.badges === undefined ? [] : marker.badges;
      check(Array.isArray(selected) && selected.every((badge) => typeof badge === "string" && badges.has(badge)) && new Set(selected).size === selected.length, "Badges must be unique supported IDs for this team");
    }
  }
  if (value.ball != null) point(value.ball);
  const arrows = value.arrows === undefined ? [] : value.arrows;
  check(Array.isArray(arrows) && arrows.length <= 30, "Arrows must contain at most 30 actions");
  const ids = new Set<string>();
  const playerIds = new Set((players as { id: number }[]).map((p) => p.id));
  for (const [index, arrow] of arrows.entries()) {
    check(object(arrow) && typeof arrow.id === "string" && /^[a-z0-9-]{1,64}(?![\s\S])/.test(arrow.id) && !ids.has(arrow.id), "Arrow IDs must be unique short text labels");
    ids.add(arrow.id);
    check(typeof arrow.kind === "string" && kinds.has(arrow.kind), "Arrow kind is not supported");
    const sequence = arrow.sequence === undefined ? index + 1 : arrow.sequence;
    check(integer(sequence) && sequence >= 1 && sequence <= 30, "Arrow sequence must be an integer from 1 to 30");
    check(arrow.path === undefined || arrow.path === "straight" || arrow.path === "curve", "Arrow path must be straight or curve");
    const timing = arrow.timing === undefined ? 1.2 : arrow.timing;
    check(typeof timing === "number" && Number.isFinite(timing) && timing >= .5 && timing <= 4, "Arrow timing must be between 0.5 and 4 seconds");
    point(arrow.start); point(arrow.end);
    if (arrow.control != null) point(arrow.control);
    if (arrow.exit_target != null) point(arrow.exit_target);
    for (const field of ["actor_id", "recipient_id", "screener_id", "handler_id", "cutter_id"]) {
      const id = arrow[field];
      check(id == null || integer(id) && playerIds.has(id), "Action participants must be offensive players");
    }
    if (["screen", "slip-screen", "pick-roll", "pick-pop"].includes(arrow.kind)) {
      check(arrow.screener_id == null || arrow.screener_id !== arrow.handler_id, "On-ball screen players must be distinct");
      if (arrow.kind === "pick-pop") check(arrow.screener_id != null && arrow.handler_id != null, "Pick and pop needs a screener and handler");
    }
    if (["off-ball-screen", "pin-down"].includes(arrow.kind)) check(arrow.screener_id != null && arrow.cutter_id != null && arrow.screener_id !== arrow.cutter_id, "Off-ball screens need distinct screeners and cutters");
    if (arrow.kind === "backdoor-cut") check(arrow.actor_id != null, "Backdoor cuts need an actor");
    if (arrow.recipient_id != null) check(["pass", "handoff"].includes(arrow.kind) && arrow.recipient_id !== arrow.actor_id, "Transfers need distinct participants");
    if (["pick-pop", "pin-down"].includes(arrow.kind)) point(arrow.exit_target);
    if (arrow.timingPlan !== undefined) {
      const plan = arrow.timingPlan;
      check(object(plan) && integer(plan.startAtMs) && plan.startAtMs >= 0 && plan.startAtMs <= 120_000, "Action start time must be 0–120 seconds");
      check(plan.syncId === undefined || typeof plan.syncId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.syncId), "Synchronization identity is invalid");
      if (plan.waits !== undefined) {
        check(Array.isArray(plan.waits) && plan.waits.length <= 30, "An action can have at most 30 timing waits");
        const waitIds = new Set<string>();
        for (const rawWait of plan.waits) {
          check(object(rawWait), "Timing wait must be an object");
          const wait = rawWait as Record<string, unknown>;
          check(Object.keys(wait).every((key) => ["id", "actionId", "event", "playerId", "routePhase", "routeSegment", "progress"].includes(key)), "Timing wait contains unsupported fields");
          check(typeof wait.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(wait.id) && !waitIds.has(wait.id), "Timing wait identities must be unique");
          waitIds.add(wait.id);
          check(typeof wait.actionId === "string" && /^[a-z0-9-]{1,64}$/.test(wait.actionId) && wait.actionId !== arrow.id, "Timing wait must name a different action");
          check(typeof wait.event === "string" && timingEvents.has(wait.event), "Timing wait event is not supported");
          check(wait.playerId === undefined || integer(wait.playerId) && playerIds.has(wait.playerId), "Timing wait player must be on the court");
          if (wait.event === "route-point") {
            check(wait.playerId !== undefined && wait.routePhase !== undefined && typeof wait.routePhase === "string" && routePhases.has(wait.routePhase)
              && integer(wait.routeSegment) && wait.routeSegment >= 0 && wait.routeSegment <= 63
              && typeof wait.progress === "number" && Number.isFinite(wait.progress) && wait.progress > 0 && wait.progress < 1,
            "Route-point waits need a player, route phase, segment, and interior progress value");
          } else check(wait.routePhase === undefined && wait.routeSegment === undefined && wait.progress === undefined && wait.playerId === undefined, "Only route-point waits can specify a player or route progress");
        }
      }
    }
  }
  if (shouldValidateTimingEdges) {
    const timedCount = (arrows as Array<Record<string, unknown>>).filter((arrow) => arrow.timingPlan !== undefined).length;
    check(timedCount === 0 || timedCount === arrows.length, "Timing must be initialized for every action in this play path");
  }
  const validateTimingEdges = (path: unknown) => {
    check(object(path) && (path.arrows === undefined || Array.isArray(path.arrows)), "Timing path is invalid");
    const pathActions = (path.arrows ?? []) as Array<Record<string, unknown>>;
    const byId = new Map(pathActions.map((action) => [action.id as string, action]));
    const graph = new Map<string, string[]>();
    const syncMembers = new Map<string, Array<Record<string, unknown>>>();
    for (const action of pathActions) {
      const plan = action.timingPlan as { syncId?: string; waits?: Array<{ id: string; actionId: string; event: string }> } | undefined;
      graph.set(action.id as string, []);
      if (plan?.syncId) { const group = syncMembers.get(plan.syncId) ?? []; group.push(action); syncMembers.set(plan.syncId, group); }
      for (const wait of plan?.waits ?? []) {
        const source = byId.get(wait.actionId);
        check(source, "Timing wait points to an action outside this play ending");
        check(wait.event !== "catch" || ["pass", "handoff"].includes(String(source.kind)), "Catch waits require a pass or handoff");
        check(wait.event !== "screen-set" || ["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"].includes(String(source.kind)), "Screen-set waits require an action that sets a screen");
        check(wait.event !== "screen-use" || ["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"].includes(String(source.kind)), "Screen-use waits require an action that uses a screen");
        graph.get(action.id as string)!.push(wait.actionId);
      }
    }
    const timingNode = (id: string) => {
      const action = byId.get(id)!;
      const syncId = (action.timingPlan as { syncId?: string } | undefined)?.syncId;
      return syncId ? `sync:${syncId}` : `action:${id}`;
    };
    const eventGraph = new Map<string, string[]>();
    for (const action of pathActions) eventGraph.set(timingNode(action.id as string), []);
    for (const action of pathActions) for (const dependency of graph.get(action.id as string) ?? []) {
      const from = timingNode(action.id as string), to = timingNode(dependency);
      check(from !== to, "Pinned actions cannot wait on one another");
      eventGraph.get(from)!.push(to);
    }
    const state = new Map<string, number>();
    const visit = (id: string) => {
      if (state.get(id) === 1) throw new Error("Timing waits cannot form a cycle");
      if (state.get(id) === 2) return;
      state.set(id, 1);
      for (const dependency of eventGraph.get(id) ?? []) visit(dependency);
      state.set(id, 2);
    };
    for (const id of eventGraph.keys()) visit(id);
    for (const members of syncMembers.values()) {
      const ids = new Set(members.map((action) => action.id as string));
      const startTimes = new Set(members.map((action) => (action.timingPlan as { startAtMs: number }).startAtMs));
      check(startTimes.size === 1, "Pinned actions must share one planned start time");
      let transferCount = 0;
      const owners = new Set<number>();
      for (const action of members) {
        if (["pass", "handoff"].includes(String(action.kind))) transferCount += 1;
        const kind = String(action.kind);
        const participants = kind === "off-ball-screen" || kind === "pin-down"
          ? [action.screener_id, action.cutter_id]
          : ["screen", "slip-screen", "pick-roll", "pick-pop"].includes(kind)
            ? [action.screener_id, action.handler_id]
            : kind === "handoff" ? [action.actor_id, action.recipient_id]
              : kind === "pass" ? [action.recipient_id]
            : kind === "movement" || kind === "backdoor-cut" ? [action.actor_id] : [];
        for (const participant of participants) {
          if (typeof participant !== "number") continue;
          check(!owners.has(participant), "Pinned actions cannot claim the same movement owner");
          owners.add(participant);
        }
        for (const dependency of graph.get(action.id as string) ?? []) check(!ids.has(dependency), "Pinned actions cannot wait on one another");
      }
      check(transferCount <= 1, "A pinned group cannot start competing ball transfers");
    }
  };
  if (shouldValidateTimingEdges) validateTimingEdges(value);
  if (value.branches !== undefined) {
    check(Array.isArray(value.branches) && value.branches.length <= 8, "A play can have at most eight endings");
    const branchIds = new Set<string>();
    for (const branch of value.branches) {
      check(object(branch) && typeof branch.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(branch.id) && !branchIds.has(branch.id), "Ending identities must be unique short labels");
      branchIds.add(branch.id);
      check(typeof branch.label === "string" && Array.from(branch.label.trim()).length >= 1 && Array.from(branch.label.trim()).length <= 40, "Ending labels must contain 1–40 characters");
      check(object(branch.fork) && Array.isArray(branch.fork.actionIds) && branch.fork.actionIds.length >= 1 && branch.fork.actionIds.length <= 30
        && branch.fork.actionIds.every((id) => typeof id === "string" && /^[a-z0-9-]{1,64}$/.test(id))
        && new Set(branch.fork.actionIds).size === branch.fork.actionIds.length
        && integer(branch.fork.sequence) && branch.fork.sequence >= 1 && branch.fork.sequence <= 30, "Ending fork reference is invalid");
      validatePlaybookDocument({ ...value, arrows: branch.continuation, branches: undefined }, false);
      const resolved = resolvePlaybookPath(value as unknown as PlaybookDraft, branch.id);
      validatePlaybookDocument({ ...value, arrows: resolved.play.arrows, branches: undefined });
      validateTimingEdges(resolved.play);
      const sharedSyncMembers = new Map<string, Set<string>>();
      const endingSyncMembers = new Map<string, Set<string>>();
      for (const action of resolved.play.arrows) {
        const syncId = (action as PlaybookArrow).timingPlan?.syncId;
        if (!syncId) continue;
        const target = resolved.sharedIds.has(action.id as string) ? sharedSyncMembers : endingSyncMembers;
        const ids = target.get(syncId) ?? new Set<string>(); ids.add(action.id as string); target.set(syncId, ids);
      }
      for (const syncId of sharedSyncMembers.keys()) check(!endingSyncMembers.has(syncId), "Pinned actions cannot cross a shared-opening boundary");
    }
  }
}

export function validateSavedPlaybook(value: unknown): asserts value is PlaybookDocument {
  validatePlaybookDocument(value);
  check(object(value) && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && Array.isArray(value.players) && Array.isArray(value.defenders) && Array.isArray(value.arrows), "Saved play is incomplete");
}

export type PlaybookSaveIdentity = { operation: "create"; sourceId: string } | { operation: "update"; id: string };
export const INVALID_PLAYBOOK_SAVE = "The save returned an invalid play. Your draft is still in memory; retry saving";

/** Fresh save results must be complete. Legacy load defaults are deliberately
 * more permissive; never treat a missing version/identity as save success. */
export function validatePlaybookSaveResult(value: unknown, identity: PlaybookSaveIdentity): asserts value is PlaybookDocument {
  try {
    validateSavedPlaybook(value);
    check(value.version === 1 && /^[a-z0-9][a-z0-9-]{7,63}(?![\s\S])/.test(value.id) && !value.id.startsWith("draft-"), "Invalid saved identity");
    check(identity.operation === "update" ? value.id === identity.id : value.id !== identity.sourceId, "Unexpected saved identity");
    check(typeof value.defenders_visible === "boolean" && value.ball !== undefined, "Incomplete saved court");
    for (const timestamp of [value.created_at, value.updated_at]) check(typeof timestamp === "string" && timestamp.trim().length > 0 && Number.isFinite(Date.parse(timestamp)), "Invalid save timestamp");
  } catch { throw new Error(INVALID_PLAYBOOK_SAVE); }
}
