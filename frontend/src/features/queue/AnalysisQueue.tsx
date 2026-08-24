import {
  CheckCircle2,
  CircleStop,
  Clock3,
  Eye,
  EyeOff,
  Film,
  LoaderCircle,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useRef } from "react";
import type { AnalysisQueueItem } from "../../domain/analysisTypes";

interface AnalysisQueueProps {
  items: AnalysisQueueItem[];
  compact?: boolean;
  hiddenIds: Set<string>;
  onFiles: (files: File[]) => void;
  onSelectResult: (item: AnalysisQueueItem) => void;
  onClear: () => void;
  onCancel: (item: AnalysisQueueItem) => void;
  onDelete: (item: AnalysisQueueItem) => void;
  onHide: (item: AnalysisQueueItem) => void;
  onShowHidden: () => void;
}

const STATUS_LABEL: Record<AnalysisQueueItem["status"], string> = {
  queued: "Queued",
  processing: "Processing",
  done: "Complete",
  error: "Needs attention",
  cancelled: "Stopped",
};

function StatusIcon({ status }: { status: AnalysisQueueItem["status"] }) {
  if (status === "processing") return <LoaderCircle className="spin" size={15} />;
  if (status === "done") return <CheckCircle2 size={15} />;
  if (status === "error") return <TriangleAlert size={15} />;
  if (status === "cancelled") return <CircleStop size={15} />;
  return <Clock3 size={15} />;
}

export function AnalysisQueue({
  items,
  compact = false,
  hiddenIds,
  onFiles,
  onSelectResult,
  onClear,
  onCancel,
  onDelete,
  onHide,
  onShowHidden,
}: AnalysisQueueProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const processing = items.filter((item) => item.status === "processing").length;
  const queued = items.filter((item) => item.status === "queued").length;
  const hiddenCount = items.filter((item) => item.status !== "processing" && hiddenIds.has(item.id)).length;
  const visibleItems = items.filter((item) => item.status === "processing" || !hiddenIds.has(item.id));
  const clearable = items.some((item) => item.status !== "processing");
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
        <div className="queue-actions">
          <button className="queue-add" type="button" onClick={() => inputRef.current?.click()}>
            <Plus size={16} /> Add videos
          </button>
          <button
            className="queue-clear"
            type="button"
            onClick={onClear}
            disabled={!clearable}
            title={clearable ? "Remove waiting, stopped, failed, and completed videos" : "Nothing to clear"}
          >
            <Trash2 size={14} /> Clear queue
          </button>
          {hiddenCount ? (
            <button className="queue-show-hidden" type="button" onClick={onShowHidden} title="Show hidden queue videos">
              <Eye size={14} /> Show {hiddenCount} hidden
            </button>
          ) : null}
        </div>
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
      {visibleItems.length ? (
        <div className="queue-list">
          {visibleItems.map((item, index) => (
            <div className={`queue-row queue-${item.status}`} key={item.id}>
              <button
                className="queue-item"
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
              <div className="queue-item-actions">
                {item.status === "processing" ? (
                  <button className="queue-action queue-stop" type="button" onClick={() => onCancel(item)} title="Stop this analysis" aria-label={`Stop ${item.filename}`}>
                    <CircleStop size={14} />
                  </button>
                ) : (
                  <button className="queue-action" type="button" onClick={() => onHide(item)} title="Hide this video" aria-label={`Hide ${item.filename}`}>
                    <EyeOff size={14} />
                  </button>
                )}
                <button className="queue-action queue-delete" type="button" onClick={() => onDelete(item)} title="Remove this video" aria-label={`Remove ${item.filename}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : items.length ? (
        <div className="queue-hidden-empty">
          <EyeOff size={16} />
          <span>Queue videos are hidden.</span>
          <button type="button" onClick={onShowHidden}>Unhide</button>
        </div>
      ) : (
        <div className="queue-empty"><Film size={18} /><p>Choose an example or add a few clips. They will run in parallel when slots are available and stay available here.</p></div>
      )}
      <p className="queue-footnote">Up to 2 local workers · no cloud upload · completed analyses stay in this session.</p>
    </aside>
  );
}
