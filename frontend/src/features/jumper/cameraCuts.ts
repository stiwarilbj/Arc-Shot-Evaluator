// Keep equivalent to backend/jumper/camera_cuts.py. Diagnostic thumbnails only.
const WIDTH = 64, HEIGHT = 36;
type Scene = { pixels: Float32Array; contrast: number };
type Transition = { frame: number; before: Scene; after: Scene };
function scene(rgb: ArrayLike<number>, channels: number): Scene {
  const pixels = new Float32Array(WIDTH * HEIGHT);
  let mean = 0;
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (rgb[i*channels]*77 + rgb[i*channels+1]*150 + rgb[i*channels+2]*29)/256;
    mean += pixels[i];
  }
  mean /= pixels.length;
  let variance = 0;
  for (const value of pixels) variance += (value-mean)**2;
  const contrast = Math.sqrt(variance/pixels.length);
  for (let i=0;i<pixels.length;i++) pixels[i] = (pixels[i]-mean)/Math.max(8,contrast);
  return { pixels, contrast };
}
// Search translated overlaps, not just colocated pixels. At least 35% of the
// image must agree, so a tiny accidental patch cannot establish continuity.
function difference(a: Scene, b: Scene) {
  function at(dx: number, dy: number) {
    const left=Math.max(0,-dx), right=Math.min(WIDTH,WIDTH-dx);
    const top=Math.max(0,-dy), bottom=Math.min(HEIGHT,HEIGHT-dy);
    if ((right-left)*(bottom-top)<WIDTH*HEIGHT*.35) return Infinity;
    let sum=0, count=0;
    for(let y=top;y<bottom;y+=2) for(let x=left;x<right;x+=2) {
      sum+=Math.min(2,Math.abs(a.pixels[y*WIDTH+x]-b.pixels[(y+dy)*WIDTH+x+dx])); count++;
    }
    return sum/count;
  }
  let best=at(0,0);
  if(best<=.45) return best;
  for(let dy=-20;dy<=20;dy++) for(let dx=-40;dx<=40;dx++) {
    const score=at(dx,dy);
    best=Math.min(best,score);
    if(best<=.15) return best;
  }
  return best;
}

/** One-frame brightness changes do not establish a scene cut. Bounded history. */
export class CameraCuts {
  private previous?: Scene;
  private frame = -1;
  private pending: Transition[] = [];
  inspect(frame: number, rgb: ArrayLike<number>, channels = 4) {
    const current=scene(rgb,channels), cuts: number[]=[];
    if(frame!==this.frame+1) {this.pending=[];this.previous=undefined;}
    let returningFlash=false;
    this.pending=this.pending.filter(p=>{
      const returned=difference(p.before,current)<=.65;
      // A clipped/white flash can erase scene detail. A brief, structured
      // inserted scene is still a cut, even if the camera returns afterward.
      if(returned) {
        if(p.after.contrast<12) returningFlash=true;
        else cuts.push(p.frame);
        return false;
      }
      if(frame-p.frame<2) return true;
      if(difference(p.after,current)<=.65) cuts.push(p.frame);
      return false;
    });
    const reset=!!this.previous && !returningFlash && difference(this.previous,current)>.75;
    if(reset) this.pending.push({frame,before:this.previous!,after:current});
    this.previous=current;this.frame=frame;
    return { reset, cuts };
  }
  // No future evidence exists at a truncated end: retain the conservative hint.
  finish() { const cuts=this.pending.map(p=>p.frame);this.pending=[];return cuts; }
}
