import type { JobProgress } from "./domain";

export function processingPhase(stage: string): string {
  if (/frame \d/i.test(stage) && !stage.startsWith("Applying selections"))
    return "browser-tracking";
  if (/Downloading.*model/i.test(stage))
    return stage.replace(/ · [\d.]+ MB$/, "");
  return stage;
}

/** Stage-local measurements only: never predict unmeasured later stages. */
export class ProcessingEstimate {
  private phase = "";
  private samples: { time: number; value: number }[] = [];
  private changedAt = 0;
  private value = 0;

  update(update: JobProgress, now: number) {
    const phase = processingPhase(update.stage);
    const value = update.progress;
    if (!Number.isFinite(value) || value < 0 || value > 1) return;
    if (phase !== this.phase || value < this.value) {
      this.phase = phase;
      this.samples = [{ time: now, value }];
      this.changedAt = now;
    } else if (value > this.value) {
      this.samples.push({ time: now, value });
      this.samples = this.samples.slice(-12);
      this.changedAt = now;
    }
    this.value = value;
  }

  hint(now: number): string {
    const download = /Downloading/i.test(this.phase);
    const tracking = /tracking/i.test(this.phase);
    const exporting = /render|finaliz/i.test(this.phase);
    const samples = this.samples;
    const first = samples[0],
      last = samples.at(-1);
    const span = first && last ? last.time - first.time : 0;
    const gap = samples.length > 1 ? span / (samples.length - 1) : 0;
    if (now - this.changedAt >= Math.max(15000, gap * 3)) {
      if (download)
        return "No new download progress yet. Network or model verification may be taking longer; you can cancel and retry.";
      if (tracking)
        return "No new frame progress yet. Model setup, overlapping players, or device load can take longer. You can cancel without losing selections.";
      return "No new progress yet. Preparing models or finishing video encoding can take longer on this device. You can cancel without losing selections.";
    }
    if (
      first &&
      last &&
      samples.length >= 4 &&
      span >= 2000 &&
      last.value > first.value &&
      this.value < 1
    ) {
      const seconds =
        ((1 - last.value) * span) / (last.value - first.value) / 1000;
      // Round up, avoiding a falsely precise countdown. Recompute only on progress.
      const rounded = Math.max(5, Math.ceil(seconds / 5) * 5);
      const duration =
        rounded < 60
          ? `${rounded} seconds`
          : `${Math.ceil(rounded / 60)} minute${rounded > 60 ? "s" : ""}`;
      return `About ${duration} left for ${download ? "this model download" : tracking ? (this.phase === "browser-tracking" ? "tracking and rendering" : "tracking") : "this stage"}. Updates with measured speed; later stages are separate.`;
    }
    if (download)
      return "First-time model downloads are separate from video processing. Cached models are reused when available; estimating this download as data arrives…";
    if (
      /automatic player detection|Detecting the selected shooter/i.test(
        this.phase,
      )
    )
      return "Preparing player detection. First use may download a model; cached models are reused when available. Tracking starts after setup.";
    if (tracking)
      return "Measuring this device’s speed over several frames. Tracking time varies with the number of players; export follows.";
    if (exporting)
      return "Exporting the masked video. Encoding and final checks are separate from tracking; waiting for measurable progress.";
    return "Preparing this stage. A time estimate appears once enough progress has been measured.";
  }
}
