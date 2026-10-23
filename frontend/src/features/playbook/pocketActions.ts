import { NBA_COURT_DIMENSIONS, NBA_COURT_GEOMETRY, courtSvgToPoint } from "./courtGeometry.ts";
import type { CourtPoint, PlaybookArrow, PlaybookDraft, PlaybookTimingWait } from "./types.ts";
import { bindAuthoredActions } from "./simulation.ts";
import { snapTimingMs } from "./timingMixer.ts";

export type PocketRole = { id: string; label: string; sourcePlayerId?: number; entry: CourtPoint };
export type PocketWait = Omit<PlaybookTimingWait, "actionId" | "playerId"> & { sourceAction: string; playerRole?: string };
export type PocketAction = {
  id: string;
  arrow: Omit<PlaybookArrow, "actor_id" | "recipient_id" | "screener_id" | "handler_id" | "cutter_id" | "timingPlan">;
  participants: Partial<Record<"actor" | "recipient" | "screener" | "handler" | "cutter", string>>;
  startAtMs: number;
  durationMs: number;
  syncGroup?: string;
  waits: PocketWait[];
};
export type PocketActionDocument = {
  version: 1;
  id: string;
  revision: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  roles: PocketRole[];
  actions: PocketAction[];
  requiredBallRole?: string;
  summary?: string;
  starter?: boolean;
};
export type PocketTransform = { anchor: CourtPoint; rotation: number; mirrored: boolean };
export type PocketCaptureIssue = { kind: "simultaneous" | "sync" | "external-wait"; actionIds: string[]; message: string };
export type PocketInsertion = { arrows: PlaybookArrow[]; insertedIds: string[]; setupIds: string[]; firstActionId: string; durationMs: number; startAtMs: number };

const allowedKinds = new Set(["movement", "pass", "screen", "slip-screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"]);
const pointValid = (point: unknown): point is CourtPoint => !!point && typeof point === "object" && Number.isFinite((point as CourtPoint).x) && Number.isFinite((point as CourtPoint).y) && (point as CourtPoint).x >= 0 && (point as CourtPoint).x <= 100 && (point as CourtPoint).y >= 0 && (point as CourtPoint).y <= 100;
const identity = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;

function participantEntries(action: PocketAction, roleMap: Map<string, number>) {
  const result: Partial<Pick<PlaybookArrow, "actor_id" | "recipient_id" | "screener_id" | "handler_id" | "cutter_id">> = {};
  for (const field of ["actor", "recipient", "screener", "handler", "cutter"] as const) {
    const role = action.participants[field];
    if (role) {
      const playerId = roleMap.get(role);
      if (playerId == null) throw new Error(`Assign the ${role} role before placing this combination`);
      result[`${field}_id` as keyof typeof result] = playerId as never;
    }
  }
  return result;
}

function metric(point: CourtPoint) {
  return { x: point.x * NBA_COURT_DIMENSIONS.widthFeet / 100, y: point.y * NBA_COURT_DIMENSIONS.halfLengthFeet / 100 };
}
function normalized(point: CourtPoint) {
  return { x: point.x * 100 / NBA_COURT_DIMENSIONS.widthFeet, y: point.y * 100 / NBA_COURT_DIMENSIONS.halfLengthFeet };
}
function physicalBoundary() {
  const { left, right, top, bottom } = NBA_COURT_GEOMETRY.boundary;
  const upperLeft = courtSvgToPoint({ x: left, y: top });
  const lowerRight = courtSvgToPoint({ x: right, y: bottom });
  return { left: upperLeft.x, right: lowerRight.x, top: upperLeft.y, bottom: lowerRight.y };
}
function transformPoint(point: CourtPoint, sourceAnchor: CourtPoint, targetAnchor: CourtPoint, rotation: number, mirrored: boolean): CourtPoint {
  const source = metric(point), origin = metric(sourceAnchor), target = metric(targetAnchor);
  let dx = source.x - origin.x;
  const dy = source.y - origin.y;
  if (mirrored) dx *= -1;
  const radians = rotation * Math.PI / 180;
  const placed = normalized({ x: target.x + dx * Math.cos(radians) - dy * Math.sin(radians), y: target.y + dx * Math.sin(radians) + dy * Math.cos(radians) });
  return { x: Math.round(placed.x * 10000) / 10000, y: Math.round(placed.y * 10000) / 10000 };
}

