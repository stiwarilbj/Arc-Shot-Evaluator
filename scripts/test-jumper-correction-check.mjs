import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkCorrections} from '../frontend/src/features/jumper/correctionCheck.ts';
import {maskResult} from '../frontend/src/features/jumper/domain.ts';
import {warningLabels,warningFrames} from '../frontend/src/features/jumper/warningTimeline.ts';
const cases=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/correction-check.json',import.meta.url)));
for(const f of cases){
 const owners=Uint8Array.from(f.owners),before=owners.slice(),tracks=structuredClone(f.tracks);
 const result=checkCorrections(f.frame,owners,f.width,f.height,f.tracks);
 assert.deepEqual(result,f.expected,f.name);
 assert.deepEqual(owners,before,'Check never paints over failures');
 assert.deepEqual(f.tracks,tracks,'Check never changes prompts');
 for(const warning of result){
  assert(warningLabels[warning.kind]);
  assert.deepEqual(warningFrames(result,warning.kind),[f.frame]);
 }
 const blob=new Blob(['fixture'],{type:'video/mp4'});
 assert(maskResult({duration:.1,highlight:blob,quiz:blob,reveal:blob,warnings:result}),f.name);
}
console.log('Correction point membership, final ownership, frame scope, warnings, and immutability passed');
