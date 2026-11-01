import { SHOTFORM_ENGINE, challengeFromSeed, chooseChallenge, measure, stable, validControls, type Controls } from "./shotformMotion.ts";
export const SHOTFORM_KEY = "arc-shotform-jenga-v1";
export type Nudge = { axis: 0 | 1 | 2; direction: -1 | 1 };
export type ShotformSession = { version: 1; engine: typeof SHOTFORM_ENGINE; rng: number; round: number; challengeSeed: number; recentSeeds: number[]; controls: Controls; previous: Controls | null; pending: Nudge | null; tests: number; completed: number; bestScore: number };
export const currentChallenge = (s: ShotformSession) => challengeFromSeed(s.challengeSeed, s.round);
export const complete = (s: ShotformSession) => stable(measure(currentChallenge(s), s.controls));
export const roundScore = (minimum: number, tests: number) => Math.min(100, Math.round(100 * minimum / tests));
export const score = (s: ShotformSession) => complete(s) && s.tests > 0 ? roundScore(currentChallenge(s).minimum, s.tests) : 0;
const attainableBestScores = new Set<number>([0]);
for (let minimum = 2; minimum <= 8; minimum++) {
  // Beyond 200 attempts per required move, every attainable result is zero
  for (let tests = minimum; tests <= minimum * 200 + 1; tests++) attainableBestScores.add(roundScore(minimum, tests));
}
export function createShotformSession(seed = Math.floor(Math.random() * 4294967296)): ShotformSession {
  const { challenge, seed: rng } = chooseChallenge(seed >>> 0, 1);
  return { version: 1, engine: SHOTFORM_ENGINE, rng, round: 1, challengeSeed: challenge.seed, recentSeeds: [challenge.seed], controls: [...challenge.start], previous: null, pending: null, tests: 0, completed: 0, bestScore: 0 };
}
export function pendingControls(s: ShotformSession): Controls {
  const c = [...s.controls] as Controls; if (s.pending) c[s.pending.axis] += s.pending.direction; return c;
}
export function stageNudge(s: ShotformSession, nudge: Nudge): ShotformSession {
  if (s.pending || complete(s) || ![0, 1, 2].includes(nudge.axis) || ![-1, 1].includes(nudge.direction)) return s;
  const next = { ...s, pending: nudge }; return validControls(pendingControls(next)) ? next : s;
}
export function testNudge(s: ShotformSession): ShotformSession {
  if (!s.pending || complete(s)) return s;
  const next: ShotformSession = { ...s, previous: [...s.controls], controls: pendingControls(s), pending: null, tests: s.tests + 1 };
  if (complete(next)) { next.completed++; next.bestScore = Math.max(next.bestScore, score(next)); }
  return next;
}
export function undoNudge(s: ShotformSession): ShotformSession {
  if (!s.previous || complete(s)) return s;
  return { ...s, controls: [...s.previous], previous: null, pending: null };
}
export function nextShotformRound(s: ShotformSession): ShotformSession {
  if (!complete(s)) return s;
  const recentIds = s.recentSeeds.map((seed, i) => challengeFromSeed(seed, s.round - s.recentSeeds.length + 1 + i).id);
  const { challenge, seed: rng } = chooseChallenge(s.rng, s.round + 1, recentIds);
  return { ...s, rng, round: s.round + 1, challengeSeed: challenge.seed, recentSeeds: [...s.recentSeeds, challenge.seed].slice(-3), controls: [...challenge.start], previous: null, pending: null, tests: 0 };
}
const integer = (n: unknown, max = 1000000): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;
export function validateShotformSession(value: unknown): value is ShotformSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as ShotformSession;
  if (s.version !== 1 || s.engine !== SHOTFORM_ENGINE || !integer(s.rng, 4294967295) || !integer(s.challengeSeed, 4294967295) || !integer(s.round) || s.round < 1 || !validControls(s.controls) || !integer(s.tests) || !integer(s.completed) || !integer(s.bestScore, 100) || !Array.isArray(s.recentSeeds) || s.recentSeeds.length !== Math.min(3, s.round) || !s.recentSeeds.every(n => integer(n, 4294967295)) || s.recentSeeds.at(-1) !== s.challengeSeed || s.rng !== s.challengeSeed) return false;
  const history = s.recentSeeds.map((seed, i) => challengeFromSeed(seed, s.round - s.recentSeeds.length + 1 + i));
  if (history.some(c => c.minimum < 2 || c.minimum > 8) || new Set(history.map(c => c.id)).size !== history.length) return false;
  const challenge = currentChallenge(s), done = complete(s);
  if (s.completed !== s.round - 1 + Number(done) || (!s.completed && s.bestScore !== 0) || !attainableBestScores.has(s.bestScore) || (done && (s.tests < challenge.minimum || !s.previous || s.bestScore < score(s) || (s.round === 1 && s.bestScore !== score(s))))) return false;
  const distanceFromStart = s.controls.reduce((n, v, i) => n + Math.abs(v - challenge.start[i]), 0);
  if (distanceFromStart > s.tests || (s.previous === null && s.tests > 0 && distanceFromStart > s.tests - 1)) return false;
  if (s.previous !== null && (!validControls(s.previous) || s.tests < 1 || stable(measure(challenge, s.previous)) || s.previous.reduce((n, v, i) => n + Math.abs(v - s.controls[i]), 0) !== 1 || s.previous.reduce((n, v, i) => n + Math.abs(v - challenge.start[i]), 0) > s.tests - 1)) return false;
  if (s.pending !== null && (!s.pending || typeof s.pending !== "object" || ![0, 1, 2].includes(s.pending.axis) || ![-1, 1].includes(s.pending.direction) || done || !validControls(pendingControls(s)))) return false;
  return s.tests !== 0 || s.previous === null;
}
type GameStorage = Pick<Storage, "getItem" | "setItem">;
export function loadShotformSession(storage: () => GameStorage = () => window.localStorage) {
  try { const raw = storage().getItem(SHOTFORM_KEY); if (raw && raw.length <= 8000) { try { const s: unknown = JSON.parse(raw); if (validateShotformSession(s)) return { session: s, storageAvailable: true, restored: true }; } catch { /* recover below */ } } return { session: createShotformSession(), storageAvailable: true, restored: false }; }
  catch { return { session: createShotformSession(), storageAvailable: false, restored: false }; }
}
export function saveShotformSession(s: ShotformSession, storage: () => GameStorage = () => window.localStorage): boolean { try { storage().setItem(SHOTFORM_KEY, JSON.stringify(s)); return true; } catch { return false; } }
