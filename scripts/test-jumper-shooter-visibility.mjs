import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ShooterVisibility} from '../frontend/src/features/jumper/shooterVisibility.ts';
import {MaskQuality} from '../frontend/src/features/jumper/maskQuality.ts';
import {MaskOwnership} from '../frontend/src/features/jumper/maskOwnership.ts';
const cases=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/jumper/shooter-visibility.json',import.meta.url)));
function pixels(rect){const a=new Float32Array(256*256).fill(-3);if(rect){const[x,y,w,h]=rect;for(let r=y;r<y+h;r++)for(let c=x;c<x+w;c++)a[r*256+c]=3;}return a;}
for(const f of cases){const gate=new ShooterVisibility();for(const [frame,step]of f.frames.entries()){
 const mask=pixels(step.target),before=mask.slice(),others=(step.others??[]).map(pixels);
 const result=gate.inspect(frame,mask,others,step.score??3,256,step.confirmed,step.uncertain);
 assert.equal(result.visible,step.visible,`${f.name} frame ${frame}`);
 assert.equal(result.warning,step.warning,`${f.name} frame ${frame}`);
 assert.deepEqual(mask,before,'Do not mutate caller evidence');
 if(!result.visible)mask.fill(-1024);
 const ownership=new MaskOwnership(256,256);ownership.begin();ownership.add(1,mask);
 others.forEach((a,i)=>ownership.add(i+2,a));const labels=ownership.finish(new Set());
 if(!result.visible)assert(!labels.includes(1),'Hidden shooter must never be painted black');
 if(others.length&&step.target===null)assert(labels.includes(2),'Occluder remains gray');
}}
const gate=new ShooterVisibility();gate.inspect(0,pixels([40,40,20,40]),[],3,256);
gate.inspect(1,pixels(null),[pixels([40,40,20,40])],-1,256);
assert.equal(gate.inspect(46,pixels([40,40,20,40]),[],3,256).warning,'ambiguous_players','Long absence requires confirmation');
const quality=new MaskQuality(),tracks=[{id:1,prompts:[{frame:0}]}];
assert.deepEqual(quality.inspect(1,new Uint8Array(16),4,4,tracks,1,false,new Set([1])),[]);
assert.equal(quality.inspect(2,new Uint8Array(16),4,4,tracks,1)[0].kind,'target_lost','Ordinary tracking loss remains reviewable');
console.log('Shooter visibility, occluder preservation, conservative reacquisition and confirmation passed');
