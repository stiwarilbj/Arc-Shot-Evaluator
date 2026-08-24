import { Film, LoaderCircle, Play } from "lucide-react";
import type { ExampleVideo } from "../../domain/analysisTypes";

interface ExampleVideoLibraryProps {
  examples: ExampleVideo[];
  loading: boolean;
  error: string | null;
  onSelect: (example: ExampleVideo) => void;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function formatDimensions(example: ExampleVideo) {
  return `${example.width}×${example.height}`;
}

export function ExampleVideoLibrary({ examples, loading, error, onSelect }: ExampleVideoLibraryProps) {
  return (
    <section className="example-video-library" aria-labelledby="example-heading">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Downloaded test clips</span>
          <h2 id="example-heading">Test with these videos</h2>
        </div>
        <span className="section-count">{examples.length ? `${examples.length} ready` : "Your clips"}</span>
      </div>
      {loading ? (
        <div className="examples-state"><LoaderCircle className="spin" size={18} />Loading example clips</div>
      ) : error ? (
        <div className="examples-state examples-error">{error}</div>
      ) : examples.length ? (
        <div className="example-grid">
          {examples.map((example) => (
            <button
              className="example-card"
              key={example.id}
              type="button"
              onClick={() => onSelect(example)}
              aria-label={`Analyze ${example.label}, ${example.filename}`}
            >
              <span className="example-preview">
                <video src={example.url} muted playsInline preload="metadata" aria-hidden="true" />
                <span className="example-play"><Play size={15} fill="currentColor" /></span>
                <span className="example-duration">{formatDuration(example.duration)}</span>
              </span>
              <span className="example-copy">
                <strong>{example.label}</strong>
                <span title={example.filename}>{example.filename}</span>
                <small><Film size={12} />{formatDimensions(example)} · {Math.round(example.fps)} fps</small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="examples-state"><Film size={18} />Add videos above to build your own examples.</div>
      )}
    </section>
  );
}
