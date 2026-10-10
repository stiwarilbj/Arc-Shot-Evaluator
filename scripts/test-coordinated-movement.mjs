import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { coordinateMovement, PLAYER_BODY_RADIUS_FEET } from '../frontend/src/features/playbook/coordinatedMovement.ts';
import { createSimulationRun, advanceSimulationRun, SIMULATION_STEP_MS, pointDistanceFeet, getSimulationFrame, setSimulationRunSettings } from '../frontend/src/features/playbook/simulation.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { DEFAULT_SIMULATION_SETTINGS, validatePlaybookParticipants } from '../frontend/src/features/playbook/types.ts';
import { COUNTER_LAB_DEFAULT_PROFILES, COUNTER_LAB_EXTRA_STRATEGIES, eligibleCounterLabSchemes } from '../frontend/src/features/playbook/counterLabTypes.ts';
const dt = 1 / 60, bounds = { left: 0, right: 50, top: 0, bottom: 47 };
const intent = (key, point, velocity = {x:0,y:0}) => ({key, point, velocity, previousVelocity:{x:0,y:0}, speed:19, acceleration:34, priority:3});
const sweptGap = (a, b, nextA, nextB) => {
  const r={x:b.x-a.x,y:b.y-a.y}, v={x:(nextB.x-b.x)-(nextA.x-a.x),y:(nextB.y-b.y)-(nextA.y-a.y)};
  const t=Math.max(0,Math.min(1,-(r.x*v.x+r.y*v.y)/Math.max(1e-12,v.x*v.x+v.y*v.y)));
  return Math.hypot(r.x+v.x*t,r.y+v.y*t);
};
let pair=[intent('a',{x:20,y:20},{x:12,y:0}),intent('b',{x:30,y:20},{x:-12,y:0})];
for(let step=0;step<180;step++) {
  const next=coordinateMovement(pair,dt,bounds);
  assert.deepEqual(next,coordinateMovement(pair,dt,bounds),'joint resolution is deterministic');
  assert.ok(sweptGap(pair[0].point,pair[1].point,next[0].point,next[1].point)>=2-1e-7,'crossing routes never tunnel through bodies');
  pair=pair.map((p,i)=>({...p,point:next[i].point,previousVelocity:next[i].velocity}));
}
let overlap=[intent('a',{x:25,y:20}),intent('b',{x:25,y:20})];
for(let step=0;step<240;step++) {
  const next=coordinateMovement(overlap,dt,bounds);
  next.forEach((n,i)=>assert.ok(Math.hypot(n.point.x-overlap[i].point.x,n.point.y-overlap[i].point.y)<=19*dt+1e-7,'overlaps resolve through bounded travel'));
  overlap=overlap.map((p,i)=>({...p,point:next[i].point,previousVelocity:next[i].velocity}));
}
assert.ok(Math.hypot(overlap[0].point.x-overlap[1].point.x,overlap[0].point.y-overlap[1].point.y)>1.99,'exact overlaps gradually separate');
let free=intent('free',{x:10,y:10},{x:19,y:0});
for(let step=0;step<30;step++) {
  const [next]=coordinateMovement([free],dt,bounds);
  assert.ok(Math.hypot(next.velocity.x-free.previousVelocity.x,next.velocity.y-free.previousVelocity.y)<=34*dt+1e-8,'free movement respects acceleration');
  free={...free,point:next.point,previousVelocity:next.velocity};
}
assert.deepEqual(coordinateMovement([free],0,bounds)[0].point,free.point,'zero time never moves a marker');
const settings={...DEFAULT_SIMULATION_SETTINGS,defenseScheme:'man-to-man',defenseStrategy:'off',offenseMode:'scripted'};
const draft=(players,arrows,ball=players[0])=>({version:1,id:'motion-fixture',name:'Motion fixture',players,arrows,ball:ball?{x:ball.x,y:ball.y}:null,defenders:[{id:1,x:85,y:85}],defenders_visible:true});
const finish=(run)=>{for(let i=0;i<2000&&run.elapsedMs<run.durationMs;i++)advanceSimulationRun(run,SIMULATION_STEP_MS,run.settings);assert.equal(run.elapsedMs,run.durationMs);return run;};
const heldOverlap=draft([{id:1,x:20,y:85}],[]);
heldOverlap.defenders=[{id:1,x:80,y:85},{id:2,x:80,y:85}];
const heldRun=createSimulationRun(heldOverlap,settings);
let prior=heldRun.defenders.map(p=>({...p}));
for(let i=0;i<180&&heldRun.elapsedMs<heldRun.durationMs;i++) {
 const time=heldRun.elapsedMs;advanceSimulationRun(heldRun,SIMULATION_STEP_MS,settings);
 heldRun.defenders.forEach((p,j)=>assert.ok(pointDistanceFeet(p,prior[j])<=2*(heldRun.elapsedMs-time)/1000+.001,'held defenders separate without teleporting'));
 prior=heldRun.defenders.map(p=>({...p}));
}
assert.ok(pointDistanceFeet(...heldRun.defenders)>1.99,'held defenders gradually resolve exact imported overlaps');
const liveHold=createSimulationRun(draft([{id:1,x:20,y:70}],[]),{...settings,defenseStrategy:'contain'});
for(let i=0;i<20;i++)advanceSimulationRun(liveHold,1000/60,liveHold.settings);
const movingVelocity={...liveHold.velocities.get('defender:1')};
assert.ok(Math.hypot(movingVelocity.x,movingVelocity.y)>2,'live hold fixture begins with a moving defender');
setSimulationRunSettings(liveHold,{...settings,defenseStrategy:'off'});
advanceSimulationRun(liveHold,1000/60,liveHold.settings);
const brakingVelocity=liveHold.velocities.get('defender:1');
assert.ok(Math.hypot(brakingVelocity.x-movingVelocity.x,brakingVelocity.y-movingVelocity.y)<=28/60+1e-6,'switching to hold brakes within the acceleration limit');


