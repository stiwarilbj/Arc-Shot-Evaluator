import type { ArrowKind, PlaybookDraft } from "./types";

function draft(name: string, players: Array<[number, number]>, ball: [number, number] | null, arrows: PlaybookDraft["arrows"] = [], defenders: Array<[number, number]> = []): PlaybookDraft {
  return {
    version: 1,
    id: `draft-${name.toLowerCase().replaceAll(" ", "-")}`,
    name,
    defenders_visible: defenders.length > 0,
    players: players.map(([x, y], index) => ({ id: index + 1, x, y, ratings: { threePoint: 3, midrange: 3, finishing: 3 } })),
    defenders: defenders.map(([x, y], index) => ({ id: index + 1, x, y })),
    ball: ball ? { x: ball[0], y: ball[1] } : null,
    arrows: arrows.map((item, index) => ({ ...item, sequence: item.sequence ?? index + 1 })),
  };
}

const arrow = (id: string, kind: ArrowKind, start: [number, number], end: [number, number], timing = 1.2, options: Partial<PlaybookDraft["arrows"][number]> = {}) => ({
  id,
  kind,
  start: { x: start[0], y: start[1] },
  end: { x: end[0], y: end[1] },
  timing,
  ...options,
});

const player = (players: Array<[number, number]>, id: number) => players[id - 1];
const namedScreen = (id: string, kind: "screen" | "pick-roll" | "pick-pop", players: Array<[number, number]>, screenerId: number, handlerId: number, screen: [number, number], sequence: number, exit?: [number, number]) => arrow(
  id, kind, player(players, screenerId), screen, 1.5,
  { screener_id: screenerId, handler_id: handlerId, sequence, ...(exit ? { exit_target: { x: exit[0], y: exit[1] } } : {}) },
);
const offBall = (id: string, kind: "off-ball-screen" | "pin-down", players: Array<[number, number]>, screenerId: number, cutterId: number, screen: [number, number], sequence: number, exit?: [number, number]) => arrow(
  id, kind, player(players, screenerId), screen, 1.35,
  { screener_id: screenerId, cutter_id: cutterId, sequence, ...(exit ? { exit_target: { x: exit[0], y: exit[1] } } : {}) },
);

export const READY_SETUP = draft("Ready setup", [[50, 77], [26, 60], [74, 60], [23, 30], [77, 30]], [50, 77]);

