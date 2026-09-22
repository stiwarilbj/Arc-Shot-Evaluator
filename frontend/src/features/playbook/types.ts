export type PlaybookTool = "select" | "player" | "ball" | "movement" | "pass" | "screen" | "handoff" | "pick-roll" | "delete";
export type ArrowKind = "movement" | "pass" | "screen" | "handoff" | "pick-roll";
export type ArrowPath = "straight" | "curve";
export type OffenseOffBallStyle = "off" | "spacing" | "cuts" | "read-react";
export type DefenseOffBallStyle = "off" | "contain" | "help" | "switch" | "trap-rotate";

export interface SimulationSettings {
  offenseOffBall: OffenseOffBallStyle;
  defenseOffBall: DefenseOffBallStyle;
  offBallIntensity: number;
}

export const DEFAULT_SIMULATION_SETTINGS: SimulationSettings = {
  offenseOffBall: "read-react",
  defenseOffBall: "help",
  offBallIntensity: 68,
};

export interface CourtPoint {
  x: number;
  y: number;
}

export interface PlaybookMarker extends CourtPoint {
  id: number;
}

export interface PlaybookArrow {
  id: string;
  kind: ArrowKind;
  start: CourtPoint;
  end: CourtPoint;
  /** 1-based order in which this action happens during a simulation. */
  sequence?: number;
  /** How the actor travels between the endpoints in the simulation. */
  path?: ArrowPath;
  /** Optional quadratic control point for a curved route. */
  control?: CourtPoint;
  /** Time in seconds reserved for this action. */
  timing?: number;
}

export interface PlaybookDocument {
  version: 1;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  defenders_visible: boolean;
  players: PlaybookMarker[];
  defenders: PlaybookMarker[];
  ball: CourtPoint | null;
  arrows: PlaybookArrow[];
}

export type PlaybookDraft = Omit<PlaybookDocument, "id" | "created_at" | "updated_at"> & {
  id: string;
  created_at?: string;
  updated_at?: string;
};

export const COURT_WIDTH = 1000;
export const COURT_HEIGHT = 720;

export function clonePlaybook(playbook: PlaybookDocument | PlaybookDraft): PlaybookDraft {
  return structuredClone(playbook);
}

export function pointDistance(a: CourtPoint, b: CourtPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
