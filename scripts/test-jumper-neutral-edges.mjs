import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { neutralEdges } from '../frontend/src/features/jumper/neutralEdges.ts';
import { silhouettePixels } from '../frontend/src/features/jumper/media.ts';
import { validateComposite, silhouetteProof } from '../frontend/src/features/jumper/videoValidation.ts';
const width = 31, height = 23;
const owners = Uint8Array.from({length: width * height}, (_, i) => {
  const x = i % width, y = Math.floor(i / width);
  return x < y ? 1 : x < y + 6 ? 2 : 0;
});
const before = silhouettePixels(owners, 1, true);
validateComposite(before, owners, 1, 'quiz', true);
const labels = owners.slice();
const result = neutralEdges(before.slice(), width, height);
const native = JSON.parse(execFileSync(new URL('../.venv/bin/python', import.meta.url).pathname,
 ['-c', 'import json,numpy as np;from backend.jumper.pipeline import silhouette_pixels;from backend.jumper.neutral_edges import neutral_edges;w,h=31,23;a=np.array([1 if i%w<i//w else 2 if i%w<i//w+6 else 0 for i in range(w*h)],np.uint8).reshape(h,w);print(json.dumps(neutral_edges(silhouette_pixels(a,1,True))[...,0].ravel().tolist()))'],
 {cwd:new URL('../',import.meta.url)}).toString());
assert.deepEqual(Array.from(owners), Array.from(labels));
assert.deepEqual(Array.from(owners, (_,i)=>result[i*4]), native);
let blended = 0;
for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
 const i=y*width+x, v=result[i*4];
 assert.equal(v,result[i*4+1]); assert.equal(v,result[i*4+2]); assert.equal(result[i*4+3],255);
 const neighbors=[];
 for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) neighbors.push(before[(Math.max(0,Math.min(height-1,y+dy))*width+Math.max(0,Math.min(width-1,x+dx)))*4]);
 assert(v>=Math.min(...neighbors)&&v<=Math.max(...neighbors));
 if(neighbors.every(n=>n===neighbors[0])) assert.equal(v,neighbors[0]);
 if(v!==before[i*4]) blended++;
}
assert(blended>0);
assert(silhouetteProof(result,width,height).length>0);
for(const value of [0,64,128,200,224]) {
 const input=new Uint8ClampedArray([value,value,value,255]);
 assert.deepEqual(neutralEdges(input.slice(),1,1),input);
}
assert.throws(()=>neutralEdges(before,0,height),/geometry/);
assert.throws(()=>neutralEdges(before,width,height+1),/geometry/);
console.log('Neutral edges: native/browser exact parity, bounded palette blends, solid interiors, opaque borders, unchanged ownership');
