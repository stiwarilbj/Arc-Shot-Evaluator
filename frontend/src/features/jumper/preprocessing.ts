// PIL-compatible bicubic RGB resampling. Native SAM's image loader uses PIL's
// default BICUBIC; canvas bilinear resampling changes small foreground masks.
function cubic(x: number) {
  x = Math.abs(x);
  return x < 1
    ? (1.5 * x - 2.5) * x * x + 1
    : x < 2
      ? ((-0.5 * x + 2.5) * x - 4) * x + 2
      : 0;
}
function coefficients(source: number, target: number) {
  const scale = source / target,
    filter = Math.max(1, scale),
    support = 2 * filter;
  return Array.from({ length: target }, (_, index) => {
    const center = (index + 0.5) * scale,
      start = Math.max(0, Math.floor(center - support + 0.5)),
      end = Math.min(source, Math.floor(center + support + 0.5));
    const values = Array.from({ length: end - start }, (_, i) =>
      cubic((i + start - center + 0.5) / filter),
    );
    const total = values.reduce((a, b) => a + b, 0);
    return {
      start,
      weights: values.map((v) => Math.round((v / total) * 2 ** 22)),
    };
  });
}
export function samPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  size = 1024,
): Float32Array {
  const xs = coefficients(width, size),
    ys = coefficients(height, size),
    horizontal = new Uint8Array(size * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 3; c++) {
        let value = 2 ** 21;
        const { start, weights } = xs[x];
        for (let i = 0; i < weights.length; i++)
          value += source[(y * width + start + i) * 4 + c] * weights[i];
        horizontal[(y * size + x) * 3 + c] = Math.max(
          0,
          Math.min(255, Math.floor(value / 2 ** 22)),
        );
      }
  const result = new Float32Array(size * size * 3),
    mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 3; c++) {
        let value = 2 ** 21;
        const { start, weights } = ys[y];
        for (let i = 0; i < weights.length; i++)
          value += horizontal[((start + i) * size + x) * 3 + c] * weights[i];
        const rgb = Math.max(0, Math.min(255, Math.floor(value / 2 ** 22)));
        result[c * size * size + y * size + x] = Math.fround(
          (Math.fround(rgb / 255) - Math.fround(mean[c])) / Math.fround(std[c]),
        );
      }
  return result;
}
