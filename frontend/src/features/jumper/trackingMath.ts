export interface Memory {
  frame: number;
  tokens: Float32Array;
  position: Float32Array;
  pointer: Float32Array;
}
export interface TrackerWeights {
  no_mem_embed: number[];
  maskmem_tpos_enc: number[][];
  pointer_weight: number[][];
  pointer_bias: number[];
}
export function bilinear(
  input: Float32Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const output = new Float32Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const fy = Math.max(0, ((y + 0.5) * height) / outHeight - 0.5);
    const y0 = Math.min(height - 1, Math.floor(fy)),
      y1 = Math.min(height - 1, y0 + 1);
    const sy = fy - y0;
    for (let x = 0; x < outWidth; x++) {
      const fx = Math.max(0, ((x + 0.5) * width) / outWidth - 0.5);
      const x0 = Math.min(width - 1, Math.floor(fx)),
        x1 = Math.min(width - 1, x0 + 1);
      const sx = fx - x0;
      output[y * outWidth + x] =
        (input[y0 * width + x0] * (1 - sx) + input[y0 * width + x1] * sx) *
          (1 - sy) +
        (input[y1 * width + x0] * (1 - sx) + input[y1 * width + x1] * sx) * sy;
    }
  }
  return output;
}
export function sequenceFirst(
  values: Float32Array,
  channels = 256,
  size = 4096,
): Float32Array {
  const result = new Float32Array(values.length);
  for (let p = 0; p < size; p++)
    for (let c = 0; c < channels; c++)
      result[p * channels + c] = values[c * size + p];
  return result;
}
export function channelsFirst(
  values: Float32Array,
  channels = 256,
  size = 4096,
): Float32Array {
  const result = new Float32Array(values.length);
  for (let p = 0; p < size; p++)
    for (let c = 0; c < channels; c++)
      result[c * size + p] = values[p * channels + c];
  return result;
}
export function buildBank(
  frame: number,
  totalFrames: number,
  conditions: Map<number, Memory>,
  recent: Map<number, Memory>,
  weights: TrackerWeights,
  reverse = false,
) {
  const direction = reverse ? -1 : 1;
  // An anchor may seed its own direction, but cannot influence an earlier
  // forward prediction or a later reverse prediction. Check map keys against
  // recorded frame identities before selecting spatial memory or pointers.
  const causal = (entries: Map<number, Memory>) => new Map(
    [...entries].filter(([at, value]) => Number.isSafeInteger(at) && at >= 0
      && value.frame === at && (frame - at) * direction > 0),
  );
  conditions = causal(conditions);
  recent = causal(recent);
  const memories: { value: Memory; temporal: number }[] = [
    ...conditions.values(),
  ].map((value) => ({ value, temporal: 6 }));
  for (let temporal = 1; temporal < 7; temporal++) {
    const value = recent.get(frame - direction * (7 - temporal));
    if (value) memories.push({ value, temporal: 6 - temporal });
  }
  if (!memories.length) throw Error("Tracking memory is empty");
  // After a rejected stretch, retain a real, timestamped reliable reference.
  // Treat it as an additional anchor, never as a fabricated recent frame.
  const fallback = [...conditions.values(), ...recent.values()]
    .filter(value => (frame - value.frame) * direction > 0)
    .sort((a, b) => (b.frame - a.frame) * direction)[0];
  if (fallback && (frame - fallback.frame) * direction > 6 && !conditions.has(fallback.frame)) {
    conditions = new Map([...conditions, [fallback.frame, fallback]]);
    memories.push({ value: fallback, temporal: 6 });
  }
  const spatial = new Float32Array(memories.length * 4096 * 64),
    positions = new Float32Array(spatial.length);
  memories.forEach(({ value, temporal }, index) => {
    const offset = index * 4096 * 64;
    spatial.set(value.tokens, offset);
    for (let i = 0; i < value.position.length; i++)
      positions[offset + i] =
        value.position[i] + weights.maskmem_tpos_enc[temporal][i % 64];
  });
  const maxPointers = Math.min(totalFrames, 16);
  const pointers: { difference: number; value: Memory }[] = [
    ...conditions.values(),
  ]
    .filter((value) => (frame - value.frame) * direction > 0)
    .map((value) => ({ difference: (frame - value.frame) * direction, value }));
  for (let difference = 1; difference < maxPointers; difference++) {
    const value = recent.get(frame - direction * difference);
    if (value && !conditions.has(value.frame)) pointers.push({ difference, value });
  }
  const pointerData = new Float32Array(pointers.length * 256),
    pointerPosition = new Float32Array(pointerData.length);
  pointers.forEach(({ difference, value }, i) => {
    pointerData.set(value.pointer, i * 256);
    const sine = new Float32Array(256);
    for (let j = 0; j < 128; j++) {
      const phase =
        difference /
        Math.max(1, maxPointers - 1) /
        10000 ** ((2 * Math.floor(j / 2)) / 128);
      sine[j] = Math.sin(phase);
      sine[j + 128] = Math.cos(phase);
    }
    for (let c = 0; c < 64; c++) {
      let sum = weights.pointer_bias[c];
      for (let j = 0; j < 256; j++)
        sum += weights.pointer_weight[c][j] * sine[j];
      for (let token = 0; token < 4; token++)
        pointerPosition[i * 256 + token * 64 + c] = sum;
    }
  });
  return { spatial, positions, pointerData, pointerPosition };
}
