import type { CourtPoint, PlaybookDraft } from "./types.ts";

const bits = new DataView(new ArrayBuffer(8));

/** Python round(float, places): nearest decimal, ties to even, from the exact
 * stored binary value. Math.round and toFixed disagree at ties (e.g. 1.125)
 * and multiplying first can introduce a false tie (e.g. 2.675). */
function roundForStorage(value: number, places: 2 | 4): number {
  if (value === 0) return value;
  bits.setFloat64(0, value);
  const raw = bits.getBigUint64(0);
  const exponent = Number((raw >> 52n) & 0x7ffn);
  const fraction = raw & ((1n << 52n) - 1n);
  const significand = exponent === 0 ? fraction : fraction | (1n << 52n);
  const shift = (exponent === 0 ? -1022 : exponent - 1023) - 52;
  let numerator = significand * (10n ** BigInt(places));
  const denominator = shift < 0 ? 1n << BigInt(-shift) : 1n;
  if (shift > 0) numerator <<= BigInt(shift);
  let rounded = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  if (twiceRemainder > denominator || twiceRemainder === denominator && rounded % 2n !== 0n) rounded++;
  const result = Number(rounded) / 10 ** places;
  return value < 0 ? -result : result;
}

/** Save-boundary copy only. Validate before calling; reads and live drafts keep
 * their precision until explicitly saved. Match the existing Python policy. */
export function normalizePlaybookPrecision<T extends PlaybookDraft>(playbook: T): T {
  const saved = structuredClone(playbook);
  const point = (value: CourtPoint) => { value.x = roundForStorage(value.x, 4); value.y = roundForStorage(value.y, 4); };
  for (const marker of [...saved.players, ...saved.defenders]) point(marker);
  if (saved.ball) point(saved.ball);
  for (const arrow of saved.arrows) {
    point(arrow.start); point(arrow.end);
    if (arrow.control) point(arrow.control);
    if (arrow.exit_target) point(arrow.exit_target);
    if (arrow.timing !== undefined) arrow.timing = roundForStorage(arrow.timing, 2);
  }
  return saved;
}
