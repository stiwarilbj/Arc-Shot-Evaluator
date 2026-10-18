import { useState } from "react";
import type { Piece } from "./editProject";
import {
  copyPieceEffects,
  pastePieceEffects,
  type PieceEffects,
  type EffectSelection,
} from "./pieceEffects";

export default function PieceEffectsClipboard({
  piece,
  name,
  onPaste,
}: {
  piece: Piece;
  name: string;
  onPaste: (patch: Partial<Piece>) => boolean;
}) {
  const [copied, setCopied] = useState<{
    effects: PieceEffects;
    name: string;
  } | null>(null);
  const [selected, setSelected] = useState<EffectSelection>({
    speed: true,
    from: true,
    to: true,
  });
  const [message, setMessage] = useState("");
  const patch = copied
    ? pastePieceEffects(copied.effects, piece, selected)
    : {};
  const changed = Object.entries(patch).some(
    ([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(piece[key as keyof Piece]),
  );
  return (
    <div
      role="group"
      aria-label="Copy and paste piece effects"
      className="jumper-effects-clipboard"
    >
      <strong>Copy effects between pieces</strong>
      <button
        onClick={() => {
          setCopied({ effects: copyPieceEffects(piece), name });
          setMessage(
            `Copied effects from ${name}. Select another piece, choose settings, then paste.`,
          );
        }}
      >
        Copy effects
      </button>
      {copied ? (
        <p className="jumper-caption">
          Copied from {copied.name}. Choose what to apply to {name}:
        </p>
      ) : (
        <p className="jumper-caption">
          Copy speed and framing from the selected piece, then select a
          destination piece.
        </p>
      )}
      {(
        [
          ["speed", "Speed"],
          ["from", "Start framing"],
          ["to", "End framing"],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={selected[key]}
            disabled={
              !copied ||
              (key === "speed" &&
                (copied.effects.speed === null || !!piece.freeze))
            }
            onChange={(e) =>
              setSelected({ ...selected, [key]: e.target.checked })
            }
          />{" "}
          {label}
        </label>
      ))}
      {piece.freeze || copied?.effects.speed === null ? (
        <p className="jumper-caption">
          Speed does not apply to freeze pieces. Freeze length stays unchanged.
        </p>
      ) : null}
      <button
        disabled={!changed}
        onClick={() => {
          if (onPaste(patch))
            setMessage(
              `Pasted selected effects into ${name}. Cuts, source ranges, and captions were not copied.`,
            );
        }}
      >
        Paste effects
      </button>
      {copied && !changed ? (
        <p className="jumper-caption">
          Choose an effect that differs from this piece to paste.
        </p>
      ) : null}
      <p className="jumper-caption" role="status">
        {message}
      </p>
    </div>
  );
}
