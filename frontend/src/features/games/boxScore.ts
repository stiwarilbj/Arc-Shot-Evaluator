export const TOTAL_KEYS = ["points", "rebounds", "misses", "fgPct", "threePct", "ftPct"] as const;
export type TotalKey = typeof TOTAL_KEYS[number];
export type Difficulty = 1 | 2 | 3;
export type SourceStats = {
  fgm: number; fga: number; threeMade: number; threeAttempts: number;
  ftm: number; fta: number; oreb: number; dreb: number;
};
export type Puzzle = {
  id: string;
  difficulty: Difficulty;
  source: SourceStats;
  totals: Partial<Record<TotalKey, number>>;
  wrongField: TotalKey;
};
export type PracticeSession = {
  version: 1;
  correct: number;
  answered: number;
  streak: number;
  bestStreak: number;
  puzzle: Puzzle;
  selected: TotalKey | null;
  recentIds: string[];
};

export const TOTAL_LABELS: Record<TotalKey, string> = {
  points: "Points", rebounds: "Total rebounds", misses: "Missed field goals",
  fgPct: "Field-goal percentage", threePct: "Three-point percentage", ftPct: "Free-throw percentage",
};
export const RECENT_LIMIT = 64;
const SOURCE_KEYS = ["fgm", "fga", "threeMade", "threeAttempts", "ftm", "fta", "oreb", "dreb"] as const;
const percentage = (made: number, attempts: number) => attempts > 0 ? Math.round(made / attempts * 1000) / 10 : 0;
export const difficultyFor = (correct: number): Difficulty => correct >= 10 ? 3 : correct >= 5 ? 2 : 1;
export const keysFor = (difficulty: Difficulty): readonly TotalKey[] => TOTAL_KEYS.slice(0, difficulty === 1 ? 3 : difficulty === 2 ? 4 : 6);
export function calculateTotals(source: SourceStats): Record<TotalKey, number> {
  return {
    points: 2 * (source.fgm - source.threeMade) + 3 * source.threeMade + source.ftm,
    rebounds: source.oreb + source.dreb,
    misses: source.fga - source.fgm,
    fgPct: percentage(source.fgm, source.fga),
    threePct: percentage(source.threeMade, source.threeAttempts),
    ftPct: percentage(source.ftm, source.fta),
  };
}
export function formatTotal(key: TotalKey, value: number): string {
  return key.endsWith("Pct") ? `${value.toFixed(1)}%` : String(value);
}
export function calculation(source: SourceStats, key: TotalKey): string {
  const totals = calculateTotals(source);
  switch (key) {
    case "points": return `2 × (${source.fgm} − ${source.threeMade}) + 3 × ${source.threeMade} + ${source.ftm} = ${totals.points} points`;
    case "rebounds": return `${source.oreb} offensive + ${source.dreb} defensive = ${totals.rebounds} rebounds`;
    case "misses": return `${source.fga} attempted − ${source.fgm} made = ${totals.misses} missed field goals`;
    case "fgPct": return `${source.fgm} ÷ ${source.fga} × 100 = ${formatTotal(key, totals[key])}`;
    case "threePct": return `${source.threeMade} ÷ ${source.threeAttempts} × 100 = ${formatTotal(key, totals[key])}`;
    case "ftPct": return `${source.ftm} ÷ ${source.fta} × 100 = ${formatTotal(key, totals[key])}`;
  }
}
function identity(source: SourceStats, difficulty: Difficulty, totals: Puzzle["totals"]): string {
  return [difficulty, ...SOURCE_KEYS.map(key => source[key]), ...keysFor(difficulty).map(key => totals[key])].join(":");
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const integer = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
export function validatePuzzle(value: unknown): value is Puzzle {
  if (!isObject(value) || ![1, 2, 3].includes(value.difficulty as number) || !isObject(value.source) || !isObject(value.totals)) return false;
  const s = value.source;
  if (!SOURCE_KEYS.every(key => integer(s[key], key === "oreb" || key === "dreb" ? 20 : 40))) return false;
  const source = s as SourceStats;
  if (source.fga < 1 || source.fgm > source.fga || source.threeMade > source.threeAttempts || source.threeAttempts > source.fga || source.threeMade > source.fgm || source.fgm - source.threeMade > source.fga - source.threeAttempts || source.ftm > source.fta) return false;
  if (value.difficulty === 3 && (source.threeAttempts === 0 || source.fta === 0)) return false;
  const difficulty = value.difficulty as Difficulty;
  const keys = keysFor(difficulty);
  if (Object.keys(value.totals).length !== keys.length || !keys.includes(value.wrongField as TotalKey)) return false;
  const totals = value.totals as Puzzle["totals"];
  const correct = calculateTotals(source);
  for (const key of keys) {
    const result = totals[key];
    if (typeof result !== "number" || !Number.isFinite(result) || result < 0) return false;
    if (key.endsWith("Pct")) {
      if (result > 100 || Math.abs(Math.round(result * 10) / 10 - result) > 1e-9) return false;
    } else if (!integer(result, key === "misses" ? source.fga : key === "rebounds" ? 40 : 160)) return false;
  }
  const errors = keys.filter(key => totals[key] !== correct[key]);
  return errors.length === 1 && errors[0] === value.wrongField && value.id === identity(source, difficulty, totals);
}

export function generatePuzzle(correct: number, recentIds: readonly string[] = [], previous?: Puzzle, random: () => number = Math.random): Puzzle {
  const difficulty = difficultyFor(correct);
  const rand = (max: number) => Math.floor(Math.min(1 - Number.EPSILON, Math.max(0, random())) * max);
  // Rotating attempts also guarantees fresh candidates with a constant test RNG.
  for (let attempt = 0; attempt < 256; attempt++) {
    const twoAttempts = 1 + (rand(20) + attempt) % 20;
    const threeAttempts = (difficulty === 3 ? 1 : 0) + (rand(14) + Math.floor(attempt / 20)) % 14;
    const fta = (difficulty === 3 ? 1 : 0) + rand(13);
    const threeMade = rand(threeAttempts + 1);
    const source: SourceStats = {
      fga: twoAttempts + threeAttempts, fgm: rand(twoAttempts + 1) + threeMade,
      threeAttempts, threeMade, fta, ftm: rand(fta + 1), oreb: rand(7), dreb: rand(13),
    };
    const correctTotals = calculateTotals(source);
    const fields = keysFor(difficulty).filter(key => key !== previous?.wrongField);
    const wrongField = fields[(rand(fields.length) + attempt) % fields.length];
    const previousDelta = previous ? previous.totals[previous.wrongField]! - calculateTotals(previous.source)[previous.wrongField] : null;
    const max = wrongField.endsWith("Pct") ? 100 : wrongField === "misses" ? source.fga : wrongField === "rebounds" ? 40 : 160;
    const candidates = (wrongField.endsWith("Pct") ? [-10, -5, -2.5, -1, 1, 2.5, 5, 10] : [-5, -3, -2, -1, 1, 2, 3, 5])
      .filter(delta => correctTotals[wrongField] + delta >= 0 && correctTotals[wrongField] + delta <= max && Math.abs(delta - (previousDelta ?? Infinity)) > 1e-8);
    if (!candidates.length) continue;
    const totals: Puzzle["totals"] = Object.fromEntries(keysFor(difficulty).map(key => [key, correctTotals[key]]));
    totals[wrongField] = Math.round((correctTotals[wrongField] + candidates[rand(candidates.length)]) * 10) / 10;
    const puzzle: Puzzle = { id: identity(source, difficulty, totals), difficulty, source, totals, wrongField };
    if (!recentIds.includes(puzzle.id) && validatePuzzle(puzzle)) return puzzle;
  }
  throw new Error("Could not prepare a new stat line");
}
export function createSession(random: () => number = Math.random): PracticeSession {
  const puzzle = generatePuzzle(0, [], undefined, random);
  return { version: 1, correct: 0, answered: 0, streak: 0, bestStreak: 0, puzzle, selected: null, recentIds: [puzzle.id] };
}
export function answerRound(session: PracticeSession, selected: TotalKey): PracticeSession {
  if (session.selected !== null || !keysFor(session.puzzle.difficulty).includes(selected)) return session;
  const right = selected === session.puzzle.wrongField;
  const streak = right ? session.streak + 1 : 0;
  return { ...session, selected, answered: session.answered + 1, correct: session.correct + Number(right), streak, bestStreak: Math.max(session.bestStreak, streak) };
}
export function nextRound(session: PracticeSession, random: () => number = Math.random): PracticeSession {
  if (session.selected === null) return session;
  const puzzle = generatePuzzle(session.correct, session.recentIds, session.puzzle, random);
  return { ...session, puzzle, selected: null, recentIds: [...session.recentIds, puzzle.id].slice(-RECENT_LIMIT) };
}
export function validateSession(value: unknown): value is PracticeSession {
  if (!isObject(value) || value.version !== 1 || !validatePuzzle(value.puzzle)) return false;
  if (!["correct", "answered", "streak", "bestStreak"].every(key => integer(value[key], 1_000_000_000))) return false;
  const { correct, answered, streak, bestStreak } = value as unknown as PracticeSession;
  if (correct > answered || streak > bestStreak || bestStreak > correct || (correct > 0 && bestStreak === 0)) return false;
  // Check that the aggregate streak summary can fit around the incorrect
  // answers, including both the reported trailing run and the historical best.
  const incorrect = answered - correct;
  const priorCorrect = correct - streak;
  if (BigInt(priorCorrect) > BigInt(incorrect) * BigInt(bestStreak) || bestStreak > Math.max(streak, priorCorrect)) return false;
  const selected = value.selected;
  if (selected !== null && !keysFor(value.puzzle.difficulty).includes(selected as TotalKey)) return false;
  if (selected !== null && answered === 0) return false;
  const justCorrect = selected === value.puzzle.wrongField;
  if (selected !== null && (justCorrect ? streak < 1 : streak !== 0)) return false;
  if (value.puzzle.difficulty !== difficultyFor(correct - Number(justCorrect))) return false;
  if (!Array.isArray(value.recentIds) || value.recentIds.length < 1 || value.recentIds.length > RECENT_LIMIT || !value.recentIds.every(id => typeof id === "string" && id.length <= 240)) return false;
  const expectedHistoryLength = Math.min(answered + Number(selected === null), RECENT_LIMIT);
  if (value.recentIds.length !== expectedHistoryLength) return false;
  if (new Set(value.recentIds).size !== value.recentIds.length || value.recentIds.at(-1) !== value.puzzle.id) return false;
  return true;
}
