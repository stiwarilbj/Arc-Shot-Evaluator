import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MaskQuality, maskExtents } from '../frontend/src/features/jumper/maskQuality.ts';
import { maskResult } from '../frontend/src/features/jumper/domain.ts';
const fixtures = JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/mask-quality.json', import.meta.url)));
for (const fixture of fixtures) {
  const quality = new MaskQuality();
  const originalTracks = structuredClone(fixture.tracks);
  for (const [frame, step] of fixture.frames.entries()) {
    const owners = new Uint8Array(fixture.width * fixture.height);
    for (const [id,x1,y1,x2,y2] of step.masks)
      for(let y=y1;y<y2;y++) for(let x=x1;x<x2;x++) owners[y*fixture.width+x]=id;
    const original = owners.slice();
    const warnings = quality.inspect(frame, owners, fixture.width, fixture.height, fixture.tracks, fixture.target);
    assert.deepEqual(warnings,step.warnings,`${fixture.name}: frame ${frame}`);
    assert.deepEqual(owners,original);
    assert.deepEqual(fixture.tracks,originalTracks);
    const areas = new Map();
    for(const id of owners) if(id) areas.set(id,(areas.get(id)??0)+1);
    assert.deepEqual([...maskExtents(owners,fixture.width,fixture.height)].map(([id,e])=>[id,e.area]).sort(), [...areas].sort());
    const blob = new Blob(['video'],{type:'video/mp4'});
    assert(maskResult({objects:fixture.tracks.map(t=>({...t,prompts:t.prompts.map(p=>({...p,box:[0,0,1,1]}))})),duration:fixture.frames.length/30,highlight:blob,quiz:blob,reveal:blob,warnings}));
  }
}
const owner = new Uint8Array([1]);
assert.deepEqual(new MaskQuality().inspect(0,owner,1,1,[{id:1,prompts:[{frame:0}]}],1),[]);
console.log('Per-player mask quality: gray/shooter loss, jumps, expansion, sustained truncation, pose recovery, all four exits, reentry, partial/ignored/future tracks, stable IDs, immutable inputs, and runtime warnings passed');
