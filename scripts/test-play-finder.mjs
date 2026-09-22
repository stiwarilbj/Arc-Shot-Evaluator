import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const featurePath = resolve(root, 'frontend/src/features/playFinder');
const catalog = JSON.parse(readFileSync(resolve(featurePath, 'catalog.v1.json'), 'utf8'));
const scratch = mkdtempSync(resolve(tmpdir(), 'arc-play-finder-test-'));

function prepareRuntime(sourcePath, outputPath, replacements = []) {
  let source = readFileSync(sourcePath, 'utf8');
  for (const [before, after] of replacements) {
    assert.ok(source.includes(before), `Expected source marker: ${before}`);
    source = source.replace(before, after);
  }
  writeFileSync(outputPath, source);
}

try {
  const searchRuntime = resolve(scratch, 'search.mts');
  const searchSource = resolve(featurePath, 'search.ts');
  const catalogImport = 'import catalogData from "./catalog.v1.json";';
  const injectedCatalog = `const catalogData = ${JSON.stringify(catalog)};`;
  prepareRuntime(searchSource, searchRuntime, [[catalogImport, injectedCatalog]]);
  const search = await import(`${pathToFileURL(searchRuntime).href}?run=${Date.now()}`);

  const pnrTurnover = search.parsePlayPrompt('pick-and-rolls ending in a turnover');
  assert.ok(pnrTurnover.some((item) => item.field === 'action' && item.value === 'pick-and-roll' && item.status === 'ready'));
  assert.ok(pnrTurnover.some((item) => item.field === 'result' && item.value === 'turnover'));
  assert.ok(search.searchCatalog(pnrTurnover).some((result) => result.clip.id === 'nba-spurs-pnr-turnover-2013-finals'));

  const curryBoston = search.parsePlayPrompt('Curry threes against Boston');
  assert.ok(curryBoston.some((item) => item.field === 'player' && item.status === 'ready'));
  assert.ok(curryBoston.some((item) => item.field === 'opponent'));
  assert.ok(search.searchCatalog(curryBoston).some((result) => result.clip.id === 'nba-finals-curry-three-compilation-2022'));

  const orderedHandoff = search.parsePlayPrompt('Handoffs followed by a backdoor cut');
  assert.ok(orderedHandoff.some((item) => item.field === 'sequence' && item.status === 'ready'));
  const orderedHits = search.searchCatalog(orderedHandoff);
  assert.ok(orderedHits.length > 0, 'ordered handoff-to-cut sequence should have reviewed examples');
  assert.ok(orderedHits.every(({ clip }) => clip.evidence.verifiedFields.includes('sequence')
    && clip.sequence.some((_, index) => clip.sequence[index] === 'handoff' && clip.sequence[index + 1] === 'cut')));

  const excludedTurnover = search.parsePlayPrompt('pick-and-rolls without a turnover');
  assert.ok(excludedTurnover.some((item) => item.field === 'result' && item.operator === 'excludes'));
  assert.ok(search.searchCatalog(excludedTurnover).every(({ clip }) => clip.result !== 'turnover'));
  const excludedAction = search.parsePlayPrompt('without a handoff, show pick and roll');
  assert.ok(excludedAction.some((item) => item.field === 'action' && item.value === 'handoff' && item.operator === 'excludes'));

  const ambiguous = search.parsePlayPrompt('Murray threes');
  const ambiguousPlayer = ambiguous.find((item) => item.field === 'player');
  assert.equal(ambiguousPlayer?.status, 'ambiguous');
  assert.equal(search.searchCatalog(ambiguous).length, 0);
  const resolved = search.resolveAmbiguousCondition(ambiguousPlayer, ambiguousPlayer.candidates[0]);
  assert.ok(search.searchCatalog(ambiguous.map((item) => item.id === ambiguousPlayer.id ? resolved : item)).length > 0);

  const unknownPlayer = search.parsePlayPrompt('Zorblax threes');
  assert.ok(unknownPlayer.some((item) => item.field === 'player' && item.status === 'unsupported'));
  assert.equal(search.searchCatalog(unknownPlayer).length, 0);
  const unsupportedCoverage = search.parsePlayPrompt('zone defense against Boston');
  assert.ok(unsupportedCoverage.some((item) => item.field === 'coverage' && item.status === 'unsupported'));
  const unsupportedClock = search.makeFilterCondition('gameClock', '2:30');
  assert.equal(unsupportedClock.status, 'unsupported');
  assert.equal(search.searchCatalog([unsupportedClock]).length, 0);

  const zeroResults = search.parsePlayPrompt('Curry threes against Boston in 2012-13 playoffs');
  assert.ok(zeroResults.every((item) => item.status === 'ready'));
  assert.equal(search.searchCatalog(zeroResults).length, 0, 'supported but incompatible conditions should remain a genuine zero-result search');

  const collectionsPath = resolve(featurePath, 'collections.ts');
  const collectionsRuntime = resolve(scratch, 'collections.mts');
  prepareRuntime(collectionsPath, collectionsRuntime);
  const collections = await import(`${pathToFileURL(collectionsRuntime).href}?run=${Date.now()}`);
  const store = new Map();
  globalThis.window = { localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  } };
  const first = collections.createCollection('Actions to study');
  first.clipIds.push('nba-spurs-pnr-turnover-2013-finals');
  first.notesByClip[first.clipIds[0]] = 'Watch the weak-side help';
  assert.equal(collections.writeCollections([first]).ok, true);
  assert.deepEqual(collections.readCollections(), [first]);
  const copy = collections.duplicateCollection(first);
  assert.notEqual(copy.id, first.id);
  assert.deepEqual(copy.clipIds, first.clipIds);
  const backup = collections.exportCollections([first, copy]);
  assert.deepEqual(collections.parseCollectionBackup(JSON.stringify(backup)), [first, copy]);
  assert.throws(() => collections.parseCollectionBackup('{"version":99,"collections":[]}'));
  globalThis.window.localStorage.setItem = () => { throw new Error('quota exceeded'); };
  const writeFailure = collections.writeCollections([first]);
  assert.equal(writeFailure.ok, false);
  assert.match(writeFailure.error, /quota exceeded/);

  console.log('Play Finder behavior tests passed: prompt synonyms, ordered actions, exclusions, ambiguous and unsupported conditions, genuine zero results, and collection persistence/import/export/write failure');
} finally {
  delete globalThis.window;
  rmSync(scratch, { recursive: true, force: true });
}
