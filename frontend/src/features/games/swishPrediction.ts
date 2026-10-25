import { MODEL_ERROR, RELEASE_HEIGHT, SWISH_ENGINE, freeTrajectory, initialVelocity, spreadControls, type FlightPoint, type ShotControls } from "./swishPhysics.ts";

type Layer = { weights: number[][]; bias: number[] };
export type SwishModel = { version: number; engine: string; architecture: number[]; activation: string; normalization: number[]; residual: string; validation: { samples: number; p99Meters: number; maxMeters: number }; layers: Layer[] };
export const PREDICTION_TIMES = Array.from({ length: 81 }, (_, i) => i / 20);
export function validateModel(value: unknown): value is SwishModel {
  if (!value || typeof value !== "object") return false;
  const m = value as SwishModel;
  if (m.version !== 1 || m.engine !== SWISH_ENGINE || m.activation !== "tanh" || m.residual !== "ballistic-plus-t-squared" ||
      JSON.stringify(m.architecture) !== "[4,48,48,2]" || JSON.stringify(m.normalization) !== "[13,13,5,4]" ||
      !m.validation || !Number.isSafeInteger(m.validation.samples) || m.validation.samples < 10000 ||
      !Number.isFinite(m.validation.p99Meters) || m.validation.p99Meters < 0 || m.validation.p99Meters > 0.02 ||
      !Number.isFinite(m.validation.maxMeters) || m.validation.maxMeters < 0 || m.validation.maxMeters > MODEL_ERROR ||
      !Array.isArray(m.layers) || m.layers.length !== 3) return false;
  return m.layers.every((layer, i) => Array.isArray(layer.weights) && layer.weights.length === m.architecture[i + 1] &&
    Array.isArray(layer.bias) && layer.bias.length === m.architecture[i + 1] && layer.bias.every(n => Number.isFinite(n) && Math.abs(n) < 100) &&
    layer.weights.every(row => Array.isArray(row) && row.length === m.architecture[i] && row.every(n => Number.isFinite(n) && Math.abs(n) < 100)));
}
export function neuralTrajectory(model: SwishModel, controls: ShotControls, times = PREDICTION_TIMES): FlightPoint[] {
  const [vx, vy] = initialVelocity(controls);
  return times.map(t => {
    let inputs = [vx / 13, vy / 13, controls.spin / 5, t / 4];
    model.layers.forEach((layer, i) => {
      inputs = layer.weights.map((row, k) => {
        let sum = layer.bias[k];
        for (let j = 0; j < row.length; j++) sum += row[j] * inputs[j];
        return i === model.layers.length - 1 ? sum : Math.tanh(sum);
      });
    });
    return { t, x: vx * t + inputs[0] * t * t, y: RELEASE_HEIGHT + vy * t - 4.905 * t * t + inputs[1] * t * t };
  });
}
export function predictShot(controls: ShotControls, model: SwishModel | null) {
  const predict = (c: ShotControls) => model ? neuralTrajectory(model, c) : freeTrajectory(c, PREDICTION_TIMES);
  return { center: predict(controls), spread: spreadControls(controls).map(predict), error: model ? MODEL_ERROR : 0 };
}
export type ShotPrediction = ReturnType<typeof predictShot>;
export async function loadSwishModel(): Promise<SwishModel> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let model: unknown;
  try {
    const response = await fetch(new URL("./swish-model.json", import.meta.url), { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error("Prediction model is unavailable");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 128 * 1024) throw new Error("Prediction model exceeds its size limit");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    model = JSON.parse(new TextDecoder().decode(bytes));
  } finally { clearTimeout(timeout); }
  if (!validateModel(model)) throw new Error("Prediction model is unavailable or incompatible");
  // Catch a finite but broken artifact too, before displaying its predictions
  const probe = { angle: 55, power: 50, spin: 2 };
  const predicted = neuralTrajectory(model, probe, [0, 0.5, 1, 1.5, 2]);
  const exact = freeTrajectory(probe, [0, 0.5, 1, 1.5, 2]);
  if (predicted.some((p, i) => !Number.isFinite(p.x + p.y) || Math.hypot(p.x - exact[i].x, p.y - exact[i].y) > MODEL_ERROR)) throw new Error("Prediction model failed its self-check");
  return model;
}
