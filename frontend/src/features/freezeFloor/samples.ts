import type { Anchor, Attribution, Contact } from "./types.ts";
export type Sample = {
  id: string;
  name: string;
  file: string;
  attribution: Attribution;
  anchors: Anchor[];
  contacts: Contact[];
  note: string;
};
const anchors = (
  coords: [string, number, number][],
  width: number,
  height: number,
): Anchor[] =>
  coords.map(([landmark, x, y], i) => ({
    id: `sample-anchor-${i}`,
    landmark,
    image: { x: x / width, y: y / height },
    enabled: true,
    origin: "sample",
    confidence: 1,
  }));
export const SAMPLES: Sample[] = [
  {
    id: "garden",
    name: "Madison Square Garden · Floor alignment",
    file: "garden.jpg",
    attribution: {
      title: "Madison Square Garden court",
      creator: "Ganley894",
      license: "Public domain",
      url: "https://commons.wikimedia.org/wiki/File:Madison_Square_Garden_court.jpg",
    },
    anchors: anchors(
      [
        ["lane-left-base", 217, 623],
        ["lane-right-base", 321, 704],
        ["free-left", 536, 598],
        ["free-right", 636, 653],
      ],
      1600,
      1200,
    ),
    contacts: [
      {
        id: "sample-person-1",
        label: "1",
        image: { x: 565 / 1600, y: 549 / 1200 },
        status: "uncertain",
        box: [548 / 1600, 472 / 1200, 587 / 1600, 550 / 1200],
      },
      {
        id: "sample-person-2",
        label: "2",
        image: { x: 256 / 1600, y: 582 / 1200 },
        status: "grounded",
        box: [239 / 1600, 505 / 1200, 273 / 1600, 584 / 1200],
      },
    ],
    note: "Manually reviewed lane overlay · Soft image and lens distortion limit accuracy · Player 1 has uncertain foot contact",
  },
  {
    id: "game",
    name: "Knicks at the Garden · Wide view",
    file: "game.jpg",
    attribution: {
      title: "Knicks playing at Madison Square Garden",
      creator: "GoCuse44",
      license: "Public domain",
      url: "https://commons.wikimedia.org/wiki/File:Knicks_playing_at_Madison_Square_Garden.jpg",
    },
    anchors: anchors(
      [
        ["lane-left-base", 604, 386],
        ["lane-right-base", 548, 423],
        ["free-left", 500, 349],
        ["free-right", 452, 378],
      ],
      800,
      600,
    ),
    contacts: [],
    note: "Manually reviewed right-half lane · Distant players need contact confirmation",
  },
  {
    id: "closeup",
    name: "Finals close-up · Insufficient floor evidence",
    file: "closeup.jpg",
    attribution: {
      title: "2019 NBA Finals Game 2",
      creator: "Chensiyuan",
      license: "CC BY-SA 4.0",
      url: "https://commons.wikimedia.org/wiki/File:2019_nba_finals_game_2.jpg",
    },
    anchors: [],
    contacts: [
      {
        id: "sample-person-3",
        label: "1",
        image: { x: 0.49, y: 0.94 },
        status: "hidden",
      },
    ],
    note: "Unsuitable example · Too little visible floor for credible alignment · Measurements are unavailable",
  },
];
