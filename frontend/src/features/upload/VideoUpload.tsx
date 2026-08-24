import { useRef, useState } from "react";
import { Film, LockKeyhole, Upload } from "lucide-react";

interface VideoUploadProps {
  error: string | null;
  onFiles: (files: File[]) => void;
}

const VIDEO_TYPES = [
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".flv",
  ".mpeg", ".mpg", ".3gp", ".m2ts", ".mts", ".ts", ".ogv", ".asf",
];

export function VideoUpload({ error, onFiles }: VideoUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function accept(files: FileList | File[] | undefined) {
    if (files?.length) onFiles(Array.from(files));
  }

  return (
    <main className="video-upload">
      <section className="upload-intro">
        <h1>See the shot. Fix the form.</h1>
        <p>
          Drop a recorded session to trace the ball, score each attempt, and inspect the
          shooter&apos;s mechanics at release—entirely on this machine.
        </p>
      </section>
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
        <span><LockKeyhole aria-hidden="true" size={16} />No cloud upload</span>
        <span><Film aria-hidden="true" size={16} />Rotation and codec normalized automatically</span>
      </div>
      <p className="local-note">Single-camera estimates · review low-confidence calls · footage stays on this machine.</p>
    </main>
  );
}
