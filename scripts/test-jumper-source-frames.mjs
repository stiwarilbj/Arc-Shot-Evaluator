import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {outputFrameAtTime,buildFrameMap,validFrameMap,sourceFrameTime,verifySourceFrame,sameFrameMap} from '../frontend/src/features/jumper/sourceFrames.ts';
import {validateMaskRequest,maskResult} from '../frontend/src/features/jumper/domain.ts';
const fixtures=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/source-frames.json',import.meta.url)));
for(const f of fixtures) {
 const map=buildFrameMap(f.source,f.start,f.end);
 assert(validFrameMap(map,f.start,f.end),f.name);
 assert.deepEqual(map.frames.map(f=>f.source_index),f.expected,f.name);
 map.frames.forEach((s,i)=> {
  const time=sourceFrameTime(map,i)*1e6;
  assert(time>s.source_us && time<s.source_us+s.duration_us);
  verifySourceFrame(map,i,{timestamp:s.source_us/1e6});
  assert.throws(()=>verifySourceFrame(map,i,{timestamp:(s.source_us+5000)/1e6}),/different timestamp/);
 });
 assert.throws(()=>sourceFrameTime(map,-1));assert.throws(()=>sourceFrameTime(map,map.frames.length));
 const copy=structuredClone(map);assert(sameFrameMap(map,copy));copy.frames[0].source_us++;assert(!sameFrameMap(map,copy));
 for(const edit of [m=>m.frames.pop(),m=>m.frames[0].source_us+=100000,m=>m.frames[0].source_index=-1,m=>m.origin_us=NaN,m=>m.frames[0].duration_us=0]) {
  const broken=structuredClone(map);edit(broken);assert(!validFrameMap(broken));
 }
 const request={start:f.start,end:f.end,target_id:1,objects:[{id:1,prompts:[{frame:0,points:[[.5,.5]],labels:[1]}]}],frame_map:map};
 validateMaskRequest(request);assert.throws(()=>validateMaskRequest({...request,frame_map:{...map,end_us:map.end_us+1}}));
 const blob=new Blob(['video'],{type:'video/mp4'});
 assert(maskResult({highlight:blob,quiz:blob,reveal:blob,duration:map.frames.length/30,warnings:[],frame_map:map}));
}
assert.throws(()=>buildFrameMap([{timestamp:0,duration:.1},{timestamp:0,duration:.1}],0,.1));
assert.throws(()=>buildFrameMap([{timestamp:0,duration:.1}],0,.2));
assert.throws(()=>buildFrameMap([{timestamp:NaN,duration:.1}],0,.1));
console.log('Shared source-frame maps: VFR, offsets, decode order, exact boundaries, repeated frames, correction identity and invalid maps passed');
// Unknown terminal duration is safe only when the selected frames end earlier.
const tail=[{timestamp:0,duration:0},{timestamp:.1,duration:0},{timestamp:.2,duration:0}];
assert(validFrameMap(buildFrameMap(tail,0,.15)));
assert.throws(()=>buildFrameMap(tail,0,.23));
assert.throws(()=>buildFrameMap([...tail,{timestamp:NaN,duration:.1}],0,.1));
const sameTime=buildFrameMap(tail,0,.15);sameTime.frames[1].source_index=1;assert(!validFrameMap(sameTime));

const clockMap=buildFrameMap([{timestamp:0,duration:1}],0,1);
for(let i=0;i<30;i++) {
 assert.equal(outputFrameAtTime(clockMap,Math.floor(i*1e6/30)/1e6),i);
 assert.equal(outputFrameAtTime(clockMap,Math.round(i*1e6/30)/1e6),i);
}
assert.equal(outputFrameAtTime(clockMap,.033),0);
assert.equal(outputFrameAtTime(clockMap,-1),0);
assert.equal(outputFrameAtTime(clockMap,2),29);
