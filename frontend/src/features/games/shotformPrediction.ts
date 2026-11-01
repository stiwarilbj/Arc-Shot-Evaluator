import { MOTION_MODEL_SHA256 } from "./shotformModelIdentity.ts";
import { FEATURE_DEFINITION, FEATURE_ID, SHOTFORM_ENGINE, challengeFromSeed, clamp, measure, motionFeatures, type Challenge, type Controls } from "./shotformMotion.ts";
export type MotionModel = { version: 1; engine: string; features: string; featureDefinition: typeof FEATURE_DEFINITION; scale: number; activation: string; layers: { weights: number[][]; bias: number[] }[]; validation: { samples: number; p99: number; maximum: number; regionAccuracy: number; eligible: number } };
export function validMotionModel(value: unknown): value is MotionModel {
  if (!value || typeof value !== "object") return false;
  const m = value as MotionModel;
  if (m.version !== 1 || m.engine !== SHOTFORM_ENGINE || m.features !== FEATURE_ID || JSON.stringify(m.featureDefinition) !== JSON.stringify(FEATURE_DEFINITION) || m.scale !== 8 || m.activation !== "relu" || !Array.isArray(m.layers) || m.layers.length !== 3) return false;
  let input = 9;
  for (const [i, layer] of m.layers.entries()) {
    const size = i === 2 ? 3 : 32;
    if (!layer || !Array.isArray(layer.bias) || layer.bias.length !== size || !Array.isArray(layer.weights) || layer.weights.length !== size || !layer.bias.every(n => Number.isFinite(n) && Math.abs(n) <= 100) || !layer.weights.every(row => Array.isArray(row) && row.length === input && row.every(n => Number.isFinite(n) && Math.abs(n) <= 100))) return false;
    input = size;
  }
  const v = m.validation;
  return !!v && Number.isInteger(v.samples) && v.samples >= 10000 && Number.isInteger(v.eligible) && v.eligible >= 100 && v.eligible <= v.samples && Number.isFinite(v.p99) && v.p99 >= 0 && v.p99 <= 2 && Number.isFinite(v.maximum) && v.maximum >= v.p99 && v.maximum <= 5 && Number.isFinite(v.regionAccuracy) && v.regionAccuracy >= .98 && v.regionAccuracy <= 1;
}
export function inferMotion(model: MotionModel, features: number[]): number[] {
  let values = features.map(n => n / model.scale);
  for (const layer of model.layers) values = layer.weights.map((row, i) => Math.max(0, layer.bias[i] + row.reduce((sum, w, j) => sum + w * values[j], 0)));
  return values.map(n => clamp(n * 100, 0, 100));
}
export function highlightedArea(challenge: Challenge, controls: Controls, model: MotionModel | null): number {
  const scores = model ? inferMotion(model, motionFeatures(challenge, controls)) : measure(challenge, controls);
  return scores.reduce((best, n, i) => n < scores[best] ? i : best, 0);
}
export async function verifiedMotionModel(bytes: Uint8Array): Promise<MotionModel> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), n => n.toString(16).padStart(2, "0")).join("");
  if (hash !== MOTION_MODEL_SHA256) throw new Error("Motion model checksum mismatch");
  const model: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!validMotionModel(model)) throw new Error("Invalid motion model");
  return model;
}
export async function loadMotionModel(signal?: AbortSignal): Promise<MotionModel> {
  const response = await fetch(new URL("./shotform-model.json", import.meta.url), { signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
  if (!response.ok || !response.body) throw new Error("Motion model unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 128 * 1024) throw new Error("Motion model exceeds size limit"); chunks.push(result.value); } } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  const model = await verifiedMotionModel(bytes);
  // Independent startup probes protect against structurally valid but damaged weights
  for (const round of [1, 4, 7]) for (const controls of [[-4, 4, -4], [0, 0, 0], [4, -4, 4]] as Controls[]) {
    const c = challengeFromSeed(701193 + round, round), expected = measure(c, controls), predicted = inferMotion(model, motionFeatures(c, controls));
    if (predicted.some((n, i) => !Number.isFinite(n) || Math.abs(n - expected[i]) > 5)) throw new Error("Motion model self-check failed");
  }
  return model;
}
