import { CheckCircle2, Clock3, Film, LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import { useRef } from "react";
import type { AnalysisQueueItem } from "../../domain/analysisTypes";

interface AnalysisQueueProps {
  items: AnalysisQueueItem[];
  compact?: boolean;
  onFiles: (files: File[]) => void;
  onSelectResult: (item: AnalysisQueueItem) => void;
}

const STATUS_LABEL: Record<AnalysisQueueItem["status"], string> = {
  queued: "Queued",
  processing: "Processing",
  done: "Complete",
  error: "Needs attention",
};

function StatusIcon({ status }: { status: AnalysisQueueItem["status"] }) {
  if (status === "processing") return <LoaderCircle className="spin" size={15} />;
  if (status === "done") return <CheckCircle2 size={15} />;
  if (status === "error") return <TriangleAlert size={15} />;
  return <Clock3 size={15} />;
}

export function AnalysisQueue({ items, compact = false, onFiles, onSelectResult }: AnalysisQueueProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const processing = items.filter((item) => item.status === "processing").length;
  const queued = items.filter((item) => item.status === "queued").length;
  const countLabel = processing
    ? `${processing} running${queued ? ` · ${queued} queued` : ""}`
    : queued
      ? `${queued} queued`
      : items.length
        ? `${items.length} saved`
        : "Empty";

  return (
    <aside className={`analysis-queue ${compact ? "analysis-queue-compact" : ""}`} aria-label="Analysis Queue">
      <div className="queue-topline">
        <div className="queue-heading">
          <div>
            <span className="section-kicker">Local workflow</span>
            <h2>Analysis Queue</h2>
          </div>
          <span className="queue-count">{countLabel}</span>
        </div>
        <button className="queue-add" type="button" onClick={() => inputRef.current?.click()}>
          <Plus size={16} /> Add videos
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mov,.m4v,.avi,.mkv,.webm,.wmv,.flv,.mpeg,.mpg,.3gp,.m2ts,.mts,.ts,.ogv,.asf"
        multiple
        onChange={(event) => {
          if (event.target.files?.length) onFiles(Array.from(event.target.files));
          event.currentTarget.value = "";
        }}
        tabIndex={-1}
        hidden
      />
      {items.length ? (
        <div className="queue-list">
          {items.map((item, index) => (
            <button
              className={`queue-item queue-${item.status}`}
              key={item.id}
              type="button"
              disabled={!item.result}
              onClick={() => onSelectResult(item)}
              title={item.result ? "Open this analysis" : item.error ?? STATUS_LABEL[item.status]}
              aria-busy={item.status === "processing"}
            >
              <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="queue-item-copy">
                <strong title={item.filename}>{item.filename}</strong>
                <span><StatusIcon status={item.status} />{item.status === "processing" && item.progress ? `${item.progress}% · ` : ""}{item.error ?? item.stage ?? STATUS_LABEL[item.status]}</span>
                {item.status === "processing" ? (
                  <span className="queue-progress" aria-label={`${item.progress}% complete`}>
                    <i style={{ width: `${Math.max(3, Math.min(98, item.progress))}%` }} />
                  </span>
                ) : null}
              </span>
              <span className="queue-status" aria-label={STATUS_LABEL[item.status]}><StatusIcon status={item.status} /></span>
            </button>
          ))}
        </div>
      ) : (
        <div className="queue-empty"><Film size={18} /><p>Choose an example or add a few clips. They will run in parallel when slots are available and stay available here.</p></div>
      )}
      <p className="queue-footnote">Up to 2 local workers · no cloud upload · completed analyses stay in this session.</p>
    </aside>
  );
}
