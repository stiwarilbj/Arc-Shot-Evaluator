import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BallAttachments,validHands} from '../frontend/src/features/jumper/ballAttachments.ts';
import {maskResult} from '../frontend/src/features/jumper/domain.ts';
import {warningLabels} from '../frontend/src/features/jumper/warningTimeline.ts';
const fixtures=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/ball-attachments.json',import.meta.url)));
for(const f of fixtures){
 const check=new BallAttachments();
 for(let frame=0;frame<f.frames;frame++){
  const labels=new Uint8Array(f.width*f.height),gray=new Uint8Array(labels.length).fill(220);
  const rect=([l,t,r,b])=>{for(let y=t;y<b;y++)for(let x=l;x<r;x++){labels[y*f.width+x]=1;gray[y*f.width+x]=80;}};
  if(f.mask_body!==false){rect(f.body);rect(f.head);rect(f.arm);}
  const [cx,cy,radius]=f.ball;
  for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if((x-cx)**2+(y-cy)**2<=radius**2){
    if(f.mask_ball!==false)labels[y*f.width+x]=f.ball_owner??1;
    if(f.image_ball!==false)gray[y*f.width+x]=80;
  }
  if(f.image_ball===false)gray.fill(220);
  let hands=[[...f.box,...f.wrist,0,0,0]];
  if(f.duplicate)hands.push([...hands[0]]);
  if(f.missing?.includes(frame))hands=[];
  if(f.invalid)hands=[[...hands[0],NaN]];
  const before=labels.slice(),beforeGray=gray.slice(),beforeHands=structuredClone(hands);
  const warnings=check.inspect(f.at?.[frame]??frame,labels,gray,f.width,f.height,1,hands,f.resets?.includes(frame));
  assert.deepEqual(warnings,f.expected[frame].map(at=>({frame:at,kind:'ball_attachment',track_ids:[1]})),`${f.name}: ${frame}`);
  assert.deepEqual(labels,before);assert.deepEqual(gray,beforeGray);assert.deepEqual(hands,beforeHands);
  labels.fill(0);gray.fill(0);
  const blob=new Blob(['video'],{type:'video/mp4'});
  assert(maskResult({duration:1,highlight:blob,quiz:blob,reveal:blob,warnings}));
 }
}
assert(validHands([]));assert(!validHands([[NaN]]));
assert.equal(warningLabels.ball_attachment,'Possible ball in shooter mask');
console.log(`PASS ${fixtures.length} shared ball-attachment fixtures: circular wrist evidence, hand preservation, temporal reset, ambiguity, release, cropped/tiny players and immutable inputs`);
