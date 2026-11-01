import type { PlaybookDraft } from "./types.ts";
import type { ArrowVisibility } from "./arrowVisibility.ts";
import { routeVisible } from "./arrowVisibility.ts";
import { authoredCourtRoutes } from "./simulation.ts";
import { playbookContentKey } from "./playbookDraftSession.ts";
import { actionPath, actionPointAt, arrowSequence, markerPoint, screenCutterPath } from "./playbookPaths.ts";

function buildMiniCourt(play: PlaybookDraft, visibility: ArrowVisibility) {
  const routes = authoredCourtRoutes(play);
  const visibleIds = new Set(routes.filter((route) => routeVisible(route, visibility)).map((route) => route.actionId));
  const arrows = play.arrows.flatMap((arrow, index) => visibleIds.has(arrow.id) ? [Object.freeze({
    id: arrow.id,
    path: actionPath(arrow),
    supportPath: screenCutterPath(arrow, play.players),
    badge: Object.freeze(markerPoint(actionPointAt(arrow, 0.5))),
    sequence: arrowSequence(arrow, index),
    className: arrow.kind === "pass" || arrow.kind === "handoff" ? "mini-pass" : arrow.kind === "screen" || arrow.kind === "slip-screen" || arrow.kind === "off-ball-screen" || arrow.kind === "pin-down" ? "mini-screen" : arrow.kind === "pick-roll" || arrow.kind === "pick-pop" ? "mini-pick-roll" : "mini-move",
  })] : []);
  return Object.freeze({
    arrows: Object.freeze(arrows),
    players: Object.freeze(play.players.map((marker) => Object.freeze({ id: marker.id, ...markerPoint(marker) }))),
    defenders: Object.freeze(play.defenders_visible ? play.defenders.map((marker) => {
      const point = markerPoint(marker);
      return Object.freeze({ id: marker.id, path: `M${point.x - 7} ${point.y - 7}l14 14M${point.x + 7} ${point.y - 7}l-14 14` });
    }) : []),
    ball: play.ball ? Object.freeze(markerPoint(play.ball)) : null,
  });
}

/** Bounded, memory-only reuse survives refreshed document objects and remounts. */
export function createMiniCourtCache(maxEntries = 128, maxBytes = 2 * 1024 * 1024) {
  const entries = new Map<string, { geometry: ReturnType<typeof buildMiniCourt>; bytes: number }>();
  let bytes = 0;
  return (play: PlaybookDraft, visibility: ArrowVisibility) => {
    // Titles, IDs and persistence timestamps cannot change preview geometry.
    const key = JSON.stringify([visibility, playbookContentKey({ ...play, name: "" })]);
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key); entries.set(key, cached);
      return cached.geometry;
    }
    const geometry = buildMiniCourt(play, visibility);
    // Include string keys, geometry, and conservative per-entry object overhead.
    const size = 1024 + 4 * (key.length + JSON.stringify(geometry).length);
    if (maxEntries <= 0 || size > maxBytes) return geometry;
    while (entries.size >= maxEntries || bytes + size > maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      bytes -= entries.get(oldest)!.bytes;
      entries.delete(oldest);
    }
    entries.set(key, { geometry, bytes: size }); bytes += size;
    return geometry;
  };
}

export const prepareMiniCourt = createMiniCourtCache();
