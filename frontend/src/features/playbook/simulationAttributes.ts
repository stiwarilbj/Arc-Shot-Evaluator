import type { PlaybookMarker, PlayerBadge, PlayerSkillRatings } from "./types.ts";

type RatingEntry = { values: PlayerSkillRatings; normalized: PlayerSkillRatings };
type BadgeEntry = { values: PlayerBadge[]; membership: Set<PlayerBadge> };
export type SimulationAttributes = { ratings: Map<PlayerSkillRatings, RatingEntry>; badges: Map<PlayerBadge[], BadgeEntry> };

// Weak lookups follow attribute objects through position-only marker copies.
// Entries belong to a run; no metadata is attached to markers or recorded frames.
const ratingsLookup = new WeakMap<PlayerSkillRatings, RatingEntry>();
const badgesLookup = new WeakMap<PlayerBadge[], BadgeEntry>();
const normalizeRating = (value: number | undefined) => Number.isInteger(value ?? 3) ? Math.max(1, Math.min(5, value ?? 3)) : 3;

export function createSimulationAttributes(): SimulationAttributes {
  return { ratings: new Map(), badges: new Map() };
}

export function refreshSimulationAttributes(cache: SimulationAttributes, players: PlaybookMarker[], defenders: PlaybookMarker[]) {
  for (const roster of [players, defenders]) for (const player of roster) {
    const ratings = player.ratings;
    if (ratings && typeof ratings === "object") {
      let entry = cache.ratings.get(ratings);
      if (!entry || !Object.is(entry.values.threePoint, ratings.threePoint) || !Object.is(entry.values.midrange, ratings.midrange) || !Object.is(entry.values.finishing, ratings.finishing)) {
        entry = { values: { ...ratings }, normalized: { threePoint: normalizeRating(ratings.threePoint), midrange: normalizeRating(ratings.midrange), finishing: normalizeRating(ratings.finishing) } };
        cache.ratings.set(ratings, entry);
      }
      ratingsLookup.set(ratings, entry);
    }
    const badges = player.badges;
    if (Array.isArray(badges)) {
      let entry = cache.badges.get(badges);
      if (!entry || entry.values.length !== badges.length || entry.values.some((badge, index) => badge !== badges[index])) {
        entry = { values: [...badges], membership: new Set(badges) };
        cache.badges.set(badges, entry);
      }
      badgesLookup.set(badges, entry);
    }
  }
}

export function preparedPlayerRating(player: PlaybookMarker, key: keyof PlayerSkillRatings) {
  return player.ratings ? ratingsLookup.get(player.ratings)?.normalized[key] ?? normalizeRating(player.ratings[key]) : 3;
}

export function preparedHasBadge(player: PlaybookMarker, badge: PlayerBadge) {
  return player.badges ? badgesLookup.get(player.badges)?.membership.has(badge) ?? player.badges.includes(badge) : false;
}
