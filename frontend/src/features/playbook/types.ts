export type PlaybookTool = "select" | "player" | "ball" | "movement" | "pass" | "screen" | "handoff" | "pick-roll" | "pick-pop" | "off-ball-screen" | "pin-down" | "backdoor-cut" | "delete";
export type ArrowKind = "movement" | "pass" | "screen" | "handoff" | "pick-roll" | "pick-pop" | "off-ball-screen" | "pin-down" | "backdoor-cut";
export type ArrowPath = "straight" | "curve";
export type OffenseOffBallStyle = "off" | "spacing" | "cuts" | "read-react";
export type DefenseStrategy = "off" | "contain" | "help" | "switch" | "trap-rotate" | "fight-over" | "go-under" | "drop" | "hedge" | "deny-lanes" | "protect-paint";

export interface AutomaticActionSettings {
  screen: boolean;
  handoff: boolean;
  pickRoll: boolean;
  offBallScreen: boolean;
}

export interface SimulationSettings {
  offenseOffBall: OffenseOffBallStyle;
  defenseStrategy: DefenseStrategy;
  offBallIntensity: number;
  automaticActions: AutomaticActionSettings;
}

export const DEFAULT_SIMULATION_SETTINGS: SimulationSettings = {
  offenseOffBall: "read-react",
  defenseStrategy: "help",
  offBallIntensity: 70,
  automaticActions: { screen: true, handoff: true, pickRoll: true, offBallScreen: true },
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
  /** Player who sets an off-ball screen. */
  screener_id?: number;
  /** Player who uses an off-ball screen. */
  cutter_id?: number;
  /** Ball handler for a named on-ball screen. */
  handler_id?: number;
  /** Actor for a named cut. */
  actor_id?: number;
  /** Destination after a pick-and-pop or pin-down screen. */
  exit_target?: CourtPoint;
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

export { COURT_HEIGHT, COURT_WIDTH } from "./courtGeometry";
import { COURT_HEIGHT, COURT_WIDTH } from "./courtGeometry";

export function clonePlaybook(playbook: PlaybookDocument | PlaybookDraft): PlaybookDraft {
  return structuredClone(playbook);
}

export function pointDistance(a: CourtPoint, b: CourtPoint) {
  return Math.hypot(a.x - b.x, ((a.y - b.y) * COURT_HEIGHT) / COURT_WIDTH);
}
