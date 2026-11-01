import { bindAuthoredActions, pointDistanceFeet } from "./simulation.ts";
import { resolvePlaybookPath } from "./playbookBranches.ts";
import { validatePlaybookDocument } from "./documentValidation.ts";
import type { ArrowKind, PlaybookArrow, PlaybookDraft } from "./types.ts";
import { clonePlaybook } from "./types.ts";

export type RoleJobLabel = "Handler" | "Passer" | "Handoff giver" | "Receiver" | "Screener" | "Screen user" | "Cutter" | "Roller" | "Popper" | "Mover" | "Hold position";
export type RoleJob = { label: RoleJobLabel; actionIds: string[]; sequences: number[] };
export type PlayerRoleAssignment = { playerId: number; jobs: RoleJob[] };
export type RoleParticipantChange = { role: string; beforeId: number; afterId: number };
export type RoleActionChange = { actionId: string; sequence: number; kind: ArrowKind; participants: RoleParticipantChange[] };
export type RoleReferenceChange = { category: "Timing" | "Spacing gate" | "My Role cue" | "Bait & Payoff"; label: string; before: string; after: string; review: boolean };
export type RoleSwitchPathImpact = { branchId: string | null; label: string; actions: RoleActionChange[] };
export type RoleSwitchPreview = {
  sourceKey: string;
  firstPlayerId: number;
  secondPlayerId: number;
  after: PlaybookDraft;
  paths: RoleSwitchPathImpact[];
  references: RoleReferenceChange[];
  frozenLessonCount: number;
  materializedBallLocation: boolean;
  validationErrors: string[];
};

type RoleAssignment = { role: string; playerId: number };
type BoundAction = ReturnType<typeof bindAuthoredActions>[number];
const transferKinds = new Set<ArrowKind>(["pass", "handoff"]);
const onBallScreenKinds = new Set<ArrowKind>(["screen", "slip-screen", "pick-roll", "pick-pop"]);
const offBallScreenKinds = new Set<ArrowKind>(["off-ball-screen", "pin-down"]);

export function roleSwitchSourceKey(source: PlaybookDraft) {
  return JSON.stringify(source);
}

function swapId(id: number | undefined, first: number, second: number): number | undefined {
  if (id === first) return second;
  if (id === second) return first;
  return id;
}

function assignmentRoles(action: BoundAction): RoleAssignment[] {
  const { arrow, actorId, recipientId, partnerId } = action;
  if (transferKinds.has(arrow.kind)) return [
    ...(actorId == null ? [] : [{ role: arrow.kind === "pass" ? "Passer" : "Handler", playerId: actorId }]),
    ...(actorId != null && arrow.kind === "handoff" ? [{ role: "Handoff giver", playerId: actorId }] : []),
    ...(recipientId == null ? [] : [{ role: "Receiver", playerId: recipientId }]),
  ];
  if (offBallScreenKinds.has(arrow.kind)) return [
    ...(actorId == null ? [] : [{ role: "Screener", playerId: actorId }]),
    ...(recipientId == null ? [] : [{ role: "Cutter", playerId: recipientId }, { role: "Screen user", playerId: recipientId }]),
  ];
  if (onBallScreenKinds.has(arrow.kind)) return [
    ...(actorId == null ? [] : [{ role: arrow.kind === "slip-screen" ? "Roller" : "Screener", playerId: actorId }]),
    ...(partnerId == null ? [] : [{ role: "Screen user", playerId: partnerId }, { role: "Handler", playerId: partnerId }]),
    ...(arrow.kind === "pick-roll" && actorId != null ? [{ role: "Roller", playerId: actorId }] : []),
    ...(arrow.kind === "pick-pop" && actorId != null ? [{ role: "Popper", playerId: actorId }] : []),
  ];
  if (arrow.kind === "backdoor-cut") return actorId == null ? [] : [{ role: "Cutter", playerId: actorId }];
  return actorId == null ? [] : [{ role: action.onBall ? "Handler" : "Mover", playerId: actorId }];
}