export const STARTER_PLAYS: PlaybookDraft[] = [
  draft("Pick and roll", [[50, 78], [27, 57], [73, 57], [24, 30], [60, 68]], [50, 78], [
    namedScreen("pickroll-screen", "pick-roll", [[50, 78], [27, 57], [73, 57], [24, 30], [60, 68]], 5, 1, [55, 68], 1),
    arrow("pickroll-pass", "pass", [50, 78], [51, 50], 1.1, { sequence: 2 }),
  ], [[47, 70], [34, 56], [66, 56], [69, 34], [30, 34]]),
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
  draft("Horns", [[50, 78], [25, 32], [75, 32], [42, 58], [58, 58]], [50, 78], [
    arrow("horns-entry", "pass", [50, 78], [42, 58], 1, { sequence: 1 }),
    namedScreen("horns-roll", "pick-roll", [[50, 78], [25, 32], [75, 32], [42, 58], [58, 58]], 5, 4, [49, 59], 2),
    arrow("horns-feed", "pass", [42, 58], [50, 46], 1, { sequence: 3 }),
  ], [[48, 68], [30, 36], [70, 36], [37, 53], [63, 53]]),
  draft("Flex", [[50, 78], [24, 34], [76, 58], [40, 39], [60, 39]], [50, 78], [
    offBall("flex-cross", "off-ball-screen", [[50, 78], [24, 34], [76, 58], [40, 39], [60, 39]], 5, 2, [31, 42], 1),
    offBall("flex-down", "pin-down", [[50, 78], [24, 34], [76, 58], [40, 39], [60, 39]], 4, 3, [68, 47], 2, [75, 60]),
    arrow("flex-entry", "pass", [50, 78], [75, 60], 1, { sequence: 3 }),
  ], [[48, 68], [32, 37], [68, 56], [40, 43], [60, 43]]),
  draft("Pick and pop", [[50, 78], [26, 56], [74, 56], [24, 30], [60, 68]], [50, 78], [
    namedScreen("pickpop-screen", "pick-pop", [[50, 78], [26, 56], [74, 56], [24, 30], [60, 68]], 5, 1, [55, 68], 1, [69, 58]),
    arrow("pickpop-pass", "pass", [50, 78], [69, 58], 1, { sequence: 2 }),
  ], [[48, 69], [34, 57], [66, 57], [69, 34], [30, 34]]),
  draft("Inverted pick and roll", [[50, 78], [24, 31], [76, 31], [50, 65], [42, 65]], [50, 65], [
    namedScreen("inverted-pick", "pick-roll", [[50, 78], [24, 31], [76, 31], [50, 65], [42, 65]], 1, 4, [46, 62], 1),
    arrow("inverted-feed", "pass", [50, 65], [50, 46], 1, { sequence: 2 }),
  ], [[48, 70], [30, 35], [70, 35], [50, 60], [37, 65]]),
  draft("Spain pick and roll", [[50, 78], [74, 59], [25, 31], [25, 59], [60, 68]], [50, 78], [
    namedScreen("spain-ball-screen", "pick-roll", [[50, 78], [74, 59], [25, 31], [25, 59], [60, 68]], 5, 1, [55, 68], 1),
    offBall("spain-back-screen", "off-ball-screen", [[50, 78], [74, 59], [25, 31], [25, 59], [60, 68]], 2, 5, [58, 65], 2),
    arrow("spain-kick", "pass", [50, 78], [60, 49], 1, { sequence: 3 }),
  ], [[48, 69], [69, 58], [30, 34], [30, 56], [56, 66]]),
  draft("Floppy", [[50, 78], [25, 34], [75, 34], [40, 37], [60, 37]], [50, 78], [
    offBall("floppy-left", "pin-down", [[50, 78], [25, 34], [75, 34], [40, 37], [60, 37]], 4, 2, [31, 47], 1, [27, 56]),
    offBall("floppy-right", "pin-down", [[50, 78], [25, 34], [75, 34], [40, 37], [60, 37]], 5, 3, [69, 47], 1, [73, 56]),
    arrow("floppy-pass", "pass", [50, 78], [27, 56], 1, { sequence: 2 }),
  ], [[48, 68], [31, 38], [69, 38], [39, 41], [61, 41]]),
  draft("5-out motion", [[50, 78], [24, 56], [76, 56], [25, 31], [75, 31]], [50, 78], [
    arrow("fiveout-entry", "pass", [50, 78], [24, 56], 0.9, { sequence: 1 }),
    arrow("fiveout-cut", "backdoor-cut", [50, 78], [51, 42], 1.1, { actor_id: 1, sequence: 2 }),
    arrow("fiveout-fill", "movement", [75, 31], [55, 76], 1.2, { sequence: 2 }),
    arrow("fiveout-return", "pass", [24, 56], [51, 42], 0.9, { sequence: 3 }),
  ], [[48, 68], [31, 58], [69, 58], [30, 34], [70, 34]]),
  draft("Horns twist", [[50, 78], [25, 32], [75, 32], [42, 58], [58, 58]], [50, 78], [
    arrow("twist-entry", "pass", [50, 78], [58, 58], 1, { sequence: 1 }),
    arrow("twist-handoff", "handoff", [58, 58], [75, 32], 1, { sequence: 2 }),
    namedScreen("twist-screen", "pick-roll", [[50, 78], [25, 32], [75, 32], [42, 58], [58, 58]], 4, 3, [67, 54], 3),
  ], [[48, 68], [30, 36], [70, 36], [38, 54], [62, 54]]),
  draft("UCLA cut", [[50, 78], [76, 58], [25, 31], [75, 31], [50, 42]], [50, 78], [
    arrow("ucla-entry", "pass", [50, 78], [76, 58], 1, { sequence: 1 }),
    offBall("ucla-back-screen", "off-ball-screen", [[50, 78], [76, 58], [25, 31], [75, 31], [50, 42]], 5, 1, [50, 54], 2),
    arrow("ucla-feed", "pass", [76, 58], [50, 25], 1, { sequence: 3 }),
  ], [[48, 69], [70, 56], [30, 35], [70, 35], [50, 45]]),
  draft("Princeton backdoor", [[50, 78], [25, 56], [75, 56], [24, 31], [50, 48]], [50, 78], [
    arrow("princeton-entry", "pass", [50, 78], [50, 48], 1, { sequence: 1 }),
    arrow("princeton-cut", "backdoor-cut", [50, 78], [51, 24], 1.1, { actor_id: 1, sequence: 2 }),
    arrow("princeton-feed", "pass", [50, 48], [51, 24], 0.9, { sequence: 3 }),
  ], [[48, 69], [30, 58], [70, 58], [30, 34], [50, 51]]),
  draft("Pistol", [[50, 78], [28, 57], [72, 57], [24, 31], [60, 68]], [50, 78], [
    arrow("pistol-entry", "pass", [50, 78], [28, 57], 0.9, { sequence: 1 }),
    arrow("pistol-handoff", "handoff", [28, 57], [72, 57], 1, { sequence: 2 }),
    namedScreen("pistol-screen", "pick-roll", [[50, 78], [28, 57], [72, 57], [24, 31], [60, 68]], 5, 3, [67, 57], 3),
  ], [[48, 69], [33, 57], [68, 57], [30, 34], [57, 66]]),
  draft("Chicago", [[50, 78], [27, 57], [74, 56], [25, 31], [60, 42]], [50, 78], [
    offBall("chicago-pin", "pin-down", [[50, 78], [27, 57], [74, 56], [25, 31], [60, 42]], 5, 2, [29, 51], 1, [27, 62]),
    arrow("chicago-handoff", "handoff", [50, 78], [27, 62], 1, { sequence: 2 }),
    arrow("chicago-drive", "movement", [27, 62], [42, 48], 1, { sequence: 3 }),
  ], [[48, 69], [33, 57], [68, 56], [30, 34], [60, 45]]),
  draft("Elevator", [[50, 78], [50, 38], [25, 31], [40, 39], [60, 39]], [50, 78], [
    offBall("elevator-left", "pin-down", [[50, 78], [50, 38], [25, 31], [40, 39], [60, 39]], 4, 2, [45, 50], 1, [50, 61]),
    offBall("elevator-right", "pin-down", [[50, 78], [50, 38], [25, 31], [40, 39], [60, 39]], 5, 2, [55, 50], 1, [50, 61]),
    arrow("elevator-shot-pass", "pass", [50, 78], [50, 61], 0.9, { sequence: 2 }),
  ], [[48, 69], [50, 41], [30, 35], [42, 42], [58, 42]]),
  draft("1-4 high", [[50, 78], [25, 56], [75, 56], [42, 65], [58, 65]], [50, 78], [
    arrow("one-four-entry", "pass", [50, 78], [25, 56], 0.9, { sequence: 1 }),
    offBall("one-four-back-screen", "off-ball-screen", [[50, 78], [25, 56], [75, 56], [42, 65], [58, 65]], 4, 3, [66, 57], 2, [74, 42]),
    arrow("one-four-feed", "pass", [25, 56], [74, 42], 0.9, { sequence: 3 }),
  ], [[48, 68], [31, 58], [69, 58], [42, 60], [58, 60]]),
  draft("4-out 1-in", [[50, 78], [27, 57], [73, 57], [25, 31], [50, 43]], [50, 78], [
    arrow("four-out-entry", "pass", [50, 78], [27, 57], 0.9, { sequence: 1 }),
    arrow("four-out-flash", "movement", [50, 43], [48, 55], 1, { sequence: 1 }),
    arrow("four-out-post-feed", "pass", [27, 57], [48, 55], 0.9, { sequence: 2 }),
    arrow("four-out-space", "movement", [73, 57], [80, 48], 1, { sequence: 2 }),
  ], [[48, 68], [32, 58], [68, 58], [30, 34], [50, 47]]),
  draft("3-out 2-in", [[50, 78], [25, 57], [75, 57], [43, 52], [55, 37]], [50, 78], [
    arrow("three-out-entry", "pass", [50, 78], [43, 52], 0.9, { sequence: 1 }),
    arrow("three-out-seal", "movement", [55, 37], [50, 27], 1, { sequence: 1 }),
    arrow("three-out-high-low", "pass", [43, 52], [50, 27], 0.9, { sequence: 2 }),
    arrow("three-out-lift", "movement", [25, 57], [31, 46], 1, { sequence: 2 }),
  ], [[48, 68], [31, 58], [69, 58], [42, 49], [57, 39]]),
  draft("Shuffle", [[50, 78], [75, 57], [25, 34], [50, 58], [58, 39]], [50, 78], [
    arrow("shuffle-reversal", "pass", [50, 78], [75, 57], 0.9, { sequence: 1 }),
    offBall("shuffle-cut", "off-ball-screen", [[50, 78], [75, 57], [25, 34], [50, 58], [58, 39]], 4, 3, [42, 53], 2, [49, 30]),
    arrow("shuffle-feed", "pass", [75, 57], [49, 30], 0.9, { sequence: 3 }),
  ], [[48, 68], [68, 58], [31, 37], [51, 55], [58, 42]]),
  draft("Triangle", [[50, 78], [73, 56], [78, 30], [61, 44], [27, 56]], [50, 78], [
    arrow("triangle-entry", "pass", [50, 78], [73, 56], 0.9, { sequence: 1 }),
    arrow("triangle-post-entry", "pass", [73, 56], [61, 44], 0.9, { sequence: 2 }),
    offBall("triangle-corner-cut", "off-ball-screen", [[50, 78], [73, 56], [78, 30], [61, 44], [27, 56]], 4, 3, [67, 38], 3, [52, 25]),
    arrow("triangle-post-feed", "pass", [61, 44], [52, 25], 0.9, { sequence: 4 }),
  ], [[48, 68], [69, 56], [73, 33], [58, 47], [31, 57]]),
  draft("Zipper", [[50, 78], [25, 32], [75, 56], [37, 59], [63, 59]], [50, 78], [
    arrow("zipper-drift", "movement", [50, 78], [72, 70], 1, { sequence: 1 }),
    offBall("zipper-cut", "pin-down", [[50, 78], [25, 32], [75, 56], [37, 59], [63, 59]], 5, 2, [50, 48], 1, [50, 64]),
    arrow("zipper-entry", "pass", [72, 70], [50, 64], 0.9, { sequence: 2 }),
  ], [[48, 68], [30, 35], [69, 56], [39, 57], [61, 57]]),
  draft("Box", [[50, 78], [34, 40], [66, 40], [39, 57], [61, 57]], [50, 78], [
    offBall("box-left-stagger", "pin-down", [[50, 78], [34, 40], [66, 40], [39, 57], [61, 57]], 4, 2, [37, 49], 1, [26, 60]),
    offBall("box-right-stagger", "pin-down", [[50, 78], [34, 40], [66, 40], [39, 57], [61, 57]], 5, 3, [63, 49], 1, [74, 60]),
    arrow("box-entry", "pass", [50, 78], [26, 60], 0.9, { sequence: 2 }),
  ], [[48, 68], [37, 43], [63, 43], [40, 55], [60, 55]]),
  draft("High-low", [[50, 78], [25, 57], [75, 57], [43, 34], [56, 56]], [50, 78], [
    arrow("high-low-entry", "pass", [50, 78], [56, 56], 0.9, { sequence: 1 }),
    arrow("high-low-seal", "movement", [43, 34], [47, 26], 1, { sequence: 1 }),
    arrow("high-low-feed", "pass", [56, 56], [47, 26], 0.9, { sequence: 2 }),
    arrow("high-low-lift", "movement", [25, 57], [33, 47], 1, { sequence: 2 }),
  ], [[48, 68], [31, 58], [69, 58], [44, 37], [54, 53]]),
];

