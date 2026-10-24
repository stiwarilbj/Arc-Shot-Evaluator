import assert from 'node:assert/strict';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { COUNTER_LAB_DEFAULT_PROFILES } from '../frontend/src/features/playbook/counterLabTypes.ts';
import { analyzeCounterLabDilemma, runCounterLabTrial } from '../frontend/src/features/playbook/counterLabEngine.ts';
import { decodeReplayForPlayback } from '../frontend/src/features/playbook/counterLabReplayValidation.ts';
import { pointDistanceFeet } from '../frontend/src/features/playbook/simulation.ts';

const profile = COUNTER_LAB_DEFAULT_PROFILES.find((candidate) => candidate.id === 'switch');
assert.ok(profile);
const draft = structuredClone(STARTER_PLAYS[0]);
draft.arrows[0].timingPlan = { startAtMs: 350 };
const original = structuredClone(draft);
const configuration = { defenderId: 1, stayWithPlayerId: 1, tagPlayerId: 2, actionId: 'pickroll-screen', milestone: 'screen-set' };
const collect = async (seed) => analyzeCounterLabDilemma(draft, profile, 'scripted', configuration, seed, () => {});
const first = await collect(40231), repeated = await collect(40231);
assert.deepEqual(first.summaries, repeated.summaries, 'all three choices use one reproducible seed and produce stable event summaries');
assert.deepEqual(draft, original, 'Dilemma trials never mutate the selected play');
assert.deepEqual(first.summaries.map((summary) => summary.choice), ['stay', 'tag', 'split']);
assert.ok(first.summaries.every((summary) => summary.status === 'released' && summary.startedAtMs >= 350 && summary.releasedAtMs >= summary.startedAtMs),
  'delayed actions start and release commitments only at recorded simulation milestones');

const decoded = new Map([...first.archives].map(([choice, archive]) => [choice, decodeReplayForPlayback(archive)]));
const initial = decoded.get('stay')[0];
for (const choice of ['stay', 'tag', 'split']) {
  const trace = decoded.get(choice);
  assert.ok(trace?.length > 2);
  assert.ok(trace.every((frame) => frame.defenderDilemma?.choice === choice));
  assert.ok(trace.every((frame) => frame.defenders.some((defender) => defender.id === configuration.defenderId)));
  assert.deepEqual({ players: trace[0].players, defenders: trace[0].defenders, ball: trace[0].ball },
    { players: initial.players, defenders: initial.defenders, ball: initial.ball }, 'all commitments begin at the same court and possession');
}
assert.deepEqual(decoded.get('stay'), decodeReplayForPlayback(repeated.archives.get('stay')), 'packed replay detail remains deterministic and lossless');
const at = (trace, time) => trace.reduce((best, frame) => Math.abs(frame.elapsedMs - time) < Math.abs(best.elapsedMs - time) ? frame : best);
const preStart = at(decoded.get('stay'), 150);
assert.equal(preStart.defenderDilemma.status, 'waiting');
const preRelease = at(decoded.get('stay'), 500);
assert.equal(preRelease.defenderDilemma.status, 'committed');
const defenderPoint = (frame) => frame.defenders.find((defender) => defender.id === configuration.defenderId);
const pointSignature = (frame) => { const value = defenderPoint(frame); return [value.x, value.y]; };
assert.notDeepEqual(pointSignature(preRelease), pointSignature(at(decoded.get('tag'), 500)), 'stay and tag commitments produce distinct normal-speed defender movement');
assert.notDeepEqual(pointSignature(preRelease), pointSignature(at(decoded.get('split'), 500)), 'split tracks the live midpoint rather than silently reusing a named threat');
const taggedEnd = decoded.get('tag').at(-1), taggedDefender = defenderPoint(taggedEnd);
const stayAtEnd = taggedEnd.players.find((player) => player.id === configuration.stayWithPlayerId);
const tagAtEnd = taggedEnd.players.find((player) => player.id === configuration.tagPlayerId);
assert.ok(pointDistanceFeet(taggedDefender, stayAtEnd) < pointDistanceFeet(taggedDefender, tagAtEnd), 'tagging returns toward the stay-with threat after the selected release milestone');

const blocked = structuredClone(STARTER_PLAYS[1]);
blocked.arrows = [{ id: 'unpossessed-pass', kind: 'pass', sequence: 1, timing: 1, start: { ...blocked.players[1] }, end: { ...blocked.players[2] }, actor_id: 2, recipient_id: 3 }];
blocked.ball = { ...blocked.players[0] };
const missingMilestone = await analyzeCounterLabDilemma(draft, profile, 'scripted', { ...configuration, milestone: 'complete' }, 13, () => {});
assert.ok(missingMilestone.summaries.every((summary) => summary.status === 'release-not-reached' && summary.startedAtMs !== null && summary.releasedAtMs === null),
  'a started action with a missing selected milestone keeps the commitment report distinct from a missing trigger');
const missingEvent = await analyzeCounterLabDilemma(blocked, profile, 'scripted', {
  defenderId: 1, stayWithPlayerId: 1, tagPlayerId: 3, actionId: 'unpossessed-pass', milestone: 'catch',
}, 7, () => {});
assert.ok(missingEvent.summaries.every((summary) => summary.status === 'trigger-not-reached' && summary.startedAtMs === null && summary.releasedAtMs === null),
  'a blocked authored transfer reports the missing trigger and never starts a scheduled commitment');

let cancelled = false;
await assert.rejects(analyzeCounterLabDilemma(draft, profile, 'scripted', configuration, 9,
  (progress) => { if (progress.label.startsWith('Running stay')) cancelled = true; }, () => cancelled),
/Dilemma cancelled/, 'cancellation interrupts between bounded simulation chunks');

const standard = runCounterLabTrial(STARTER_PLAYS[0], profile, 'scripted');
assert.deepEqual(runCounterLabTrial(STARTER_PLAYS[0], profile, 'scripted'), standard, 'ordinary Counter Lab trials remain deterministic and unaffected by opt-in Dilemma state');
console.log('Defender Dilemma tests passed: delayed actual milestones, three seeded commitments, lossless replay, missing milestone, blocked trigger, and ordinary trial isolation');
