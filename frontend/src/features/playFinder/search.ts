import catalogData from "./catalog.v1.json";
import type { PlayAction, PlayClip, PlayCondition, PlayFinderCatalog, SearchField, SearchResult } from "./types";

export const PLAY_FINDER_CATALOG = catalogData as PlayFinderCatalog;

export const FIELD_LABELS: Record<SearchField | "sequence", string> = {
  player: "Player",
  team: "Team",
  opponent: "Opponent",
  season: "Season",
  postseason: "Postseason",
  quarter: "Quarter",
  gameClock: "Game clock",
  scoreMargin: "Score margin",
  shotType: "Shot type",
  result: "Result",
  action: "Action",
  coverage: "Defensive coverage",
  sequence: "Action order",
};

export const ACTION_LABELS: Record<PlayAction, string> = {
  "pick-and-roll": "Pick and roll",
  "pick-and-pop": "Pick and pop",
  handoff: "Handoff",
  "off-ball-screen": "Off-ball screen",
  cut: "Cut",
  "drive-and-kick": "Drive and kick",
  isolation: "Isolation",
  transition: "Transition",
};

const actionAliases: Array<{ action: PlayAction; patterns: string[] }> = [
  { action: "pick-and-roll", patterns: ["pick and rolls", "pick and roll", "pick-and-rolls", "pick-and-roll", "pick n rolls", "pick n roll", "pick 'n' roll", "pnr", "screen and roll", "ball screen and roll"] },
  { action: "pick-and-pop", patterns: ["pick and pops", "pick and pop", "pick-and-pops", "pick-and-pop", "pick pop"] },
  { action: "handoff", patterns: ["dribble handoffs", "dribble hand-offs", "dribble handoff", "dribble hand-off", "handoffs", "handoff", "hand offs", "hand off", "hand-offs", "hand-off", "dho"] },
  { action: "off-ball-screen", patterns: ["off-ball screen", "off ball screen", "pindown", "pin-down", "pin down", "screen away"] },
  { action: "drive-and-kick", patterns: ["drive and kicks", "drive and kick", "drive-and-kicks", "drive-and-kick", "drive kicks", "drive kick"] },
  { action: "cut", patterns: ["backdoor cut", "back-door cut", "backdoor", "back-door", "give and go", "give-and-go", "cut", "cuts"] },
  { action: "isolation", patterns: ["isolation", "iso"] },
  { action: "transition", patterns: ["fast break", "fastbreak", "transition"] },
];