/** Build factual, action-bound job badges for the selected resolved path */
export function roleAssignmentsForPath(source: PlaybookDraft): PlayerRoleAssignment[] {
  const jobsByPlayer = new Map(source.players.map((player) => [player.id, new Map<RoleJobLabel, RoleJob>()]));
  const actions = bindAuthoredActions(source);
  for (const action of actions) for (const item of assignmentRoles(action)) {
    const jobs = jobsByPlayer.get(item.playerId);
    if (!jobs) continue;
    const label = item.role as RoleJobLabel;
    const job = jobs.get(label) ?? { label, actionIds: [], sequences: [] };
    if (!job.actionIds.includes(action.arrow.id)) {
      job.actionIds.push(action.arrow.id);
      job.sequences.push(action.sequence);
    }
    jobs.set(label, job);
  }
  return source.players.map((player) => {
    const jobs = [...jobsByPlayer.get(player.id)!.values()];
    return { playerId: player.id, jobs: jobs.length ? jobs : [{ label: "Hold position", actionIds: [], sequences: [] }] };
  });
}

function nearestStartingHandler(source: PlaybookDraft): number | null {
  if (!source.players.length) return null;
  const target = source.ball ?? source.players[0];
  let nearest = source.players[0];
  let distance = pointDistanceFeet(nearest, target);
  for (const player of source.players.slice(1)) {
    const candidate = pointDistanceFeet(player, target);
    if (candidate < distance) { nearest = player; distance = candidate; }
  }
  return nearest.id;
}

function bindArrowParticipants(arrow: PlaybookArrow, binding: BoundAction, first: number, second: number): PlaybookArrow {
  const next: PlaybookArrow = {
    ...arrow,
    ...(arrow.actor_id == null ? {} : { actor_id: swapId(arrow.actor_id, first, second) }),
    ...(arrow.recipient_id == null ? {} : { recipient_id: swapId(arrow.recipient_id, first, second) }),
    ...(arrow.screener_id == null ? {} : { screener_id: swapId(arrow.screener_id, first, second) }),
    ...(arrow.cutter_id == null ? {} : { cutter_id: swapId(arrow.cutter_id, first, second) }),
    ...(arrow.handler_id == null ? {} : { handler_id: swapId(arrow.handler_id, first, second) }),
  };
  const mappedActor = swapId(binding.actorId ?? undefined, first, second);
  const mappedRecipient = swapId(binding.recipientId ?? undefined, first, second);
  if (mappedActor != null) {
    if (onBallScreenKinds.has(arrow.kind) || offBallScreenKinds.has(arrow.kind)) next.screener_id = mappedActor;
    else next.actor_id = mappedActor;
  }
  if (mappedRecipient != null) {
    if (offBallScreenKinds.has(arrow.kind)) next.cutter_id = mappedRecipient;
    else if (transferKinds.has(arrow.kind)) next.recipient_id = mappedRecipient;
  }
  const mappedHandler = swapId(binding.partnerId ?? undefined, first, second);
  if (onBallScreenKinds.has(arrow.kind) && mappedHandler != null && mappedHandler !== mappedActor) next.handler_id = mappedHandler;
  return next;
}

function roleAssignmentsForAction(action: BoundAction): RoleAssignment[] {
  return assignmentRoles(action);
}

function changedAction(action: BoundAction, after: BoundAction, first: number, second: number): RoleActionChange | null {
  const beforeRoles = roleAssignmentsForAction(action);
  const afterRoles = roleAssignmentsForAction(after);
  const afterByRole = new Map(afterRoles.map((role) => [role.role, role.playerId]));
  const participants = beforeRoles.flatMap((role) => {
    const mappedId = swapId(role.playerId, first, second)!;
    return afterByRole.get(role.role) === mappedId && mappedId !== role.playerId
      ? [{ role: role.role, beforeId: role.playerId, afterId: mappedId }]
      : [];
  });
  return participants.length ? { actionId: action.arrow.id, sequence: action.sequence, kind: action.arrow.kind, participants } : null;
}

