import assert from 'node:assert/strict';
import { mergeDetectedPeople } from '../frontend/src/features/jumper/mergeDetections.ts';
import { CorrectionHistory } from '../frontend/src/features/jumper/correctionHistory.ts';
const shooter = { id: 7, prompts: [
  {frame:0, points:[[.7,.4],[.8,.5]], labels:[1,0]},
  {frame:12, points:[[.71,.45]], labels:[1]},
]};
const other = {id:2, ignored:true, prompts:[{frame:0,box:[.05,.1,.2,.8]}, {frame:20,points:[[.1,.5]], labels:[0]}]};
const tracks = [shooter,other];
const before = structuredClone(tracks);
const boxes = [[.05,.1,.2,.8],[.6,.1,.8,.9],[.3,.1,.4,.9]];
const merged = mergeDetectedPeople(tracks,7,boxes);
assert.equal(merged.added,1);
assert.equal(merged.tracks[0],shooter);
assert.equal(merged.tracks[1],other);
assert.equal(merged.tracks[2].id,1);
assert.equal(merged.tracks[2].prompts[0].box === boxes[2],false);
assert.deepEqual(tracks,before,'existing IDs, flags, points and later corrections never change');
assert.deepEqual(mergeDetectedPeople(tracks,7,[...boxes].reverse()).tracks,merged.tracks,'detection order must not change the shooter');
assert.equal(mergeDetectedPeople(merged.tracks,7,boxes).tracks,merged.tracks,'repeat discovery is a no-op');
const correctedBox = [{...shooter, prompts:[{...shooter.prompts[0],box:boxes[1]},shooter.prompts[1]]}];
assert.equal(mergeDetectedPeople(correctedBox,7,[boxes[1]]).tracks,correctedBox);
for (const [existing, detections] of [
  [tracks, []],
  [tracks, [boxes[0],boxes[2]]],
  [tracks, [...boxes,boxes[1]]],
  [[...tracks,{id:9,prompts:[{frame:5,box:boxes[2]}]}], boxes],
  [[...tracks,{id:9,prompts:[]}], boxes],
  [[...tracks,{id:9,prompts:[{frame:0,box:boxes[0]}]}], boxes],
]) {
  const result=mergeDetectedPeople(existing,7,detections);
  assert.equal(result.tracks,existing,'uncertain matches leave all corrections intact');
  assert.equal(result.added,0);
  assert.match(result.message,/could not be matched safely/);
}
assert.equal(mergeDetectedPeople([],7,boxes).added,0,'never choose a shooter using detection order');
const overlapping = [...boxes, [.31,.1,.42,.9]];
const skipped = mergeDetectedPeople(tracks,7,overlapping);
assert.equal(skipped.added,0);
assert.match(skipped.message,/2 overlapping detections/);
assert.equal(mergeDetectedPeople(tracks,7,[boxes[0],boxes[1],[.79,.2,.9,.8]]).added,0,'an overlapping proposal is not duplicated as a new person');
const capacity = Array.from({length:20},(_,i)=>({id:i+1,prompts:[{frame:0,box:[i/25,0,(i+.5)/25,.1]}]}));
const crowded = mergeDetectedPeople(capacity,1,[...capacity.map(t=>t.prompts[0].box),[.9,.5,1,1]]);
assert.equal(crowded.tracks,capacity);
assert.match(crowded.message,/limit/);
assert.throws(()=>mergeDetectedPeople(tracks,7,[[NaN,0,1,1]]),/Invalid person/);
const highID = [{...shooter,id:255}];
assert.equal(mergeDetectedPeople(highID,255,[boxes[1],boxes[2]]).tracks[1].id,1);
const history = new CorrectionHistory();
const state = {tracks,target:7,editing:2,frame:12,negative:true,automatic:true};
history.record(state,'Find people');
assert.deepEqual(history.undo({...state,tracks:merged.tracks}),state);
assert.deepEqual(history.redo(state),{...state,tracks:merged.tracks});
console.log('Detection merges: stable shooter/IDs/corrections, removed tracks, order independence, repeat discovery, ambiguity, missing/later tracks, limits, immutable proposals and undo/redo passed');
