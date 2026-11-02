import type { FloorProject } from "./types.ts";

// A save timestamp is bookkeeping · Undoing back to the baseline is clean
export function hasProjectChanges(
  project: FloorProject | null,
  baseline: FloorProject | null,
) {
  return !!project && !!baseline && (
    JSON.stringify({ ...project, updatedAt: undefined }) !==
      JSON.stringify({ ...baseline, updatedAt: undefined })
  );
}
