export type PlaybookTool = "select" | "player" | "ball" | "movement" | "pass" | "delete";
export type ArrowKind = "movement" | "pass";

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