function mapAction(arrow: PlaybookArrow, binding: BoundAction, first: number, second: number) {
  return bindArrowParticipants(arrow, binding, first, second);
}

function remapTeachingReferences(source: PlaybookDraft, first: number, second: number) {
  if (source.roleCues) source.roleCues = { ...source.roleCues, cues: source.roleCues.cues.map((cue) => ({ ...cue, playerId: swapId(cue.playerId, first, second)! })) };
  if (source.spacingGates) source.spacingGates = { ...source.spacingGates, gates: source.spacingGates.gates.map((gate) => ({
    ...gate, playerId: swapId(gate.playerId, first, second)!,
    trigger: { ...gate.trigger, ...(gate.trigger.routePlayerId == null ? {} : { routePlayerId: swapId(gate.trigger.routePlayerId, first, second) }) },
  })) };
  if (source.baitPayoffs) source.baitPayoffs = { ...source.baitPayoffs, connections: source.baitPayoffs.connections.map((connection) => ({
    ...connection,
    ...(connection.reaction ? { reaction: { ...connection.reaction, checkpoint: { ...connection.reaction.checkpoint,
      ...(connection.reaction.checkpoint.routePlayerId == null ? {} : { routePlayerId: swapId(connection.reaction.checkpoint.routePlayerId, first, second) }) } } } : {}),
  })) };
}

