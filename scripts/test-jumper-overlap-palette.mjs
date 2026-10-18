import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { OverlapPalette, GRAY_SHADES } from '../frontend/src/features/jumper/overlapPalette.ts';
import { PaletteFrames, packLabels, unpackLabels } from '../frontend/src/features/jumper/paletteFrames.ts';
import { silhouettePixels } from '../frontend/src/features/jumper/media.ts';
import { validateComposite } from '../frontend/src/features/jumper/videoValidation.ts';
const width=24,height=18;
const frames=Array.from({length:12},(_,frame)=>Uint8Array.from({length:width*height},(_,i)=>{
 const x=i%width,y=Math.floor(i/width);
 if(y<2) return 1;
 if(y>14) return frame>7 && x>4 && x<18 ? 9 : 0;
 if(x<10) return 2;
 if(x<20) return 5;
 return frame===11 ? 3 : 0;
}));
const graph=new OverlapPalette(1);
const frozen=frames.map(f=>f.slice());
for(const f of frames) graph.observe(f,width,height);
const shades=graph.finish();
assert.equal(shades[0],224);assert.equal(shades[1],0);
assert.equal(Math.abs(shades[2]-shades[5]),136);
assert.equal(Math.abs((64+47%137)-(64+4*47%137)),4);
for(const id of [2,3,5,9]) assert(GRAY_SHADES.includes(shades[id]));
assert.deepEqual(graph.finish(),shades);
const reverse=new OverlapPalette(1);
for(const f of [...frames].reverse())reverse.observe(f,width,height);
assert.deepEqual(reverse.finish(),shades);
for(let i=0;i<frames.length;i++) {
 assert.deepEqual(frames[i],frozen[i]);
 const pixels=silhouettePixels(frames[i],1,true,shades);
 validateComposite(pixels,frames[i],1,'quiz',true,shades);
 for(let j=0;j<frames[i].length;j++)assert.equal(pixels[j*4],shades[frames[i][j]]);
}
const native=JSON.parse(execFileSync(new URL('../.venv/bin/python',import.meta.url).pathname,
 ['-c',`import json,sys,numpy as np
from backend.jumper.overlap_palette import OverlapPalette
v=json.load(sys.stdin); g=OverlapPalette(1)
for a in v['frames']: g.observe(np.array(a,np.uint8).reshape(v['height'],v['width']))
print(json.dumps(g.finish().tolist()))`],
 {cwd:new URL('../',import.meta.url),input:JSON.stringify({width,height,frames:frames.map(f=>[...f])})}).toString());
assert.deepEqual([...shades],native);
for(const labels of [new Uint8Array(1000).fill(2),Uint8Array.from({length:700},(_,i)=>i%256),...frames])
 assert.deepEqual(unpackLabels(packLabels(labels),labels.length),labels);
assert.throws(()=>unpackLabels(new Uint32Array([0]),10),/Invalid/);
assert.throws(()=>unpackLabels(new Uint32Array([257]),2),/Incomplete/);
const store=new PaletteFrames(width*height,frames.length);
for(let i=0;i<frames.length;i++)await store.add(i,frames[i]);
assert(store.ready());
for(let i=0;i<frames.length;i++)assert.deepEqual(await store.frame(i),frames[i]);
const mutable=await store.frame(0);mutable.fill(255);
assert.deepEqual(await store.frame(0),frames[0]);
await assert.rejects(()=>store.add(12,frames[0]),/order/);
await assert.rejects(()=>store.frame(-1),/unavailable/);
store.close();assert(!store.ready());
// Node has no IndexedDB: small jobs must survive unavailable scratch storage.
const fallback=new PaletteFrames(width*height,1,1);
await fallback.add(0,frames[0]);assert(fallback.ready());
assert.deepEqual(await fallback.frame(0),frames[0]);fallback.close();
await assert.rejects(()=>store.frame(0),/unavailable/);
assert.throws(()=>new OverlapPalette(0),/target/);
assert.throws(()=>graph.observe(new Uint8Array(1),2,2),/frame/);
console.log('Overlap palette: full-clip evidence, strongly separated crossings, fixed shades, late entrants, deterministic native parity, source-free rendering and lossless bounded replay');