const teamAliases: Record<string, string> = {
  boston: "Boston Celtics", celtics: "Boston Celtics", bos: "Boston Celtics",
  denver: "Denver Nuggets", nuggets: "Denver Nuggets", den: "Denver Nuggets",
  "golden state": "Golden State Warriors", warriors: "Golden State Warriors", gsw: "Golden State Warriors",
  miami: "Miami Heat", heat: "Miami Heat", mia: "Miami Heat",
  "los angeles lakers": "Los Angeles Lakers", lakers: "Los Angeles Lakers", lal: "Los Angeles Lakers",
  phoenix: "Phoenix Suns", suns: "Phoenix Suns", phx: "Phoenix Suns",
  milwaukee: "Milwaukee Bucks", bucks: "Milwaukee Bucks", mil: "Milwaukee Bucks",
  cleveland: "Cleveland Cavaliers", cavaliers: "Cleveland Cavaliers", cavs: "Cleveland Cavaliers", cle: "Cleveland Cavaliers",
  dallas: "Dallas Mavericks", mavericks: "Dallas Mavericks", mavs: "Dallas Mavericks", dal: "Dallas Mavericks",
  indiana: "Indiana Pacers", pacers: "Indiana Pacers", ind: "Indiana Pacers",
  okc: "Oklahoma City Thunder", "oklahoma city": "Oklahoma City Thunder", thunder: "Oklahoma City Thunder",
  toronto: "Toronto Raptors", raptors: "Toronto Raptors", tor: "Toronto Raptors",
  chicago: "Chicago Bulls", bulls: "Chicago Bulls", chi: "Chicago Bulls",
  atlanta: "Atlanta Hawks", hawks: "Atlanta Hawks", atl: "Atlanta Hawks",
  brooklyn: "Brooklyn Nets", nets: "Brooklyn Nets", bkn: "Brooklyn Nets",
  philadelphia: "Philadelphia 76ers", sixers: "Philadelphia 76ers", phi: "Philadelphia 76ers",
  orlando: "Orlando Magic", magic: "Orlando Magic", orl: "Orlando Magic",
  memphis: "Memphis Grizzlies", grizzlies: "Memphis Grizzlies", mem: "Memphis Grizzlies",
  minnesota: "Minnesota Timberwolves", timberwolves: "Minnesota Timberwolves", wolves: "Minnesota Timberwolves", min: "Minnesota Timberwolves",
  "new york": "New York Knicks", knicks: "New York Knicks", nyk: "New York Knicks",
  portland: "Portland Trail Blazers", blazers: "Portland Trail Blazers", por: "Portland Trail Blazers",
  sacramento: "Sacramento Kings", kings: "Sacramento Kings", sac: "Sacramento Kings",
  utah: "Utah Jazz", jazz: "Utah Jazz", uta: "Utah Jazz",
  washington: "Washington Wizards", wizards: "Washington Wizards", was: "Washington Wizards",
  charlotte: "Charlotte Hornets", hornets: "Charlotte Hornets", cha: "Charlotte Hornets",
  detroit: "Detroit Pistons", pistons: "Detroit Pistons", det: "Detroit Pistons",
  houston: "Houston Rockets", rockets: "Houston Rockets", hou: "Houston Rockets",
  "new orleans": "New Orleans Pelicans", pelicans: "New Orleans Pelicans", nop: "New Orleans Pelicans",
  "san antonio": "San Antonio Spurs", spurs: "San Antonio Spurs", sas: "San Antonio Spurs",
};

let conditionCounter = 0;
function condition(field: PlayCondition["field"], value: PlayCondition["value"], operator: PlayCondition["operator"], origin: PlayCondition["origin"] = "prompt", status: PlayCondition["status"] = "ready", candidates?: string[]): PlayCondition {
  conditionCounter += 1;
  return { id: `pf-${conditionCounter}`, field, value, operator, origin, status, ...(candidates ? { candidates } : {}) };
}

function normalize(value: string) {
  return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

interface ActionMatch { action: PlayAction; start: number; end: number; phrase: string; excluded: boolean }
function isNegatedPrefix(prefix: string) {
  return /\b(?:without|excluding|exclude|no|not)(?:\s+\w+){0,3}\s*$/.test(prefix);
}
function findActionMatches(text: string): ActionMatch[] {
  const matches: ActionMatch[] = [];
  for (const { action, patterns } of actionAliases) {
    for (const phrase of patterns) {
      const regex = new RegExp(`(^|[^a-z0-9])(${escapeRegExp(phrase)})(?=$|[^a-z0-9])`, "gi");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text))) {
        const start = match.index + match[1].length;
        const end = start + match[2].length;
        const prefix = text.slice(Math.max(0, start - 30), start);
        matches.push({ action, start, end, phrase, excluded: isNegatedPrefix(prefix) });
      }
    }
  }
  return matches.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start).filter((candidate, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.start <= candidate.start && other.end >= candidate.end));
}

function resolvePlayer(term: string) {
  const names = [...new Set(PLAY_FINDER_CATALOG.clips.filter((clip) => clip.evidence.verifiedFields.includes("players")).flatMap((clip) => clip.players).filter((name) => !/\b(nuggets|warriors|celtics|lakers|heat|suns|bucks|cavaliers|raptors|knicks|nets|hawks|sixers|magic|grizzlies|timberwolves|blazers|kings|jazz|wizards|hornets|pistons|rockets|pelicans|spurs|bulls|pacers|mavericks)\b/i.test(name)))];
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return [];
  return names.filter((name) => {
    const normalizedName = normalize(name);
    return normalizedName === normalizedTerm || normalizedName.endsWith(` ${normalizedTerm}`) || normalizedName.includes(` ${normalizedTerm} `);
  });
}

