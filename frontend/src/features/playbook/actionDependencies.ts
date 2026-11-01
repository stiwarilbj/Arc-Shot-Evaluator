/** Internal execution plan. Saved version-1 arrows never contain these fields. */
export type ActionDependency = { key: string; milestone: "completed" | "catch"; playerId: number | null };
export type PlannedAction = {
  key: string;
  nominalStartMs: number;
  dependencies: ActionDependency[];
  requiresPossessionId: number | null;
  failure?: { phase: "conflict" | "obstructed"; notice: string };
};
export type DependencyAction = {
  key: string; sequence: number; startTime: number; kind: string;
  actorId: number | null; recipientId: number | null; userId: number | null;
  onBall: boolean; automatic: boolean; userTarget?: { x: number; y: number };
};
const transfers = new Set(["pass", "handoff"]);
const screens = new Set(["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "slip-screen"]);
const participants = (action: DependencyAction) => new Set([action.actorId, action.recipientId, action.userId].filter((id): id is number => id != null));

/** Return every member of a cycle, rather than incorrectly blaming descendants. */
export function cyclicActionKeys(plans: ReadonlyMap<string, PlannedAction>): Set<string> {
  const cycles = new Set<string>(), indices = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], active = new Set<string>();
  let index = 0;
  const visit = (key: string) => {
    indices.set(key, index); low.set(key, index++); stack.push(key); active.add(key);
    for (const dependency of plans.get(key)?.dependencies ?? []) {
      if (!plans.has(dependency.key)) continue;
      if (!indices.has(dependency.key)) {
        visit(dependency.key); low.set(key, Math.min(low.get(key)!, low.get(dependency.key)!));
      } else if (active.has(dependency.key)) low.set(key, Math.min(low.get(key)!, indices.get(dependency.key)!));
    }
    if (low.get(key) !== indices.get(key)) return;
    const component: string[] = [];
    let member: string;
    do { member = stack.pop()!; active.delete(member); component.push(member); } while (member !== key);
    if (component.length > 1 || plans.get(key)?.dependencies.some((edge) => edge.key === key)) component.forEach((value) => cycles.add(value));
  };
  for (const key of plans.keys()) if (!indices.has(key)) visit(key);
  return cycles;
}

/** Stable diagram order wins competing authored movement/ball ownership.
 * Simultaneous receiver routes and screen-support routes remain compatible. */
export function compileActionDependencies(actions: readonly DependencyAction[], initialHandlerId: number | null): Map<string, PlannedAction> {
  const plans = new Map<string, PlannedAction>();
  const ordered = actions.map((action, index) => ({ action, index })).sort((a, b) =>
    Number(a.action.automatic) - Number(b.action.automatic) || a.action.sequence - b.action.sequence || a.index - b.index).map(({ action }) => action);
  for (const action of ordered) {
    if (plans.has(action.key)) throw new Error("Simulation action identities must be unique");
    plans.set(action.key, { key: action.key, nominalStartMs: action.startTime, dependencies: [],
      requiresPossessionId: transfers.has(action.kind) ? action.actorId : action.onBall ? action.userId ?? action.actorId : null });
  }
  for (const action of ordered) {
    const plan = plans.get(action.key)!;
    const transfer = transfers.has(action.kind), screen = screens.has(action.kind);
    const fail = (phase: "conflict" | "obstructed", reason: string) => { plan.failure ??= { phase, notice: `Move ${action.sequence} ${reason}` }; };
    if (action.actorId == null) fail("obstructed", "has no available actor");
    if (transfer && (action.recipientId == null || action.actorId === action.recipientId)) fail("obstructed", "needs a different, available receiver");
    if (screen && (action.userId == null || action.userId === action.actorId)) fail("obstructed", "needs a different, available screen user");
    const add = (prior: DependencyAction, milestone: ActionDependency["milestone"], playerId: number | null) => {
      if (!plan.dependencies.some((edge) => edge.key === prior.key && edge.milestone === milestone)) plan.dependencies.push({ key: prior.key, milestone, playerId });
    };
    const involved = participants(action);
    for (const prior of ordered) {
      if (prior === action) continue;
      if (prior.sequence < action.sequence && prior.startTime <= action.startTime && plans.get(prior.key)!.failure?.phase !== "conflict") {
        const shared = [...participants(prior)].find((id) => involved.has(id));
        // All transfers share one ball, even when their inferred participants differ.
        if (shared != null || transfer && transfers.has(prior.kind)) add(prior, transfers.has(prior.kind) ? "catch" : "completed", shared ?? null);
      }
    }
    const earlier = ordered.slice(0, ordered.indexOf(action)).filter((prior) => prior.sequence === action.sequence && !plans.get(prior.key)!.failure);
    if (earlier.some((prior) => prior.actorId === action.actorId && !transfers.has(prior.kind) && !transfer)) fail("conflict", `conflicts with another route for player ${action.actorId}`);
    if (transfer && earlier.some((prior) => transfers.has(prior.kind))) fail("conflict", "conflicts with another simultaneous transfer of the ball");
    if (screen && earlier.some((prior) => screens.has(prior.kind) && prior.userId === action.userId
      && !(prior.userTarget && action.userTarget && prior.userTarget.x === action.userTarget.x && prior.userTarget.y === action.userTarget.y))) fail("conflict", `conflicts with another screen for player ${action.userId}`);
    const holder = plan.requiresPossessionId;
    if (holder != null) {
      const providers = ordered.filter((prior) => prior !== action && transfers.has(prior.kind) && prior.recipientId === holder
        && (prior.sequence < action.sequence || prior.sequence === action.sequence && holder !== initialHandlerId));
      const provider = providers.at(-1);
      if (provider) add(provider, "catch", holder);
      else if (holder !== initialHandlerId) fail("obstructed", `cannot start because player ${holder} has no preceding catch or initial possession`);
    }
  }
  for (const key of cyclicActionKeys(plans)) plans.get(key)!.failure = { phase: "conflict", notice: "Circular action dependencies prevent this move from starting" };
  return plans;
}
