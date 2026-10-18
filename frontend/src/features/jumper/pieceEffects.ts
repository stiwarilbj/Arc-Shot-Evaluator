import type { Piece } from "./editProject";

export type PieceEffects = {
  speed: Piece["speed"] | null;
  from: Piece["from"];
  to: Piece["to"];
};
export type EffectSelection = Record<"speed" | "from" | "to", boolean>;

/** Private editor clipboard; no cuts, footage, captions, or object references. */
export function copyPieceEffects(piece: Piece): PieceEffects {
  return {
    speed: piece.freeze ? null : piece.speed,
    from: { ...piece.from },
    to: { ...piece.to },
  };
}
export function pastePieceEffects(
  source: PieceEffects,
  target: Piece,
  selected: EffectSelection,
): Partial<Piece> {
  return {
    ...(selected.speed && source.speed !== null && !target.freeze
      ? { speed: source.speed }
      : {}),
    ...(selected.from ? { from: { ...source.from } } : {}),
    ...(selected.to ? { to: { ...source.to } } : {}),
  };
}
