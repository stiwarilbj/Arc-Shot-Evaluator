import { useCallback, useEffect, useRef, useState } from "react";
import {
  readWorkspaceHash,
  workspaceHash,
  type WorkspaceLocation,
  type AppWorkspace,
  type AnalysisView,
  type JumperView,
  type PlaybookView,
} from "./workspaceLocation";

export function useWorkspaceNavigation() {
  const [location, setLocation] = useState(() =>
    readWorkspaceHash(
      typeof window === "undefined" ? "" : window.location.hash,
    ),
  );
  const current = useRef(location);
  const update = useCallback((next: WorkspaceLocation) => {
    if (
      next.workspace === current.current.workspace &&
      next.analysisView === current.current.analysisView &&
      next.jumperView === current.current.jumperView &&
      next.playbookView === current.current.playbookView &&
      next.rolePlayerId === current.current.rolePlayerId
    )
      return;
    current.current = next;
    setLocation(next);
  }, []);

  useEffect(() => {
    function read() {
      const next = readWorkspaceHash(window.location.hash, current.current);
      const hash = workspaceHash(next);
      if (window.location.hash !== hash)
        window.history.replaceState(window.history.state, "", hash);
      update(next);
    }
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    read();
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, [update]);

  useEffect(() => {
    const titles: Record<AppWorkspace, string> = {
      home: "Basketball tools & games",
      analyzer: "Shot Analyzer",
      playbook: location.playbookView === "practice" ? "Practice reads · Playbook" : location.playbookView === "role" ? "My Role · Playbook" : location.playbookView === "flipbook" ? "Play Flipbook · Playbook" : "Playbook",
      counterlab: "Counter Lab",
      boxscore: "Box-Score Error Hunt · Games",
      jumper:
        location.jumperView === "create"
          ? "Create · Guess the Jumper"
          : location.jumperView === "clips"
            ? "My Clips · Guess the Jumper"
            : "Guess the Jumper",
    };
    document.title = `ARCade Hoops · ${titles[location.workspace]}`;
  }, [location.workspace, location.jumperView, location.playbookView]);

  const navigate = useCallback(
    (patch: Partial<WorkspaceLocation>) => {
      const next = { ...current.current, ...patch };
      const hash = workspaceHash(next);
      // pushState changes only the fragment, without scrolling or reloading the app.
      if (window.location.hash !== hash)
        window.history.pushState(window.history.state, "", hash);
      update(next);
    },
    [update],
  );

  return {
    ...location,
    changeWorkspace: (workspace: AppWorkspace) => navigate({ workspace }),
    changeAnalysisView: (analysisView: AnalysisView) =>
      navigate({ analysisView }),
    changeJumperView: (jumperView: JumperView) => navigate({ jumperView }),
    changePlaybookView: (playbookView: PlaybookView, rolePlayerId: number | null = null) => navigate({ playbookView, rolePlayerId }),
  };
}
