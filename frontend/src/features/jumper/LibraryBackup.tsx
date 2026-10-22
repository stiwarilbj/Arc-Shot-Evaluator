import { useRef, useState } from "react";
import { Download, Upload, Archive } from "lucide-react";
import type { LoadedBackup } from "./backupArchive";

export function LibraryBackup({
  onRestored,
}: {
  onRestored: () => Promise<void>;
}) {
  const [includeHistory, setIncludeHistory] = useState(false);
  const [restoreHistory, setRestoreHistory] = useState(true);
  const [pending, setPending] = useState<LoadedBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await work();
    } catch (caught) {
      setStatus("");
      setError(
        caught instanceof Error
          ? caught.message
          : "Backup operation failed. Your existing library was kept",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function download() {
    await run(async () => {
      setStatus("Reading your private library");
      const { exportLibrary } = await import("./backupService");
      const blob = await exportLibrary(includeHistory, setStatus);
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `arc-jumper-library-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus(
        "Backup download started. Keep the ZIP somewhere safe; it contains your private videos",
      );
    });
  }
  async function choose(file: File) {
    setPending(null);
    await run(async () => {
      setStatus("Checking backup files");
      const { inspectLibraryBackup } = await import("./backupService");
      const backup = await inspectLibraryBackup(file, setStatus);
      setPending(backup);
      setRestoreHistory(true);
      setStatus("Backup verified. Review the contents below before restoring");
    });
  }
  async function restore() {
    if (!pending) return;
    await run(async () => {
      const { restoreLibrary } = await import("./backupService");
      const result = await restoreLibrary(
        pending,
        restoreHistory,
        setStatus,
      ).finally(onRestored);
      setPending(null);
      setStatus(
        `Restored ${result.added} clip${result.added === 1 ? "" : "s"}; skipped ${result.skipped} existing. ${result.conflicts} conflicting clip${result.conflicts === 1 ? "" : "s"} kept as separate copies. ${result.historyAdded} answers restored; ${result.historySkipped} existing answers kept`,
      );
    });
  }
  return (
    <details className="jumper-panel jumper-backup">
      <summary>
        <Archive size={18} aria-hidden="true" /> Back up or restore library
      </summary>
      <p>
        Move your personal clips between devices or protect them before clearing
        browser data. One private ZIP contains finished videos, masked bases,
        edit recipes, player labels, and quiz eligibility. No account or cloud
        upload
      </p>
      <div className="jumper-toolbar">
        <label>
          <input
            type="checkbox"
            checked={includeHistory}
            disabled={busy}
            onChange={(e) => setIncludeHistory(e.target.checked)}
          />{" "}
          Include guessing history in backup
        </label>
        <div className="jumper-backup-actions">
          <button
            type="button"
            className="button button-outline"
            disabled={busy}
            onClick={download}
          >
            <Download size={16} /> Download backup
          </button>
          <button
            type="button"
            className="button button-outline"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Upload size={16} /> Choose backup ZIP
          </button>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            aria-label="Choose library backup ZIP"
            hidden
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void choose(file);
            }}
          />
        </div>
      </div>
      <p className="jumper-caption">
        ARCade Hoops backups only · Up to 512 MiB and 1,000 clips. Original
        uploads, tracking data, and models are excluded. Older clips retain
        their legacy status
      </p>
      {status ? (
        <p role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="jumper-notice">
          {error}
        </p>
      ) : null}
      {pending ? (
        <div className="jumper-backup-preview">
          <h3>Ready to restore</h3>
          <p>
            {pending.manifest.clips.length} personal clips ·{" "}
            {pending.manifest.history?.length ?? 0} saved answers · Backup from{" "}
            {new Date(pending.manifest.createdAt).toLocaleDateString()}
          </p>
          <p>
            Identical clips are skipped. Conflicting IDs become separate copies.
            Existing videos, labels, and answers are never overwritten
          </p>
          {pending.manifest.history?.length ? (
            <label>
              <input
                type="checkbox"
                checked={restoreHistory}
                disabled={busy}
                onChange={(e) => setRestoreHistory(e.target.checked)}
              />{" "}
              Restore guessing history
            </label>
          ) : null}
          <div className="jumper-backup-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={restore}
            >
              Restore backup
            </button>
            <button
              type="button"
              className="button button-outline"
              disabled={busy}
              onClick={() => {
                setPending(null);
                setStatus("");
                setError("");
              }}
            >
              Cancel restore
            </button>
          </div>
        </div>
      ) : null}
    </details>
  );
}
