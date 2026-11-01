import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FrameBoundary} from '../frontend/src/features/jumper/frameBoundary.ts';
import {smallPlayerCrop,paddedSourceCrop,sourceCropPrompt,projectRefinement,acceptRefinement} from '../frontend/src/features/jumper/smallPlayer.ts';
import {maskExtents} from '../frontend/src/features/jumper/maskQuality.ts';
import {outlineChanges} from '../frontend/src/features/jumper/maskOutline.ts';
import {maskResult} from '../frontend/src/features/jumper/domain.ts';
const fixtures=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/frame-boundary.json',import.meta.url)));
for(const f of fixtures){
 const check=new FrameBoundary(),tracks=[{id:1,ignored:f.ignored,prompts:[{frame:f.start??0}]}];
 for(let n=0;n<f.frames;n++){
  const labels=new Uint8Array(f.width*f.height);
  for(const [id,l,t,r,b]of f.masks)for(let y=t;y<b;y++)labels.fill(id,y*f.width+l,y*f.width+r);
  const before=labels.slice(),boxes=f.missing?.includes(n)?[]:[f.box];if(f.duplicate)boxes.push(f.box);
  const warnings=check.inspect(f.at?.[n]??n,labels,f.width,f.height,tracks,1,boxes,f.wrists?[[...f.box,...f.wrists]]:[],f.resets?.includes(n));
  assert.deepEqual(warnings,f.expected[n].map(at=>({frame:at,kind:'frame_cropped',track_ids:[1]})),`${f.name} ${n}`);
  assert.deepEqual(labels,before);labels.fill(0);
  const blob=new Blob(['video'],{type:'video/mp4'});assert(maskResult({duration:1,highlight:blob,quiz:blob,reveal:blob,warnings}));
 }
}
const near=(a,b)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`);
// Four sides, corners, portrait/landscape, integer and rounded source dimensions.
for(const [w,h,rect]of [[100,100,[0,30,15,60]],[100,100,[85,30,100,60]],[100,100,[30,0,50,30]],[100,100,[30,70,50,100]],[100,100,[0,0,20,30]],[100,100,[80,70,100,100]],[60,140,[0,40,10,80]]]){
 const coarse=new Float32Array(w*h).fill(-3);for(let y=rect[1];y<rect[3];y++)coarse.fill(3,y*w+rect[0],y*w+rect[2]);
 const crop=smallPlayerCrop(coarse,w,h);assert(crop&&!crop.unusable);assert(crop.padding.some(n=>n>0));
 const sw=373,sh=281,region=paddedSourceCrop(crop,w,h,sw,sh),prompt=sourceCropPrompt(crop,w,h,sw,sh);
 for(let i=0;i<crop.points.length;i++){
  near((region.x+prompt.points[i][0]*region.inputWidth-region.left)/sw,(crop.x+crop.points[i][0]*crop.width)/w);
  near((region.y+prompt.points[i][1]*region.inputHeight-region.top)/sh,(crop.y+crop.points[i][1]*crop.height)/h);
 }
 const ramp=Float32Array.from({length:256*256},(_,i)=>((i%256)+.5)/256+2*(Math.floor(i/256)+.5)/256);
 const result=projectRefinement(ramp,crop,w,h,sw,sh);
 for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){
  const u=((crop.x+x+.5)*sw/w-region.x+region.left)/region.inputWidth;
  const v=((crop.y+y+.5)*sh/h-region.y+region.top)/region.inputHeight;
  near(result[y*crop.width+x],u+2*v);
 }
 // Never project positive predictions from synthetic outside-frame padding.
 const outside=new Float32Array(256*256);
 for(let y=0;y<256;y++)for(let x=0;x<256;x++){
  const sx=(x+.5)/256*region.inputWidth-region.left,sy=(y+.5)/256*region.inputHeight-region.top;
  outside[y*256+x]=sx<0||sy<0||sx>=region.width||sy>=region.height ? 3:-3;
 }
 const projected=projectRefinement(outside,crop,w,h,sw,sh);assert(projected.every(v=>v<=0));
 // Reject a refinement that erases supported visible border pixels.
 const owners=Uint8Array.from(coarse,v=>+(v>0)),candidate=new Float32Array(crop.width*crop.height).fill(-3);
 for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++)candidate[y*crop.width+x]=coarse[(crop.y+y)*w+crop.x+x];
 assert(acceptRefinement(coarse,candidate,crop,w,h,owners,1));
 for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++)if(crop.x+x===0||crop.y+y===0||crop.x+x===w-1||crop.y+y===h-1)candidate[y*crop.width+x]=-3;
 assert.equal(acceptRefinement(coarse,candidate,crop,w,h,owners,1),undefined);
}
// Common visible support: no comparison against invented offscreen pixels.
const w=100,h=100,a=new Uint8Array(w*h),b=new Uint8Array(w*h);
for(let y=0;y<80;y++)for(let x=40;x<(y<30?50:60);x++){a[y*w+x]=1;if(y>=5)b[(y-5)*w+x]=1;}
const ea=maskExtents(a,w,h).get(1),eb=maskExtents(b,w,h).get(1);
assert.deepEqual(outlineChanges(a,b,w,h,1,ea,eb),{outline:false,fragmented:false});
console.log(`PASS ${fixtures.length} source-supported crop fixtures; neutral padding, pixel-center round trips, visible-only projection, border preservation and offscreen-aware diagnostics`);
