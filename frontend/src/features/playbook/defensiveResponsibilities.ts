import type { CourtPoint, DefenseStrategy, PlaybookMarker } from "./types.ts";

export const DEFENSIVE_ROLES = ["primary", "screen", "helper", "rim-protector", "recovery", "matchup", "zone"] as const;
export type DefensiveRole = typeof DEFENSIVE_ROLES[number];
export type DefensiveResponsibility = {
  defenderId: number; role: DefensiveRole; playerId: number | null; zoneSlot: number | null;
  actionId: string | null; relatedDefenderId: number | null;
  reason: string; releaseOn: string; sinceMs: number;
};
export type DefensiveRotation = {
  id: number; atMs: number; helperId: number; replacementId: number | null;
  vacatedPlayerId: number | null; vacatedZoneSlot: number | null;
  exposedPlayerId: number | null; exposedZoneSlot: number | null;
};
type Recovery = { sinceMs: number; relatedDefenderId: number | null; playerId: number | null; zoneSlot: number | null };
export type DefensiveTeamState = {
  duties: Map<number, DefensiveResponsibility>;
  helper: { defenderId: number; playerId: number; sinceMs: number; threatEndedAtMs: number | null } | null;
  recoveries: Map<number, Recovery>; rotations: DefensiveRotation[]; nextRotationId: number;
};
export function createDefensiveTeamState(): DefensiveTeamState {
  return { duties: new Map(), helper: null, recoveries: new Map(), rotations: [], nextRotationId: 1 };
}
export function resetDefensiveDuties(state: DefensiveTeamState) {
  state.helper = null; state.recoveries.clear(); state.duties.clear();
}
type ScreenDuty = { defenderId: number; playerId: number; actionId: string };
type DefenseContext = {
  atMs: number; strategy: DefenseStrategy; zone: boolean;
  players: PlaybookMarker[]; defenders: PlaybookMarker[];
  assignments: Map<number, number>; zoneAssignments: Map<number, number>; chasers: Map<number, number>;
  primary: { defenderId: number; playerId: number } | null; screens: ScreenDuty[];
  drive: boolean; helperCandidates: number[]; rimCandidates: number[];
  distance: (a: CourtPoint, b: CourtPoint) => number;
  anchor: (defenderId: number) => CourtPoint | null;
  threat: (player: PlaybookMarker) => number;
};

/** Allocate responsibilities before computing any individual target. A help
 * rotation exchanges two base duties atomically, never two independent guesses.
 * The helper's new duty is explicitly exposed until that defender recovers. */
