import assert from 'node:assert/strict';
import { parseCounterLabRequest, counterLabRequestError } from '../frontend/src/features/playbook/counterLabRequests.ts';
import { STARTER_PLAYS } from '../frontend/src/features/playbook/data.ts';
import { COUNTER_LAB_DEFAULT_PROFILES, COUNTER_LAB_EXTRA_STRATEGIES, COUNTER_LAB_EXTRA_SCHEMES } from '../frontend/src/features/playbook/counterLabTypes.ts';

const request = () => ({ type: 'analyze', id: 'analysis-1', draft: structuredClone(STARTER_PLAYS[0]), profiles: structuredClone(COUNTER_LAB_DEFAULT_PROFILES), modes: ['scripted', 'adaptive'] });
for (const draft of STARTER_PLAYS) {
  const valid = { ...request(), draft, profiles: [...COUNTER_LAB_DEFAULT_PROFILES, ...COUNTER_LAB_EXTRA_STRATEGIES, ...COUNTER_LAB_EXTRA_SCHEMES] };
  const before = structuredClone(valid);
  assert.equal(parseCounterLabRequest(valid), valid, 'valid input follows the existing path without normalization');
  assert.deepEqual(valid, before, 'validation never edits a play');
}
for (const type of ['cancel', 'release']) assert.deepEqual(parseCounterLabRequest({ type, id: 'a' }), { type, id: 'a' });
const details = { type: 'details', id: 'a', detailId: 'detail-1', key: 'switch:scripted', repairId: 'original' };
assert.equal(parseCounterLabRequest(details), details);
assert.ok(parseCounterLabRequest({ ...details, key: 'custom-profile:adaptive', repairId: 'slip-screen-one' }));
const dilemma = { type: 'dilemma', id: 'analysis-d', dilemmaId: 'dilemma-1', draft: structuredClone(STARTER_PLAYS[0]),
  profile: structuredClone(COUNTER_LAB_DEFAULT_PROFILES.find((profile) => profile.id === 'switch')), mode: 'scripted', seed: 193,
  configuration: { defenderId: 1, stayWithPlayerId: 1, tagPlayerId: 2, actionId: 'pickroll-screen', milestone: 'screen-set' } };
assert.equal(parseCounterLabRequest(dilemma), dilemma, 'valid Dilemma requests preserve their authored input');
assert.equal(parseCounterLabRequest({ type: 'dilemma-cancel', id: 'a', dilemmaId: 'd-1' }).type, 'dilemma-cancel');
assert.equal(parseCounterLabRequest({ type: 'dilemma-details', id: 'a', dilemmaId: 'd-1', detailId: 'detail-2', choice: 'split' }).choice, 'split');
const legacy = request();
for (const marker of [...legacy.draft.players, ...legacy.draft.defenders]) { delete marker.ratings; delete marker.badges; }
for (const arrow of legacy.draft.arrows) { delete arrow.actor_id; delete arrow.recipient_id; }
assert.ok(parseCounterLabRequest(legacy), 'version-1 plays retain optional attributes and implicit participants');
const partial = request(); partial.draft.players = partial.draft.players.slice(0, 2); partial.draft.defenders = []; partial.draft.arrows = [];
assert.ok(parseCounterLabRequest(partial), 'partial rosters and empty action lists remain supported');