export const STARTER_PLAY_DETAILS: Record<string, { category: string; description: string }> = {
  "Pick and roll": { category: "Ball screens", description: "Screen, roll to the rim, then feed the screener." },
  "Give and go": { category: "Cuts and passes", description: "Give the ball away and cut into open space." },
  "Drive and kick": { category: "Cuts and passes", description: "Attack the lane and pass to a spaced shooter." },
  Horns: { category: "Horns", description: "Elbow entry into a middle ball screen." },
  Flex: { category: "Off-ball screens", description: "Cross screen and pin-down create two cuts." },
  "Pick and pop": { category: "Ball screens", description: "Screen, pop to space, and receive the return pass." },
  "Inverted pick and roll": { category: "Ball screens", description: "A guard screens for a forward handling the ball." },
  "Spain pick and roll": { category: "Ball screens", description: "A back screen joins the roll to complicate help." },
  Floppy: { category: "Off-ball screens", description: "Two baseline screen routes open a shooter." },
  "5-out motion": { category: "Cuts and passes", description: "Pass, cut behind the defense, and fill the top." },
  "Horns twist": { category: "Horns", description: "Elbow entry and handoff flow into a ball screen." },
  "UCLA cut": { category: "Cuts and passes", description: "Wing entry triggers a back screen and basket cut." },
  "Princeton backdoor": { category: "Cuts and passes", description: "High-post entry punishes a denied passing lane." },
  Pistol: { category: "Ball screens", description: "Wing entry, handoff, and a quick ball screen." },
  Chicago: { category: "Off-ball screens", description: "Pin-down flows into a wing handoff and drive." },
  Elevator: { category: "Off-ball screens", description: "Two screeners close a gate as the shooter cuts through." },
  "1-4 high": { category: "Classic sets", description: "Elbow alignment opens a back screen and a cut to the rim." },
  "4-out 1-in": { category: "Classic sets", description: "Four perimeter spots open a flash and post-entry option." },
  "3-out 2-in": { category: "Classic sets", description: "A high-post touch sets up a low-post seal and high-low feed." },
  Shuffle: { category: "Classic sets", description: "Reverse the ball, then send a cutter off the high-post screen." },
  Triangle: { category: "Classic sets", description: "Build a strong-side triangle around a post entry and corner cut." },
  Zipper: { category: "Classic sets", description: "A wing drift opens the lane for a screened zipper cut." },
  Box: { category: "Classic sets", description: "Two staggered screens free either side from a box alignment." },
  "High-low": { category: "Classic sets", description: "Feed the high post, seal inside, and look for the low-post pass." },
};

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