function addEntityConditions(text: string, output: PlayCondition[]) {
  const normalized = normalize(text);
  const playerNames = [...new Set(PLAY_FINDER_CATALOG.clips.filter((clip) => clip.evidence.verifiedFields.includes("players")).flatMap((clip) => clip.players).filter((name) => !/\b(nuggets|warriors|celtics|lakers|heat|suns|bucks|cavaliers|raptors|knicks|nets|hawks|sixers|magic|grizzlies|timberwolves|blazers|kings|jazz|wizards|hornets|pistons|rockets|pelicans|spurs|bulls|pacers|mavericks)\b/i.test(name)))].sort((a, b) => b.length - a.length);
  const used = new Set<string>();
  for (const name of playerNames) {
    const needle = normalize(name);
    if (needle.length < 3 || used.has(needle)) continue;
    if (new RegExp(`(^|\\b)${escapeRegExp(needle)}(\\b|$)`).test(normalized)) {
      const selected = name;
      if (!output.some((item) => item.field === "player" && item.value === selected)) output.push(condition("player", selected, "includes"));
      used.add(needle);
    }
  }
  if (!output.some((item) => item.field === "player")) {
    const surnameMatch = text.match(/\b(?:for|by|from|with)\s+([A-Z][a-z]+)\b/);
    const casualNameMatch = text.match(/\b([A-Z][a-z]{2,})\b/);
    const candidateName = surnameMatch?.[1] ?? casualNameMatch?.[1];
    const queryWords = new Set(["pick", "roll", "rolls", "screen", "screens", "handoff", "handoffs", "hand-off", "hand-offs", "dribble", "drive", "drives", "kick", "cut", "cuts", "backdoor", "transition", "isolation", "three", "threes", "pointer", "pointers", "made", "make", "miss", "missed", "turnover", "turnovers", "foul", "block", "against", "boston", "finals", "playoffs", "quarter", "followed", "then", "before", "after", "the", "a", "an", "and", "by", "for", "from", "with", "without", "ending", "ends", "game", "plays", "play"]);
    if (candidateName && !queryWords.has(candidateName.toLowerCase()) && !teamAliases[candidateName.toLowerCase()]) {
      const aliases: Record<string, string> = { steph: "Stephen Curry", "king james": "LeBron James" };
      const candidates = aliases[candidateName.toLowerCase()] ? [aliases[candidateName.toLowerCase()]] : resolvePlayer(candidateName);
      if (candidates.length) output.push(condition("player", candidates.length === 1 ? candidates[0] : candidateName, "includes", "prompt", candidates.length > 1 ? "ambiguous" : "ready", candidates.length > 1 ? candidates : undefined));
      else output.push(condition("player", candidateName, "includes", "prompt", "unsupported"));
    }
  }

  const allTeams = [...new Set(PLAY_FINDER_CATALOG.clips.flatMap((clip) => [
    ...(clip.evidence.verifiedFields.includes("team") ? [clip.team] : []),
    ...(clip.evidence.verifiedFields.includes("opponent") ? [clip.opponent] : []),
    ...(clip.evidence.verifiedFields.includes("teams") ? clip.teams ?? [] : []),
  ].filter((team): team is string => Boolean(team))))];
  const teamMatches = new Map<string, string>();
  for (const [alias, canonical] of Object.entries(teamAliases)) {
    if (new RegExp(`(^|\\b)${escapeRegExp(normalize(alias))}(\\b|$)`, "i").test(normalized)) teamMatches.set(canonical, alias);
  }
  for (const team of allTeams) {
    const words = normalize(team);
    if (words && new RegExp(`(^|\\b)${escapeRegExp(words)}(\\b|$)`, "i").test(normalized)) teamMatches.set(team, team);
  }
  for (const [team] of teamMatches) {
    const againstPattern = new RegExp(`\\b(?:against|vs|versus)\\s+(?:the\\s+)?(?:${Object.entries(teamAliases).filter(([, canonical]) => canonical === team).map(([alias]) => escapeRegExp(normalize(alias))).join("|")}|${escapeRegExp(normalize(team))})\\b`, "i");
    const field: SearchField = againstPattern.test(normalized) ? "opponent" : "team";
    if (!output.some((item) => item.field === field && normalize(String(item.value)) === normalize(team))) output.push(condition(field, team, "includes"));
  }
}

