export type AppWorkspace =
  | "home"
  | "analyzer"
  | "playbook"
  | "counterlab"
  | "jumper";
export type AnalysisView = "overview" | "shot" | "tracking";
export type JumperView = "guess" | "create" | "clips";
export type PlaybookView = "edit" | "practice" | "role" | "flipbook";
export type WorkspaceLocation = {
  workspace: AppWorkspace;
  analysisView: AnalysisView;
  jumperView: JumperView;
  playbookView: PlaybookView;
  rolePlayerId: number | null;
};

export const DEFAULT_LOCATION: WorkspaceLocation = {
  workspace: "home",
  analysisView: "shot",
  jumperView: "guess",
  playbookView: "edit",
  rolePlayerId: null,
};

// Keep inactive views in memory while the fragment describes the visible view.
export function readWorkspaceHash(
  hash: string,
  current: WorkspaceLocation = DEFAULT_LOCATION,
): WorkspaceLocation {
  switch (hash) {
    case "#shot-analyzer":
      return { ...current, workspace: "analyzer", analysisView: "shot" };
    case "#playbook":
      return { ...current, workspace: "playbook", playbookView: "edit" };
    case "#playbook/practice":
      return { ...current, workspace: "playbook", playbookView: "practice", rolePlayerId: null };
    case "#playbook/flipbook":
      return { ...current, workspace: "playbook", playbookView: "flipbook", rolePlayerId: null };
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
    default: {
      const roleMatch = /^#playbook\/role\/(\d+)$/.exec(hash);
      if (roleMatch) {
        const rolePlayerId = Number(roleMatch[1]);
        if (Number.isSafeInteger(rolePlayerId) && rolePlayerId > 0) return { ...current, workspace: "playbook", playbookView: "role", rolePlayerId };
      }
      return { ...current, workspace: "home" };
    }
  }
}

export function workspaceHash(value: WorkspaceLocation): string {
  if (value.workspace === "home") return "#home";
  if (value.workspace === "playbook") return value.playbookView === "practice" ? "#playbook/practice" : value.playbookView === "flipbook" ? "#playbook/flipbook" : value.playbookView === "role" && value.rolePlayerId ? `#playbook/role/${value.rolePlayerId}` : "#playbook";
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