export function validatePocketAction(value: unknown): asserts value is PocketActionDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pocket action must be an object");
  const pocket = value as PocketActionDocument;
  if (Object.keys(value).some((key) => !["version", "id", "revision", "name", "createdAt", "updatedAt", "roles", "actions", "requiredBallRole", "summary", "starter"].includes(key))) throw new Error("Pocket action contains unsupported fields");
  if (pocket.version !== 1 || !/^pocket-[a-z0-9-]{8,72}$/.test(pocket.id) || typeof pocket.revision !== "string" || !pocket.revision || pocket.revision.length > 128 || typeof pocket.name !== "string" || !pocket.name.trim() || pocket.name.trim().length > 60) throw new Error("Pocket identity or name is invalid");
  if (![pocket.createdAt, pocket.updatedAt].every((date) => typeof date === "string" && Number.isFinite(Date.parse(date)))) throw new Error("Pocket timestamps are invalid");
  if (pocket.summary !== undefined && (typeof pocket.summary !== "string" || pocket.summary.length > 300) || pocket.starter !== undefined && typeof pocket.starter !== "boolean") throw new Error("Pocket metadata is invalid");
  if (!Array.isArray(pocket.roles) || pocket.roles.length < 1 || pocket.roles.length > 5 || !Array.isArray(pocket.actions) || pocket.actions.length < 1 || pocket.actions.length > 30) throw new Error("Pocket actions need one to five roles and one to thirty actions");
  const roles = new Set<string>();
  for (const role of pocket.roles) {
    if (!role || typeof role !== "object" || Object.keys(role).some((key) => !["id", "label", "entry", "sourcePlayerId"].includes(key)) || !/^role-[a-z0-9-]{1,32}$/.test(role.id) || roles.has(role.id) || typeof role.label !== "string" || !role.label.trim() || role.label.trim().length > 40 || !pointValid(role.entry) || role.sourcePlayerId !== undefined && (!Number.isInteger(role.sourcePlayerId) || role.sourcePlayerId < 1 || role.sourcePlayerId > 5)) throw new Error("Pocket role is invalid");
    roles.add(role.id);
  }
  const actions = new Set<string>();
  const waitIds = new Set<string>();
  for (const action of pocket.actions) {
    if (!action || typeof action !== "object" || Object.keys(action).some((key) => !["id", "arrow", "participants", "startAtMs", "durationMs", "syncGroup", "waits"].includes(key)) || !/^pact-[a-z0-9-]{1,48}$/.test(action.id) || actions.has(action.id) || !action.arrow || typeof action.arrow !== "object" || action.arrow.id !== action.id || Object.keys(action.arrow).some((key) => !["id", "kind", "start", "end", "sequence", "path", "control", "timing", "exit_target"].includes(key)) || !allowedKinds.has(action.arrow.kind) || !pointValid(action.arrow.start) || !pointValid(action.arrow.end) || action.arrow.control !== undefined && !pointValid(action.arrow.control) || action.arrow.exit_target !== undefined && !pointValid(action.arrow.exit_target) || action.arrow.path !== undefined && !["straight", "curve"].includes(action.arrow.path) || action.arrow.path === "curve" && !action.arrow.control || action.arrow.sequence !== undefined && (!Number.isInteger(action.arrow.sequence) || action.arrow.sequence < 1 || action.arrow.sequence > 30) || action.arrow.timing !== undefined && (!Number.isFinite(action.arrow.timing) || action.arrow.timing < .5 || action.arrow.timing > 4) || !Number.isFinite(action.startAtMs) || action.startAtMs < 0 || action.startAtMs > 120000 || !Number.isFinite(action.durationMs) || action.durationMs < 500 || action.durationMs > 120000 || !action.participants || typeof action.participants !== "object" || Array.isArray(action.participants) || Object.keys(action.participants).some((key) => !["actor", "recipient", "screener", "handler", "cutter"].includes(key)) || !Array.isArray(action.waits) || action.waits.length > 30 || action.syncGroup !== undefined && (typeof action.syncGroup !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(action.syncGroup))) throw new Error("Pocket action details are invalid");
    actions.add(action.id);
    for (const role of Object.values(action.participants)) if (typeof role !== "string" || !roles.has(role)) throw new Error("Pocket action references a missing role");
    const has = (key: keyof PocketAction["participants"]) => typeof action.participants[key] === "string";
    const required = ["movement", "backdoor-cut"].includes(action.arrow.kind) ? [action.participants.actor]
      : ["pass", "handoff"].includes(action.arrow.kind) ? [action.participants.actor, action.participants.recipient]
        : ["screen", "slip-screen", "pick-roll", "pick-pop"].includes(action.arrow.kind) ? [action.participants.screener, action.participants.handler]
          : ["off-ball-screen", "pin-down"].includes(action.arrow.kind) ? [action.participants.screener, action.participants.cutter] : [];
    if (required.some((role) => typeof role !== "string") || new Set(required).size !== required.length) throw new Error("Pocket action needs distinct roles for every required participant");
  }
  if (pocket.requiredBallRole !== undefined && (typeof pocket.requiredBallRole !== "string" || !roles.has(pocket.requiredBallRole))) throw new Error("Pocket possession role is missing");
  for (const action of pocket.actions) for (const wait of action.waits) {
    if (!wait || typeof wait !== "object" || Object.keys(wait).some((key) => !["id", "sourceAction", "event", "playerRole", "routePhase", "routeSegment", "progress"].includes(key)) || typeof wait.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(wait.id) || waitIds.has(wait.id) || !actions.has(wait.sourceAction) || wait.sourceAction === action.id || !["start", "complete", "catch", "screen-set", "screen-use", "route-point"].includes(wait.event) || wait.playerRole !== undefined && !roles.has(wait.playerRole) || wait.event === "route-point" && (wait.playerRole === undefined || !["main", "approach", "use", "release"].includes(wait.routePhase ?? "") || !Number.isInteger(wait.routeSegment) || wait.routeSegment! < 0 || wait.routeSegment! > 63 || !Number.isFinite(wait.progress) || wait.progress! <= 0 || wait.progress! >= 1) || wait.event !== "route-point" && (wait.playerRole !== undefined || wait.routePhase !== undefined || wait.routeSegment !== undefined || wait.progress !== undefined)) throw new Error("Pocket contains an invalid internal wait");
    const source = pocket.actions.find((candidate) => candidate.id === wait.sourceAction)?.arrow.kind;
    if (wait.event === "catch" && source !== "pass" && source !== "handoff" || ["screen-set", "screen-use"].includes(wait.event) && !["screen", "slip-screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down"].includes(source ?? "")) throw new Error("Pocket wait event does not match its source action");
    waitIds.add(wait.id);
  }
  const graph = new Map(pocket.actions.map((action) => [action.id, action.waits.map((wait) => wait.sourceAction)]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Pocket waits cannot form a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
  const syncByAction = new Map<string, string>();
  const syncStarts = new Map<string, Set<number>>();
  for (const action of pocket.actions) if (action.syncGroup) {
    syncByAction.set(action.id, action.syncGroup);
    const starts = syncStarts.get(action.syncGroup) ?? new Set<number>();
    starts.add(action.startAtMs);
    syncStarts.set(action.syncGroup, starts);
  }
  if ([...syncStarts.values()].some((starts) => starts.size !== 1)) throw new Error("Pinned pocket actions need one planned start time");
  for (const [groupId] of syncStarts) {
    const members = pocket.actions.filter((action) => action.syncGroup === groupId);
    const owners = new Set<string>();
    let transfers = 0;
    for (const action of members) {
      const kind = action.arrow.kind;
      if (kind === "pass" || kind === "handoff") transfers += 1;
      const fields = ["off-ball-screen", "pin-down"].includes(kind) ? ["screener", "cutter"]
        : ["screen", "slip-screen", "pick-roll", "pick-pop"].includes(kind) ? ["screener", "handler"]
          : kind === "handoff" ? ["actor", "recipient"]
            : kind === "pass" ? ["recipient"]
              : ["movement", "backdoor-cut"].includes(kind) ? ["actor"] : [];
      for (const field of fields) {
        const owner = action.participants[field as keyof PocketAction["participants"]];
        if (!owner) continue;
        if (owners.has(owner)) throw new Error("Pinned pocket actions cannot claim the same movement role");
        owners.add(owner);
      }
    }
    if (transfers > 1) throw new Error("A pinned pocket group cannot start competing ball transfers");
  }
  const eventGraph = new Map<string, Set<string>>();
  const eventNode = (actionId: string) => syncByAction.has(actionId) ? `sync:${syncByAction.get(actionId)}` : `action:${actionId}`;
  for (const action of pocket.actions) {
    const node = eventNode(action.id);
    eventGraph.set(node, eventGraph.get(node) ?? new Set());
    for (const wait of action.waits) {
      const dependency = eventNode(wait.sourceAction);
      if (node === dependency) throw new Error("Pinned actions cannot wait on one another");
      eventGraph.get(node)!.add(dependency);
      eventGraph.set(dependency, eventGraph.get(dependency) ?? new Set());
    }
  }
  const checkedEvents = new Set<string>();
  const visitEvent = (node: string, active: Set<string>) => {
    if (active.has(node)) throw new Error("Pocket waits cannot form a cycle through synchronized actions");
    if (checkedEvents.has(node)) return;
    active.add(node);
    for (const dependency of eventGraph.get(node) ?? []) visitEvent(dependency, active);
    active.delete(node);
    checkedEvents.add(node);
  };
  for (const node of eventGraph.keys()) visitEvent(node, new Set());
}

export function inspectPocketCapture(arrows: PlaybookArrow[], selectedIds: string[]): PocketCaptureIssue[] {
  const selected = new Set(selectedIds);
  const issues: PocketCaptureIssue[] = [];
  for (const arrow of arrows.filter((item) => selected.has(item.id))) {
    const sameMove = arrows.filter((item) => (item.sequence ?? 1) === (arrow.sequence ?? 1));
    if (sameMove.length > 1 && sameMove.some((item) => !selected.has(item.id))) issues.push({ kind: "simultaneous", actionIds: sameMove.map((item) => item.id), message: `Move ${arrow.sequence ?? 1} runs together. Include every action in the move or confirm removing the unselected action` });
    const sync = arrow.timingPlan?.syncId;
    if (sync) {
      const members = arrows.filter((item) => item.timingPlan?.syncId === sync);
      if (members.some((item) => !selected.has(item.id))) issues.push({ kind: "sync", actionIds: members.map((item) => item.id), message: "A pinned action group is only partly selected. Include the full group or remove its pin in the pocket copy" });
    }
    for (const wait of arrow.timingPlan?.waits ?? []) if (!selected.has(wait.actionId)) issues.push({ kind: "external-wait", actionIds: [arrow.id, wait.actionId], message: "A selected action waits on a move outside this combination. Include that move or remove the external wait in the pocket copy" });
  }
  return issues.filter((issue, index) => issues.findIndex((candidate) => candidate.kind === issue.kind && candidate.actionIds.slice().sort().join("|") === issue.actionIds.slice().sort().join("|")) === index);
}

export function createPocketFromSelection(source: PlaybookDraft, selectedIds: string[], name: string, removeExternalConnections = false): PocketActionDocument {
  const selected = new Set(selectedIds);
  const arrows = source.arrows.filter((arrow) => selected.has(arrow.id));
  if (!arrows.length) throw new Error("Select at least one action to save a pocket");
  const issues = inspectPocketCapture(source.arrows, selectedIds);
  if (issues.length && !removeExternalConnections) throw new Error(issues[0].message);
  const bindings = new Map(bindAuthoredActions(source).map((binding) => [binding.arrow.id, binding]));
  const participants = new Map<number, { label: string; entry: CourtPoint }>();
  const take = (id: number | null | undefined, label: string, entry?: CourtPoint | null) => {
    if (id == null) return;
    const existing = participants.get(id);
    if (!existing) participants.set(id, { label, entry: entry ? { ...entry } : { x: 50, y: 50 } });
    else if (entry && existing.entry.x === 50 && existing.entry.y === 50) existing.entry = { ...entry };
  };
  for (const arrow of arrows) {
    const binding = bindings.get(arrow.id);
    const hasActorRole = ["movement", "backdoor-cut", "pass", "handoff"].includes(arrow.kind);
    const actionRoles: Array<[number | null | undefined, string, CourtPoint | null | undefined]> = [
      [hasActorRole ? arrow.actor_id ?? binding?.actorId : undefined, arrow.kind === "pass" || arrow.kind === "handoff" ? "Ball handler" : "Mover", binding?.plannedStart ?? arrow.start],
      [arrow.recipient_id ?? binding?.recipientId, "Receiver", binding?.recipientStart ?? arrow.end],
      [arrow.screener_id ?? binding?.actorId, "Screener", binding?.plannedStart ?? arrow.start],
      [arrow.handler_id ?? binding?.partnerId, "Ball handler", binding?.partnerStart ?? binding?.plannedStart ?? arrow.start],
      [arrow.cutter_id ?? (arrow.kind === "off-ball-screen" || arrow.kind === "pin-down" ? binding?.recipientId : undefined), "Cutter", binding?.recipientStart ?? arrow.end],
    ];
    for (const [id, label, entry] of actionRoles) take(id, label, entry);
    for (const wait of arrow.timingPlan?.waits ?? []) {
      if (!selected.has(wait.actionId) || wait.playerId == null) continue;
      const player = source.players.find((candidate) => candidate.id === wait.playerId);
      take(wait.playerId, "Wait player", player ? { x: player.x, y: player.y } : undefined);
    }
  }
  const sourceRole = new Map<number, string>();
  const roles: PocketRole[] = [...participants.entries()].map(([sourcePlayerId, value], index) => {
    const id = `role-${index + 1}`;
    sourceRole.set(sourcePlayerId, id);
    return { id, label: value.label, sourcePlayerId, entry: value.entry };
  });
  const actionKey = new Map(arrows.map((arrow, index) => [arrow.id, `pact-${index + 1}`]));
  const earliest = Math.min(...arrows.map((arrow) => bindings.get(arrow.id)?.startTime ?? (arrow.timingPlan?.startAtMs ?? 0)));
  const syncKey = new Map<string, string>();
  const actions: PocketAction[] = arrows.map((original, index) => {
    const bound = bindings.get(original.id);
    const arrow = structuredClone(original);
    const participants: PocketAction["participants"] = {};
    const assign = (field: keyof PocketAction["participants"], player: number | null | undefined) => { if (player != null && sourceRole.has(player)) participants[field] = sourceRole.get(player)!; };
    if (["movement", "backdoor-cut", "pass", "handoff"].includes(original.kind)) assign("actor", original.actor_id ?? bound?.actorId);
    assign("recipient", original.recipient_id ?? bound?.recipientId);
    assign("screener", original.screener_id ?? bound?.actorId);
    assign("handler", original.handler_id ?? bound?.partnerId);
    assign("cutter", original.cutter_id ?? (original.kind === "off-ball-screen" || original.kind === "pin-down" ? bound?.recipientId : undefined));
    const sync = original.timingPlan?.syncId;
    if (sync && !syncKey.has(sync)) syncKey.set(sync, `sync-${syncKey.size + 1}`);
    const waits: PocketWait[] = (original.timingPlan?.waits ?? []).filter((wait) => selected.has(wait.actionId)).map((wait) => {
      const { actionId, playerId, ...details } = wait;
      return {
        ...details,
        sourceAction: actionKey.get(actionId)!,
        ...(playerId != null && sourceRole.has(playerId) ? { playerRole: sourceRole.get(playerId)! } : {}),
      } as PocketWait;
    });
    delete (arrow as Partial<PlaybookArrow>).actor_id;
    delete (arrow as Partial<PlaybookArrow>).recipient_id;
    delete (arrow as Partial<PlaybookArrow>).screener_id;
    delete (arrow as Partial<PlaybookArrow>).handler_id;
    delete (arrow as Partial<PlaybookArrow>).cutter_id;
    delete (arrow as Partial<PlaybookArrow>).timingPlan;
    arrow.id = actionKey.get(original.id)!;
    arrow.sequence = Math.max(1, Math.round((original.sequence ?? index + 1) - Math.min(...arrows.map((item) => item.sequence ?? 1)) + 1));
    const binding = bindings.get(original.id);
    return { id: actionKey.get(original.id)!, arrow: arrow as PocketAction["arrow"], participants, startAtMs: Math.max(0, Math.round((binding?.startTime ?? original.timingPlan?.startAtMs ?? 0) - earliest)), durationMs: binding?.durationMs ?? Math.round((original.timing ?? 1.2) * 1000), ...(sync && [...source.arrows].filter((item) => item.timingPlan?.syncId === sync).every((item) => selected.has(item.id)) ? { syncGroup: syncKey.get(sync) } : {}), waits };
  });
  const firstTransfer = arrows.filter((arrow) => arrow.kind === "pass" || arrow.kind === "handoff")
    .sort((left, right) => (bindings.get(left.id)?.startTime ?? 0) - (bindings.get(right.id)?.startTime ?? 0) || (left.sequence ?? 0) - (right.sequence ?? 0))[0];
  const firstTransferBinding = firstTransfer ? bindings.get(firstTransfer.id) : undefined;
  const requiredPlayer = firstTransfer?.actor_id ?? firstTransferBinding?.actorId;
  const now = new Date().toISOString();
  const pocket: PocketActionDocument = { version: 1, id: identity("pocket"), revision: identity("rev"), name: name.trim().slice(0, 60) || "Untitled combination", createdAt: now, updatedAt: now, roles, actions, ...(requiredPlayer != null && sourceRole.has(requiredPlayer) ? { requiredBallRole: sourceRole.get(requiredPlayer)! } : {}) };
  validatePocketAction(pocket);
  return pocket;
}

export function transformPocketActions(pocket: PocketActionDocument, assignments: Record<string, number>, transform: PocketTransform) {
  validatePocketAction(pocket);
  if (!pointValid(transform.anchor) || !Number.isFinite(transform.rotation) || Math.abs(transform.rotation) > 360 || typeof transform.mirrored !== "boolean") throw new Error("Pocket placement coordinates or rotation are invalid");
  const assigned = new Set<number>();
  const roleMap = new Map<string, number>();
  for (const role of pocket.roles) {
    const playerId = assignments[role.id];
    if (!Number.isInteger(playerId) || assigned.has(playerId)) throw new Error("Assign every pocket role to a different offensive player");
    assigned.add(playerId); roleMap.set(role.id, playerId);
  }
  const anchorRole = pocket.roles[0];
  const anchorPoint = transform.anchor;
  const byPocketId = new Map<string, string>();
  const syncMap = new Map<string, string>();
  pocket.actions.forEach((action) => { if (action.syncGroup && !syncMap.has(action.syncGroup)) syncMap.set(action.syncGroup, identity("sync")); });
  pocket.actions.forEach((action) => byPocketId.set(action.id, identity("arrow")));
  const rotation = Number.isFinite(transform.rotation) ? transform.rotation : 0;
  const arrows = pocket.actions.map((action) => {
    const base = structuredClone(action.arrow) as PlaybookArrow;
    const point = (value: CourtPoint) => transformPoint(value, anchorRole.entry, anchorPoint, rotation, transform.mirrored);
    base.id = byPocketId.get(action.id)!;
    base.start = point(base.start); base.end = point(base.end);
    if (base.control) base.control = point(base.control);
    if (base.exit_target) base.exit_target = point(base.exit_target);
    Object.assign(base, participantEntries(action, roleMap));
    const group = action.syncGroup;
    const waits = action.waits.map((wait) => {
      const { sourceAction, playerRole, ...details } = wait;
      return { ...details, id: identity("wait"), actionId: byPocketId.get(sourceAction)!, ...(playerRole ? { playerId: roleMap.get(playerRole) } : {}) };
    });
    base.timingPlan = { startAtMs: action.startAtMs, ...(group ? { syncId: syncMap.get(group) } : {}), ...(waits.length ? { waits } : {}) };
    return base;
  });
  const boundary = physicalBoundary();
  const points = [...arrows.flatMap((arrow) => [arrow.start, arrow.end, ...(arrow.control ? [arrow.control] : []), ...(arrow.exit_target ? [arrow.exit_target] : [])]), ...pocket.roles.map((role) => transformPoint(role.entry, anchorRole.entry, anchorPoint, rotation, transform.mirrored))];
  if (points.some((point) => point.x < boundary.left || point.x > boundary.right || point.y < boundary.top || point.y > boundary.bottom)) throw new Error("This rotation or placement extends outside the playable court. Adjust the anchor or angle");
  return { arrows, roleMap, entries: new Map(pocket.roles.map((role) => [role.id, transformPoint(role.entry, anchorRole.entry, anchorPoint, rotation, transform.mirrored)])) };
}

export function buildPocketInsertion(options: {
  source: PlaybookDraft;
  pocket: PocketActionDocument;
  assignments: Record<string, number>;
  transform: PocketTransform;
  beforeSequence: number | null;
  currentPositions: Array<{ id: number; x: number; y: number }>;
  currentBallHandlerId: number | null;
  includeConnectionPass: boolean;
  baseStartAtMs: number;
  idFactory?: () => string;
}): PocketInsertion {
  const { source, pocket, assignments, transform } = options;
  if (!Number.isFinite(options.baseStartAtMs) || options.baseStartAtMs < 0 || options.baseStartAtMs > 120_000) throw new Error("Choose an insertion boundary within the 120-second play timeline");
  const baseStartAtMs = snapTimingMs(options.baseStartAtMs);
  const rosterIds = new Set(source.players.map((player) => player.id));
  if (pocket.roles.some((role) => !rosterIds.has(assignments[role.id]))) throw new Error("Assign every pocket role to a player on this court");
  const idFactory = options.idFactory ?? (() => identity("arrow"));
  const { arrows: pocketArrows, roleMap, entries } = transformPocketActions(pocket, assignments, transform);
  const existingSequences = source.arrows.map((arrow, index) => arrow.sequence ?? index + 1);
  const beforeSequence = options.beforeSequence;
  const insertAt = beforeSequence == null ? Math.max(0, ...existingSequences) + 1 : beforeSequence;
  const pocketGroups = [...new Set(pocketArrows.map((arrow) => arrow.sequence ?? 1))].sort((a, b) => a - b);
  const uniqueSetupIds: string[] = [];
  const setup: PlaybookArrow[] = [];
  const entryActions = pocket.roles.map((role) => {
    const playerId = roleMap.get(role.id)!;
    const position = options.currentPositions.find((player) => player.id === playerId);
    const target = entries.get(role.id)!;
    return { role, playerId, position, target };
  });
  const missing = entryActions.find((entry) => !entry.position);
  if (missing) throw new Error(`Player ${missing.playerId} is no longer on the court`);
  const holderRoleId = pocket.requiredBallRole;
  const requiredHolder = holderRoleId ? roleMap.get(holderRoleId) ?? null : null;
  let connectionPass: PlaybookArrow | null = null;
  if (requiredHolder != null && options.currentBallHandlerId == null) throw new Error("The ball handler is unresolved at this insertion point. Choose a different boundary or repair the preceding pass");
  if (requiredHolder != null && options.currentBallHandlerId != null && requiredHolder !== options.currentBallHandlerId) {
    if (!options.includeConnectionPass) throw new Error(`This combination starts with Player ${requiredHolder} on the ball. Confirm the setup pass from Player ${options.currentBallHandlerId}`);
    const recipient = entryActions.find((entry) => entry.playerId === requiredHolder)!;
    const handler = options.currentPositions.find((player) => player.id === options.currentBallHandlerId)!;
    connectionPass = { id: idFactory(), kind: "pass", start: { x: handler.x, y: handler.y }, end: { x: recipient.position!.x, y: recipient.position!.y }, actor_id: handler.id, recipient_id: recipient.playerId, sequence: insertAt, timing: 1, timingPlan: { startAtMs: baseStartAtMs } };
  }
  const setupSequence = insertAt + (connectionPass ? 1 : 0);
  for (const entry of entryActions) {
    const start = entry.position!;
    const feet = Math.hypot((start.x - entry.target.x) * NBA_COURT_DIMENSIONS.widthFeet / 100, (start.y - entry.target.y) * NBA_COURT_DIMENSIONS.halfLengthFeet / 100);
    if (feet < 1) continue;
    const id = idFactory(); uniqueSetupIds.push(id);
    setup.push({ id, kind: "movement", start: { x: start.x, y: start.y }, end: { ...entry.target }, actor_id: entry.playerId, sequence: setupSequence, timing: Math.max(.5, Math.min(4, feet / 6.5)), timingPlan: { startAtMs: baseStartAtMs, ...(connectionPass ? { waits: [{ id: identity("wait"), actionId: connectionPass.id, event: "catch" as const }] } : {}) } });
  }
  const setupDuration = snapTimingMs(Math.max(0, ...setup.map((arrow) => (arrow.timing ?? .5) * 1000)));
  const pocketStartSequence = setupSequence + (setup.length ? 1 : 0);
  const sequenceMap = new Map(pocketGroups.map((group, index) => [group, pocketStartSequence + index]));
  if (pocket.actions.some((action) => baseStartAtMs + setupDuration + action.startAtMs > 120_000)) throw new Error("This combination would extend beyond the 120-second play timeline");
  // Action order is stable in the pocket document; use its action record to
  // translate relative sequence groups and schedule offsets without guessing IDs.
  const mappedWithTiming = pocket.actions.map((action, index) => {
    const arrow = pocketArrows[index];
    const group = action.arrow.sequence ?? index + 1;
    const waits = [...(arrow.timingPlan?.waits ?? [])];
    const isFirstGroup = action.startAtMs === Math.min(...pocket.actions.map((item) => item.startAtMs));
    const setupWaits = isFirstGroup ? uniqueSetupIds.map((setupId) => ({ id: identity("wait"), actionId: setupId, event: "complete" as const })) : [];
    const passWait = isFirstGroup && connectionPass ? [{ id: identity("wait"), actionId: connectionPass.id, event: "catch" as const }] : [];
    return {
      ...arrow,
      sequence: sequenceMap.get(group) ?? pocketStartSequence,
      timingPlan: {
        ...(arrow.timingPlan ?? { startAtMs: action.startAtMs }),
        startAtMs: snapTimingMs(baseStartAtMs + setupDuration + action.startAtMs),
        ...(waits.length || setupWaits.length || passWait.length ? { waits: [...waits, ...setupWaits, ...passWait] } : {}),
      },
    };
  });
  const inserted = [...(connectionPass ? [connectionPass] : []), ...setup, ...mappedWithTiming];
  const sequenceShift = (connectionPass ? 1 : 0) + (setup.length ? 1 : 0) + pocketGroups.length;
  const shiftedSource = source.arrows.map((arrow, index) => {
    const sequence = arrow.sequence ?? index + 1;
    return sequence >= insertAt ? { ...arrow, sequence: sequence + sequenceShift } : arrow;
  });
  const insertedIds = inserted.map((arrow) => arrow.id);
  const firstActionId = connectionPass?.id ?? setup[0]?.id ?? mappedWithTiming[0]?.id;
  if (!firstActionId) throw new Error("Pocket combination has no actions");
  const combined = [...shiftedSource, ...inserted];
  if (combined.length > 30) throw new Error("This combination and its setup moves would exceed the 30-action limit");
  const boundInserted = bindAuthoredActions({ ...source, arrows: combined }).filter((action) => insertedIds.includes(action.arrow.id));
  const finish = Math.max(baseStartAtMs, ...boundInserted.map((action) => action.startTime + action.durationMs));
  return { arrows: combined, insertedIds, setupIds: uniqueSetupIds, firstActionId, durationMs: Math.max(0, finish - baseStartAtMs), startAtMs: baseStartAtMs };
}

export function freshPocketCopy(source: PocketActionDocument, name = `${source.name} copy`): PocketActionDocument {
  const copy = structuredClone(source);
  const actionIds = new Map(copy.actions.map((action) => [action.id, identity("pact")]));
  const groups = new Map<string, string>();
  copy.id = identity("pocket"); copy.revision = identity("rev"); copy.name = name.slice(0, 60); copy.createdAt = new Date().toISOString(); copy.updatedAt = copy.createdAt; delete copy.starter;
  copy.actions = copy.actions.map((action) => {
    const syncGroup = action.syncGroup ? (groups.get(action.syncGroup) ?? (() => { const id = identity("sync"); groups.set(action.syncGroup!, id); return id; })()) : undefined;
    return { ...action, id: actionIds.get(action.id)!, arrow: { ...action.arrow, id: actionIds.get(action.id)! }, ...(syncGroup ? { syncGroup } : {}), waits: action.waits.map((wait) => ({ ...wait, id: identity("wait"), sourceAction: actionIds.get(wait.sourceAction)! })) };
  });
  if (copy.requiredBallRole && !copy.roles.some((role) => role.id === copy.requiredBallRole)) delete copy.requiredBallRole;
  validatePocketAction(copy);
  return copy;
}

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
function starter(name: string, summary: string, roles: Array<[string, number, number]>, definitions: Array<{ kind: PlaybookArrow["kind"]; actor: number; end: [number, number]; start?: [number, number]; recipient?: number; screener?: number; handler?: number; cutter?: number; duration?: number; sequence?: number; control?: [number, number]; exit?: [number, number]; waits?: Array<{ action: number; event: PocketWait["event"] }> }>, requiredBallRole?: string): PocketActionDocument {
  const roleData = roles.map(([label, x, y], index) => ({ id: `role-${index + 1}`, label, entry: { x, y } }));
  const actions = definitions.map((item, index) => {
    const p = (coords: [number, number] | undefined, fallback: CourtPoint): CourtPoint => coords ? { x: coords[0], y: coords[1] } : fallback;
    const actor = roleData[item.actor - 1];
    const arrow = { id: `pact-${index + 1}`, kind: item.kind, start: p(item.start, actor.entry), end: { x: item.end[0], y: item.end[1] }, sequence: item.sequence ?? index + 1, path: item.control ? "curve" as const : "straight" as const, ...(item.control ? { control: { x: item.control[0], y: item.control[1] } } : {}), ...(item.exit ? { exit_target: { x: item.exit[0], y: item.exit[1] } } : {}), timing: item.duration ?? 1.2 } as PocketAction["arrow"];
    return { id: arrow.id, arrow, participants: { ...(["movement", "backdoor-cut", "pass", "handoff"].includes(item.kind) ? { actor: `role-${item.actor}` } : {}), ...(item.recipient ? { recipient: `role-${item.recipient}` } : {}), ...(item.screener ? { screener: `role-${item.screener}` } : {}), ...(item.handler ? { handler: `role-${item.handler}` } : {}), ...(item.cutter ? { cutter: `role-${item.cutter}` } : {}) }, startAtMs: 0, durationMs: (item.duration ?? 1.2) * 1000, waits: (item.waits ?? []).map((wait, waitIndex) => ({ id: `wait-${index + 1}-${waitIndex + 1}`, sourceAction: `pact-${wait.action}`, event: wait.event })) };
  });
  let cursor = 0;
  const sequences = [...new Set(actions.map((action) => action.arrow.sequence ?? 1))].sort((a, b) => a - b);
  for (const sequence of sequences) {
    const group = actions.filter((action) => (action.arrow.sequence ?? 1) === sequence);
    for (const action of group) action.startAtMs = cursor;
    cursor += Math.max(0, ...group.map((action) => action.durationMs));
  }
  return { version: 1, id: `pocket-starter-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, revision: "starter-v1", name, createdAt: now, updatedAt: now, roles: roleData, actions, ...(requiredBallRole ? { requiredBallRole } : {}), summary, starter: true };
}
export const STARTER_POCKET_ACTIONS: PocketActionDocument[] = [
  starter("Handoff into rescreen", "A tight exchange flows straight into a second screen", [["Handler", 49, 76], ["Screener", 59, 59]], [
    { kind: "handoff", actor: 1, recipient: 2, end: [59, 59], duration: 1 },
    { kind: "pick-roll", actor: 2, screener: 1, handler: 2, end: [56, 55], exit: [55, 37], duration: 1.4, sequence: 2, waits: [{ action: 1, event: "catch" }] },
  ], "role-1"),
  starter("Corner cut plus replacement", "A baseline cut clears space for a corner fill", [["Corner cutter", 11, 30], ["Weak-side wing", 75, 57]], [
    { kind: "backdoor-cut", actor: 1, start: [11, 30], end: [37, 55], control: [25, 38], duration: 1.3 },
    { kind: "movement", actor: 2, start: [75, 57], end: [17, 31], control: [58, 45], duration: 1.6, sequence: 1 },
  ]),
  starter("Give and go", "Pass to the wing, cut hard, and receive the return", [["Ball handler", 49, 77], ["Wing receiver", 25, 56]], [
    { kind: "pass", actor: 1, recipient: 2, start: [49, 77], end: [25, 56], duration: .9 },
    { kind: "backdoor-cut", actor: 1, start: [49, 77], end: [50, 44], control: [40, 58], duration: 1.2, sequence: 2, waits: [{ action: 1, event: "catch" }] },
    { kind: "pass", actor: 2, recipient: 1, start: [25, 56], end: [50, 44], duration: .9, sequence: 3, waits: [{ action: 1, event: "catch" }, { action: 2, event: "complete" }] },
  ], "role-1"),
  starter("Staggered screen", "Two screen actions create a moving route to space", [["Shooter", 50, 34], ["First screener", 37, 54], ["Second screener", 63, 53]], [
    { kind: "pin-down", actor: 2, screener: 2, cutter: 1, start: [37, 54], end: [43, 63], exit: [52, 70], duration: 1.1 },
    { kind: "off-ball-screen", actor: 3, screener: 3, cutter: 1, start: [63, 53], end: [57, 64], duration: 1.2, sequence: 2, waits: [{ action: 1, event: "screen-use" }] },
  ]),
];
