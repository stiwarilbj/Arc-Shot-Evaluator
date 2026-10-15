import assert from 'node:assert/strict';
import { packReplay, unpackReplay } from '../frontend/src/features/playbook/counterLabReplayArchive.ts';
import { decodeReplayForPlayback } from '../frontend/src/features/playbook/counterLabReplayValidation.ts';

const frame = () => ({ elapsedMs: 0, sequence: 2, action: 'Pass', ballHandlerId: 1,
  players: [{ id: 1, x: -0, y: 42.123456789012345 }, { id: 2, x: 60, y: 50 }], defenders: [{ id: 1, x: 40, y: 40 }],
  ball: { x: 50, y: 50 }, shotPhase: 'idle', assignments: [{ defenderId: 1, playerId: 2 }],
  opportunities: [{ kind: 'pass', playerId: 2, quality: 65.12345678901235, score: 1, receiverGap: Infinity, laneGap: Infinity }],
  blockedPass: { actionId: 'pass', sequence: 2, playerId: 2, receiverGap: 1, laneGap: 1 }, involvedPlayerIds: [1, 2],
  activeRoutes: [{ id: 'curve', actionId: 'pass', sequence: 2, playerId: 1, kind: 'pass', scope: 'on-ball', importance: 'main',
    start: { x: 50, y: 50 }, end: { x: 60, y: 50 }, control: { x: 55, y: 60 }, via: { x: 52, y: 51 }, points: [{ x: 50, y: 50 }, { x: 60, y: 50 }] }],
  execution: [{ actionId: 'pass', sequence: 2, actorId: 1, recipientId: 2, partnerId: null, phase: 'transfer', startedAtMs: 0,
    completedAtMs: null, setAtMs: 0, usedAtMs: 0, progress: .12345678901234567, notice: null }],
});
const frames = [frame(), { ...frame(), elapsedMs: 1000 / 30, ballHandlerId: 2 }, { ...frame(), elapsedMs: 2000 / 30, ball: null, ballHandlerId: null, shotPhase: 'air' }];
const archive = packReplay(frames), decoded = decodeReplayForPlayback(archive);
assert.deepEqual(decoded, frames, 'correct samples retain exact precision, optional fields and infinity gap sentinels');
assert.equal(decoded[0].activeRoutes, decoded[1].activeRoutes, 'validation preserves shared immutable route metadata');
assert.ok(Object.isFrozen(decoded[0].players[0]));
assert.ok(Object.is(decoded[0].players[0].x, -0));
assert.deepEqual(unpackReplay(archive), decoded, 'validation neither modifies nor replaces decoded sample contents');
const partial = frame(); partial.players = [partial.players[0]]; partial.defenders = []; partial.ballHandlerId = null;
partial.assignments = []; partial.opportunities = []; partial.blockedPass = null; partial.involvedPlayerIds = []; partial.activeRoutes = [];
delete partial.execution;
assert.deepEqual(decodeReplayForPlayback(packReplay([partial])), [partial], 'partial rosters, null possession and absent execution are supported');
const reordered = structuredClone(frames); reordered[1].players.reverse();
assert.deepEqual(decodeReplayForPlayback(packReplay(reordered)), reordered, 'roster ordering may change while identities stay fixed');
const tied = [frame(), frame()];
assert.deepEqual(decodeReplayForPlayback(packReplay(tied)), tied, 'equal timestamps are ordered and remain safe to seek');

let rejected = 0;
function invalid(values) {
  const packed = packReplay(values);
  assert.doesNotThrow(() => unpackReplay(packed), 'fixture is structurally decodable, isolating content validation');
  assert.throws(() => decodeReplayForPlayback(packed), /Replay data is damaged or incompatible.*Retry/, 'bad contents use the recoverable replay error');
  rejected++;
}
invalid([]); invalid([[]]); invalid([{}]);
for (const field of Object.keys(frame()).filter(key => key !== 'execution')) {
  const value = frame(); delete value[field]; invalid([value]);
}
for (const value of [NaN, Infinity, -Infinity, -1, '0']) { const item = frame(); item.elapsedMs = value; invalid([item]); }
invalid([{ ...frame(), elapsedMs: 10 }, { ...frame(), elapsedMs: 9.999 }]);
for (const field of ['players', 'defenders', 'assignments', 'opportunities', 'involvedPlayerIds', 'activeRoutes', 'execution']) {
  for (const bad of [null, {}, [null]]) { const item = frame(); item[field] = bad; invalid([item]); }
}
for (const change of [
  v => { v.players[0].x = NaN; }, v => { v.players[0].y = Infinity; }, v => { v.defenders[0].x = -Infinity; },
  v => { v.ball.x = NaN; }, v => { v.ball = {}; }, v => { v.players[0].id = 0; }, v => { v.defenders[0].id = '1'; },
  v => { v.players[1].id = 1; }, v => { v.defenders.push({ ...v.defenders[0] }); },
  v => { v.ballHandlerId = 99; }, v => { v.assignments[0].playerId = 99; }, v => { v.assignments[0].defenderId = 99; },
  v => { v.opportunities[0].playerId = 99; }, v => { v.involvedPlayerIds = [99]; }, v => { v.blockedPass.playerId = 99; },
  v => { v.activeRoutes[0].playerId = 99; }, v => { v.execution[0].actorId = 99; },
  v => { v.execution[0].recipientId = 99; }, v => { v.execution[0].partnerId = 99; },
  v => { v.sequence = 0; }, v => { v.action = {}; }, v => { v.shotPhase = 'flying'; },
  v => { v.opportunities[0].quality = NaN; }, v => { v.opportunities[0].score = Infinity; },
  v => { v.opportunities[0].receiverGap = NaN; }, v => { v.opportunities[0].laneGap = -Infinity; },
  v => { v.opportunities[0].kind = 'screen'; }, v => { delete v.blockedPass.actionId; },
  v => { v.activeRoutes[0].start.x = NaN; }, v => { v.activeRoutes[0].end.y = Infinity; },
  v => { v.activeRoutes[0].control.x = NaN; }, v => { v.activeRoutes[0].via.y = NaN; },
  v => { v.activeRoutes[0].points[1].x = -Infinity; }, v => { v.activeRoutes[0].points = {}; },
  v => { v.activeRoutes[0].scope = 'unknown'; }, v => { v.activeRoutes[0].importance = 'unknown'; },
  v => { delete v.activeRoutes[0].id; }, v => { delete v.activeRoutes[0].end; },
  v => { v.execution[0].progress = NaN; }, v => { v.execution[0].phase = 'unknown'; },
  v => { delete v.execution[0].recipientId; }, v => { v.execution[0].startedAtMs = Infinity; },
  v => { v.execution[0].completedAtMs = -1; }, v => { v.execution[0].setAtMs = NaN; },
  v => { v.execution[0].usedAtMs = '0'; }, v => { v.execution[0].notice = {}; },
]) { const item = frame(); change(item); invalid([item]); }
const missingPlayer = structuredClone(frames); missingPlayer[1] = { ...partial, elapsedMs: 100 };
invalid(missingPlayer);
const replacedDefender = structuredClone(frames); replacedDefender[1].defenders[0].id = 2; replacedDefender[1].assignments[0].defenderId = 2;
invalid(replacedDefender);
// Decode-time failure must not damage the reusable source archive or later retries.
assert.deepEqual(decodeReplayForPlayback(archive), frames);
console.log(`Replay content validation passed: ${rejected} structurally decodable damaged payloads rejected; exact values, shared metadata, partial rosters, possession changes and retry preserved`);
