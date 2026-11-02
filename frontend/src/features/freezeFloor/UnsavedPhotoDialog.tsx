import { useEffect, useRef } from "react";

export function UnsavedPhotoDialog({
  target, saving, error, onSave, onDiscard, onCancel,
}: {
  target: string;
  saving: boolean;
  error: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="ff-unsaved-dialog"
      aria-labelledby="ff-unsaved-title"
      aria-describedby="ff-unsaved-description"
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
    >
      <h2 id="ff-unsaved-title">Keep your corrections?</h2>
      <p id="ff-unsaved-description">
        This photograph has unsaved changes · Save them before opening <strong>{target}</strong>,
        discard them, or cancel to keep editing
      </p>
      {error ? <p className="ff-error" role="alert">{error}</p> : null}
      <div className="ff-unsaved-actions">
        <button className="ff-primary" disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onDiscard}>Discard</button>
        <button ref={cancel} onClick={onCancel}>Cancel</button>
      </div>
    </dialog>
  );
}
