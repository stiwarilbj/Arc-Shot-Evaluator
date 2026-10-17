import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CanvasSink } from "mediabunny";
import { openVideo } from "./media";
import { pieceFrames, type Piece } from "./editProject";

function sampleFrames(piece: Piece) {
  const last = pieceFrames(piece) - 1;
  return [
    ...new Set(
      [0, Math.floor(last / 2), last].map((offset) =>
        piece.freeze
          ? piece.start
          : Math.min(piece.end - 1, piece.start + Math.floor(offset * piece.speed)),
      ),
    ),
  ];
}

/** Only masked-base frames are decoded. The cache is private to this editor. */
export default memo(function TimelinePieces({
  base,
  pieces,
  selected,
  active,
  onSelect,
}: {
  base: Blob;
  pieces: Piece[];
  selected: string;
  active: boolean;
  onSelect: (id: string, frame: number) => void;
}) {
  const samples = useMemo(() => pieces.map(sampleFrames), [pieces]);
  // Reordering pieces, changing captions, or selecting a piece needs no decoding.
  const frameKey = [...new Set(samples.flat())].sort((a, b) => a - b).join(",");
  const cache = useRef({ base, frames: new Map<number, string>() });
  const [images, setImages] = useState({ base, frames: new Map<number, string>() });
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);

  useEffect(() => {
    if (cache.current.base !== base) cache.current = { base, frames: new Map() };
    const entries = cache.current.frames;
    const wanted = new Set(frameKey.split(",").filter(Boolean).map(Number));
    const missing = [...wanted].filter((frame) => !entries.has(frame));
    let cancelled = false;
    let input: Awaited<ReturnType<typeof openVideo>>["input"] | undefined;
    const publish = () => {
      if (!cancelled) setImages({ base, frames: new Map(entries) });
    };
    setFailed(false);
    publish();
    if (!active || !missing.length) return;

    void (async () => {
      const opened = await openVideo(base);
      input = opened.input;
      if (cancelled) return;
      const sink = new CanvasSink(opened.track, { width: 144, poolSize: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = 144;
      canvas.height = 80;
      const context = canvas.getContext("2d");
      if (!context) throw Error("Thumbnail canvas unavailable");
      for (let i = 0; i < missing.length; i++) {
        const frame = missing[i];
        const sample = await sink.getCanvas(frame / 30 + 0.00001);
        if (cancelled) return;
        if (!sample) throw Error("Thumbnail frame unavailable");
        context.fillStyle = "#e0e0e0";
        context.fillRect(0, 0, 144, 80);
        const scale = Math.min(
          144 / sample.canvas.width,
          80 / sample.canvas.height,
        );
        const width = sample.canvas.width * scale,
          height = sample.canvas.height * scale;
        context.drawImage(
          sample.canvas,
          (144 - width) / 2,
          (80 - height) / 2,
          width,
          height,
        );
        entries.set(frame, canvas.toDataURL("image/png"));
        // At most three samples per piece, with no more than 100 pieces.
        for (const key of entries.keys()) {
          if (entries.size <= 300) break;
          if (!wanted.has(key)) entries.delete(key);
        }
        if (i % 3 === 2 || i === missing.length - 1) publish();
      }
    })()
      .catch(() => {
        if (!cancelled) {
          publish();
          setFailed(true);
        }
      })
      .finally(() => input?.dispose());
    return () => {
      cancelled = true;
      input?.dispose();
    };
  }, [base, frameKey, active, retry]);

  let offset = 0;
  return (
    <>
      <div className="jumper-edit-pieces" role="group" aria-label="Timeline pieces">
        {pieces.map((piece, index) => {
          const start = offset;
          const duration = (pieceFrames(piece) / 30).toFixed(2);
          const name = piece.freeze ? `Freeze ${index + 1}` : `Piece ${index + 1}`;
          offset += pieceFrames(piece);
          return (
            <button
              key={piece.id}
              type="button"
              className="jumper-edit-piece"
              aria-label={`${name}, ${duration} seconds`}
              aria-pressed={piece.id === selected}
              onClick={() => onSelect(piece.id, start)}
              style={{ flexGrow: pieceFrames(piece) }}
            >
              <span className="jumper-piece-thumbnails" aria-hidden="true">
                {samples[index].map((frame) => {
                  const image = images.base === base
                    ? images.frames.get(frame)
                    : undefined;
                  return image ? (
                    <img key={frame} src={image} alt="" draggable={false} />
                  ) : (
                    <span key={frame} className="jumper-piece-placeholder" />
                  );
                })}
              </span>
              <span className="jumper-piece-label">
                <span>{name}</span>
                <span>{duration}s</span>
              </span>
            </button>
          );
        })}
      </div>
      {failed ? (
        <p className="jumper-caption" role="status">
          Some thumbnails are unavailable. You can still select and preview each
          piece.{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry thumbnails
          </button>
        </p>
      ) : null}
    </>
  );
});
