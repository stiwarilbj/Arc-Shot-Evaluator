import assert from 'node:assert/strict';
import { answerRound, calculateTotals, calculation, createSession, difficultyFor, formatTotal, generatePuzzle, keysFor, nextRound, validatePuzzle, validateSession } from '../frontend/src/features/games/boxScore.ts';
import { loadPractice, PRACTICE_KEY, savePractice } from '../frontend/src/features/games/boxScoreStorage.ts';

function seeded(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function expectedTotals(s) {
  const percent = (m, a) => a ? Number((m / a * 100).toFixed(1)) : 0;
  return {points: s.fgm * 2 + s.threeMade + s.ftm, rebounds: s.oreb + s.dreb, misses: s.fga - s.fgm, fgPct: percent(s.fgm, s.fga), threePct: percent(s.threeMade, s.threeAttempts), ftPct: percent(s.ftm, s.fta)};
}
const seenFields = new Set();
for (const correct of [0, 4, 5, 9, 10, 100]) {
  const random = seeded(200 + correct);
  const recent = [];
  let previous;
  for (let n = 0; n < 1000; n++) {
    const puzzle = generatePuzzle(correct, recent, previous, random);
    assert(validatePuzzle(puzzle));
    const expected = expectedTotals(puzzle.source);
    assert.deepEqual(calculateTotals(puzzle.source), expected);
    assert.equal(puzzle.source.fgm - puzzle.source.threeMade <= puzzle.source.fga - puzzle.source.threeAttempts, true);
    assert.deepEqual(keysFor(puzzle.difficulty).filter(k => puzzle.totals[k] !== expected[k]), [puzzle.wrongField]);
    if (previous) {
      assert.notEqual(puzzle.wrongField, previous.wrongField);
      assert(Math.abs((puzzle.totals[puzzle.wrongField] - expected[puzzle.wrongField]) - (previous.totals[previous.wrongField] - expectedTotals(previous.source)[previous.wrongField])) > 1e-8);
    }
    assert(!recent.includes(puzzle.id));
    seenFields.add(puzzle.wrongField);
    recent.push(puzzle.id); if (recent.length > 64) recent.shift(); previous = puzzle;
  }
}
assert.equal(seenFields.size, 6);
// Degenerate RNGs must not make endless practice hang or repeat recent puzzles.
for (const random of [() => 0, () => 0.999999]) {
  let session = createSession(random);
  for (let n = 0; n < 200; n++) {
    session = answerRound(session, session.puzzle.wrongField);
    session = nextRound(session, random);
    assert(validateSession(session));
    assert.equal(new Set(session.recentIds).size, session.recentIds.length);
  }
}
for (const s of [
  {fgm:0,fga:1,threeMade:0,threeAttempts:0,ftm:0,fta:0,oreb:0,dreb:0},
  {fgm:5,fga:5,threeMade:5,threeAttempts:5,ftm:4,fta:4,oreb:2,dreb:3},
  {fgm:1,fga:3,threeMade:1,threeAttempts:3,ftm:2,fta:3,oreb:0,dreb:1},
]) assert.deepEqual(calculateTotals(s), expectedTotals(s));
assert.equal(formatTotal('fgPct', 100), '100.0%');
assert.equal(formatTotal('fgPct', 33.3), '33.3%');
assert.equal(formatTotal('points', 0), '0');
assert.equal(calculation({fgm:5,fga:9,threeMade:2,threeAttempts:3,ftm:3,fta:4,oreb:1,dreb:4}, 'points'), '2 × (5 − 2) + 3 × 2 + 3 = 15 points');
assert.deepEqual([0,4,5,9,10].map(difficultyFor), [1,1,2,2,3]);
let session = createSession(seeded(13));
assert.equal(nextRound(session), session);
for (let n = 0; n < 11; n++) {
  assert.equal(session.puzzle.difficulty, difficultyFor(n));
  const answered = answerRound(session, session.puzzle.wrongField);
  assert.equal(answered.correct, n + 1);
  assert(validateSession(answered));
  assert.equal(answerRound(answered, keysFor(answered.puzzle.difficulty)[0]), answered);
  session = nextRound(answered, seeded(50 + n));
}
const wrong = keysFor(session.puzzle.difficulty).find(k => k !== session.puzzle.wrongField);
session = answerRound(session, wrong);
assert.equal(session.correct, 11); assert.equal(session.answered, 12);
assert.equal(session.streak, 0); assert.equal(session.bestStreak, 11);
assert(validateSession(session));
assert.equal(answerRound(session, session.puzzle.wrongField), session);
const restarted = createSession();
assert.equal(restarted.answered, 0); assert.equal(restarted.bestStreak, 0); assert.equal(restarted.puzzle.difficulty, 1);
for (let seed = 700; seed < 730; seed++) {
  const random = seeded(seed);
  let progression = createSession(random);
  for (let round = 0; round < 100; round++) {
    const options = keysFor(progression.puzzle.difficulty);
    progression = answerRound(progression, options[Math.floor(random() * options.length)]);
    assert(validateSession(progression), "Random valid answer summaries remain restorable");
    progression = nextRound(progression, random);
    assert(validateSession(progression), "Random valid round history remains restorable");
  }
}

// Saved puzzle history and streak summaries must describe a reachable game state
let answeredPuzzle = createSession(seeded(501));
answeredPuzzle = answerRound(answeredPuzzle, answeredPuzzle.puzzle.wrongField);
assert(validateSession(answeredPuzzle));
const replayedAsUnanswered = { ...answeredPuzzle, selected: null };
assert.equal(validateSession(replayedAsUnanswered), false, "An answered puzzle cannot be restored as a fresh answer opportunity");
const nextPuzzle = nextRound(answeredPuzzle, seeded(502));
assert(validateSession(nextPuzzle), "A normal answer followed by Next round retains valid history");
assert.equal(validateSession({ ...nextPuzzle, recentIds: [nextPuzzle.puzzle.id] }), false, "History cannot forget generated puzzles before the recent window is full");

let oneMissSequence = createSession(seeded(503));
for (let n = 0; n < 4; n++) {
  const answer = n < 3 ? oneMissSequence.puzzle.wrongField : keysFor(oneMissSequence.puzzle.difficulty).find(key => key !== oneMissSequence.puzzle.wrongField);
  oneMissSequence = answerRound(oneMissSequence, answer);
  if (n < 3) oneMissSequence = nextRound(oneMissSequence, seeded(504 + n));
}
assert(validateSession(oneMissSequence), "Three correct answers and a final miss can produce a best streak of three");
assert.equal(validateSession({ ...oneMissSequence, bestStreak: 1 }), false, "One miss cannot split three correct answers into runs of one");

let splitSequence = createSession(seeded(510));
for (let n = 0; n < 4; n++) {
  const answer = n === 2
    ? keysFor(splitSequence.puzzle.difficulty).find(key => key !== splitSequence.puzzle.wrongField)
    : splitSequence.puzzle.wrongField;
  splitSequence = answerRound(splitSequence, answer);
  if (n < 3) splitSequence = nextRound(splitSequence, seeded(511 + n));
}
assert(validateSession(splitSequence), "Two runs of correct answers around a miss can end with a streak of one");
assert.equal(validateSession({ ...splitSequence, bestStreak: 3 }), false, "Best streak cannot exceed every run allowed by the trailing streak");

// Reject corrupt persisted results, identities, statistics, and impossible source lines.
for (const mutate of [
  s => {s.puzzle.totals.points = -1;},
  s => {s.puzzle.totals.points = Infinity;},
  s => {s.puzzle.source.fgm = s.puzzle.source.fga + 1;},
  s => {s.puzzle.source.threeMade = s.puzzle.source.fgm + 1;},
  s => {s.puzzle.id = 'fake';},
  s => {s.selected = 'not-a-stat';},
  s => {s.correct = s.answered + 1;},
  s => {s.streak = s.bestStreak + 1;},
  s => {s.puzzle.totals.extra = 99;},
  s => {s.puzzle.difficulty = 9;},
  s => {s.recentIds = [];},
]) {
  const broken = structuredClone(session); mutate(broken); assert(!validateSession(broken));
}
const store = new Map();
const storage = {getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v)};
assert(savePractice(session, () => storage));
const restored = loadPractice(() => storage);
assert.deepEqual(restored.session, session);
assert.equal(answerRound(restored.session, restored.session.puzzle.wrongField), restored.session);
store.set(PRACTICE_KEY, JSON.stringify(replayedAsUnanswered));
assert.equal(loadPractice(() => storage).session.answered, 0, "Impossible saved answer state recovers to a fresh session");
for (const raw of ['bad JSON', '{}', 'null', 'x'.repeat(32769)]) {
  store.set(PRACTICE_KEY, raw); const result = loadPractice(() => storage); assert(validateSession(result.session));
}
const unavailable = () => { throw new Error('blocked'); };
assert(!loadPractice(unavailable).storageAvailable);
assert(!savePractice(session, unavailable));
assert(!savePractice(session, () => ({...storage, setItem: () => {throw new Error('quota');}})));
assert.equal(loadPractice(() => storage).storageAvailable, true);
console.log('Box-score game: 6,000 generated puzzles, degenerate randomness, progression, edge math, locking, scoring, restore and storage failures passed');
