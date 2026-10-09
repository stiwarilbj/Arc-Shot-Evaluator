import { useRef, useState, type KeyboardEvent } from "react";
import { Film, ScanLine, Upload } from "lucide-react";
import { PROCESSING_MODE_OPTIONS } from "../../domain/analysisModes";
import type { ProcessingMode, ShotMode } from "../../domain/analysisTypes";

interface VideoUploadProps {
  error: string | null;
  onFiles: (files: File[]) => void;
  processingMode: ProcessingMode;
  onProcessingModeChange: (mode: ProcessingMode) => void;
  shotMode: ShotMode;
  onShotModeChange: (mode: ShotMode) => void;
}

const VIDEO_TYPES = [
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".flv",
  ".mpeg", ".mpg", ".3gp", ".m2ts", ".mts", ".ts", ".ogv", ".asf",
];

export function VideoUpload({ error, onFiles, processingMode, onProcessingModeChange, shotMode, onShotModeChange }: VideoUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const depthOptionsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const [dragging, setDragging] = useState(false);

  function handleDepthKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (index + 1) % PROCESSING_MODE_OPTIONS.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index - 1 + PROCESSING_MODE_OPTIONS.length) % PROCESSING_MODE_OPTIONS.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? PROCESSING_MODE_OPTIONS.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const option = PROCESSING_MODE_OPTIONS[nextIndex];
    onProcessingModeChange(option.value);
    depthOptionsRef.current[nextIndex]?.focus();
  }

  function accept(files: FileList | File[] | undefined) {
    if (files?.length) onFiles(Array.from(files));
  }

  return (
    <main className="video-upload">
      <section className="upload-intro">
        <h1>See the shot; fix the form</h1>
        <p>
          Upload a basketball clip to review movement, release timing, and shot attempts in ARC; use Playbook to draw screens, cuts, handoffs, and adaptive reads across 24 editable starters
        </p>
      </section>
      <div className="analysis-depth-control">
        <span id="analysis-depth-label">Analysis depth</span>
        <div className="analysis-depth-options" role="radiogroup" aria-labelledby="analysis-depth-label">
          {PROCESSING_MODE_OPTIONS.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => { depthOptionsRef.current[index] = element; }}
              className={processingMode === option.value ? "is-active" : ""}
              type="button"
              role="radio"
              aria-checked={processingMode === option.value}
              tabIndex={processingMode === option.value ? 0 : -1}
              onClick={() => onProcessingModeChange(option.value)}
              onKeyDown={(event) => handleDepthKeyDown(event, index)}
            >
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
      </div>
      <fieldset className="shot-mode-control">
        <legend>Shot type</legend>
        <div className="shot-mode-options" role="group" aria-label="Shot type">
          <button
            type="button"
            className={shotMode === "free_throw" ? "is-active" : ""}
            aria-pressed={shotMode === "free_throw"}
            onClick={() => onShotModeChange("free_throw")}
          >
            Free throw
          </button>
        </div>
      </fieldset>
      <button
        className={`upload-drop ${dragging ? "is-dragging" : ""}`}
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={VIDEO_TYPES.join(",")}
          onChange={(event) => {
            accept(event.target.files ?? undefined);
            event.currentTarget.value = "";
          }}
          tabIndex={-1}
        />
        <span className="upload-icon"><Upload aria-hidden="true" size={24} /></span>
        <strong>Choose basketball videos</strong>
        <span>Drop one or several clips · MP4, MOV, M4V, AVI, MKV, WebM, MPEG, and more</span>
      </button>
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      <div className="privacy-row">
        <span><ScanLine aria-hidden="true" size={16} />Browser motion review</span>
        <span><Film aria-hidden="true" size={16} />Rotation and codec normalized automatically</span>
      </div>
    </main>
  );
}