const curved=draft([{id:1,x:20,y:70},{id:2,x:70,y:85}],[{id:'curve',kind:'movement',actor_id:1,path:'curve',control:{x:55,y:60},start:{x:20,y:70},end:{x:60,y:40},sequence:1,timing:3.5}]);
const snapshot=structuredClone(curved), curvedRun=createSimulationRun(curved,settings);
finish(curvedRun);
assert.equal(curvedRun.actions[0].execution.phase,'completed','unobstructed curved actions reach their destination');
assert.ok(pointDistanceFeet(curvedRun.players[0],curved.arrows[0].end)<.6);
assert.deepEqual(curved,snapshot,'execution never modifies authored documents');
assert.equal(curvedRun.actions.filter(a=>a.automatic||a.adaptiveReadLabel).length,0,'scripted mode centrally suppresses improvisation');
const handoff=draft([{id:1,x:40,y:60},{id:2,x:45,y:60}],[{id:'handoff',kind:'handoff',actor_id:1,recipient_id:2,start:{x:40,y:60},end:{x:45,y:60},sequence:1,timing:1}]);
const handoffRun=createSimulationRun(handoff,settings);let caught=false;
for(let i=0;i<500&&handoffRun.elapsedMs<handoffRun.durationMs;i++) {
  advanceSimulationRun(handoffRun,SIMULATION_STEP_MS,handoffRun.settings);
  if(handoffRun.actions[0].transferCompletedAtMs!=null&&!caught){caught=true;assert.equal(handoffRun.ballHandlerId,2);assert.ok(pointDistanceFeet(...handoffRun.players)<=2.8+1e-5,'handoff requires close participants');assert.ok(pointDistanceFeet(handoffRun.ball,handoffRun.players[1])<=1.1+1e-5,'handoff requires an actual catch');}
}
assert.ok(caught,'reachable handoff completes');
const distant=structuredClone(handoff);distant.players[0].x=10;distant.players[1].x=90;distant.ball.x=10;distant.arrows[0].start.x=10;distant.arrows[0].end.x=90;
const distantRun=finish(createSimulationRun(distant,settings));
assert.equal(distantRun.actions[0].execution.phase,'obstructed','unreachable handoffs report obstruction');
assert.equal(distantRun.ballHandlerId,1,'failed handoffs leave the ball with the giver');
assert.ok([...distantRun.phaseWaitMs.values()].every(wait=>wait<=1200+1e-6),'phase waiting stays bounded');
const cadence=[];
for(const hz of [30,60,120]) {
 const run=createSimulationRun(curved,settings);
 for(let frame=0;frame<hz*3;frame++)advanceSimulationRun(run,1000/hz,settings);
 cadence.push(run.players);
}
assert.deepEqual(cadence[0],cadence[1],'30/60Hz calls execute identical fixed steps');
assert.deepEqual(cadence[1],cadence[2],'60/120Hz calls execute identical fixed steps');
const stopped=curvedRun.players.map(p=>({...p}));
for(let i=0;i<30;i++)advanceSimulationRun(curvedRun,SIMULATION_STEP_MS,settings);
assert.deepEqual(curvedRun.players,stopped,'finished routes remain stopped');

