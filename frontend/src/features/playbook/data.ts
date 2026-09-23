import type { ArrowKind, PlaybookDraft } from "./types";

function draft(name: string, players: Array<[number, number]>, ball: [number, number] | null, arrows: PlaybookDraft["arrows"] = [], defenders: Array<[number, number]> = []): PlaybookDraft {
  return {
    version: 1,
    id: `draft-${name.toLowerCase().replaceAll(" ", "-")}`,
    name,
    defenders_visible: defenders.length > 0,
    players: players.map(([x, y], index) => ({ id: index + 1, x, y })),
    defenders: defenders.map(([x, y], index) => ({ id: index + 1, x, y })),
    ball: ball ? { x: ball[0], y: ball[1] } : null,
    arrows: arrows.map((item, index) => ({ ...item, sequence: item.sequence ?? index + 1 })),
  };
}

const arrow = (id: string, kind: ArrowKind, start: [number, number], end: [number, number], timing = 1.2) => ({
  id,
  kind,
  start: { x: start[0], y: start[1] },
  end: { x: end[0], y: end[1] },
  timing,
});

export const READY_SETUP = draft("Ready setup", [[50, 77], [26, 60], [74, 60], [23, 30], [77, 30]], [50, 77]);

export const STARTER_PLAYS: PlaybookDraft[] = [
  draft("Pick and roll", [[50, 78], [29, 57], [71, 36], [22, 29], [78, 29]], [30, 57], [
    arrow("pick-drive", "screen", [71, 36], [56, 53], 1.4),
    arrow("guard-roll", "pick-roll", [50, 78], [50, 62], 1.6),
    arrow("kick-out", "pass", [50, 62], [22, 29]),
  ], [[47, 67], [60, 59], [39, 48], [68, 33], [28, 33]]),
  draft("Give and go", [[50, 77], [35, 52], [76, 31], [24, 31], [74, 61]], [36, 52], [
    arrow("give", "handoff", [36, 52], [50, 70], 1.1),
    arrow("cut", "movement", [35, 52], [55, 31]),
    arrow("finish", "pass", [50, 70], [55, 31]),
  ], [[48, 64], [62, 56], [42, 39], [73, 36], [28, 37]]),
  draft("Drive and kick", [[50, 76], [25, 58], [73, 58], [24, 29], [76, 29]], [50, 76], [
    arrow("drive", "movement", [50, 76], [50, 49]),
    arrow("corner-pass", "pass", [50, 49], [24, 29]),
    arrow("space", "movement", [73, 58], [82, 43]),
  ], [[48, 64], [62, 53], [38, 47], [68, 33], [30, 34]]),
];

export const EMPTY_COURT: PlaybookDraft = draft("Empty court", [], null);

export function withDefenders(source: PlaybookDraft, visible: boolean): PlaybookDraft {
  if (!visible) return { ...source, defenders_visible: false };
  const positions: Array<[number, number]> = [[47, 66], [61, 58], [39, 48], [69, 34], [30, 34]];
  return {
    ...source,
    defenders_visible: true,
    defenders: source.defenders.length ? source.defenders : positions.map(([x, y], index) => ({ id: index + 1, x, y })),
  };
}
