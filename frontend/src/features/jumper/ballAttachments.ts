import type { MaskWarning } from "./domain.ts";
/** Detection box plus left/right wrist x,y,confidence. Not a ball identity model. */
export type HandEvidence = number[];
export function validHands(value: unknown): value is HandEvidence[] {
  return Array.isArray(value) && value.length <= 20 && value.every(row =>
    Array.isArray(row) && row.length === 10 && row.every(n =>
      typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
    row[0] < row[2] && row[1] < row[3]);
}
type Candidate = { x: number; y: number; radius: number; height: number; flagged?: boolean };
/** Review only. Never changes masks, colors, corrections or tracker memory. */
export class BallAttachments {
  private previous?: Candidate;
  private previousFrame = -2;
  inspect(frame: number, labels: Uint8Array, gray: Uint8Array, width: number, height: number,
    target: number, hands: HandEvidence[], reset = false): MaskWarning[] {
    if (reset || frame !== this.previousFrame + 1) this.previous = undefined;
    const prior = this.previous;
    this.previous = undefined; this.previousFrame = frame;
    if (labels.length !== width*height || gray.length !== width*height || !validHands(hands)) return [];
    const owned = (x: number,y: number) => labels[Math.floor(y)*width+Math.floor(x)] === target;
    const supported = hands.filter(([l,t,r,b]) => {
      let total = 0, hit = 0;
      for(let y=Math.ceil((t+(b-t)*.25)*height); y<(b-(b-t)*.25)*height;y+=3)
        for(let x=Math.ceil((l+(r-l)*.25)*width);x<(r-(r-l)*.25)*width;x+=3) {
          total++; hit+=+owned(x,y);
        }
      return total>=12 && hit/total>=.6;
    });
    if(supported.length!==1) return [];
    const [l,t,r,b,...wrists]=supported[0], bh=(b-t)*height;
    if(bh<70) return []; // Tiny hands/balls cannot be checked reliably.
    let best: Candidate | undefined, bestScore=0;
    for(let hand=0;hand<2;hand++) {
      const [nx,ny,confidence]=wrists.slice(hand*3,hand*3+3);
      if(confidence<.6) continue;
      const wx=nx*width,wy=ny*height;
      for(const fraction of [.035,.05,.065]) {
        const radius=Math.max(4,bh*fraction);
        for(const dx of [-1,0,1]) for(const dy of [-1,0,1]) {
          const x=wx+dx*radius,y=wy+dy*radius;
          if(x-radius*1.3<0 || x+radius*1.3>=width || y-radius*1.3<0 || y+radius*1.3>=height) continue;
          // Avoid mistaking the head for a ball when a wrist passes the face.
          if(Math.abs(x-(l+r)*width/2)<(r-l)*width*.23 && y<(t+(b-t)*.26)*height) continue;
          let filled=0, outside=0, contrast=0;
          for(let i=0;i<24;i++) {
            const a=2*Math.PI*i/24,c=Math.cos(a),s=Math.sin(a);
            const ix=x+c*radius*.7,iy=y+s*radius*.7;
            const ox=x+c*radius*1.3,oy=y+s*radius*1.3;
            filled+=+owned(ix,iy); outside+=+!owned(ox,oy);
            contrast+=+(Math.abs(gray[Math.floor(iy)*width+Math.floor(ix)]-gray[Math.floor(oy)*width+Math.floor(ox)])>=18);
          }
          const score=filled+outside+contrast;
          if(filled>=21 && outside>=17 && contrast>=14 && score>bestScore) {
            best={x,y,radius,height:bh}; bestScore=score;
          }
        }
      }
    }
    if(!best) return [];
    this.previous=best;
    if(!prior || Math.hypot(best.x-prior.x,best.y-prior.y)>bh*.18 ||
      best.radius/prior.radius<.65 || best.radius/prior.radius>1.55) return [];
    best.flagged=true;
    const frames=prior.flagged ? [frame] : [frame-1,frame];
    return frames.map(at => ({frame:at,kind:"ball_attachment",track_ids:[target]}));
  }
}