const wrong=structuredClone(handoff);wrong.arrows[0]={...wrong.arrows[0],kind:'pass',actor_id:2,recipient_id:1};
const wrongRun=createSimulationRun(wrong,settings);advanceSimulationRun(wrongRun,100,wrongRun.settings);
assert.equal(wrongRun.actions[0].execution.phase,'obstructed','a non-holder cannot throw the ball');
assert.equal(wrongRun.ballHandlerId,1,'invalid transfers never fabricate possession');
const conflict=structuredClone(curved);conflict.arrows.push({...conflict.arrows[0],id:'second-route',end:{x:10,y:40}});
const conflictRun=createSimulationRun(conflict,settings);advanceSimulationRun(conflictRun,100,conflictRun.settings);
assert.equal(conflictRun.actions[1].execution.phase,'conflict');
assert.match(conflictRun.actions[1].execution.notice,/Move 1/);
assert.throws(()=>validatePlaybookParticipants({...curved,arrows:[{...curved.arrows[0],actor_id:99}]}));

if(process.env.ARC_MOVEMENT_FIXTURES_ONLY==='1'){console.log('Coordinated movement fixtures passed');process.exit(0);}

// Reproduce the original 288-trial audit, then cover every extra tactic and eligible zone.
const report={bodyRadiusFeet:PLAYER_BODY_RADIUS_FEET,measurement:"Live authored action positions from 300ms onward; imported overlaps separate gradually.",before:{trials:288,trialsWithCentersBelowOneFoot:261},after:{trials:0,trialsWithCentersBelowOneFoot:0,minimumGapFeet:Infinity,minimumGapTrial:null},additional:{trials:0},outcomes:{completed:0,obstructed:0,conflict:0}};
const audit=(play,profile,mode,baseline)=>{
 const run=createSimulationRun(play,{...DEFAULT_SIMULATION_SETTINGS,offenseMode:mode,defenseScheme:profile.scheme,defenseStrategy:profile.strategy});
 let min=Infinity, previous=[...run.players,...run.defenders].map(p=>({...p}));
 for(let step=0;step<2400&&run.elapsedMs<run.durationMs;step++) {
  const time=run.elapsedMs;advanceSimulationRun(run,SIMULATION_STEP_MS,run.settings);const seconds=(run.elapsedMs-time)/1000;
  const markers=[...run.players,...run.defenders];
  markers.forEach((p,i)=>{assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y),`${play.name} finite positions`);assert.ok(pointDistanceFeet(p,previous[i])<=(i<run.players.length?19:15)*seconds+.003,`${play.name} speed bound`);});
  if(run.elapsedMs>=300&&run.elapsedMs<=run.actionDurationMs) for(let a=0;a<markers.length;a++)for(let b=a+1;b<markers.length;b++)min=Math.min(min,pointDistanceFeet(markers[a],markers[b]));
  for(let a=0;a<markers.length;a++)for(let b=a+1;b<markers.length;b++)if(pointDistanceFeet(previous[a],previous[b])>=2.0001)assert.ok(pointDistanceFeet(markers[a],markers[b])>=1.999,`${play.name} swept clearance`);
  previous=markers.map(p=>({...p}));
 }
 assert.equal(run.elapsedMs,run.durationMs,`${play.name} bounded retries`);
 if(baseline){report.after.trials++;if(min<report.after.minimumGapFeet){report.after.minimumGapFeet=min;report.after.minimumGapTrial=`${play.name} / ${profile.id} / ${mode}`;}if(min<1)report.after.trialsWithCentersBelowOneFoot++;}else report.additional.trials++;
 for(const a of run.actions){const phase=a.execution?.phase;if(phase in report.outcomes)report.outcomes[phase]++;if(phase==='completed')assert.ok(a.execution.completedAtMs!=null,'completion requires execution evidence');}
 return run;
};
for(const play of STARTER_PLAYS)for(const profile of COUNTER_LAB_DEFAULT_PROFILES)for(const mode of ['scripted','adaptive'])audit(play,profile,mode,true);
assert.equal(report.after.trials,288);
assert.equal(report.after.trialsWithCentersBelowOneFoot,0,'no severe body overlap in the complete starter matrix');
for(const play of STARTER_PLAYS)for(const profile of [...COUNTER_LAB_EXTRA_STRATEGIES,...eligibleCounterLabSchemes(5,play.players.length)])for(const mode of ['scripted','adaptive'])audit(play,profile,mode,false);
const repeatA=audit(STARTER_PLAYS[0],COUNTER_LAB_DEFAULT_PROFILES[0],'scripted',false),repeatB=audit(STARTER_PLAYS[0],COUNTER_LAB_DEFAULT_PROFILES[0],'scripted',false);
assert.deepEqual(getSimulationFrame(repeatA),getSimulationFrame(repeatB),'full engine comparisons are deterministic');
report.after.minimumGapFeet=Number(report.after.minimumGapFeet.toFixed(6));
if(process.env.ARC_MOVEMENT_AUDIT_FILE)writeFileSync(process.env.ARC_MOVEMENT_AUDIT_FILE,JSON.stringify(report,null,2)+'\n');
console.log('Coordinated movement passed:',JSON.stringify(report));
