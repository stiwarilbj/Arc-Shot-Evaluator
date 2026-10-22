import type { CourtPoint, DefensiveBadge, OffensiveBadge, PlayerSkillRatings } from "./types.ts";

type Point = Readonly<CourtPoint>;
export type ShotCatchEvidence = Readonly<{
  atMs: number; actionId: string; sequence: number; giverId: number | null; kind: "pass" | "handoff";
  position: Point; receiverVelocityFtPerSecond: Point; nearestDefenderGapFeet: number | null;
}>;
export type ShotActionEvidence = Readonly<{
  actionId: string; sequence: number; kind: string; startedAtMs: number; completedAtMs: number | null;
}>;
/** All velocities use court feet/second, not SVG or normalized court units. */
export type ShotMotionEvidence = {
  atMs: number; shooterVelocityFtPerSecond: CourtPoint;
  defenderVelocities: Array<{ id: number; velocityFtPerSecond: CourtPoint }>;
  catch: ShotCatchEvidence | null; recentActions: ShotActionEvidence[];
};
export type ShotReleaseContext = Readonly<{
  version: 1; scale: "simulation-score"; atMs: number;
  shooter: Readonly<{ id: number; position: Point; velocityFtPerSecond: Point; speedFtPerSecond: number;
    skill: keyof PlayerSkillRatings; rating: number; badges: readonly OffensiveBadge[] }>;
  hoop: Point; distanceFeet: number; offBallQuality: number;
  catch: (ShotCatchEvidence & Readonly<{ elapsedMs: number; settled: boolean }>) | null;
  recentActions: readonly ShotActionEvidence[];
  defenders: readonly Readonly<{ id: number; position: Point; velocityFtPerSecond: Point; distanceFeet: number;
    directionToShooter: Point; approachSpeedFtPerSecond: number; relativeClosingSpeedFtPerSecond: number;
    goalSide: number; badgePressure: number; badges: readonly DefensiveBadge[] }>[];
  modifiers: readonly Readonly<{ key: string; points: number; evidence: Readonly<Record<string, string | number | boolean | null>> }>[];
  unclampedQuality: number; quality: number;
}>;

/** Reapply after structured cloning/checkpoint restoration; no live marker or
 * mutable execution object may be reachable from a released evaluation. */
export function freezeShotRelease<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeShotRelease(nested);
    Object.freeze(value);
  }
  return value;
}

export function validateShotRelease(value: unknown): asserts value is ShotReleaseContext {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const point = (v: unknown): v is CourtPoint => object(v) && finite(v.x) && finite(v.y);
  const id = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
  function check(valid: unknown): asserts valid { if (!valid) throw new Error("Invalid shot-release context"); }
  check(object(value)); const v = value;
  check(v.version === 1 && v.scale === "simulation-score" && finite(v.atMs) && v.atMs >= 0);
  check(object(v.shooter) && id(v.shooter.id) && point(v.shooter.position) && point(v.shooter.velocityFtPerSecond)
    && finite(v.shooter.speedFtPerSecond) && v.shooter.speedFtPerSecond >= 0
    && typeof v.shooter.skill === "string" && ["threePoint", "midrange", "finishing"].includes(v.shooter.skill)
    && finite(v.shooter.rating) && Number.isInteger(v.shooter.rating) && v.shooter.rating >= 1 && v.shooter.rating <= 5 && Array.isArray(v.shooter.badges));
  check(point(v.hoop) && finite(v.distanceFeet) && v.distanceFeet >= 0 && finite(v.offBallQuality));
  check(finite(v.quality) && Number.isInteger(v.quality) && v.quality >= 0 && v.quality <= 100 && finite(v.unclampedQuality));
  check(Array.isArray(v.defenders) && v.defenders.length <= 5);
  for (const d of v.defenders) check(object(d) && id(d.id) && point(d.position) && point(d.velocityFtPerSecond)
    && point(d.directionToShooter) && finite(d.distanceFeet) && d.distanceFeet >= 0 && finite(d.approachSpeedFtPerSecond)
    && finite(d.relativeClosingSpeedFtPerSecond) && finite(d.goalSide) && finite(d.badgePressure) && Array.isArray(d.badges));
  check(new Set(v.defenders.map(d => d.id)).size === v.defenders.length);
  check(Array.isArray(v.recentActions));
  for (const a of v.recentActions) check(object(a) && typeof a.actionId === "string" && id(a.sequence) && typeof a.kind === "string"
    && finite(a.startedAtMs) && a.startedAtMs <= v.atMs && (a.completedAtMs === null || finite(a.completedAtMs) && a.completedAtMs <= v.atMs));
  if (v.catch !== null) {
    const c = v.catch;
    check(object(c) && finite(c.atMs) && c.atMs <= v.atMs && typeof c.actionId === "string" && id(c.sequence)
      && (c.giverId === null || id(c.giverId)) && typeof c.kind === "string" && ["pass", "handoff"].includes(c.kind)
      && point(c.position) && point(c.receiverVelocityFtPerSecond) && (c.nearestDefenderGapFeet === null || finite(c.nearestDefenderGapFeet) && c.nearestDefenderGapFeet >= 0)
      && finite(c.elapsedMs) && c.elapsedMs >= 0 && typeof c.settled === "boolean");
    check(Math.abs(c.elapsedMs - (v.atMs - c.atMs)) <= 1e-6);
  }
  check(Array.isArray(v.modifiers) && v.modifiers.length > 0);
  for (const m of v.modifiers) {
    check(object(m) && typeof m.key === "string" && finite(m.points) && object(m.evidence));
    for (const evidence of Object.values(m.evidence)) check(evidence === null || typeof evidence === "string" || typeof evidence === "boolean" || finite(evidence));
  }
  check(new Set(v.modifiers.map(m => m.key)).size === v.modifiers.length);
  check(Math.abs(v.modifiers.reduce((sum, m) => sum + m.points, 0) - v.quality) < 1e-7);
  check(Math.abs(Math.hypot(v.shooter.velocityFtPerSecond.x, v.shooter.velocityFtPerSecond.y) - v.shooter.speedFtPerSecond) < 1e-7);
}