function addResultAndShotConditions(text: string, output: PlayCondition[]) {
  const lower = normalize(text);
  const negative = (_term: string, start: number) => isNegatedPrefix(lower.slice(Math.max(0, start - 40), start));
  const results: Array<[PlayResultLabel, RegExp]> = [
    ["turnover", /\bturnovers?\b/g], ["missed", /\b(?:miss(?:es|ed)?|missed shots?)\b/g],
    ["made", /\b(?:made|makes|make|converted)\b/g], ["foul", /\b(?:foul|fouled|fouls)\b/g], ["block", /\b(?:blocked|block|blocks)\b/g],
  ];
  for (const [result, regex] of results) {
    const match = regex.exec(lower);
    if (match) output.push(condition("result", result, negative(match[0], match.index) ? "excludes" : "equals"));
  }
  const shots: Array<[string, RegExp]> = [
    ["three", /\b(?:threes?|3s|three pointers?|3 pointers?)\b/g], ["layup", /\blayups?\b/g], ["dunk", /\bdunks?\b/g],
    ["mid-range", /\b(?:mid range|midrange|pull up twos?)\b/g], ["free-throw", /\b(?:free throws?|free throw attempts?)\b/g], ["two", /\b(?:two pointers?|2 pointers?)\b/g],
  ];
  for (const [shot, regex] of shots) {
    const match = regex.exec(lower);
    if (match) output.push(condition("shotType", shot, negative(match[0], match.index) ? "excludes" : "equals"));
  }
  const quarter = lower.match(/\b(?:q|quarter)\s*([1-4])\b/);
  if (quarter) output.push(condition("quarter", quarter[1], "equals"));
  const season = text.match(/\b(20\d{2})\s*[-–/]\s*(\d{2,4})\b/);
  if (season) {
    const end = season[2].length === 2 ? `20${season[2]}` : season[2];
    output.push(condition("season", `${season[1]}-${end.slice(-2)}`, "equals"));
  }
  if (/\b(?:playoffs?|postseason|finals)\b/i.test(text)) output.push(condition("postseason", "true", "equals"));
  const clock = lower.match(/\b(?:with|at|under|in)\s+(?:the\s+)?(?:last\s+)?(\d{1,2}):([0-5]\d)\s*(?:left|remaining)?\b/);
  if (clock) output.push(condition("gameClock", `${clock[1]}:${clock[2]}`, "equals"));
  const margin = lower.match(/\b(?:up|down|leading|trailing)\s+(\d{1,2})\b/);
  if (margin) output.push(condition("scoreMargin", margin[1], "equals"));
}

type PlayResultLabel = "made" | "missed" | "turnover" | "foul" | "block";

