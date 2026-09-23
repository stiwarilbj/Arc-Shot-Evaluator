import type { OffensiveBadge } from "./types.ts";

export const OFFENSIVE_BADGE_ORDER: OffensiveBadge[] = [
  "playmaker",
  "off-dribble-creator",
  "deep-range",
  "catch-and-shoot",
  "slasher",
  "rim-finisher",
  "cutter",
  "screen-setter",
  "roll-threat",
  "post-scorer",
];

export const OFFENSIVE_BADGES: Record<OffensiveBadge, { label: string; description: string }> = {
  playmaker: { label: "Playmaker", description: "Finds open teammates sooner; defenders shade likely passing lanes." },
  "off-dribble-creator": { label: "Off-dribble creator", description: "Creates pull-up chances after movement; defenders contain the ball more carefully." },
  "deep-range": { label: "Deep range", description: "Makes shots beyond the arc more viable; defenders extend their closeouts." },
  "catch-and-shoot": { label: "Catch-and-shoot", description: "Gets a quicker, cleaner look after a pass; defenders recover to the receiver faster." },
  slasher: { label: "Slasher", description: "Attacks clear driving lanes; defenders prepare earlier help at the rim." },
  "rim-finisher": { label: "Rim finisher", description: "Finishes better near the basket and draws more rim help." },
  cutter: { label: "Cutter", description: "Looks for cuts and screen opportunities; defenders track those routes more closely." },
  "screen-setter": { label: "Screen setter", description: "Gets chosen more often for screens and makes screen coverage more demanding." },
  "roll-threat": { label: "Roll threat", description: "Gets more pick-and-roll and open-roller opportunities; helpers account for the roll." },
  "post-scorer": { label: "Post scorer", description: "Seeks post space and feeds; nearby defenders protect that area." },
};

export function isOffensiveBadge(value: unknown): value is OffensiveBadge {
  return typeof value === "string" && (OFFENSIVE_BADGE_ORDER as string[]).includes(value);
}

export function playerHasBadge(player: { badges?: readonly OffensiveBadge[] }, badge: OffensiveBadge) {
  return player.badges?.includes(badge) ?? false;
}
