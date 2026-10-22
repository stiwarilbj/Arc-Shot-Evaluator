import type { PlaybookDocument } from "./types.ts";

// Version-1 persistence contract. Keep in sync with backend/api/playbooks.py;
// both implementations run the same shared document examples in tests.
const kinds = new Set(["movement", "pass", "screen", "slip-screen", "handoff", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "backdoor-cut"]);
const offenseBadges = new Set(["playmaker", "off-dribble-creator", "deep-range", "catch-and-shoot", "slasher", "rim-finisher", "cutter", "screen-setter", "roll-threat", "post-scorer"]);
const defenseBadges = new Set(["lockdown", "paint-protector", "helper"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function check(valid: unknown, message: string): asserts valid { if (!valid) throw new Error(message); }
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
function point(value: unknown) {
  check(object(value) && [value.x, value.y].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100), "Court positions must contain numeric x and y from 0 to 100");
}

/** Validate without normalizing or mutating valid drawings, including legacy v1 defaults. */
export function validatePlaybookDocument(value: unknown): void {
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
