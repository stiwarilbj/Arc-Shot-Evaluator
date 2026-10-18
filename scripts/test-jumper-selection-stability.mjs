import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {maskingErrorMessage} from '../frontend/src/features/jumper/domain.ts';
import {ShooterSelectionError} from '../frontend/src/features/jumper/discovery.ts';
import {selectionProbes,stableSelection} from '../frontend/src/features/jumper/selectionStability.ts';
const fixtures=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/selection-stability.json',import.meta.url)));
function mask(rects) {
 const result=new Float32Array(65536).fill(-4);
 for(const [x,y,w,h] of rects)for(let py=y;py<y+h;py++)for(let px=x;px<x+w;px++)result[py*256+px]=4;
 return result;
}
for(const f of fixtures.comparisons)assert.equal(stableSelection(mask(f.a),mask(f.b)),f.stable,f.name);
const baseline=mask([[70,35,80,180]]);
const prompt={frame:0,box:[.2,.1,.7,.9],points:[[.4,.5],[.43,.6],[.65,.2]],labels:[1,1,0]};
const original=structuredClone(prompt),before=baseline.slice();
const probes=selectionProbes(prompt,baseline);
assert.equal(probes.length,3);
assert.deepEqual(probes.map(p=>p.points[0]),fixtures.points);
for(const probe of probes) {
 assert.deepEqual(probe.box,prompt.box);assert.deepEqual(probe.labels,prompt.labels);
 assert.deepEqual(probe.points.slice(1),prompt.points.slice(1));
 const [x,y]=probe.points[0];assert(baseline[Math.floor(y*256)*256+Math.floor(x*256)]>0);
}
probes[0].box[0]=0;probes[0].points[1][0]=0;
assert.deepEqual(prompt,original);assert.deepEqual(baseline,before);
assert.deepEqual(selectionProbes({frame:0,points:[[.4,.5]],labels:[1]},baseline),[]);
assert.deepEqual(selectionProbes({frame:0,box:prompt.box},baseline),[]);
assert.throws(()=>selectionProbes(prompt,mask([[102,128,1,1]])),/another Include point/);
const bad=baseline.slice();bad[1]=NaN;assert(!stableSelection(bad,baseline));
assert(!stableSelection(new Float32Array(1),baseline));
console.log('Selection stability: shared mask thresholds, independent nearby prompts, preserved confirmations/exclusions, tiny masks, invalid numbers and immutability passed');

assert.equal(maskingErrorMessage(new ShooterSelectionError("Add another Include point")),"Add another Include point");
