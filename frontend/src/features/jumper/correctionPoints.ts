export class CorrectionConflictError extends Error {
  constructor(message:string) { super(message); this.name="CorrectionConflictError"; }
  override toString() { return this.message; }
}

/** Compare explicit Include/Exclude points on SAM's 1024-pixel input grid.
 * Keep the first coordinate unchanged; never merge frames, tracks or box corners.
 */
export function correctionPrompt<T extends {frame:number; points?:number[][]; labels?:number[]}>(
  prompt:T, trackId:number, context="",
):T {
  if (!prompt.points?.length) return prompt;
  const cells=new Map<string,number>();
  const points:number[][]=[], labels:number[]=[];
  for (let i=0;i<prompt.points.length;i++) {
    const point=prompt.points[i], label=prompt.labels![i];
    const cell=point.map(n=>Math.min(1023,Math.max(0,Math.floor(Math.fround(n*1024))))).join(":");
    const previous=cells.get(cell);
    if (previous!==undefined) {
      if (previous!==label) {
        throw new CorrectionConflictError(`Include and Exclude points overlap on the same processing pixel at frame ${prompt.frame+1}, track ${trackId}${context ? ` (${context})` : ""}. Remove or move one of these correction points, then retry`);
      }
      continue;
    }
    cells.set(cell,label); points.push([...point]); labels.push(label);
  }
  return {...prompt,points,labels};
}
