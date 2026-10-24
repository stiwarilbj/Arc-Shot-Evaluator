import type { PlaybookArrow, PlaybookDocument, PlaybookDraft } from "./types.ts";
import { resolvePlaybookPath } from "./playbookBranches.ts";

// Version-1 persistence contract. Keep in sync with backend/api/playbooks.py;
// both implementations run the same shared document examples in tests.
const kinds = new Set(["movement", "pass", "screen", "slip-screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"]);
const offenseBadges = new Set(["playmaker", "off-dribble-creator", "deep-range", "catch-and-shoot", "slasher", "rim-finisher", "cutter", "screen-setter", "roll-threat", "post-scorer"]);
const defenseBadges = new Set(["lockdown", "paint-protector", "helper"]);
const timingEvents = new Set(["start", "complete", "catch", "screen-set", "screen-use", "route-point"]);
const routePhases = new Set(["main", "approach", "use", "release"]);
const spacingEvents = new Set(["start", "complete", "catch", "screen-set", "screen-use", "route-point"]);
const roleCuePhases = new Set(["hold", "perform", "receive", "screen", "screen-use", "roll", "pop", "cut", "pass", "handoff", "move", "wait"]);
const defenseSchemes = new Set(["man-to-man", "pack-line", "zone-2-3", "zone-3-2", "zone-1-3-1", "zone-2-1-2", "zone-1-2-2", "matchup-1-1-3", "box-and-one", "triangle-and-two"]);
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
      // These extensions are validated against the complete play family below
      // and may legitimately reference shared Main actions that are not present
      // in the branch's continuation-only structural validation.
      validatePlaybookDocument({ ...value, arrows: branch.continuation, branches: undefined, roleCues: undefined, spacingGates: undefined, flipbooks: undefined, baitPayoffs: undefined }, false);
      const resolved = resolvePlaybookPath(value as unknown as PlaybookDraft, branch.id);
      validatePlaybookDocument({ ...value, arrows: resolved.play.arrows, branches: undefined, roleCues: undefined, spacingGates: undefined, flipbooks: undefined, baitPayoffs: undefined });
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
  if (value.roleCues !== undefined) {
    const lesson = value.roleCues;
    check(object(lesson) && lesson.version === 1 && Array.isArray(lesson.cues) && lesson.cues.length <= 600, "Role rehearsal cues are invalid");
    const branches = new Map(((value.branches ?? []) as Array<Record<string, unknown>>).map((branch) => [String(branch.id), branch]));
    const cueKeys = new Set<string>();
    for (const rawCue of lesson.cues) {
      check(object(rawCue) && Object.keys(rawCue).every((key) => ["playerId", "actionId", "phase", "scope", "branchId", "text", "signature"].includes(key))
        && integer(rawCue.playerId) && playerIds.has(rawCue.playerId)
        && typeof rawCue.actionId === "string" && (rawCue.actionId === "stationary" || /^[a-z0-9-]{1,64}$/.test(rawCue.actionId))
        && typeof rawCue.phase === "string" && roleCuePhases.has(rawCue.phase)
        && (rawCue.scope === "shared" || rawCue.scope === "ending")
        && typeof rawCue.text === "string" && rawCue.text.trim().length > 0 && Array.from(rawCue.text).length <= 240
        && typeof rawCue.signature === "string" && /^[0-9a-f]{8}$/.test(rawCue.signature), "Role rehearsal cue fields are invalid");
      const cue = rawCue as Record<string, unknown>;
      if (cue.actionId === "stationary") {
        check(cue.phase === "hold", "Stationary cues must describe holding position");
        if (cue.scope === "ending") check(typeof cue.branchId === "string" && branches.has(cue.branchId), "Ending stationary cue must reference an existing ending");
        else check(cue.branchId === undefined, "Shared stationary cues cannot name an ending");
      }
      else if (cue.scope === "shared") check((arrows as Array<Record<string, unknown>>).some((arrow) => arrow.id === cue.actionId), "Shared role cue must reference a Main action");
      else {
        check(typeof cue.branchId === "string" && branches.has(cue.branchId), "Ending role cue must reference an existing ending");
        const branch = branches.get(String(cue.branchId))!;
        check(Array.isArray(branch.continuation) && (branch.continuation as Array<Record<string, unknown>>).some((arrow) => arrow.id === cue.actionId), "Ending role cue must reference an action in that ending");
      }
      check(cue.scope !== "shared" || cue.branchId === undefined, "Shared role cues cannot name an ending");
      const key = `${cue.scope}:${String(cue.branchId ?? "")}:${cue.playerId}:${cue.actionId}:${cue.phase}`;
      check(!cueKeys.has(key), "Role cue identities must be unique"); cueKeys.add(key);
    }
  }
  if (value.spacingGates !== undefined) {
    const lesson = value.spacingGates;
    check(object(lesson) && lesson.version === 1 && Array.isArray(lesson.gates) && lesson.gates.length <= 30, "Spacing gates must be a version-1 list with at most 30 entries");
    const branches = new Map(((value.branches ?? []) as Array<Record<string, unknown>>).map((branch) => [String(branch.id), branch]));
    const gateIds = new Set<string>();
    const mainActions = new Map((arrows as Array<Record<string, unknown>>).map((arrow) => [String(arrow.id), arrow]));
    for (const rawGate of lesson.gates) {
      check(object(rawGate) && Object.keys(rawGate).every((key) => ["id", "playerId", "area", "rule", "trigger", "beforeSeconds", "afterSeconds", "instruction", "scope", "branchId"].includes(key)), "Spacing gate contains unsupported fields");
      const gate = rawGate as Record<string, unknown>;
      check(typeof gate.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(gate.id) && !gateIds.has(gate.id), "Spacing gate IDs must be unique short labels");
      gateIds.add(gate.id);
      check(integer(gate.playerId) && playerIds.has(gate.playerId), "Spacing gate must reference an offensive player");
      check(gate.rule === "inside" || gate.rule === "outside", "Spacing gate rule must be inside or outside");
      check(gate.scope === "shared" || gate.scope === "ending", "Spacing gate scope is invalid");
      const area = gate.area;
      check(object(area) && Object.keys(area).every((key) => ["shape", "center", "radiusFeet", "widthFeet", "heightFeet"].includes(key)), "Spacing gate area is invalid");
      point(area.center);
      const center = area.center as { x: number; y: number };
      if (area.shape === "circle") {
        check(typeof area.radiusFeet === "number" && Number.isFinite(area.radiusFeet) && area.radiusFeet >= 0.5 && area.radiusFeet <= 25
          && area.widthFeet === undefined && area.heightFeet === undefined, "Spacing gate circle radius must be 0.5–25 feet");
        check(center.x * 0.5 >= area.radiusFeet - 1e-6 && (100 - center.x) * 0.5 >= area.radiusFeet - 1e-6
          && center.y * 0.47 >= area.radiusFeet - 1e-6 && (100 - center.y) * 0.47 >= area.radiusFeet - 1e-6, "Spacing gate must stay within the playable court");
      } else {
        check(area.shape === "rectangle" && typeof area.widthFeet === "number" && Number.isFinite(area.widthFeet) && area.widthFeet >= 1 && area.widthFeet <= 50
          && typeof area.heightFeet === "number" && Number.isFinite(area.heightFeet) && area.heightFeet >= 1 && area.heightFeet <= 47
          && area.radiusFeet === undefined, "Spacing gate rectangle dimensions are invalid");
        check(center.x * 0.5 >= area.widthFeet / 2 - 1e-6 && (100 - center.x) * 0.5 >= area.widthFeet / 2 - 1e-6
          && center.y * 0.47 >= area.heightFeet / 2 - 1e-6 && (100 - center.y) * 0.47 >= area.heightFeet / 2 - 1e-6, "Spacing gate must stay within the playable court");
      }
      for (const key of ["beforeSeconds", "afterSeconds"] as const) {
        const seconds = gate[key];
        check(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= 5
          && Math.abs(seconds * 10 - Math.round(seconds * 10)) < 1e-6, `Spacing gate ${key} must use 0.1-second steps up to five seconds`);
      }
      check(gate.instruction === undefined || typeof gate.instruction === "string" && Array.from(gate.instruction).length <= 120, "Spacing gate instruction must be 120 characters or fewer");
      check(object(gate.trigger) && Object.keys(gate.trigger).every((key) => ["actionId", "event", "routePlayerId", "routePhase", "routeSegment", "progress"].includes(key)), "Spacing gate checkpoint is invalid");
      const trigger = gate.trigger as Record<string, unknown>;
      check(typeof trigger.actionId === "string" && /^[a-z0-9-]{1,64}$/.test(trigger.actionId) && spacingEvents.has(String(trigger.event)), "Spacing gate checkpoint must reference a supported action milestone");
      const branch = gate.scope === "ending" ? branches.get(String(gate.branchId)) : undefined;
      check(gate.scope !== "ending" || (typeof gate.branchId === "string" && branch), "Ending spacing gate must reference an existing ending");
      check(gate.scope !== "shared" || gate.branchId === undefined, "Shared spacing gates cannot name an ending");
      const action = gate.scope === "shared" ? mainActions.get(trigger.actionId) : (branch?.continuation as Array<Record<string, unknown>> | undefined)?.find((candidate) => candidate.id === trigger.actionId);
      check(action, "Spacing gate checkpoint must stay in its shared opening or selected ending");
      if (trigger.event === "catch") check(["pass", "handoff"].includes(String(action.kind)), "Catch checkpoints require a pass or handoff");
      if (trigger.event === "screen-set") check(["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"].includes(String(action.kind)), "Screen-set checkpoints require a screen action");
      if (trigger.event === "screen-use") check(["screen", "slip-screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "handoff"].includes(String(action.kind)), "Screen-use checkpoints require a screen or handoff action");
      if (trigger.event === "route-point") {
        check(integer(trigger.routePlayerId) && playerIds.has(trigger.routePlayerId) && typeof trigger.routePhase === "string" && routePhases.has(trigger.routePhase)
          && integer(trigger.routeSegment) && trigger.routeSegment >= 0 && trigger.routeSegment <= 63
          && typeof trigger.progress === "number" && Number.isFinite(trigger.progress) && trigger.progress > 0 && trigger.progress < 1,
        "Route checkpoints need a player, route phase, segment, and progress between zero and one");
      } else check(trigger.routePlayerId === undefined && trigger.routePhase === undefined && trigger.routeSegment === undefined && trigger.progress === undefined, "Only route checkpoints can specify a route point");
    }
  }
  if (value.readCoach !== undefined) validateReadCoach(value.readCoach);
  if (value.flipbooks !== undefined) validateFlipbookLesson(value.flipbooks, value as unknown as PlaybookDraft);
  if (value.baitPayoffs !== undefined) validateBaitPayoffLesson(value.baitPayoffs, value as unknown as PlaybookDraft);
}

function validateBaitPayoffLesson(raw: unknown, play: PlaybookDraft) {
  check(object(raw) && raw.version === 1 && Array.isArray(raw.connections) && raw.connections.length <= 30, "Bait & Payoff supports at most 30 connections");
  const branches = new Map((play.branches ?? []).map((branch) => [branch.id, branch]));
  const main = new Map(play.arrows.map((arrow) => [arrow.id, arrow]));
  const ids = new Set<string>();
  const knownPlayerIds = new Set(play.players.map((player) => player.id));
  const knownDefenderIds = new Set(play.defenders.map((player) => player.id));
  if (play.defenders.length === 0) for (const player of play.players) knownDefenderIds.add(player.id);
  for (const item of raw.connections) {
    check(object(item) && Object.keys(item).every((key) => ["id", "baitActionId", "payoffActionId", "title", "explanation", "scope", "branchId", "baitSignature", "payoffSignature", "reaction"].includes(key)), "Bait & Payoff connection contains unsupported fields");
    check(typeof item.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) && !ids.has(item.id), "Bait & Payoff connection identities must be unique");
    ids.add(item.id);
    check(typeof item.baitActionId === "string" && /^[a-z0-9-]{1,64}$/.test(item.baitActionId)
      && typeof item.payoffActionId === "string" && /^[a-z0-9-]{1,64}$/.test(item.payoffActionId)
      && item.baitActionId !== item.payoffActionId, "Bait and payoff must be different stable action identities");
    check(typeof item.title === "string" && item.title.trim().length > 0 && Array.from(item.title).length <= 60, "Bait & Payoff title must contain 1–60 characters");
    check(typeof item.explanation === "string" && item.explanation.trim().length > 0 && Array.from(item.explanation).length <= 1000, "Bait & Payoff explanation must contain 1–1000 characters");
    check(item.scope === "shared" || item.scope === "ending", "Bait & Payoff scope is invalid");
    check(typeof item.baitSignature === "string" && /^[0-9a-f]{8}$/.test(item.baitSignature)
      && typeof item.payoffSignature === "string" && /^[0-9a-f]{8}$/.test(item.payoffSignature), "Bait & Payoff action review signatures are invalid");
    const branch = item.scope === "ending" ? branches.get(String(item.branchId)) : undefined;
    check(item.scope !== "ending" || typeof item.branchId === "string" && Boolean(branch), "Ending connection must reference an existing ending");
    check(item.scope !== "shared" || item.branchId === undefined, "Shared connections cannot name an ending");
    const actions = item.scope === "shared"
      ? main
      : new Map(resolvePlaybookPath(play, branch!.id).play.arrows.map((arrow) => [arrow.id, arrow]));
    const bait = actions.get(item.baitActionId as string), payoff = actions.get(item.payoffActionId as string);
    check(bait && payoff, "Bait & Payoff actions must remain in their saved path");
    if (item.reaction !== undefined) {
      check(object(item.reaction) && Object.keys(item.reaction).every((key) => ["defenderId", "area", "direction", "checkpoint"].includes(key)), "Defender reaction check contains unsupported fields");
      const reaction = item.reaction as Record<string, unknown>;
      check(integer(reaction.defenderId) && knownDefenderIds.has(reaction.defenderId), "Reaction check must reference a defender on this court");
      check(reaction.direction === "enter" || reaction.direction === "leave", "Reaction direction must be enter or leave");
      check(object(reaction.area) && Object.keys(reaction.area).every((key) => ["shape", "center", "radiusFeet", "widthFeet", "heightFeet"].includes(key)), "Reaction area is invalid");
      const area = reaction.area as Record<string, unknown>;
      point(area.center);
      const center = area.center as { x: number; y: number };
      if (area.shape === "circle") {
        check(typeof area.radiusFeet === "number" && Number.isFinite(area.radiusFeet) && area.radiusFeet >= 0.5 && area.radiusFeet <= 25 && area.widthFeet === undefined && area.heightFeet === undefined, "Reaction radius must be 0.5–25 feet");
        check(center.x * .5 >= area.radiusFeet - 1e-6 && (100 - center.x) * .5 >= area.radiusFeet - 1e-6 && center.y * .47 >= area.radiusFeet - 1e-6 && (100 - center.y) * .47 >= area.radiusFeet - 1e-6, "Reaction area must stay within the playable court");
      } else {
        check(area.shape === "rectangle" && typeof area.widthFeet === "number" && Number.isFinite(area.widthFeet) && area.widthFeet >= 1 && area.widthFeet <= 50 && typeof area.heightFeet === "number" && Number.isFinite(area.heightFeet) && area.heightFeet >= 1 && area.heightFeet <= 47 && area.radiusFeet === undefined, "Reaction rectangle dimensions are invalid");
        check(center.x * .5 >= area.widthFeet / 2 - 1e-6 && (100 - center.x) * .5 >= area.widthFeet / 2 - 1e-6 && center.y * .47 >= area.heightFeet / 2 - 1e-6 && (100 - center.y) * .47 >= area.heightFeet / 2 - 1e-6, "Reaction area must stay within the playable court");
      }
      check(object(reaction.checkpoint) && Object.keys(reaction.checkpoint).every((key) => ["actionId", "event", "routePlayerId", "routePhase", "routeSegment", "progress"].includes(key)), "Reaction checkpoint is invalid");
      const checkpoint = reaction.checkpoint as Record<string, unknown>;
      const supportedEvents = new Set(["start", "complete", "catch", "screen-set", "screen-use", "route-point"]);
      const checkpointAction = typeof checkpoint.actionId === "string" ? actions.get(checkpoint.actionId) : undefined;
      check(checkpointAction && supportedEvents.has(String(checkpoint.event)), "Reaction checkpoint must identify an action milestone");
      check(checkpointAction.id === item.baitActionId || checkpointAction.id === item.payoffActionId, "Reaction checkpoint must belong to the linked bait or payoff");
      if (checkpoint.event === "catch") check(["pass", "handoff"].includes(checkpointAction.kind), "Catch checkpoints require a pass or handoff");
      if (checkpoint.event === "screen-set") check(["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"].includes(checkpointAction.kind), "Screen-set checkpoints require a screen action");
      if (checkpoint.event === "screen-use") check(["screen", "slip-screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "handoff"].includes(checkpointAction.kind), "Screen-use checkpoints require a screen or handoff action");
      if (checkpoint.event === "route-point") {
        check(integer(checkpoint.routePlayerId) && knownPlayerIds.has(checkpoint.routePlayerId) && checkpoint.routePhase === "main"
        && checkpoint.routeSegment === 0 && typeof checkpoint.progress === "number" && Number.isFinite(checkpoint.progress) && checkpoint.progress > 0 && checkpoint.progress < 1, "Route-point checkpoints need a court player, main route, and interior progress");
      } else check(checkpoint.routePlayerId === undefined && checkpoint.routePhase === undefined && checkpoint.routeSegment === undefined && checkpoint.progress === undefined, "Only route-point checkpoints can specify route progress");
    }
  }
}

function validateFlipbookLesson(raw: unknown, play: PlaybookDraft) {
  check(object(raw) && raw.version === 1 && Array.isArray(raw.stories) && raw.stories.length <= 9, "Play Flipbook supports one story for Main and each ending");
  const branchById = new Map((play.branches ?? []).map((branch) => [branch.id, branch]));
  const storyKeys = new Set<string>();
  const playerIds = new Set(play.players.map((player) => player.id));
  for (const rawStory of raw.stories) {
    check(object(rawStory) && Object.keys(rawStory).every((key) => ["id", "playName", "endingId", "endingLabel", "recording", "panels"].includes(key)), "Walkthrough contains unsupported fields");
    const story = rawStory as Record<string, unknown>;
    check(typeof story.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(story.id), "Walkthrough identity is invalid");
    check(typeof story.playName === "string" && story.playName.trim().length > 0 && Array.from(story.playName).length <= 80, "Walkthrough play name is invalid");
    const endingId = story.endingId;
    check(endingId === null || typeof endingId === "string" && branchById.has(endingId), "Walkthrough must belong to Main or an existing ending");
    const endingKey = endingId === null ? "main" : endingId;
    check(!storyKeys.has(endingKey), "A play can contain only one walkthrough per ending"); storyKeys.add(endingKey);
    check(typeof story.endingLabel === "string" && story.endingLabel.trim().length > 0 && Array.from(story.endingLabel).length <= 40, "Walkthrough ending label must contain 1–40 characters");
    validateReadCoachSessionRecord(story.recording);
    const session = story.recording as Record<string, unknown>;
    const recordingEndMs = Number(session.positionMs);
    check(Number.isFinite(recordingEndMs) && recordingEndMs > 0, "Walkthrough recording must contain a complete possession");
    const source = session.initialDrawing as Record<string, unknown>;
    const lastEdit = [...(session.events as Array<Record<string, unknown>>)].reverse().find((event) => event.kind === "edit");
    const captured = (lastEdit?.drawing as Record<string, unknown> | undefined) ?? source;
    const expectedPlayers = new Set((captured.players as Array<Record<string, unknown>>).map((marker) => marker.id));
    const authoredDefenders = captured.defenders as Array<Record<string, unknown>>;
    const expectedDefenders = new Set(authoredDefenders.length ? authoredDefenders.map((marker) => marker.id) : [...expectedPlayers]);
    const actionIds = new Set<string>((source.arrows as Array<Record<string, unknown>>).map((action) => String(action.id)));
    for (const event of session.events as Array<Record<string, unknown>>) if (event.kind === "edit") {
      for (const action of ((event.drawing as Record<string, unknown>).arrows as Array<Record<string, unknown>>)) actionIds.add(String(action.id));
    }
    check(typeof story.endingLabel === "string" && story.endingLabel.length <= 40
      && Array.isArray(story.panels) && story.panels.length >= 1 && story.panels.length <= 12, "Walkthrough needs 1–12 panels");
    const panelIds = new Set<string>();
    let previousTime = -1;
    for (const rawPanel of story.panels) {
      check(object(rawPanel) && Object.keys(rawPanel).every((key) => ["id", "atMs", "caption", "focusPlayerIds", "routeIds", "snapshot"].includes(key)), "Walkthrough panel contains unsupported fields");
      const panel = rawPanel as Record<string, unknown>;
      check(typeof panel.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(panel.id) && !panelIds.has(panel.id), "Walkthrough panel identities must be unique"); panelIds.add(panel.id);
      check(typeof panel.atMs === "number" && Number.isFinite(panel.atMs) && panel.atMs >= 0 && panel.atMs <= recordingEndMs
        && panel.atMs > previousTime, "Walkthrough panels must be chronological recorded moments");
      previousTime = panel.atMs;
      check(typeof panel.caption === "string" && Array.from(panel.caption).length <= 160, "Walkthrough caption must be 160 characters or fewer");
      check(Array.isArray(panel.focusPlayerIds) && panel.focusPlayerIds.length <= 5 && panel.focusPlayerIds.every((id) => integer(id) && playerIds.has(id))
        && new Set(panel.focusPlayerIds).size === panel.focusPlayerIds.length, "Walkthrough focus players are invalid");
      check(object(panel.snapshot) && panel.snapshot.atMs === panel.atMs, "Walkthrough court moment must match its panel time");
      const snapshot = panel.snapshot as Record<string, unknown>;
      check(Array.isArray(snapshot.players) && snapshot.players.length <= 5 && Array.isArray(snapshot.defenders) && snapshot.defenders.length <= 5, "Walkthrough roster is invalid");
      const validateCourtRoster = (roster: unknown[], expected: Set<unknown>, label: string) => {
        const seen = new Set<number>();
        for (const rawMarker of roster) {
          check(object(rawMarker) && Object.keys(rawMarker).every((key) => ["id", "x", "y"].includes(key))
            && integer(rawMarker.id) && expected.has(rawMarker.id) && !seen.has(rawMarker.id), `Walkthrough ${label} identity is invalid`);
          point(rawMarker); seen.add(rawMarker.id as number);
        }
        check(seen.size === expected.size, `Walkthrough ${label} roster is incomplete`);
      };
      validateCourtRoster(snapshot.players as unknown[], expectedPlayers, "player");
      validateCourtRoster(snapshot.defenders as unknown[], expectedDefenders, "defender");
      check(snapshot.ball === null || object(snapshot.ball), "Walkthrough ball position is invalid");
      if (snapshot.ball !== null) point(snapshot.ball);
      check(snapshot.ballHandlerId === null || integer(snapshot.ballHandlerId) && playerIds.has(snapshot.ballHandlerId), "Walkthrough ball handler is invalid");
      check(["held", "pass-in-flight", "handoff-pending", "loose", "shot-setup", "shot-in-flight", "shot-result"].includes(String(snapshot.ballPhase))
        && ["idle", "setup", "air", "result"].includes(String(snapshot.shotPhase)), "Walkthrough ball state is invalid");
      check(Array.isArray(snapshot.routes) && snapshot.routes.length <= 100, "Walkthrough routes are invalid");
      const routeIds = new Set<string>();
      for (const rawRoute of snapshot.routes) {
        const routeActionId = object(rawRoute) ? rawRoute.actionId : undefined;
        const generatedAction = typeof routeActionId === "string"
          && (/^auto-(?:offball|handoff|pick-roll|screen)-(?:[1-9]|[12]\d|30)$/.test(routeActionId)
            || /^adaptive-read-(?:movement|pass)$/.test(routeActionId));
        check(object(rawRoute) && Object.keys(rawRoute).every((key) => ["id", "actionId", "sequence", "kind", "playerId", "scope", "importance", "start", "end", "control", "via", "points"].includes(key))
          && typeof rawRoute.id === "string" && !routeIds.has(rawRoute.id) && integer(rawRoute.playerId) && playerIds.has(rawRoute.playerId)
          && (rawRoute.actionId === null || typeof rawRoute.actionId === "string" && (actionIds.has(rawRoute.actionId) || generatedAction))
          && (rawRoute.sequence === null || integer(rawRoute.sequence) && rawRoute.sequence >= 1 && rawRoute.sequence <= 30)
          && typeof rawRoute.kind === "string" && ["on-ball", "off-ball"].includes(String(rawRoute.scope))
          && ["main", "adjustment"].includes(String(rawRoute.importance)), "Walkthrough route identity is invalid");
        routeIds.add(rawRoute.id as string); point(rawRoute.start); point(rawRoute.end);
        if (rawRoute.control !== undefined) point(rawRoute.control);
        if (rawRoute.via !== undefined) point(rawRoute.via);
        if (rawRoute.points !== undefined) check(Array.isArray(rawRoute.points) && rawRoute.points.length <= 128 && rawRoute.points.every((item) => { point(item); return true; }), "Walkthrough route points are invalid");
      }
      check(Array.isArray(panel.routeIds) && panel.routeIds.length <= 100 && panel.routeIds.every((id) => typeof id === "string" && routeIds.has(id))
        && new Set(panel.routeIds).size === panel.routeIds.length, "Walkthrough route selection is invalid");
    }
  }
}

export function validateReadCoachSessionRecord(raw: unknown) {
  check(object(raw) && raw.version === 1 && Number.isInteger(raw.engineVersion) && Number(raw.engineVersion) > 0
    && Number.isInteger(raw.seed) && Number(raw.seed) >= 0 && Number(raw.seed) <= 0xffffffff
    && defenseSchemes.has(String(raw.resolvedDefenseScheme)) && typeof raw.positionMs === "number" && Number.isFinite(raw.positionMs) && raw.positionMs >= 0
    && Array.isArray(raw.events) && raw.events.length <= 200000, "Read checkpoint session is invalid");
  check(object(raw.hoop), "Read checkpoint court is invalid"); point(raw.hoop);
  const source = raw.initialDrawing;
  check(object(source) && source.readCoach === undefined && source.roleCues === undefined && source.spacingGates === undefined && source.flipbooks === undefined && source.baitPayoffs === undefined && source.branches === undefined, "Read checkpoint snapshot must be a flattened path without another lesson");
  validatePlaybookDocument(source);
  const settings = raw.initialSettings;
  check(object(settings) && ["off", "spacing", "cuts", "read-react"].includes(String(settings.offenseOffBall))
    && ["auto", ...defenseSchemes].includes(String(settings.defenseScheme))
    && ["off", "contain", "help", "switch", "trap-rotate", "fight-over", "go-under", "drop", "hedge", "deny-lanes", "protect-paint"].includes(String(settings.defenseStrategy))
    && typeof settings.offBallIntensity === "number" && Number.isFinite(settings.offBallIntensity)
    && object(settings.automaticActions) && ["screen", "handoff", "pickRoll", "offBallScreen"].every((key) => typeof (settings.automaticActions as Record<string, unknown>)[key] === "boolean"), "Read checkpoint settings are invalid");
  let expectedTime = 0;
  for (const event of raw.events) {
    check(object(event) && Number.isFinite(event.atMs) && Number(event.atMs) >= 0 && Number.isFinite(event.elapsedMs)
      && Number.isFinite(event.accumulatorMs) && Math.abs(Number(event.atMs) - expectedTime) < 1e-5, "Read checkpoint replay timeline is invalid");
    if (event.kind === "advance") {
      check(typeof event.deltaMs === "number" && Number.isFinite(event.deltaMs) && event.deltaMs > 0 && event.deltaMs <= 50
        && typeof event.endMs === "number" && Number.isFinite(event.endMs) && event.endMs > Number(event.atMs), "Read checkpoint replay step is invalid");
      expectedTime = event.endMs;
    } else if (event.kind === "settings") {
      check(object(event.settings), "Read checkpoint replay settings are invalid");
    } else if (event.kind === "edit") {
      check(object(event.drawing) && event.drawing.readCoach === undefined && event.drawing.roleCues === undefined && event.drawing.spacingGates === undefined && event.drawing.flipbooks === undefined && event.drawing.baitPayoffs === undefined && event.drawing.branches === undefined, "Read checkpoint replay edit must be flattened");
      validatePlaybookDocument(event.drawing);
    } else throw new Error("Read checkpoint replay event is unsupported");
  }
  check(Math.abs(expectedTime - Number(raw.positionMs)) < 1e-5, "Read checkpoint must end at its recorded moment");
}

export function validateReadCoachLesson(raw: unknown) { validateReadCoach(raw); }

function validateReadCoach(raw: unknown) {
  check(object(raw) && raw.version === 1 && Array.isArray(raw.checkpoints) && raw.checkpoints.length <= 8, "Read Coach must contain at most eight checkpoints");
  const ids = new Set<string>();
  for (const item of raw.checkpoints) {
    check(object(item) && typeof item.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) && !ids.has(item.id), "Read checkpoint identities must be unique");
    ids.add(item.id);
    check(typeof item.question === "string" && item.question.trim().length > 0 && Array.from(item.question).length <= 240, "Read checkpoint question must contain 1–240 characters");
    check(typeof item.explanation === "string" && item.explanation.trim().length > 0 && Array.from(item.explanation).length <= 2000, "Read checkpoint explanation must contain 1–2000 characters");
    validateReadCoachSessionRecord(item.session);
    const source = (item.session as Record<string, unknown>).initialDrawing as Record<string, unknown>;
    const snapshot = item.snapshot;
    check(object(snapshot) && Array.isArray(snapshot.players) && Array.isArray(snapshot.defenders)
      && snapshot.players.length <= 5 && snapshot.defenders.length <= 5
      && Number.isFinite(snapshot.atMs) && Math.abs(Number(snapshot.atMs) - Number((item.session as Record<string, unknown>).positionMs)) < 1e-5,
    "Read checkpoint court snapshot is invalid");
    const validateSnapshotRoster = (rawMarkers: unknown[], sourceMarkers: unknown, label: string, allowGenerated = false) => {
      check(Array.isArray(sourceMarkers), `Read checkpoint ${label} source is invalid`);
      const generated = allowGenerated && sourceMarkers.length === 0;
      check(generated ? rawMarkers.length <= 5 : rawMarkers.length === sourceMarkers.length, `Read checkpoint ${label} roster changed`);
      const expected = generated
        ? new Set(Array.from({ length: rawMarkers.length }, (_, index) => index + 1))
        : new Set((sourceMarkers as Array<Record<string, unknown>>).map((marker) => marker.id));
      const seen = new Set<number>();
      for (const marker of rawMarkers) {
        check(object(marker) && integer(marker.id) && expected.has(marker.id) && !seen.has(marker.id), `Read checkpoint ${label} identities are invalid`);
        point(marker); seen.add(marker.id);
      }
    };
    const lastEdit = [...((item.session as Record<string, unknown>).events as Array<Record<string, unknown>>)].reverse().find((event) => event.kind === "edit");
    const capturedDrawing = (lastEdit?.drawing as Record<string, unknown> | undefined) ?? source;
    validateSnapshotRoster(snapshot.players as unknown[], capturedDrawing.players, "player");
    // The engine creates deterministic, goal-side defenders when a play has
    // none authored. Their stable IDs are positional (1..N) and are recorded
    // in the frozen snapshot, while the original drawing stays unchanged.
    validateSnapshotRoster(snapshot.defenders as unknown[], capturedDrawing.defenders, "defender", true);
    if (!(capturedDrawing.defenders as unknown[]).length) {
      check(snapshot.defenders.length === snapshot.players.length, "Generated defender count must match the captured offense");
    }
    check(snapshot.ball === null || object(snapshot.ball), "Read checkpoint ball is invalid");
    if (snapshot.ball !== null) point(snapshot.ball);
    const snapshotPlayerIds = new Set((snapshot.players as Array<{ id: number }>).map((marker) => marker.id));
    check(integer(snapshot.ballHandlerId) && snapshotPlayerIds.has(snapshot.ballHandlerId), "Read checkpoint must capture a held ball and its handler");
    check(snapshot.ball !== null, "Read checkpoint held ball position is required");
    check(Array.isArray(item.choices) && item.choices.length >= 2 && item.choices.length <= 3, "Read checkpoints need two or three choices");
    const choiceIds = new Set<string>();
    for (const choice of item.choices) {
      check(object(choice) && typeof choice.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(choice.id) && !choiceIds.has(choice.id), "Read choice identities must be unique");
      choiceIds.add(choice.id);
      check(typeof choice.label === "string" && choice.label.trim().length > 0 && Array.from(choice.label).length <= 80
        && Array.isArray(choice.arrows) && choice.arrows.length >= 1 && choice.arrows.length <= 30, "Read choice is invalid");
      const path = { ...source, name: `${String(source.name)} · ${choice.label}`.slice(0, 80), id: String(source.id), arrows: choice.arrows, branches: undefined, readCoach: undefined, spacingGates: undefined, baitPayoffs: undefined };
      validatePlaybookDocument(path);
    }
    check(typeof item.correctChoiceId === "string" && choiceIds.has(item.correctChoiceId), "Choose one intended read");
  }
}

export function validateSavedPlaybook(value: unknown): asserts value is PlaybookDocument {
  validatePlaybookDocument(value);
  check(object(value) && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && Array.isArray(value.players) && Array.isArray(value.defenders) && Array.isArray(value.arrows), "Saved play is incomplete");
}

export type PlaybookSaveIdentity = { operation: "create"; sourceId: string } | { operation: "update"; id: string };
export const INVALID_PLAYBOOK_SAVE = "The save returned an invalid play · Your draft is still in memory; retry saving";

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
