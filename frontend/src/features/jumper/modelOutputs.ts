/** Contracts for the pinned SAM video graphs, checked before consuming outputs. */
export class InvalidModelOutputError extends Error {
  constructor(name: string) {
    super(`The masking model returned an invalid ${name}. Processing stopped. Retry processing; if it repeats, reload the editor or use a shorter segment`);
    this.name = "InvalidModelOutputError";
  }
}

export function validateModelTensor(
  value: unknown,
  shape: readonly number[],
  name: string,
): asserts value is { dims: readonly number[]; data: Float32Array } {
  const item = value as { dims?: unknown; data?: unknown } | null;
  const dims = item?.dims;
  if (!item || !Array.isArray(dims) ||
      dims.length !== shape.length ||
      !shape.every((size, i) => dims[i] === size) ||
      !(item.data instanceof Float32Array) ||
      item.data.length !== shape.reduce((a, b) => a * b, 1))
    throw new InvalidModelOutputError(name);
  // Do not repair invalid numbers: even an unselected mask can poison tracking.
  for (const value of item.data)
    if (!Number.isFinite(value)) throw new InvalidModelOutputError(name);
}

export function validateDecoderOutputs(result: Record<string, unknown>) {
  validateModelTensor(result.masks, [1, 4, 256, 256], "predicted mask");
  validateModelTensor(result.quality, [1, 4], "mask quality");
  validateModelTensor(result.pointers, [1, 4, 256], "tracking pointer");
  validateModelTensor(result.scores, [1, 1], "object score");
}

/** The pinned attention graph returns [1, batch, spatial, channel], not a
 * three-dimensional sequence tensor. Flattening remains sequence-first. */
export function validateAttentionOutput(value: unknown) {
  validateModelTensor(value, [1, 1, 4096, 256], "conditioned features");
}
