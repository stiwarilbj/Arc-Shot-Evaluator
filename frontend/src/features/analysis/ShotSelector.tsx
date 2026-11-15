import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AnalysisSession, ShotAnalysis } from "../../domain/analysisTypes";

interface ShotSelectorProps {
  session: AnalysisSession;
  selected: number;
  onSelect: (index: number) => void;
}

export function ShotSelector({ session, selected, onSelect }: ShotSelectorProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const selectedId = session.shots[selected]?.id;
  useEffect(() => {
    const list = listRef.current;
    const card = selectedRef.current;
    if (!list || !card) return;
    function revealSelection(list: HTMLDivElement, card: HTMLButtonElement) {
      const strip = list.getBoundingClientRect();
      const bounds = card.getBoundingClientRect();
      if (bounds.left < strip.left) list.scrollBy({ left: bounds.left - strip.left });
      else if (bounds.right > strip.right) list.scrollBy({ left: bounds.right - strip.right });
    }
    revealSelection(list, card);
    const resize = new ResizeObserver(() => revealSelection(list, card));
    resize.observe(list);
    return () => resize.disconnect();
  }, [selected, selectedId, session.session.id]);

  if (!session.shots.length) return null;
  return (
    <section className="shot-selector" aria-label="Shot attempts">
      <button className="icon-button" type="button" disabled={selected === 0} onClick={() => onSelect(Math.max(0, selected - 1))} aria-label="Previous shot"><ChevronLeft size={20} /></button>
      <div ref={listRef} className="shot-selector-list">
        {session.shots.map((shot: ShotAnalysis, index) => (
          <button
            key={shot.id}
            ref={selected === index ? selectedRef : undefined}
            aria-current={selected === index || undefined}
            type="button"
            className={`shot-option ${selected === index ? "is-selected" : ""}`}
            onClick={() => onSelect(index)}
          >
            {session.artifacts.thumbnails[index] ? (
              <img src={session.artifacts.thumbnails[index]} alt="" />
            ) : (
              <span className="shot-option-placeholder" aria-hidden="true">Manual</span>
            )}
            <span>{String(shot.id).padStart(2, "0")}</span>
            <strong className={`text-${shot.outcome}`}>{shot.outcome.toUpperCase()}</strong>
          </button>
        ))}
      </div>
      <button className="icon-button" type="button" disabled={selected >= session.shots.length - 1} onClick={() => onSelect(Math.min(session.shots.length - 1, selected + 1))} aria-label="Next shot"><ChevronRight size={20} /></button>
    </section>
  );
}
