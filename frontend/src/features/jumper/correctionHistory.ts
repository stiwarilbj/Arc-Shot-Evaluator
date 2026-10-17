import type { Track } from "./domain";

export interface CorrectionState {
  tracks: Track[];
  target: number;
  editing: number;
  frame: number;
  negative: boolean;
  automatic: boolean;
}
interface Entry {
  state: CorrectionState;
  label: string;
}

/** No files, videos or processing results are retained in correction history. */
export class CorrectionHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private readonly limit: number;
  constructor(limit = 50) {
    this.limit = limit;
  }
  get undoLabel() {
    return this.past.at(-1)?.label;
  }
  get redoLabel() {
    return this.future.at(-1)?.label;
  }
  record(state: CorrectionState, label: string) {
    this.past.push({ state: structuredClone(state), label });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: CorrectionState): CorrectionState | undefined {
    const entry = this.past.pop();
    if (!entry) return;
    this.future.push({ state: structuredClone(current), label: entry.label });
    return structuredClone(entry.state);
  }
  redo(current: CorrectionState): CorrectionState | undefined {
    const entry = this.future.pop();
    if (!entry) return;
    this.past.push({ state: structuredClone(current), label: entry.label });
    return structuredClone(entry.state);
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}
