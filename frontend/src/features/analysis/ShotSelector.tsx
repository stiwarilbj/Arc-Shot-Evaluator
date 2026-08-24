import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AnalysisSession, ShotAnalysis } from "../../domain/analysisTypes";

interface ShotSelectorProps {
  session: AnalysisSession;
  selected: number;
  onSelect: (index: number) => void;
}

export function ShotSelector({ session, selected, onSelect }: ShotSelectorProps) {
  if (!session.shots.length) return null;
  return (
    <section className="shot-selector" aria-label="Shot attempts">
      <button className="icon-button" type="button" disabled={selected === 0} onClick={() => onSelect(Math.max(0, selected - 1))} aria-label="Previous shot"><ChevronLeft size={20} /></button>
      <div className="shot-selector-list">
        {session.shots.map((shot: ShotAnalysis, index) => (
          <button
            key={shot.id}
            type="button"
            className={`shot-option ${selected === index ? "is-selected" : ""}`}
            onClick={() => onSelect(index)}
          >
            <img src={session.artifacts.thumbnails[index]} alt="" />
            <span>{String(shot.id).padStart(2, "0")}</span>
            <strong className={`text-${shot.outcome}`}>{shot.outcome.toUpperCase()}</strong>
          </button>
        ))}
      </div>
      <button className="icon-button" type="button" disabled={selected >= session.shots.length - 1} onClick={() => onSelect(Math.min(session.shots.length - 1, selected + 1))} aria-label="Next shot"><ChevronRight size={20} /></button>
    </section>
  );
}
