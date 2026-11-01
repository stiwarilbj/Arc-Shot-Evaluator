import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FloorAttachments} from '../frontend/src/features/jumper/floorAttachments.ts';
import {MaskQuality} from '../frontend/src/features/jumper/maskQuality.ts';
import {maskResult} from '../frontend/src/features/jumper/domain.ts';
import {warningLabels} from '../frontend/src/features/jumper/warningTimeline.ts';
const fixtures=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/floor-attachments.json',import.meta.url)));
for(const f of fixtures){
 const check=new FloorAttachments(f.width,f.height),legacy=new MaskQuality(),id=f.identity??1;
 const tracks=[{id,ignored:f.ignored??false,prompts:[{frame:f.start??0,box:[0,0,1,1]},...(f.correction?[{frame:f.correction,points:[[.5,.5]],labels:[1]}]:[])]}];
 const beforeTracks=structuredClone(tracks),beforeFixture=structuredClone(f);
 for(const [n,step]of f.frames.entries()){
  const owners=new Uint8Array(f.width*f.height);
  for(const [identity,l,t,r,b]of step.masks)for(let y=t;y<b;y++)owners.fill(identity,y*f.width+l,y*f.width+r);
  const before=owners.slice();
  if(fixtures.indexOf(f)<2)assert.deepEqual(legacy.inspect(n,owners,f.width,f.height,tracks,id),[],
    "Stable attachments evade existing sudden-change checks");
  const warnings=check.inspect(step.at??n,owners,f.width,f.height,tracks,step.boxes??f.boxes,step.reset);
  assert.deepEqual(warnings,f.expected[n].map(frame=>({frame,kind:'floor_attachment',track_ids:[id]})),`${f.name}: ${n}`);
  assert.deepEqual(owners,before,'Diagnostics must not trim silhouettes');
  owners.fill(0);
  const blob=new Blob(['video'],{type:'video/mp4'});
  assert(maskResult({duration:1,highlight:blob,quiz:blob,reveal:blob,warnings}));
 }
 assert.deepEqual(tracks,beforeTracks);assert.deepEqual(f,beforeFixture);
}
assert.equal(warningLabels.floor_attachment,'Possible shadow or reflection');
console.log(`PASS ${fixtures.length} shared floor-attachment fixtures: shadows, reflections, shoes/legs, movement, persistence, reset, ambiguity, gray players and immutable masks`);
