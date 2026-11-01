import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reliableMask,pruneReliable} from '../frontend/src/features/jumper/memoryQuality.ts';
import {buildBank} from '../frontend/src/features/jumper/trackingMath.ts';
import {maskResult} from '../frontend/src/features/jumper/domain.ts';
import {warningLabels} from '../frontend/src/features/jumper/warningTimeline.ts';
const cases=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/jumper/memory-quality.json',import.meta.url)));
function pixels(rect,value=3,strong=undefined){
 const result=new Float32Array(256*256).fill(-3);
 if(rect){const [x,y,w,h]=rect;let count=0;
  for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)result[row*256+col]=count++<(strong??0)?3:value;
 }return result;
}
for(const f of cases){
 const current=pixels(f.rect,f.value,f.strong),before=current.slice();
 assert.equal(reliableMask(current,f.previous?pixels(f.previous):undefined,f.score),f.expected,f.name);
 assert.deepEqual(current,before);
}
for(const reverse of [false,true]){
 const dir=reverse?-1:1,start=reverse?50:0;
 const recent=new Map([[start+dir,{frame:start+dir,tokens:new Float32Array(4096*64).fill(7),position:new Float32Array(4096*64),pointer:new Float32Array(256).fill(7)}]]);
 for(let step=2;step<40;step++)pruneReliable(recent,start+dir*step,reverse);
 assert.deepEqual([...recent.keys()],[start+dir]);
 const initial={frame:start,tokens:new Float32Array(4096*64).fill(1),position:new Float32Array(4096*64),pointer:new Float32Array(256).fill(1)};
 const conditions=new Map([[start,initial]]);
 const weights={maskmem_tpos_enc:Array.from({length:7},()=>new Array(64).fill(0)),pointer_weight:Array.from({length:64},()=>new Array(256).fill(0)),pointer_bias:new Array(64).fill(0)};
 const bank=buildBank(start+dir*40,60,conditions,recent,weights,reverse);
 assert.equal(bank.spatial.length,2*4096*64);
 assert.equal(bank.spatial[4096*64],7);
 assert.equal(bank.pointerData[256],7);
 const nearBank=buildBank(start+dir*8,60,conditions,recent,weights,reverse);
 assert.equal(nearBank.pointerData.length,512,'Fallback pointer must not be duplicated in recent and anchor lists');
 assert.deepEqual([...conditions.keys()],[start],'Fallback must not mutate authored anchors');
 recent.set(start+dir*40,{frame:start+dir*40});pruneReliable(recent,start+dir*40,reverse);
 assert(!recent.has(start+dir),'New reliable frame replaces expired fallback');
}
const blob=new Blob(['fixture'],{type:'video/mp4'});
assert(warningLabels.memory_rejected);
assert(maskResult({duration:.1,highlight:blob,quiz:blob,reveal:blob,warnings:[{frame:1,kind:'memory_rejected',track_ids:[7]}]}));
console.log('Tracking-memory thresholds, forward/reverse retention, timestamped fallback, bounded replacement and warnings passed');

const orderCases=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/jumper/memory-order.json',import.meta.url)));
const weights={maskmem_tpos_enc:Array.from({length:7},()=>new Array(64).fill(0)),pointer_weight:Array.from({length:64},()=>new Array(256).fill(0)),pointer_bias:new Array(64).fill(0)};
const memory=frame=>({frame,tokens:new Float32Array(4096*64).fill(frame),position:new Float32Array(4096*64),pointer:new Float32Array(256).fill(frame)});
for(const test of orderCases){
 const conditions=new Map(test.conditions.map(([key,frame])=>[key,memory(frame)]));
 const recent=new Map(test.recent.map(([key,frame])=>[key,memory(frame)]));
 const beforeConditions=[...conditions],beforeRecent=[...recent];
 const run=()=>buildBank(test.frame,30,conditions,recent,weights,test.reverse);
 if(test.error) assert.throws(run,/Tracking memory is empty/,test.name);
 else {
  const bank=run();
  assert.deepEqual([...bank.spatial].filter((_,i)=>i%(4096*64)===0),test.spatial,test.name);
  assert.deepEqual([...bank.pointerData].filter((_,i)=>i%256===0),test.pointers,test.name);
 }
 assert.deepEqual([...conditions],beforeConditions,'Stored correction anchors stay intact');
 assert.deepEqual([...recent],beforeRecent,'Filtering must not mutate recent history');
}
console.log('PASS forward/reverse causal memory, same-frame exclusion, mismatched frame identities and future-only rejection');
