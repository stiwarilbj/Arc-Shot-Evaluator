import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containedImageRect, imagePoint, previewImageRect } from '../frontend/src/features/jumper/imageCoordinates.ts';
import { smallPlayerCrop, sourceCrop, sourceCropPrompt, projectRefinement } from '../frontend/src/features/jumper/smallPlayer.ts';
const near = (a,b) => assert(Math.abs(a-b)<1e-6, `${a} != ${b}`);
// Upright landscape/portrait images, fractional CSS sizes, both letterbox directions.
for (const [w,h] of [[1920,1080],[1080,1920],[1080,1080],[641,359]]) {
 for (const box of [{left:7.5,top:29.25,width:800,height:300},{left:-50,top:10,width:250.5,height:700.25}]) {
  const rect=containedImageRect(box,w,h);
  for(const [x,y] of [[0,0],[1,1],[0,1],[1,0],[.001,.999],[.317,.762]]) {
   const actual=imagePoint(rect,rect.left+x*rect.width,rect.top+y*rect.height);
   assert(actual);near(actual[0],x);near(actual[1],y);
   // Full-frame model resize is anisotropic, without padding or a second rotation.
   near(actual[0]*1024/1024*w,x*w);near(actual[1]*1024/1024*h,y*h);
  }
  if(rect.left>box.left) assert.equal(imagePoint(rect,box.left,rect.top+rect.height/2),undefined);
  if(rect.top>box.top) assert.equal(imagePoint(rect,rect.left+rect.width/2,box.top),undefined);
  assert.equal(imagePoint(rect,NaN,0),undefined);
 }
}
assert.equal(containedImageRect({left:0,top:0,width:0,height:10},1,1),undefined);
// Border/content box sizing and fractional CSS scales use the same image geometry.
for(const boxSizing of ['border-box','content-box']) {
 const style={boxSizing,width:boxSizing==='border-box'?'247.5px':'207.5px',height:boxSizing==='border-box'?'345.25px':'325.25px',
  borderLeftWidth:'3px',paddingLeft:'17px',borderRightWidth:'5px',paddingRight:'15px',
  borderTopWidth:'2px',paddingTop:'8px',borderBottomWidth:'4px',paddingBottom:'6px'};
 const original=globalThis.getComputedStyle;
 try {
  globalThis.getComputedStyle=()=>style;
  const image={naturalWidth:180,naturalHeight:320,getBoundingClientRect:()=>({left:5,top:9,width:247.5*.93,height:345.25*.87})};
  const rect=previewImageRect(image);
  const layout=containedImageRect({left:20,top:10,width:207.5,height:325.25},180,320);
  const expected={left:5+layout.left*.93,top:9+layout.top*.87,width:layout.width*.93,height:layout.height*.87};
  for(const key of ['left','top','width','height'])near(rect[key],expected[key]);
 } finally {if(original)globalThis.getComputedStyle=original;else delete globalThis.getComputedStyle}
}
const fixtures=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/image-coordinates.json',import.meta.url)));
const ramp=Float32Array.from({length:256*256},(_,i)=>((i%256)+.5)/256+2*(Math.floor(i/256)+.5)/256);
for(const f of fixtures) {
 const crop={...f.crop,points:f.points,labels:f.points.map(()=>1),box:[.05,.1,.95,.9],unusable:false};
 const args=[crop,f.width,f.height,f.sourceWidth,f.sourceHeight];
 const region=sourceCrop(...args), prompt=sourceCropPrompt(...args);
 for(const [i,p] of crop.points.entries()) {
  near((region.x+prompt.points[i][0]*region.width)/f.sourceWidth,(crop.x+p[0]*crop.width)/f.width);
  near((region.y+prompt.points[i][1]*region.height)/f.sourceHeight,(crop.y+p[1]*crop.height)/f.height);
 }
 for(let i=0;i<4;i+=2) {
  near((region.x+prompt.box[i]*region.width)/f.sourceWidth,(crop.x+crop.box[i]*crop.width)/f.width);
  near((region.y+prompt.box[i+1]*region.height)/f.sourceHeight,(crop.y+crop.box[i+1]*crop.height)/f.height);
 }
 const result=projectRefinement(ramp,...args);
 for(let y=0;y<crop.height;y++) for(let x=0;x<crop.width;x++) {
  const u=((crop.x+x+.5)*f.sourceWidth/f.width-region.x)/region.width;
  const v=((crop.y+y+.5)*f.sourceHeight/f.height-region.y)/region.height;
  near(result[y*crop.width+x],u+2*v);
 }
}
// A valid prompt exactly on the right/bottom image edge must survive crop refinement.
const mask=new Float32Array(320*180).fill(-3);
for(let y=167;y<180;y++)for(let x=315;x<320;x++)mask[y*320+x]=3;
const edge=smallPlayerCrop(mask,320,180,{frame:0,points:[[1,1]],labels:[1]});
assert(!edge.unusable);assert.deepEqual(edge.points.at(-1),[1,1]);
console.log('Preview letterboxing, edge clicks, model resize, rounded crop prompt/mask round trips passed');
