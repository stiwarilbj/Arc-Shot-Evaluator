import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePlaybookDocument, validateSavedPlaybook } from '../frontend/src/features/playbook/documentValidation.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { createCounterLabRepairs } from '../frontend/src/features/playbook/counterLabTypes.ts';
let repairs = 0;
for (const play of STARTER_PLAYS) {
  validatePlaybookDocument(play);
  for (const repair of createCounterLabRepairs(play)) { validatePlaybookDocument(repair.play); repairs++; }
}
console.log(`All ${STARTER_PLAYS.length} starters and ${repairs} generated repair candidates satisfy the persistence contract`);
const examples = JSON.parse(readFileSync(new URL('../tests/fixtures/playbook-documents.json', import.meta.url)));
for (const { name, valid, document } of examples) {
  const before = structuredClone(document);
  if (valid) { validatePlaybookDocument(document); assert.deepEqual(document, before, `${name}: validation cannot mutate valid documents`); }
  else assert.throws(() => validatePlaybookDocument(document), undefined, name);
}
for (const value of [NaN, Infinity, -Infinity]) {
  for (const field of ['x', 'y']) {
    const play = structuredClone(examples[0].document); play.players[0][field] = value;
    assert.throws(() => validatePlaybookDocument(play));
  }
}
validateSavedPlaybook(examples[0].document);
assert.throws(() => validateSavedPlaybook({ ...examples[0].document, id: '' }));
console.log(`Browser document validation passed: ${examples.length} shared examples, finite coordinates and immutable valid documents`);