export function parsePlayPrompt(text: string): PlayCondition[] {
  const lower = text.toLowerCase().replace(/[’]/g, "'");
  const result: PlayCondition[] = [];
  const actionMatches = findActionMatches(lower);
  const sequenceRequested = actionMatches.length > 1 && /\b(?:then|followed by|before|after)\b/.test(lower);
  if (sequenceRequested) {
    const sequenceMatches = actionMatches.filter((item) => !item.excluded).sort((a, b) => a.start - b.start);
    if (sequenceMatches.length > 1) result.push(condition("sequence", sequenceMatches.map((match) => match.action), "sequence"));
    else for (const match of actionMatches) result.push(condition("action", match.action, match.excluded ? "excludes" : "includes"));
  } else {
    for (const match of actionMatches) result.push(condition("action", match.action, match.excluded ? "excludes" : "includes"));
  }
  if (/\b(?:zone defense|left handed|right handed|shot clock|weak side tag|weak-side tag|weak side help|weak-side help|switching assignment)\b/i.test(text)) {
    const unsupported = text.match(/\b(?:zone defense|left handed|right handed|shot clock|weak side tag|weak-side tag|weak side help|weak-side help|switching assignment)\b/i)?.[0];
    if (unsupported) result.push(condition("coverage", unsupported, "equals", "prompt", "unsupported"));
  }
  addResultAndShotConditions(text, result);
  addEntityConditions(text, result);
  return result.map(markUnsupportedWhenUnrepresented);
}

export function makeFilterCondition(field: SearchField, value: string, operator: PlayCondition["operator"] = "includes"): PlayCondition {
  const normalizedValue = value.trim();
  const lower = normalizedValue.toLowerCase();
  const status: PlayCondition["status"] = field === "action" && !Object.keys(ACTION_LABELS).includes(lower) ? "unsupported" : "ready";
  return markUnsupportedWhenUnrepresented(condition(field, field === "postseason" ? lower === "true" || lower === "yes" ? "true" : "false" : normalizedValue, operator, "filter", status));
}

function catalogHasVerifiedField(field: PlayCondition["field"]) {
  const fields = PLAY_FINDER_CATALOG.clips.flatMap((clip) => clip.evidence.verifiedFields);
  if (field === "team") return fields.includes("team") || fields.includes("teams");
  const fieldName: Record<PlayCondition["field"], string> = {
    player: "players", team: "team", opponent: "opponent", season: "season", postseason: "postseason", quarter: "quarter",
    gameClock: "gameClockSeconds", scoreMargin: "scoreMargin", shotType: "shotType", result: "result",
    action: "actions", coverage: "coverage", sequence: "sequence",
  };
  return fields.includes(fieldName[field]);
}

function markUnsupportedWhenUnrepresented(item: PlayCondition): PlayCondition {
  return item.status === "ready" && !catalogHasVerifiedField(item.field) ? { ...item, status: "unsupported" } : item;
}

export function resolveAmbiguousCondition(item: PlayCondition, value: string): PlayCondition {
  return { ...item, value, status: "ready", candidates: undefined };
}

function verified(clip: PlayClip, field: string) {
  return clip.evidence.verifiedFields.includes(field);
}
function textIncludes(values: string[] | undefined, target: string) {
  if (!values?.length) return false;
  const needle = normalize(target);
  return values.some((value) => normalize(value).includes(needle));
}
function parseClock(value: string) {
  const [minutes, seconds] = value.split(":").map(Number);
  return Number.isFinite(minutes) && Number.isFinite(seconds) ? minutes * 60 + seconds : Number.NaN;
}

function fieldValueMatches(clip: PlayClip, item: PlayCondition): boolean | null {
  const value = String(item.value);
  switch (item.field) {
    case "player": return verified(clip, "players") ? textIncludes(clip.players, value) : null;
    case "team": return verified(clip, "team") || verified(clip, "teams") ? textIncludes([clip.team, ...(clip.teams ?? [])].filter(Boolean) as string[], value) : null;
    case "opponent": return verified(clip, "opponent") ? textIncludes(clip.opponent ? [clip.opponent] : [], value) : null;
    case "season": return verified(clip, "season") ? normalize(clip.season ?? "") === normalize(value) : null;
    case "postseason": return verified(clip, "postseason") ? String(clip.postseason) === value.toLowerCase() : null;
    case "quarter": return verified(clip, "quarter") ? String(clip.quarter) === value : null;
    case "gameClock": return verified(clip, "gameClockSeconds") ? clip.gameClockSeconds === parseClock(value) : null;
    case "scoreMargin": return verified(clip, "scoreMargin") ? Math.abs(clip.scoreMargin ?? Infinity) === Math.abs(Number(value)) : null;
    case "shotType": return verified(clip, "shotType") ? normalize(clip.shotType ?? "") === normalize(value) : null;
    case "result": return verified(clip, "result") ? normalize(clip.result ?? "") === normalize(value) : null;
    case "coverage": return verified(clip, "coverage") ? normalize(clip.coverage ?? "").includes(normalize(value)) : null;
    case "action": return verified(clip, "actions") ? clip.actions.includes(value as PlayAction) : null;
    case "sequence": {
      if (!verified(clip, "sequence")) return null;
      const sequence = item.value as PlayAction[];
      return Boolean(clip.sequence?.some((_, index) => sequence.every((action, offset) => clip.sequence?.[index + offset] === action)));
    }
  }
}

