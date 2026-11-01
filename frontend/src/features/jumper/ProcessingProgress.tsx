import { useEffect, useState } from "react";
import type { JobProgress } from "./domain";
import { ProcessingEstimate } from "./processingEstimate";

export default function ProcessingProgress({
  progress,
  busy,
}: {
  progress: JobProgress;
  busy: boolean;
}) {
  const [estimate] = useState(() => new ProcessingEstimate());
  const [hint, setHint] = useState("");
  useEffect(() => {
    if (!busy) {
      setHint("");
      return;
    }
    estimate.update(progress, performance.now());
    const refresh = () => setHint(estimate.hint(performance.now()));
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [progress, busy, estimate]);
  return (
    <div className="jumper-progress">
      <span role="status">{progress.stage}</span>
      <progress
        aria-label={progress.stage}
        max="1"
        value={
          busy && (progress.progress === 0 || /Finalizing/.test(progress.stage))
            ? undefined
            : Math.max(0, Math.min(1, progress.progress))
        }
      />
      {busy && hint ? (
        <small className="jumper-progress-hint" role="status">
          {hint}
        </small>
      ) : null}
    </div>
  );
}