let rejected = 0;
function invalid(value) {
  let error;
  assert.throws(() => { try { parseCounterLabRequest(value); } catch (caught) { error = caught; throw caught; } }, Error);
  const response = counterLabRequestError(value, error);
  assert.ok(['error', 'dilemma-error'].includes(response.type)); assert.equal(typeof response.id, 'string'); assert.equal(typeof response.message, 'string');
  rejected++;
}
for (const value of [null, undefined, true, 4, 'analyze', [], {}, { id: 'a' }, { type: 'unknown', id: 'a' }, { type: 'cancel', id: 7 }, { type: 'release', id: '  ' }]) invalid(value);
for (const field of ['id', 'draft', 'profiles', 'modes']) { const value = request(); delete value[field]; invalid(value); }
for (const [field, values] of Object.entries({ profiles: [null, {}, [], [null], [{}], new Array(1)], modes: [null, {}, [], ['other'], ['scripted', 'scripted'], new Array(1)] })) {
  for (const content of values) { const value = request(); value[field] = content; invalid(value); }
}
for (const [field, content] of [['id', ''], ['id', 'bad:key'], ['label', null], ['strategy', 'other'], ['scheme', 'auto'], ['scheme', 'other']]) {
  const value = request(); value.profiles[0][field] = content; invalid(value);
}
const duplicate = request(); duplicate.profiles.push(duplicate.profiles[0]); invalid(duplicate);
for (const [field, content] of [['version', 2], ['id', null], ['name', {}], ['defenders_visible', 'yes'], ['players', [null]], ['defenders', [null]], ['arrows', [null]], ['ball', undefined], ['ball', {x: Infinity,y: 1}], ['created_at', 12]]) {
  const value = request(); value.draft[field] = content; invalid(value);
}
for (const change of [
  v => { v.draft.players[0].x = NaN; }, v => { v.draft.players[0].id = 0; },
  v => { v.draft.players[0].ratings = 'bad'; }, v => { v.draft.players[0].ratings.threePoint = Infinity; },
  v => { v.draft.players[0].badges = [null]; }, v => { v.draft.players[0].badges = new Array(1); },
  v => { v.draft.arrows[0].kind = 'other'; }, v => { v.draft.arrows[0].path = 'other'; },
  v => { v.draft.arrows[0].control = {}; }, v => { v.draft.arrows[0].timing = '1'; },
  v => { v.draft.arrows[0].actor_id = 999; }, v => { v.draft.arrows[0].sequence = NaN; },
]) { const value = request(); change(value); invalid(value); }
for (const change of [
  value => { value.configuration.milestone = 'scheduled-time'; },
  value => { value.configuration.tagPlayerId = value.configuration.stayWithPlayerId; },
  value => { value.configuration.defenderId = 999; },
  value => { value.configuration.actionId = 'missing'; },
  value => { value.seed = -1; },
  value => { value.profile.strategy = 'unknown'; },
  value => { value.draft.defenders = []; },
]) { const value = structuredClone(dilemma); change(value); invalid(value); }
{
  const value = request(); value.draft.arrows[0].timingPlan = { startAtMs: NaN }; invalid(value);
}
{
  const value = request(); value.draft.arrows[0].timingPlan = { startAtMs: 0, waits: [{ id: 'wait-orphan', actionId: 'missing-action', event: 'complete' }] }; invalid(value);
}
{
  const value = request(), [first, second] = value.draft.arrows;
  first.timingPlan = { startAtMs: 0, waits: [{ id: 'wait-first', actionId: second.id, event: 'complete' }] };
  second.timingPlan = { startAtMs: 100, waits: [{ id: 'wait-second', actionId: first.id, event: 'complete' }] };
  invalid(value);
}
for (const field of ['detailId', 'repairId', 'key']) { const value = { ...details }; delete value[field]; invalid(value); }
for (const key of ['switch', 'switch:other', ':scripted', 'switch:scripted:extra', 5]) invalid({ ...details, key });
assert.deepEqual(counterLabRequestError(null, null), { type: 'error', id: '', message: 'Invalid Counter Lab request · Try again' });
assert.deepEqual(counterLabRequestError({ ...details, key: 'broken' }, new Error('bad key')), { type: 'error', id: 'a', detailId: 'detail-1', message: 'bad key' }, 'detail errors retain request correlation');
assert.equal(counterLabRequestError({ id: 9 }, new Error('bad id')).id, '', 'invalid IDs never target a real analysis');
console.log(`Worker request validation passed: all 24 starters and defenses, legacy/partial plays, four request kinds, ${rejected} malformed payloads and correlated errors`);
