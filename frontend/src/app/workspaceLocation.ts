export type AppWorkspace = "analyzer" | "playbook" | "counterlab" | "jumper";
export type AnalysisView = "overview" | "shot" | "tracking";
export type JumperView = "guess" | "create" | "clips";
export type WorkspaceLocation = {
  workspace: AppWorkspace;
  analysisView: AnalysisView;
  jumperView: JumperView;
};

export const DEFAULT_LOCATION: WorkspaceLocation = {
  workspace: "analyzer",
  analysisView: "shot",
  jumperView: "guess",
};

// Keep inactive views in memory while the fragment describes the visible view.
export function readWorkspaceHash(
  hash: string,
  current: WorkspaceLocation = DEFAULT_LOCATION,
): WorkspaceLocation {
  switch (hash) {
    case "#playbook":
      return { ...current, workspace: "playbook" };
    case "#counter-lab":
      return { ...current, workspace: "counterlab" };
    case "#jumper":
    case "#jumper/guess":
      return { ...current, workspace: "jumper", jumperView: "guess" };
    case "#jumper/create":
      return { ...current, workspace: "jumper", jumperView: "create" };
    case "#jumper/my-clips":
      return { ...current, workspace: "jumper", jumperView: "clips" };
    case "#shot-analyzer/overview":
      return { ...current, workspace: "analyzer", analysisView: "overview" };
    case "#shot-analyzer/tracking":
      return { ...current, workspace: "analyzer", analysisView: "tracking" };
    default:
      return { ...current, workspace: "analyzer", analysisView: "shot" };
  }
}

export function workspaceHash(value: WorkspaceLocation): string {
  if (value.workspace === "playbook") return "#playbook";
  if (value.workspace === "counterlab") return "#counter-lab";
  if (value.workspace === "jumper") {
    return value.jumperView === "guess"
      ? "#jumper"
      : value.jumperView === "clips"
        ? "#jumper/my-clips"
        : "#jumper/create";
  }
  return value.analysisView === "shot"
    ? "#shot-analyzer"
    : `#shot-analyzer/${value.analysisView}`;
}
