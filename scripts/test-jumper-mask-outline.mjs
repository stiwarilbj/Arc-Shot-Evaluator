import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MaskQuality, maskExtents } from '../frontend/src/features/jumper/maskQuality.ts';
import { maskResult, unstableMask } from '../frontend/src/features/jumper/domain.ts';
const fixtures = JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/mask-outline.json',import.meta.url)));
for(const f of fixtures) {
  const make = rects => { const out=new Uint8Array(f.width*f.height); for(const [id,l,t,r,b] of rects) for(let y=t;y<b;y++) out.fill(id,y*f.width+l,y*f.width+r); return out; };
  const id=f.identity??1, frame=f.frame??1;
  const tracks=[{id,prompts:[{frame:0},...(f.correction?[{frame}]:[])]}];
  const quality=new MaskQuality(), before=make(f.before), after=make(f.after), copy=after.slice();
  if(f.name==='missing shooting hand' || f.name==='gray player hand loss') {
    const a=maskExtents(before,f.width,f.height).get(id), b=maskExtents(after,f.width,f.height).get(id);
    assert.equal(unstableMask(a,b),false,'the old area/centroid instability test misses this failure');
    assert(b.area/a.area>0.9,'less than ten percent of body area was lost');
  }
  quality.inspect(0,before,f.width,f.height,tracks,1);
  before.fill(0); // The monitor must own its history.
  const warnings=quality.inspect(frame,after,f.width,f.height,tracks,1,f.reset);
  assert.deepEqual(warnings.map(w=>w.kind),f.expected,f.name);
  assert(warnings.every(w=>w.frame===frame&&w.track_ids[0]===id));
  assert.deepEqual(after,copy);
  const blob=new Blob(['video'],{type:'video/mp4'});
  assert(maskResult({objects:tracks.map(t=>({...t,prompts:t.prompts.map(p=>({...p,box:[0,0,1,1]}))})),duration:1,highlight:blob,quiz:blob,reveal:blob,warnings}));
}
console.log(`Partial-body diagnostics: ${fixtures.length} shared outline, fragment, motion, reset and immutable-history fixtures passed`);