/** Prepare and validate a full-family player/job exchange without mutating its source */
export function prepareRoleSwitch(source: PlaybookDraft, firstPlayerId: number, secondPlayerId: number): RoleSwitchPreview {
  validatePlaybookDocument(source);
  if (firstPlayerId === secondPlayerId) throw new Error("Choose two different offensive players");
  if (!source.players.some((player) => player.id === firstPlayerId) || !source.players.some((player) => player.id === secondPlayerId)) {
    throw new Error("Both selected players must still be on the offensive roster");
  }
  const idMap = (id: number | null) => id == null ? null : swapId(id, firstPlayerId, secondPlayerId)!;
  const pathIds: Array<{ id: string | null; label: string }> = [{ id: null, label: "Main" }, ...(source.branches ?? []).map((branch) => ({ id: branch.id, label: branch.label }))];
  const bindingsByPath = new Map<string | null, BoundAction[]>();
  const resolvedByPath = new Map<string | null, ReturnType<typeof resolvePlaybookPath>>();
  for (const path of pathIds) {
    const resolved = resolvePlaybookPath(source, path.id);
    resolvedByPath.set(path.id, resolved);
    bindingsByPath.set(path.id, bindAuthoredActions(resolved.play));
  }

  const after = clonePlaybook(source);
  const first = after.players.find((player) => player.id === firstPlayerId)!;
  const second = after.players.find((player) => player.id === secondPlayerId)!;
  const firstPoint = { x: first.x, y: first.y };
  const materializedBallLocation = after.ball == null && after.players.length > 0;
  // An omitted ball starts at Player 1's spot in the existing simulator
  // Materialize that same point before exchanging coordinates so possession
  // stays at its original court location and follows the incoming role
  if (materializedBallLocation) after.ball = { x: after.players[0].x, y: after.players[0].y };
  first.x = second.x; first.y = second.y;
  second.x = firstPoint.x; second.y = firstPoint.y;

  const mainBindings = new Map(bindingsByPath.get(null)!.map((action) => [action.arrow.id, action]));
  const updateArrowList = (arrows: PlaybookArrow[], bindings: Map<string, BoundAction>) => arrows.map((arrow) => {
    const binding = bindings.get(arrow.id);
    return binding ? mapAction(arrow, binding, firstPlayerId, secondPlayerId) : arrow;
  });
  after.arrows = updateArrowList(after.arrows, mainBindings);
  after.branches = after.branches?.map((branch) => {
    const bindings = new Map((bindingsByPath.get(branch.id) ?? []).map((action) => [action.arrow.id, action]));
    return { ...branch, continuation: updateArrowList(branch.continuation, bindings) };
  });
  after.arrows = after.arrows.map((arrow) => arrow.timingPlan?.waits?.length ? { ...arrow, timingPlan: { ...arrow.timingPlan, waits: arrow.timingPlan.waits.map((wait) => ({ ...wait, ...(wait.playerId == null ? {} : { playerId: swapId(wait.playerId, firstPlayerId, secondPlayerId) }) })) } } : arrow);
  after.branches = after.branches?.map((branch) => ({ ...branch, continuation: branch.continuation.map((arrow) => arrow.timingPlan?.waits?.length
    ? { ...arrow, timingPlan: { ...arrow.timingPlan, waits: arrow.timingPlan.waits.map((wait) => ({ ...wait, ...(wait.playerId == null ? {} : { playerId: swapId(wait.playerId, firstPlayerId, secondPlayerId) }) })) } }
    : arrow) }));
  remapTeachingReferences(after, firstPlayerId, secondPlayerId);

  const validationErrors: string[] = [];
  try { validatePlaybookDocument(after); }
  catch (error) { validationErrors.push(error instanceof Error ? error.message : "The reassigned play is not valid"); }
  const impacts: RoleSwitchPathImpact[] = [];
  for (const path of pathIds) {
    const beforePath = resolvedByPath.get(path.id)!;
    const afterPath = resolvePlaybookPath(after, path.id);
    const beforeBindings = bindingsByPath.get(path.id)!;
    const afterBindings = bindAuthoredActions(afterPath.play);
    const afterById = new Map(afterBindings.map((action) => [action.arrow.id, action]));
    for (const beforeAction of beforeBindings) {
      const afterAction = afterById.get(beforeAction.arrow.id);
      if (!afterAction) throw new Error(`${path.label} no longer contains Move ${beforeAction.sequence}`);
      const expected = { actorId: idMap(beforeAction.actorId), recipientId: idMap(beforeAction.recipientId), partnerId: idMap(beforeAction.partnerId ?? null) };
      if (afterAction.actorId !== expected.actorId || afterAction.recipientId !== expected.recipientId || (afterAction.partnerId ?? null) !== expected.partnerId) {
        validationErrors.push(`${path.label} Move ${beforeAction.sequence} would bind to a different player than the selected role swap allows`);
      }
    }
    const oldHandler = nearestStartingHandler(beforePath.play);
    const newHandler = nearestStartingHandler(afterPath.play);
    if (oldHandler != null && newHandler !== idMap(oldHandler)) validationErrors.push(`${path.label} would start with a different ball handler than the exchanged starting spot · Move the ball or choose another pair first`);
    const actionChanges = beforeBindings.flatMap((action) => {
      const replacement = afterById.get(action.arrow.id)!;
      const change = changedAction(action, replacement, firstPlayerId, secondPlayerId);
      return change ? [change] : [];
    });
    impacts.push({ branchId: path.id, label: path.label, actions: actionChanges });
  }

  const changedActionIds = new Set(impacts.flatMap((impact) => impact.actions.map((action) => action.actionId)));
  const allActions = [...source.arrows, ...(source.branches ?? []).flatMap((branch) => branch.continuation)];
  const sequenceOfAction = (actionId: string) => allActions.find((item) => item.id === actionId)?.sequence ?? "?";
  const referenceChanges: RoleReferenceChange[] = [];
  for (const arrow of allActions) {
    for (const wait of arrow.timingPlan?.waits ?? []) {
      const playerChanged = wait.playerId === firstPlayerId || wait.playerId === secondPlayerId;
      const eventActionChanged = changedActionIds.has(wait.actionId);
      const dependentActionChanged = changedActionIds.has(arrow.id);
      if (!playerChanged && !eventActionChanged && !dependentActionChanged) continue;
      const before = playerChanged ? `Player ${wait.playerId}` : `Move ${sequenceOfAction(wait.actionId)} · ${wait.event}`;
      const after = playerChanged ? `Player ${swapId(wait.playerId, firstPlayerId, secondPlayerId)}` : `Move ${sequenceOfAction(wait.actionId)} · ${wait.event} stays connected`;
      referenceChanges.push({ category: "Timing", label: `Wait in Move ${arrow.sequence ?? "?"} · ${wait.event} at Move ${sequenceOfAction(wait.actionId)}`,
        before, after, review: false });
    }
  }
  for (const gate of source.spacingGates?.gates ?? []) {
    const assigned = gate.playerId === firstPlayerId || gate.playerId === secondPlayerId;
    const routePlayer = gate.trigger.routePlayerId === firstPlayerId || gate.trigger.routePlayerId === secondPlayerId;
    const actionChanged = changedActionIds.has(gate.trigger.actionId);
    if (assigned || routePlayer || actionChanged) referenceChanges.push({ category: "Spacing gate", label: gate.instruction?.trim() || `Gate · Move ${gate.trigger.actionId}`,
      before: [assigned ? `assigned to Player ${gate.playerId}` : "", routePlayer ? `route uses Player ${gate.trigger.routePlayerId}` : ""].filter(Boolean).join(" · "),
      after: [assigned ? `assigned to Player ${swapId(gate.playerId, firstPlayerId, secondPlayerId)}` : "", routePlayer ? `route uses Player ${swapId(gate.trigger.routePlayerId!, firstPlayerId, secondPlayerId)}` : "", actionChanged ? "Checkpoint action roles changed" : ""].filter(Boolean).join(" · "), review: true });
  }
  for (const cue of source.roleCues?.cues ?? []) if (cue.playerId === firstPlayerId || cue.playerId === secondPlayerId || changedActionIds.has(cue.actionId)) {
    referenceChanges.push({ category: "My Role cue", label: `Move ${sequenceOfAction(cue.actionId)} · ${cue.phase}`,
      before: `Player ${cue.playerId} · ${cue.text}`, after: `${swapId(cue.playerId, firstPlayerId, secondPlayerId) === cue.playerId ? `Player ${cue.playerId}` : `Player ${swapId(cue.playerId, firstPlayerId, secondPlayerId)}`} · Wording kept for review`, review: true });
  }
  for (const connection of source.baitPayoffs?.connections ?? []) {
    const routePlayer = connection.reaction?.checkpoint.routePlayerId;
    const changed = changedActionIds.has(connection.baitActionId) || changedActionIds.has(connection.payoffActionId);
    if (routePlayer === firstPlayerId || routePlayer === secondPlayerId || changed) {
      referenceChanges.push({ category: "Bait & Payoff", label: connection.title,
        before: routePlayer === firstPlayerId || routePlayer === secondPlayerId ? `Reaction route · Player ${routePlayer}` : `Move ${connection.baitActionId} → Move ${connection.payoffActionId}`,
        after: routePlayer === firstPlayerId || routePlayer === secondPlayerId ? `Reaction route · Player ${swapId(routePlayer!, firstPlayerId, secondPlayerId)} · Wording kept for review` : "Linked actions stay connected · Wording flagged for review", review: true });
    }
  }

  const uniqueReferences = [...new Map(referenceChanges.map((item) => [`${item.category}:${item.label}:${item.before}:${item.after}`, item])).values()];
  return {
    sourceKey: roleSwitchSourceKey(source), firstPlayerId, secondPlayerId, after, paths: impacts, references: uniqueReferences,
    frozenLessonCount: (source.readCoach?.checkpoints.length ?? 0) + (source.flipbooks?.stories.length ?? 0),
    materializedBallLocation,
    validationErrors: [...new Set(validationErrors)],
  };
}

