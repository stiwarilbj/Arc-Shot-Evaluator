import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TEST_SECONDS, challengeFromSeed, chooseChallenge, formatStability, measure, motionFeatures, poseAt, randomStep, solution, stable, steadyScore, tierFor } from '../frontend/src/features/games/shotformMotion.ts';
import { BALL_RADIUS, projectCourtPoint, shotBallPosition } from '../frontend/src/features/games/shotformCourt.ts';
import { complete, createShotformSession, currentChallenge, loadShotformSession, nextShotformRound, saveShotformSession, score, stageNudge, testNudge, undoNudge, validateShotformSession } from '../frontend/src/features/games/shotformSession.ts';
import { highlightedArea, inferMotion, validMotionModel, verifiedMotionModel } from '../frontend/src/features/games/shotformPrediction.ts';
assert.equal(TEST_SECONDS,4.8,"Browser range endpoint must unlock a paused test exactly");
let seed = 930911;
const random = () => { let v; [seed,v] = randomStep(seed); return v; };
const length = (a,b) => Math.hypot(...a.map((v,i) => v-b[i]));
for (let n=0;n<180;n++) {
  const round = [1,4,7][n%3], {challenge:c} = chooseChallenge(Math.floor(random()*4294967296),round);
  assert(c.minimum>=2 && c.minimum<=8); assert(!stable(measure(c,c.start)));
  assert.equal(measure(c,c.start).filter(value=>!steadyScore(value)).length,tierFor(round),'new challenge starts with the tier number of unstable areas');
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
const oneMove=testNudge(stageNudge(fresh,{axis:0,direction:fresh.controls[0]<4?1:-1}));
const realUndo=undoNudge(oneMove);
assert(validateShotformSession(realUndo),"a real undo remains restorable");
assert(!validateShotformSession({...oneMove,previous:null}),"a changed one-test board cannot erase its required undo history");
assert.equal(loadShotformSession(()=>({getItem:()=>JSON.stringify({...oneMove,previous:null}),setItem(){}})).restored,false,"an impossible undo save recovers as a new game");
assert.equal(formatStability(79.983),'<80'); assert.equal(formatStability(80),'80.0');
assert.equal(steadyScore(79.983),false); assert.equal(steadyScore(80),true);

// Previously saved v1 challenges remain valid even if they do not match the new tier-count rule
function legacySession(round) {
  const seeds=[], ids=new Set();
  for(let historyRound=round-2;historyRound<=round;historyRound++) {
    const required=tierFor(historyRound); let selected=null;
    for(let seed=10000+historyRound*1000;seed<200000;seed++) {
      const c=challengeFromSeed(seed,historyRound), unstable=measure(c,c.start).filter(value=>!steadyScore(value)).length;
      if(c.minimum<2||c.minimum>8||ids.has(c.id)||(historyRound===round&&unstable===required))continue;
      selected={seed,c}; break;
    }
    assert(selected,`find an old-style saved challenge for round ${historyRound}`);
    seeds.push(selected.seed); ids.add(selected.c.id);
  }
  const last=seeds.at(-1),c=challengeFromSeed(last,round);
  const session={...createShotformSession(987),round,challengeSeed:last,rng:last,recentSeeds:seeds,controls:[...c.start],previous:null,pending:null,tests:0,completed:round-1,bestScore:0};
  assert.notEqual(measure(c,c.start).filter(value=>!steadyScore(value)).length,tierFor(round));
  assert(validateShotformSession(session));
}
legacySession(4); legacySession(7);

// A first completed result must carry the actual immediately preceding tested controls and score
let suboptimal=createShotformSession(50),goal=solution(currentChallenge(suboptimal));
const firstAxis=suboptimal.controls.findIndex((v,i)=>v!==goal[i]),firstDirection=Math.sign(goal[firstAxis]-suboptimal.controls[firstAxis]);
suboptimal=testNudge(stageNudge(suboptimal,{axis:firstAxis,direction:firstDirection}));
suboptimal=testNudge(stageNudge(suboptimal,{axis:firstAxis,direction:-firstDirection}));
while(!complete(suboptimal)) {
  const axis=suboptimal.controls.findIndex((v,i)=>v!==goal[i]);
  suboptimal=testNudge(stageNudge(suboptimal,{axis,direction:Math.sign(goal[axis]-suboptimal.controls[axis])}));
}
assert(score(suboptimal)<100); assert(validateShotformSession(suboptimal));
assert(!validateShotformSession({...suboptimal,previous:null}));
assert(!validateShotformSession({...suboptimal,bestScore:100}));
const roundTwo=nextShotformRound(suboptimal);
assert(validateShotformSession(roundTwo));
assert(!validateShotformSession({...roundTwo,bestScore:99}),"a best score the formula cannot produce is rejected");
assert.equal(loadShotformSession(()=>({getItem:()=>JSON.stringify({...roundTwo,bestScore:99}),setItem(){}})).restored,false,"an impossible best score recovers as a new game");

// The ball remains inside the SVG, is continuous at release, and follows a path fixed at release
for(let n=0;n<24;n++) {
  const round=[1,4,7][n%3],c=challengeFromSeed(624214377+n,round);
  for(const controls of [c.start,[-4,-4,-4],[4,4,4],[-4,4,-4],[4,-4,4]]) for(let rep=0;rep<3;rep++) {
    const atRelease=shotBallPosition(c,controls,rep,.52),justBefore=shotBallPosition(c,controls,rep,.52-1e-7),justAfter=shotBallPosition(c,controls,rep,.52+1e-7);
    assert(Math.hypot(justBefore[0]-justAfter[0],justBefore[1]-justAfter[1])<.01,'ball path is continuous at release');
    for(let frame=0;frame<=100;frame++) {
      const t=frame/100,p=shotBallPosition(c,controls,rep,t);
      assert(p.every(Number.isFinite));
      assert(p[0]>=BALL_RADIUS+14&&p[0]<=620-BALL_RADIUS-14&&p[1]>=BALL_RADIUS+14&&p[1]<=440-BALL_RADIUS-14,'ball and radius stay within the court with a safe margin');
      if(t>.52) {
        const u=(t-.52)/.48,inv=1-u,target=[470,169],dx=target[0]-atRelease[0],controlY=BALL_RADIUS+14;
        const expected=[inv**3*atRelease[0]+3*inv**2*u*(atRelease[0]+dx/3)+3*inv*u**2*(atRelease[0]+2*dx/3)+u**3*target[0],inv**3*atRelease[1]+3*inv**2*u*controlY+3*inv*u**2*controlY+u**3*target[1]];
        assert(Math.hypot(p[0]-expected[0],p[1]-expected[1])<1e-9,'flight remains anchored to the recorded release position');
      }
    }
  }
}
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
