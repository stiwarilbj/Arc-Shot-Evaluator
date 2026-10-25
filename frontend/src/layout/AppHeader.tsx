import { useRef, useState } from "react";
import {
  ChevronDown,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  FlaskConical,
  Moon,
  RotateCw,
  Sun,
} from "lucide-react";
import type { ThemeMode } from "../domain/analysisTypes";
import { UsageGuide } from "./UsageGuide";
import type { AppWorkspace } from "../app/workspaceLocation";

interface AppHeaderProps {
  filename?: string;
  complete: boolean;
  showReset?: boolean;
  onReset: () => void;
  onHome?: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  workspace?: AppWorkspace;
  onWorkspaceChange?: (workspace: AppWorkspace) => void;
}

export function AppHeader({
  filename,
  complete,
  showReset = false,
  onReset,
  onHome,
  theme,
  onThemeChange,
  workspace = "analyzer",
  onWorkspaceChange,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <button
        className="brand-lockup"
        type="button"
        onClick={onHome ?? onReset}
        aria-label="Go to ARCade Hoops home"
      >
        <div className="brand-mark" aria-label="ARC">
          ARC
        </div>
        <span className="brand-placeholder" aria-hidden="true">Online Shot Analysis</span>
      </button>
      {onWorkspaceChange ? (
        <nav className="workspace-nav" aria-label="ARCade Hoops workspaces">
          <button
            type="button"
            className={workspace === "analyzer" ? "is-active" : ""}
            aria-current={workspace === "analyzer" ? "page" : undefined}
            onClick={() => onWorkspaceChange("analyzer")}
          >
            <CircleDot size={15} /> Shot Analyzer
          </button>
          <button
            type="button"
            className={workspace === "playbook" ? "is-active" : ""}
            aria-current={workspace === "playbook" ? "page" : undefined}
            onClick={() => onWorkspaceChange("playbook")}
          >
            <ClipboardList size={15} /> Playbook
          </button>
          <button
            type="button"
            className={workspace === "counterlab" ? "is-active" : ""}
            aria-current={workspace === "counterlab" ? "page" : undefined}
            onClick={() => onWorkspaceChange("counterlab")}
          >
            <FlaskConical size={15} /> Counter Lab
          </button>
          <WorkspaceMenu label="Games" id="games-workspace-menu" active={workspace === "boxscore"} onSelect={() => onWorkspaceChange("boxscore")} item="Box-Score Error Hunt" />
          <WorkspaceMenu label="Others" id="others-workspace-menu" active={workspace === "jumper"} onSelect={() => onWorkspaceChange("jumper")} item="Guess the Jumper" />
        </nav>
      ) : null}
      {filename ? (
        <div className="header-filename" title={filename}>
          {filename}
        </div>
      ) : (
        <div />
      )}
      <div className="header-actions">
        <UsageGuide />
        <div className="theme-switch" role="group" aria-label="Color theme">
          <button
            className={theme === "dark" ? "is-active" : ""}
            type="button"
            aria-label="Dark"
            aria-pressed={theme === "dark"}
            onClick={() => onThemeChange("dark")}
          >
            <Moon aria-hidden="true" size={14} />
            <span>Dark</span>
          </button>
          <button
            className={theme === "light" ? "is-active" : ""}
            type="button"
            aria-label="Light"
            aria-pressed={theme === "light"}
            onClick={() => onThemeChange("light")}
          >
            <Sun aria-hidden="true" size={14} />
            <span>Light</span>
          </button>
        </div>
        {complete ? (
          <div className="complete-state">
            <CheckCircle2 aria-hidden="true" size={18} />
            <span>Analysis complete</span>
          </div>
        ) : null}
        {complete || showReset ? (
          <button
            className="button button-outline"
            type="button"
            onClick={onReset}
          >
            <RotateCw aria-hidden="true" size={17} />
            Analyze another
          </button>
        ) : null}
      </div>
    </header>
  );
}

function WorkspaceMenu({ label, id, active, item, onSelect }: {
  label: string;
  id: string;
  active: boolean;
  item: string;
  onSelect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const suppressFocus = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="workspace-others"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          suppressFocus.current = true;
          setOpen(false);
          button.current?.focus();
          suppressFocus.current = false;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setOpen(true);
          const container = event.currentTarget;
          setTimeout(() => container.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus(), 0);
        }
      }}
    >
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        className={active ? "is-active" : ""}
        onFocus={() => { if (!suppressFocus.current) setOpen(true); }}
        onClick={() => setOpen(true)}
      >
        {label} <ChevronDown size={14} />
      </button>
      <div className="workspace-others-menu" id={id} role="menu" hidden={!open}>
        <button type="button" role="menuitem" onClick={() => { onSelect(); setOpen(false); }}>
          {item}
        </button>
      </div>
    </div>
  );
}