export function coordinateDefensiveDuties(state: DefensiveTeamState, c: DefenseContext) {
  const players = new Map(c.players.map(p => [p.id, p])), defenders = new Map(c.defenders.map(d => [d.id, d]));
  const screens = new Map(c.screens.filter(s => defenders.has(s.defenderId) && players.has(s.playerId)).map(s => [s.defenderId, s]));
  const primary = c.primary && defenders.has(c.primary.defenderId) && players.has(c.primary.playerId) ? c.primary : null;
  const reserved = (id: number) => primary?.defenderId === id || screens.has(id) || c.chasers.has(id);
  const base = (id: number): Recovery => ({ sinceMs: c.atMs, relatedDefenderId: null,
    playerId: c.zone ? c.chasers.get(id) ?? null : (players.has(c.assignments.get(id)!) ? c.assignments.get(id)! : null),
    zoneSlot: c.zone ? c.zoneAssignments.get(id) ?? null : null });
  const recover = (id: number, related: number | null) => {
    if (defenders.has(id)) state.recoveries.set(id, { ...base(id), relatedDefenderId: related });
  };
  if (c.strategy === "off" || !primary) { resetDefensiveDuties(state); return; }

  const helper = state.helper;
  if (helper) {
    const available = defenders.has(helper.defenderId) && !reserved(helper.defenderId)
      && helper.playerId === primary.playerId && c.helperCandidates.includes(helper.defenderId);
    if (c.drive && available) helper.threatEndedAtMs = null;
    else helper.threatEndedAtMs ??= c.atMs;
    if (!available || c.atMs - (helper.threatEndedAtMs ?? c.atMs) >= 220) {
      recover(helper.defenderId, null); state.helper = null;
    }
  }
  if (!state.helper && c.drive) {
    const helperId = c.helperCandidates.find(id => defenders.has(id) && !reserved(id) && !state.recoveries.has(id));
    if (helperId != null) {
      const vacated = base(helperId);
      // A second helper is forbidden. Prefer a free defender who can actually
      // cover the vacated player/area; protect chasers and active screen pairs.
      const destination = c.zone ? c.anchor(helperId) : players.get(vacated.playerId!) ?? null;
      const candidates = c.defenders.filter(d => d.id !== helperId && !reserved(d.id) && !state.recoveries.has(d.id)
        && (c.zone ? c.zoneAssignments.has(d.id) : base(d.id).playerId != null));
      candidates.sort((a, b) => {
        const cost = (d: PlaybookMarker) => {
          const own = players.get(base(d.id).playerId!);
          return (destination ? c.distance(d, destination) : Infinity)
            + (own ? Math.max(0, c.threat(own) - 3) * 2 : 0)
            + (c.rimCandidates[0] === d.id && candidates.length > 1 ? 6 : 0);
        };
        return cost(a) - cost(b) || a.id - b.id;
      });
      const replacement = destination ? candidates[0] : undefined;
      const exposed = replacement ? base(replacement.id) : vacated;
      if (replacement) {
        const map = c.zone ? c.zoneAssignments : c.assignments;
        const own = map.get(helperId), other = map.get(replacement.id);
        if (own != null && other != null) {
          map.set(replacement.id, own); map.set(helperId, other);
          recover(replacement.id, helperId);
        }
      }
      state.helper = { defenderId: helperId, playerId: primary.playerId, sinceMs: c.atMs, threatEndedAtMs: null };
      state.rotations.push({ id: state.nextRotationId++, atMs: c.atMs, helperId, replacementId: replacement?.id ?? null,
        vacatedPlayerId: vacated.playerId, vacatedZoneSlot: vacated.zoneSlot,
        exposedPlayerId: exposed.playerId, exposedZoneSlot: exposed.zoneSlot });
      if (state.rotations.length > 32) state.rotations.shift();
    }
  }

  const next = new Map<number, DefensiveResponsibility>();
  const put = (id: number, role: DefensiveRole, playerId: number | null, reason: string, releaseOn: string,
    actionId: string | null = null, relatedDefenderId: number | null = null) => {
    const old = state.duties.get(id), slot = c.zone ? c.zoneAssignments.get(id) ?? null : null;
    const same = old?.role === role && old.playerId === playerId && old.zoneSlot === slot && old.actionId === actionId && old.relatedDefenderId === relatedDefenderId;
    next.set(id, same ? old : { defenderId: id, role, playerId, zoneSlot: slot, actionId, relatedDefenderId, reason, releaseOn, sinceMs: c.atMs });
  };
  put(primary.defenderId, "primary", primary.playerId, "Contain the current ball threat", "ball-threat-or-assignment-change", screens.get(primary.defenderId)?.actionId ?? null);
  for (const screen of screens.values()) if (!next.has(screen.defenderId))
    put(screen.defenderId, "screen", screen.playerId, "Own the locked screen matchup", "screen-release-or-participant-loss", screen.actionId);
  for (const [id, playerId] of c.chasers) if (defenders.has(id) && players.has(playerId) && !next.has(id))
    put(id, "matchup", playerId, "Keep the scheme's designated chaser", "scheme-or-participant-change");
  if (state.helper) put(state.helper.defenderId, "helper", state.helper.playerId, "Help the drive; teammates inherit the vacated duty", "threat-cleared-or-ball-change");

  for (const [id, recovery] of state.recoveries) {
    const current = base(id), destination = c.zone ? c.anchor(id) : players.get(current.playerId!) ?? null;
    if (!defenders.has(id) || next.has(id) || current.playerId !== recovery.playerId || current.zoneSlot !== recovery.zoneSlot
      || destination && c.distance(defenders.get(id)!, destination) <= 6) { state.recoveries.delete(id); continue; }
    put(id, "recovery", current.playerId, "Recover to the inherited duty, not the former matchup", "arrival-or-priority-change", null, recovery.relatedDefenderId);
  }
  const rimId = c.rimCandidates.find(id => defenders.has(id) && !next.has(id));
  if (rimId != null) {
    const playerId = base(rimId).playerId;
    put(rimId, "rim-protector", [...next.values()].some(d => d.playerId === playerId) ? null : playerId,
      "Keep one free defender responsible for interior support", "priority-duty-or-better-position");
  }

  // Claim zone closeouts together. Retain a plausible existing claim before
  // assigning unclaimed threats; never send two free slots to the same player.
  const claimed = new Set([...next.values()].map(d => d.playerId).filter((id): id is number => id != null));
  const free = c.defenders.filter(d => !next.has(d.id)).sort((a, b) => a.id - b.id);
  if (c.zone) {
    // Rim/recovery duties still own their slot and may close out from it.
    for (const d of c.defenders) if (next.has(d.id) && ["rim-protector", "recovery"].includes(next.get(d.id)!.role)) free.push(d);
    for (const d of free) {
      const anchor = c.anchor(d.id);
      const options = anchor ? c.players.filter(p => !claimed.has(p.id) && c.distance(anchor, p) <= 15)
        .map(p => ({ p, score: c.distance(anchor, p) - (c.threat(p) - 3) * 1.2 }))
        .sort((a, b) => a.score - b.score || a.p.id - b.p.id) : [];
      const prior = options.find(o => o.p.id === state.duties.get(d.id)?.playerId);
      const choice = prior && prior.score <= (options[0]?.score ?? Infinity) + 3 ? prior : options[0];
      const role = next.get(d.id)?.role ?? "zone";
      put(d.id, role, choice?.p.id ?? null, role === "zone" ? "Own the zone slot and its unique closeout" : next.get(d.id)!.reason,
        role === "zone" ? "ball-area-or-threat-change" : next.get(d.id)!.releaseOn, null, next.get(d.id)?.relatedDefenderId ?? null);
      if (choice) claimed.add(choice.p.id);
    }
  } else for (const d of free) {
    const playerId = base(d.id).playerId;
    put(d.id, "matchup", playerId != null && !claimed.has(playerId) ? playerId : null,
      "Keep the current team matchup; spare defenders hold their position", "assignment-or-participant-change");
    if (playerId != null) claimed.add(playerId);
  }
  state.duties = next;
}

export function defensiveDutySnapshot(state: DefensiveTeamState) {
  return [...state.duties.values()].map(d => ({ ...d }));
}
