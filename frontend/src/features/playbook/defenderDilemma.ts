import type { PlaybookArrow } from "./types.ts";

export type DefenderDilemmaChoice = "stay" | "tag" | "split";
export type DefenderDilemmaMilestone = "complete" | "catch" | "pass-release" | "screen-set" | "screen-use" | "screen-release";
export type DefenderDilemmaConfiguration = {
  defenderId: number;
  stayWithPlayerId: number;
  tagPlayerId: number;
  actionId: string;
  milestone: DefenderDilemmaMilestone;
};
export type DefenderDilemmaSetup = {
  defenderId: number | null; stayWithPlayerId: number | null; tagPlayerId: number | null;
  actionId: string; milestone: DefenderDilemmaMilestone | "";
};
export type DefenderDilemmaStatus = "waiting" | "committed" | "released" | "trigger-not-reached" | "release-not-reached";
export type DefenderDilemmaFrame = DefenderDilemmaConfiguration & {
  choice: DefenderDilemmaChoice;
  startedAtMs: number | null;
  releasedAtMs: number | null;
  status: DefenderDilemmaStatus;
};
export type DefenderDilemmaChoiceSummary = {
  choice: DefenderDilemmaChoice;
  status: "released" | "trigger-not-reached" | "release-not-reached";
  startedAtMs: number | null;
  releasedAtMs: number | null;
  durationMs: number;
  message: string;
};
export type DefenderDilemmaProgress = { completed: number; total: number; choice: DefenderDilemmaChoice; label: string };
export const DILEMMA_CHOICES: DefenderDilemmaChoice[] = ["stay", "tag", "split"];

const screenKinds = new Set<PlaybookArrow["kind"]>(["screen", "pick-roll", "pick-pop", "off-ball-screen", "pin-down", "slip-screen"]);

export function dilemmaReleaseMilestones(kind: PlaybookArrow["kind"]): Array<{ id: DefenderDilemmaMilestone; label: string }> {
  const milestones: Array<{ id: DefenderDilemmaMilestone; label: string }> = [{ id: "complete", label: "Action completes" }];
  if (kind === "pass" || kind === "handoff") milestones.push({ id: "pass-release", label: kind === "pass" ? "Pass is released" : "Handoff transfer is released" });
  if (kind === "pass" || kind === "handoff") milestones.push({ id: "catch", label: "Receiver confirms the catch" });
  if (screenKinds.has(kind) && kind !== "slip-screen") milestones.push({ id: "screen-set", label: "Screen is set" });
  if (screenKinds.has(kind) && kind !== "slip-screen") milestones.push({ id: "screen-use", label: "Screen is used" });
  if (screenKinds.has(kind)) milestones.push({ id: "screen-release", label: "Screen coverage is released" });
  return milestones;
}

export function dilemmaChoiceLabel(choice: DefenderDilemmaChoice, stayWithName: string, tagName: string) {
  if (choice === "stay") return `Stay with ${stayWithName}`;
  if (choice === "tag") return `Tag ${tagName}`;
  return "Split the difference";
}
