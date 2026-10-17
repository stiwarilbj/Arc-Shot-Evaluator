import * as ort from "onnxruntime-web/webgpu";
export const PERSON_DETECTOR_SHA =
  "ae0eb4ed805163adc419b3db5454b3dfcf8b3620148fc4e294b0a1e5cccc26d5";
export async function createPersonDetector() {
  const url = new URL(
    `${import.meta.env.BASE_URL}jumper/models/person-detector.onnx`,
    self.location.href,
  ).href;
  let cache: Cache | undefined;
  try {
    cache = await caches.open("arc-jumper-models-v1");
  } catch {}
  const response = (await cache?.match(url)) ?? (await fetch(url));
  if (!response.ok)
    throw Error("Person detector could not download; retry processing.");
  const bytes = await response.arrayBuffer();
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  if (sha !== PERSON_DETECTOR_SHA) {
    await cache?.delete(url);
    throw Error("Person detector integrity check failed; retry processing.");
  }
  try {
    await cache?.put(url, new Response(bytes));
  } catch {}
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["webgpu"],
  });

  return {
    async detect(image: HTMLCanvasElement | OffscreenCanvas) {
      const width = image.width,
        height = image.height;
      const canvas = new OffscreenCanvas(640, 640),
        ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const fit = Math.min(640 / width, 640 / height);
      // Match Ultralytics' native letterbox padding.
      ctx.fillStyle = "rgb(114,114,114)";
      ctx.fillRect(0, 0, 640, 640);
      ctx.drawImage(
        image,
        (640 - width * fit) / 2,
        (640 - height * fit) / 2,
        width * fit,
        height * fit,
      );
      const rgb = ctx.getImageData(0, 0, 640, 640).data,
        pixels = new Float32Array(3 * 640 * 640);
      for (let i = 0; i < 640 * 640; i++)
        for (let c = 0; c < 3; c++)
          pixels[c * 640 * 640 + i] = rgb[i * 4 + c] / 255;
      const tensor = new ort.Tensor("float32", pixels, [1, 3, 640, 640]);
      let output: Record<string, ort.Tensor> | undefined;
      try {
        output = await session.run({ [session.inputNames[0]]: tensor });
        const value = output[session.outputNames[0]],
          values = value.data as Float32Array,
          n = value.dims[2];
        const scale = Math.min(640 / width, 640 / height),
          ox = (640 - width * scale) / 2,
          oy = (640 - height * scale) / 2;
        const candidates: { box: number[]; score: number }[] = [];
        for (let i = 0; i < n; i++) {
          if (values[4 * n + i] < 0.25) continue;
          const x = values[i],
            y = values[n + i],
            w = values[2 * n + i],
            h = values[3 * n + i];
          const clamp = (v: number) => Math.max(0, Math.min(1, v));
          const box = [
            clamp((x - w / 2 - ox) / (width * scale)),
            clamp((y - h / 2 - oy) / (height * scale)),
            clamp((x + w / 2 - ox) / (width * scale)),
            clamp((y + h / 2 - oy) / (height * scale)),
          ];
          if (box[2] > box[0] && box[3] > box[1])
            candidates.push({ box, score: values[4 * n + i] });
        }
        candidates.sort((a, b) => b.score - a.score);
        const kept: number[][] = [];
        for (const { box } of candidates) {
          if (
            kept.some((other) => {
              const intersect =
                Math.max(
                  0,
                  Math.min(box[2], other[2]) - Math.max(box[0], other[0]),
                ) *
                Math.max(
                  0,
                  Math.min(box[3], other[3]) - Math.max(box[1], other[1]),
                );
              return (
                intersect /
                  ((box[2] - box[0]) * (box[3] - box[1]) +
                    (other[2] - other[0]) * (other[3] - other[1]) -
                    intersect) >
                0.45
              );
            })
          )
            continue;
          kept.push(box);
          if (kept.length > 20)
            throw Error(
              "More than 20 people detected. Trim to a closer view or turn off automatic discovery and select court players manually.",
            );
        }
        return kept;
      } finally {
        tensor.dispose();
        if (output) Object.values(output).forEach((t) => t.dispose());
      }
    },
    release: () => session.release(),
  };
}
