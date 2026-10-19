import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {correctionPrompt} from '../frontend/src/features/jumper/correctionPoints.ts';
import {validateMaskRequest,maskingErrorMessage} from '../frontend/src/features/jumper/domain.ts';
import {sourceCropPrompt} from '../frontend/src/features/jumper/smallPlayer.ts';
const cases=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/correction-points.json',import.meta.url)));
for(const f of cases){
 const prompt={frame:6,...(f.points?{points:f.points,labels:f.labels}:{}),...(f.box?{box:f.box}:{}),anchor:false};
 const before=structuredClone(prompt);
 const request={start:0,end:1,target_id:7,objects:[{id:7,prompts:[{frame:0,box:[0,0,1,1]},prompt]}]};
 if(f.conflict){
  assert.throws(()=>correctionPrompt(prompt,7),e=>e.name==='CorrectionConflictError' && /frame 7, track 7/.test(maskingErrorMessage(e)),f.name);
  assert.throws(()=>validateMaskRequest(request),/same processing pixel/,f.name);
 }else{
  const result=correctionPrompt(prompt,7);
  assert.deepEqual(result.points,f.points?f.keep.map(i=>f.points[i]):undefined,f.name);
  assert.deepEqual(result.labels,f.points?f.keep.map(i=>f.labels[i]):undefined,f.name);
  assert.deepEqual(result.box,prompt.box);assert.equal(result.anchor,false);
  assert.doesNotThrow(()=>validateMaskRequest(request));
 }
 assert.deepEqual(prompt,before,'Caller history remains unchanged');
}
// Opposing labels on different frames or different tracks are independent.
const include={frame:0,points:[[.5,.5]],labels:[1]};
const exclude={frame:1,points:[[.5,.5]],labels:[0]};
validateMaskRequest({start:0,end:1,target_id:7,objects:[{id:7,prompts:[include,exclude]},{id:9,prompts:[{...exclude,frame:0}]}]});
// A padded detail crop can merge cells that were distinct in the full frame.
const crop={x:0,y:0,width:100,height:100,padding:[100,100,100,100],box:[0,0,1,1],points:[[.5,.5],[.5011,.5]],labels:[1,0],unusable:false};
assert.doesNotThrow(()=>correctionPrompt({frame:3,points:crop.points,labels:crop.labels},9));
const mapped={frame:3,...sourceCropPrompt(crop,100,100,373,281)};
assert.throws(()=>correctionPrompt(mapped,9,'detail crop'),/frame 4, track 9 \(detail crop\)/);
console.log('Correction pixel conflicts, float32/grid edges, independent frames/tracks, crop mapping, deduplication and immutable history: PASS');
