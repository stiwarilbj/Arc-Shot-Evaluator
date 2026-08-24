import { CheckCircle2, Moon, RotateCw, Sun } from "lucide-react";
import type { ThemeMode } from "../domain/analysisTypes";

interface AppHeaderProps {
  filename?: string;
  complete: boolean;
  showReset?: boolean;
  onReset: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}

export function AppHeader({ filename, complete, showReset = false, onReset, theme, onThemeChange }: AppHeaderProps) {
  return (
    <header className="app-header">
      <button className="brand-lockup" type="button" onClick={onReset} aria-label="Go to ARC home">
        <div className="brand-mark" aria-label="ARC">
          ARC
        </div>
        <span>Local Shot Analysis</span>
      </button>
      {filename ? <div className="header-filename" title={filename}>{filename}</div> : <div />}
      <div className="header-actions">
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
          <button className="button button-outline" type="button" onClick={onReset}>
            <RotateCw aria-hidden="true" size={17} />
            Analyze another
          </button>
        ) : null}
      </div>
    </header>
  );
}
