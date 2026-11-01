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
    for (const wait of arrow.timingPlan?.waits ?? []) if (wait.progress !== undefined) wait.progress = roundForStorage(wait.progress, 4);
  }
  for (const branch of saved.branches ?? []) for (const arrow of branch.continuation) {
    point(arrow.start); point(arrow.end);
    if (arrow.control) point(arrow.control);
    if (arrow.exit_target) point(arrow.exit_target);
    if (arrow.timing !== undefined) arrow.timing = roundForStorage(arrow.timing, 2);
    for (const wait of arrow.timingPlan?.waits ?? []) if (wait.progress !== undefined) wait.progress = roundForStorage(wait.progress, 4);
  }
  for (const checkpoint of saved.readCoach?.checkpoints ?? []) {
    for (const marker of [...checkpoint.snapshot.players, ...checkpoint.snapshot.defenders]) point(marker);
    if (checkpoint.snapshot.ball) point(checkpoint.snapshot.ball);
    for (const choice of checkpoint.choices) for (const arrow of choice.arrows) {
      point(arrow.start); point(arrow.end);
      if (arrow.control) point(arrow.control);
      if (arrow.exit_target) point(arrow.exit_target);
      if (arrow.timing !== undefined) arrow.timing = roundForStorage(arrow.timing, 2);
      for (const wait of arrow.timingPlan?.waits ?? []) if (wait.progress !== undefined) wait.progress = roundForStorage(wait.progress, 4);
    }
  }
  for (const gate of saved.spacingGates?.gates ?? []) {
    point(gate.area.center);
    if (gate.area.shape === "circle") gate.area.radiusFeet = roundForStorage(gate.area.radiusFeet, 2);
    else { gate.area.widthFeet = roundForStorage(gate.area.widthFeet, 2); gate.area.heightFeet = roundForStorage(gate.area.heightFeet, 2); }
    gate.beforeSeconds = roundForStorage(gate.beforeSeconds, 2);
    gate.afterSeconds = roundForStorage(gate.afterSeconds, 2);
    if (gate.trigger.progress !== undefined) gate.trigger.progress = roundForStorage(gate.trigger.progress, 4);
  }
  for (const connection of saved.baitPayoffs?.connections ?? []) {
    if (connection.reaction) {
      point(connection.reaction.area.center);
      if (connection.reaction.area.shape === "circle") connection.reaction.area.radiusFeet = roundForStorage(connection.reaction.area.radiusFeet, 2);
      else {
        connection.reaction.area.widthFeet = roundForStorage(connection.reaction.area.widthFeet, 2);
        connection.reaction.area.heightFeet = roundForStorage(connection.reaction.area.heightFeet, 2);
      }
      if (connection.reaction.checkpoint.progress !== undefined) connection.reaction.checkpoint.progress = roundForStorage(connection.reaction.checkpoint.progress, 4);
    }
  }
  return saved;
}
