import { ROUND_SETUPS, SWISH_ENGINE, randomStep, simulateShot, validControls, varyControls, type ShotControls, type ShotOutcome } from "./swishPhysics.ts";

export const SWISH_STORAGE_KEY = "arc-swish-tuner-v1";
export type SwishSession = {
  version: 1; engine: typeof SWISH_ENGINE; seed: number; round: number; setupIndex: number;
  recent: number[]; controls: ShotControls; attempts: number; makes: number; completed: number;
  totalScore: number; lastShot: { controls: ShotControls; outcome: ShotOutcome } | null;
};
export type SwishStorage = Pick<Storage, "getItem" | "setItem">;
export const roundScore = (attempts: number) => attempts >= 3 ? Math.min(100, Math.round(300 / attempts)) : 0;
export function createSwishSession(seed = Math.floor(Math.random() * 4294967296)): SwishSession {
  return { version: 1, engine: SWISH_ENGINE, seed: seed >>> 0, round: 1, setupIndex: 0, recent: [0], controls: { angle: 52, power: 35, spin: 2 }, attempts: 0, makes: 0, completed: 0, totalScore: 0, lastShot: null };
}
export function shoot(session: SwishSession) {
  if (session.makes >= 3) return { session, flight: null };
  const varied = varyControls(session.controls, session.seed);
  const flight = simulateShot(varied.controls, ROUND_SETUPS[session.setupIndex]);
  const makes = session.makes + (flight.outcome === "Swish" ? 1 : 0), attempts = session.attempts + 1;
  const complete = makes === 3;
  return { flight, session: { ...session, seed: varied.seed, makes, attempts,
    completed: session.completed + (complete ? 1 : 0), totalScore: session.totalScore + (complete ? roundScore(attempts) : 0),
    lastShot: { controls: varied.controls, outcome: flight.outcome },
  } };
}
export function nextSwishRound(session: SwishSession): SwishSession {
  if (session.makes < 3) return session;
  const [seed, random] = randomStep(session.seed);
  const maximum = session.round < 3 ? 3 : session.round < 6 ? 7 : ROUND_SETUPS.length;
  const available = Array.from({ length: maximum }, (_, i) => i).filter(i => !session.recent.slice(-3).includes(i));
  const choices = available.length ? available : Array.from({ length: maximum }, (_, i) => i).filter(i => i !== session.setupIndex);
  const setupIndex = choices[Math.floor(random * choices.length)];
  return { ...session, seed, round: session.round + 1, setupIndex, recent: [...session.recent, setupIndex].slice(-3), attempts: 0, makes: 0, lastShot: null };
}
const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
function setupLimitForRound(round: number): number {
  // nextSwishRound chooses the next round's setup using the difficulty of
  // the round just completed, so the unlocked ranges lag the displayed round
  return round <= 3 ? 3 : round <= 6 ? 7 : ROUND_SETUPS.length;
}
export function validateSwishSession(value: unknown): value is SwishSession {
  if (!value || typeof value !== "object") return false;
  const s = value as SwishSession;
  if (s.version !== 1 || s.engine !== SWISH_ENGINE || !integer(s.seed, 4294967295) || !integer(s.round, 1000000) || s.round < 1 ||
      !integer(s.setupIndex, ROUND_SETUPS.length - 1) || !validControls(s.controls) || !integer(s.attempts, 1000000) || !integer(s.makes, 3) || s.makes > s.attempts ||
      !integer(s.completed) || s.completed !== s.round - (s.makes === 3 ? 0 : 1) || !integer(s.totalScore, s.completed * 100) ||
      s.setupIndex >= setupLimitForRound(s.round) || (s.round === 1 && s.setupIndex !== 0) ||
      !Array.isArray(s.recent) || s.recent.length !== Math.min(s.round, 3) ||
      !s.recent.every(n => integer(n, ROUND_SETUPS.length - 1)) || new Set(s.recent).size !== s.recent.length || s.recent.at(-1) !== s.setupIndex) return false;
  if (s.lastShot === null) return s.attempts === 0 && s.makes === 0;
  if (!s.lastShot || !validControls(s.lastShot.controls) || s.attempts < 1) return false;
  // A miss is itself an attempt, so earlier attempts must account for all current makes
  if (s.lastShot.outcome !== "Swish" && s.makes >= s.attempts) return false;
  if ((s.makes === 0 && s.lastShot.outcome === "Swish") || (s.makes === 3 && s.lastShot.outcome !== "Swish")) return false;
  if (s.makes === 3 && (s.totalScore < roundScore(s.attempts) || s.totalScore > (s.completed - 1) * 100 + roundScore(s.attempts))) return false;
  return simulateShot(s.lastShot.controls, ROUND_SETUPS[s.setupIndex]).outcome === s.lastShot.outcome;
}
export function loadSwishSession(storage: () => SwishStorage = () => window.localStorage): { session: SwishSession; storageAvailable: boolean } {
  try {
    const raw = storage().getItem(SWISH_STORAGE_KEY);
    if (raw && raw.length <= 16000) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (validateSwishSession(parsed)) return { session: parsed, storageAvailable: true };
      } catch { /* Damaged progress must never prevent practice */ }
    }
    return { session: createSwishSession(), storageAvailable: true };
  } catch { return { session: createSwishSession(), storageAvailable: false }; }
}
export function saveSwishSession(session: SwishSession, storage: () => SwishStorage = () => window.localStorage): boolean {
  try { storage().setItem(SWISH_STORAGE_KEY, JSON.stringify(session)); return true; }
  catch { return false; }
}
