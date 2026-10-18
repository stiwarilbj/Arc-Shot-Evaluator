/** Conservative visibility, never a substitute for identity recognition.
 * Equivalent to backend/jumper/shooter_visibility.py. No synthetic gap filling. */
export class ShooterVisibility {
  private reference?: Float32Array;
  private pending?: Float32Array;
  private streak = 0;
  private hiddenAt?: number;
  private lastVisible = 0;
  private confirmation = false;

  inspect(frame: number, target: Float32Array, others: readonly Float32Array[],
    score: number, width: number, confirmed = false, uncertainIdentity = false) {
    const area = (mask: Float32Array) => mask.reduce((n, v) => n + +(v > 0), 0);
    const count = area(target);
    const referenceArea = this.reference ? area(this.reference) : 0;
    const competing = new Uint8Array(target.length);
    for (const mask of others)
      for (let i = 0; i < mask.length; i++) if (mask[i] > 0.5) competing[i] = 1;
    let covered = 0, referenceCovered = 0;
    for (let i = 0; i < target.length; i++) {
      if (competing[i] && target[i] > 0) covered++;
      if (competing[i] && this.reference && this.reference[i] > 0) referenceCovered++;
    }
    const absent = !Number.isFinite(score) || score <= 0 || count < 4;
    const merged = count >= 4 && covered / count >= 0.85;
    const behind = referenceArea > 0 && referenceCovered / referenceArea >= 0.6;
    const prompted = confirmed && !absent;
    if (prompted) this.confirmation = false;
    if (absent || (!prompted && merged)) {
      this.hiddenAt ??= frame;
      this.pending = undefined; this.streak = 0;
      // Absence is not itself an identity failure. Without an observed occluder,
      // keep a review flag rather than silently treating tracking loss as safe.
      return { visible: false, warning: behind || merged ? undefined : "target_lost" as const };
    }
    if (this.hiddenAt !== undefined && !prompted) {
      const ambiguous = uncertainIdentity || covered / count >= 0.25 || frame - this.lastVisible > 45;
      this.confirmation ||= ambiguous;
      if (this.confirmation) return { visible: false, warning: "ambiguous_players" as const };
      const compatible = (before: Float32Array, minIoU: number) => {
        let a = 0, b = 0, intersection = 0, ax = 0, ay = 0, bx = 0, by = 0;
        for (let i = 0; i < target.length; i++) {
          if (before[i] > 0) { a++; ax += i % width; ay += Math.floor(i / width); }
          if (target[i] > 0) { b++; bx += i % width; by += Math.floor(i / width); if (before[i] > 0) intersection++; }
        }
        const distance = Math.hypot((ax/a-bx/b) / width, (ay/a-by/b) / (target.length/width));
        return a > 0 && b/a >= 0.25 && b/a <= 4 &&
          (minIoU ? intersection/(a+b-intersection) >= minIoU :
            distance <= Math.min(0.3, 0.1 + (frame-this.lastVisible)*0.015));
      };
      if (!this.reference || !compatible(this.reference, 0)) {
        this.confirmation = true;
        return { visible: false, warning: "ambiguous_players" as const };
      }
      this.streak = this.pending && compatible(this.pending, 0.5) ? this.streak + 1 : 1;
      this.pending = target.slice();
      if (this.streak < 3) return { visible: false, warning: undefined };
    }
    this.hiddenAt = undefined; this.pending = undefined; this.streak = 0;
    this.reference = target.slice(); this.lastVisible = frame;
    return { visible: true, warning: undefined };
  }
}
