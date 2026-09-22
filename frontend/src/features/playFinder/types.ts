export const ACTION_TAGS = [
  "pick-and-roll",
  "pick-and-pop",
  "handoff",
  "off-ball-screen",
  "cut",
  "drive-and-kick",
  "isolation",
  "transition",
] as const;

export type PlayAction = (typeof ACTION_TAGS)[number];
export type ShotType = "three" | "two" | "layup" | "dunk" | "mid-range" | "free-throw";
export type PlayResult = "made" | "missed" | "turnover" | "foul" | "block";

export interface PlayClip {
  id: string;
  title: string;
  publishedAt?: string;
  season?: string;
  game?: string;
  teams?: string[];
  team?: string;
  opponent?: string;
  players: string[];
  actions: PlayAction[];
  sequence?: PlayAction[];
  shotType?: ShotType;
  result?: PlayResult;
  coverage?: string;
  postseason?: boolean;
  quarter?: number;
  gameClockSeconds?: number;
  scoreMargin?: number;
  description: string;
  source: {
    publisher: string;
    label: string;
    url: string;
    embedUrl?: string;
  };
  evidence: {
    kind: "official-video-title" | "official-video-description" | "official-film-analysis";
    verifiedFields: string[];
  };
}

export interface PlayFinderCatalog {
  version: 1;
  lastReviewed: string;
  clips: PlayClip[];
}

export type SearchField =
  | "player"
  | "team"
  | "opponent"
  | "season"
  | "postseason"
  | "quarter"
  | "gameClock"
  | "scoreMargin"
  | "shotType"
  | "result"
  | "action"
  | "coverage";

export interface PlayCondition {
  id: string;
  field: SearchField | "sequence";
  value: string | PlayAction[];
  operator: "includes" | "excludes" | "equals" | "sequence";
  status: "ready" | "unsupported" | "ambiguous";
  candidates?: string[];
  origin: "prompt" | "filter";
}

export interface PlayQuery {
  text: string;
  conditions: PlayCondition[];
}

export interface SearchResult {
  clip: PlayClip;
  score: number;
  why: string[];
}

export interface FilmCollection {
  id: string;
  name: string;
  clipIds: string[];
  notesByClip: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionBackup {
  version: 1;
  exportedAt: string;
  collections: FilmCollection[];
}