function conditionText(item: PlayCondition) {
  const value = item.field === "action" ? ACTION_LABELS[item.value as PlayAction] ?? String(item.value)
    : item.field === "sequence" ? (item.value as PlayAction[]).map((action) => ACTION_LABELS[action]).join(" then ")
      : String(item.value);
  return `${item.operator === "excludes" ? "without " : ""}${FIELD_LABELS[item.field]}: ${value}`;
}

export function searchCatalog(conditions: PlayCondition[], sort: "relevance" | "date" = "relevance"): SearchResult[] {
  if (conditions.some((item) => item.status !== "ready")) return [];
  const active = conditions;
  const hits: SearchResult[] = [];
  for (const clip of PLAY_FINDER_CATALOG.clips) {
    let matches = true;
    const why: string[] = [];
    for (const item of active) {
      const result = fieldValueMatches(clip, item);
      if (result === null || (item.operator === "excludes" && result) || (item.operator !== "excludes" && !result)) {
        matches = false;
        break;
      }
      why.push(conditionText(item));
    }
    if (matches) hits.push({ clip, score: active.length ? active.length + why.length / 100 : 0, why: why.length ? why : ["Browse the verified ARC clip catalog"] });
  }
  return hits.sort((a, b) => sort === "date"
    ? (verified(b.clip, "publishedAt") ? b.clip.publishedAt ?? "" : "").localeCompare(verified(a.clip, "publishedAt") ? a.clip.publishedAt ?? "" : "") || a.clip.title.localeCompare(b.clip.title)
    : b.score - a.score || (verified(b.clip, "publishedAt") ? b.clip.publishedAt ?? "" : "").localeCompare(verified(a.clip, "publishedAt") ? a.clip.publishedAt ?? "" : "") || a.clip.title.localeCompare(b.clip.title));
}

export function findSimilarPlays(source: PlayClip, limit = 4): Array<{ clip: PlayClip; shared: string[] }> {
  return PLAY_FINDER_CATALOG.clips.filter((clip) => clip.id !== source.id).map((clip) => {
    const shared: string[] = [];
    const commonActions = verified(source, "actions") && verified(clip, "actions")
      ? source.actions.filter((action) => clip.actions.includes(action))
      : [];
    commonActions.forEach((action) => shared.push(ACTION_LABELS[action]));
    if (verified(source, "coverage") && verified(clip, "coverage") && source.coverage && clip.coverage && normalize(source.coverage) === normalize(clip.coverage)) shared.push(`${source.coverage} coverage`);
    if (verified(source, "shotType") && verified(clip, "shotType") && source.shotType && clip.shotType && source.shotType === clip.shotType) shared.push(`${source.shotType} finish`);
    if (verified(source, "result") && verified(clip, "result") && source.result && clip.result && source.result === clip.result) shared.push(`${source.result} result`);
    return { clip, shared, score: shared.length };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || (verified(b.clip, "publishedAt") ? b.clip.publishedAt ?? "" : "").localeCompare(verified(a.clip, "publishedAt") ? a.clip.publishedAt ?? "" : "")).slice(0, limit);
}
