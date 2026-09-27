import type { ProcessingMode } from "./analysisTypes";

export const PROCESSING_MODE_OPTIONS: ReadonlyArray<{
  value: ProcessingMode;
  label: string;
  description: string;
}> = [
  { value: "fast", label: "Fast", description: "Quick scan · fewer frames" },
  { value: "normal", label: "Normal", description: "Standard shot review" },
  { value: "deep", label: "Deep", description: "Detailed mechanics review" },
];

export function isProcessingMode(value: unknown): value is ProcessingMode {
  return value === "fast" || value === "normal" || value === "deep";
}

export function processingModeLabel(value: unknown) {
  return PROCESSING_MODE_OPTIONS.find((option) => option.value === value)?.label ?? "Normal";
}

export function browserSamplingPlan(mode: ProcessingMode, durationSeconds: number) {
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 1;
  const plan = mode === "fast"
    ? { framesPerSecond: 1.25, minimum: 8, maximum: 48, candidateLimit: 3 }
    : mode === "deep"
      ? { framesPerSecond: 4, minimum: 12, maximum: 72, candidateLimit: 5 }
      : { framesPerSecond: 2.5, minimum: 12, maximum: 72, candidateLimit: 5 };
  return {
    sampleCount: Math.min(plan.maximum, Math.max(plan.minimum, Math.round(duration * plan.framesPerSecond))),
    candidateLimit: plan.candidateLimit,
  };
}
