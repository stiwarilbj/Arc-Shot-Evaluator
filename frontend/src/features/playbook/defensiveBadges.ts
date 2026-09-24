import type { DefensiveBadge, PlayerBadge } from "./types.ts";

export const DEFENSIVE_BADGE_ORDER: DefensiveBadge[] = ["lockdown", "paint-protector", "helper"];

export const DEFENSIVE_BADGES: Record<DefensiveBadge, { label: string; description: string }> = {
  lockdown: {
    label: "Lockdown",
    description: "Stays goal-side of a leading scorer, closes out sooner, and recovers closely through screens.",
  },
  "paint-protector": {
    label: "Paint protector",
    description: "Favors interior assignments, protects the lane, and contests nearby finishes.",
  },
  helper: {
    label: "Helper",
    description: "Rotates earlier to threaten drives, pressures the ball, then recovers to their assignment.",
  },
};

export function isDefensiveBadge(value: unknown): value is DefensiveBadge {
  return typeof value === "string" && (DEFENSIVE_BADGE_ORDER as string[]).includes(value);
}

export function defenderHasBadge(defender: { badges?: readonly PlayerBadge[] }, badge: DefensiveBadge) {
  return defender.badges?.includes(badge) ?? false;
}
