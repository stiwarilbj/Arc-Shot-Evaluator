import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TEST_SECONDS, challengeFromSeed, chooseChallenge, measure, motionFeatures, poseAt, randomStep, solution, stable } from '../frontend/src/features/games/shotformMotion.ts';
import { complete, createShotformSession, currentChallenge, loadShotformSession, nextShotformRound, saveShotformSession, score, stageNudge, testNudge, undoNudge, validateShotformSession } from '../frontend/src/features/games/shotformSession.ts';
import { highlightedArea, inferMotion, validMotionModel, verifiedMotionModel } from '../frontend/src/features/games/shotformPrediction.ts';
assert.equal(TEST_SECONDS,4.8,"Browser range endpoint must unlock a paused test exactly");
let seed = 930911;
const random = () => { let v; [seed,v] = randomStep(seed); return v; };
const length = (a,b) => Math.hypot(...a.map((v,i) => v-b[i]));
for (let n=0;n<180;n++) {
  const round = [1,4,7][n%3], {challenge:c} = chooseChallenge(Math.floor(random()*4294967296),round);
  assert(c.minimum>=2 && c.minimum<=8); assert(!stable(measure(c,c.start)));
  assert(stable(measure(c,c.target)));
  { const best=solution(c); assert.equal(best.reduce((sum,v,i)=>sum+Math.abs(v-c.start[i]),0),c.minimum); }
  for(const controls of [c.start,c.target,[-4,-4,-4],[4,4,4],[-4,4,-4],[4,-4,4]]) {
    for(let step=0;step<=30;step++) for(let rep=0;rep<3;rep++) {
      const pose=poseAt(c,controls,rep,step/30);
      assert(Object.values(pose).flat().every(Number.isFinite));
      for(const side of ['left','right']) for(const [a,b,d] of [['Hip','Knee',.48],['Knee','Ankle',.48],['Shoulder','Elbow',.29],['Elbow','Wrist',.26],['Wrist','Hand',.13]]) assert(Math.abs(length(pose[side+a],pose[side+b])-d)<1e-10,`${side}${a} length`);
    }
    assert.deepEqual(motionFeatures(c,controls),motionFeatures(c,controls));
  }
  const shifted=[...c.target];shifted[0]++;
  const center=controls=>[0,1,2].reduce((sum,rep)=>sum+poseAt(c,controls,rep,.58).hips[0],0)/3;
  assert(center(shifted)>center(c.target),'Shift right moves the mean body position right');
  for(let axis=0;axis<3;axis++) {
    const moved=[...c.target]; moved[axis]++;
    const deltas=measure(c,moved);
    assert(deltas.every(v=>v<100),'Adjustment couples into every area');
  }
  assert.deepEqual(challengeFromSeed(c.seed,round),c);
}
// One change per test, deterministic score, no refunded experiments, completion exactly once
let s = createShotformSession(50);
for(let round=1;round<=12;round++) {
  assert(validateShotformSession(s)); assert.equal(s.round,round);
  const c=currentChallenge(s), target=solution(c); let safety=0;
  while(!complete(s)) {
    const axis=s.controls.findIndex((v,i)=>v!==target[i]), direction=Math.sign(target[axis]-s.controls[axis]);
    const staged=stageNudge(s,{axis,direction}); assert.notEqual(staged,s); assert.equal(stageNudge(staged,{axis,direction}),staged); assert(validateShotformSession(staged));
    const tested=testNudge(staged); assert.equal(tested.tests,s.tests+1); assert.equal(testNudge(tested),tested); assert(validateShotformSession(tested));
    if(!complete(tested)&&s.tests===0) { const undo=undoNudge(tested); assert.deepEqual(undo.controls,s.controls); assert.equal(undo.tests,tested.tests); assert(validateShotformSession(undo)); assert.equal(undoNudge(undo),undo); }
    s=tested; assert(++safety<=8);
  }
  assert.equal(score(s),100); assert.equal(s.completed,round); assert.equal(testNudge(s),s); assert.equal(undoNudge(s),s);
  assert(validateShotformSession(JSON.parse(JSON.stringify(s))));
  s=nextShotformRound(s);
}
const fresh=createShotformSession(177);
assert.equal(nextShotformRound(fresh),fresh);
for(const corrupt of [null,{}, {...fresh,engine:'old'}, {...fresh,controls:[NaN,0,0]}, {...fresh,tests:-1}, {...fresh,controls:[4,4,4]}, {...fresh,completed:1}, {...fresh,previous:[0,0,0]}, {...fresh,recentSeeds:[]}, {...fresh,pending:{axis:4,direction:1}}, {...fresh,pending:{axis:0,direction:NaN}}]) assert(!validateShotformSession(corrupt));
for (let axis=0;axis<3;axis++) for (const direction of [-1,1]) {
  const boundary={...fresh,controls:[...fresh.controls]}; boundary.controls[axis]=direction*4;
  assert.equal(stageNudge(boundary,{axis,direction}),boundary);
}
const staged=stageNudge(fresh,{axis:0,direction:fresh.controls[0]<4?1:-1});
let stored=''; const storage=()=>({getItem:()=>stored,setItem:(_,v)=>stored=v});
assert(saveShotformSession(staged,storage)); assert.deepEqual(loadShotformSession(storage).session,staged);
assert.equal(saveShotformSession(staged,()=>{throw Error('quota')}),false);
assert.equal(loadShotformSession(()=>{throw Error('blocked')}).storageAvailable,false);
stored='{"bad":true}'; assert(validateShotformSession(loadShotformSession(storage).session));
const bytes=new Uint8Array(readFileSync(new URL('../frontend/src/features/games/shotform-model.json',import.meta.url)));
const model=await verifiedMotionModel(bytes); assert(validMotionModel(model));
const damaged=bytes.slice();damaged[100]^=1;await assert.rejects(verifiedMotionModel(damaged));
for(const corrupt of [null,{}, {...model,layers:[null,null,null]}, {...model,layers:[{weights:null,bias:[]},...model.layers.slice(1)]}, {...model,validation:null}, {...model,featureDefinition:null}, {...model,scale:0}]) assert(!validMotionModel(corrupt));
const rows=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types',new URL('./shotform-dataset.mjs',import.meta.url).pathname,'791915'],{maxBuffer:8*1024*1024,encoding:'utf8'}));
let errors=[],eligible=0,identified=0;
for(const [features,truth] of rows) {
  const pred=inferMotion(model,features); errors.push(...pred.map((v,i)=>Math.abs(v-truth[i])));
  const order=truth.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v);
  if(order[1].v-order[0].v>5) { eligible++; if(pred.indexOf(Math.min(...pred))===order[0].i) identified++; }
}
errors.sort((a,b)=>a-b);assert(errors[Math.floor(errors.length*.99)]<=2);assert(errors.at(-1)<=5);assert(identified/eligible>=.98);
for(let n=0;n<300;n++) {
  const c=challengeFromSeed(890001+n,[1,4,7][n%3]);
  for(const controls of [c.start,c.target,[-4,-4,-4],[4,4,4],[-4,4,-4],[4,-4,4]]) {
    const exact=measure(c,controls),pred=inferMotion(model,motionFeatures(c,controls));
    assert(pred.every((v,i)=>Math.abs(v-exact[i])<=5),'Boundary model error');
    assert.equal(highlightedArea(c,controls,null),exact.indexOf(Math.min(...exact)));
  }
}
console.log(`Shotform: 180 seeded challenges, fixed bones, coupled motion, 12 complete rounds, locks/undo/storage, pinned model and 12,000 held-out samples passed (p99 ${errors[Math.floor(errors.length*.99)].toFixed(3)}, max ${errors.at(-1).toFixed(3)}, region ${(100*identified/eligible).toFixed(1)}%)`);
