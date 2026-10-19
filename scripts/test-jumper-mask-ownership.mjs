import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MaskOwnership } from '../frontend/src/features/jumper/maskOwnership.ts';
const fixtures = JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/mask-ownership.json', import.meta.url)));
function permutations(items) {
  if (!items.length) return [[]];
  return items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map(rest => [item, ...rest]));
}
function schedules(frames) {
  if (!frames.length) return [[]];
  return permutations(frames[0].scores).flatMap(scores => schedules(frames.slice(1)).map(rest => [{ ...frames[0], scores }, ...rest]));
}
for (const fixture of fixtures) for (const frames of schedules(fixture.frames)) {
  const ownership = new MaskOwnership(fixture.width, fixture.height);
  let previous;
  for (const [index, frame] of frames.entries()) {
    ownership.begin();
    const scores = frame.scores.map(([id, sparse]) => {
      const values = new Float32Array(fixture.width * fixture.height).fill(-2);
      for (const [pixel, score] of sparse) values[pixel] = score;
      const snapshot = values.slice();
      ownership.add(id, values);
      assert.deepEqual(values, snapshot);
      return [id, values];
    });
    const raw = ownership.owners.slice();
    const labels = ownership.finish(new Set(frame.excluded), frame.reset);
    assert.deepEqual([...labels], frame.labels, `${fixture.name}: ${index}`);
    for (let pixel = 0; pixel < labels.length; pixel++) {
      if (labels[pixel]) assert(scores.some(([id, values]) => id === labels[pixel] && values[pixel] > 0), 'only positive current masks may own pixels');
      if (labels[pixel] !== raw[pixel]) assert(previous?.[pixel] === labels[pixel] || labels[pixel] === 0);
      assert(!frame.excluded.includes(labels[pixel]));
    }
    previous = labels.slice();
    labels.fill(255); // Render/checkpoint consumers cannot corrupt temporal history.
  }
}
console.log('Mask ownership: uncertain flicker, two-frame cap, strong occlusion, current/core evidence, missing masks, resets, exclusions, symmetric colors, independent frames and every per-frame track-order permutation passed');
