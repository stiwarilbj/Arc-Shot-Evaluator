import assert from 'node:assert/strict';
import { buildRoleCues, authoredRoleCueTemplates } from '../frontend/src/features/playbook/roleRehearsal.ts';
import { authoredCourtRoutes } from '../frontend/src/features/playbook/simulation.ts';
import { validatePlaybookDocument } from '../frontend/src/features/playbook/documentValidation.ts';
import { normalizePlaybookPrecision } from '../frontend/src/features/playbook/documentPrecision.ts';
import { playbookContentKey } from '../frontend/src/features/playbook/playbookDraftSession.ts';

const play = {
  version: 1, id: 'draft-role', name: 'Give and cut', defenders_visible: true,
  players: [{ id: 1, x: 50, y: 70 }, { id: 2, x: 35, y: 62 }, { id: 3, x: 23, y: 55 }],
  defenders: [{ id: 1, x: 50, y: 55 }], ball: { x: 50, y: 70 },
  arrows: [
    { id: 'pass-one', kind: 'pass', sequence: 1, actor_id: 1, recipient_id: 2, timing: 1.2,
      timingPlan: { startAtMs: 0 }, start: { x: 50, y: 70 }, end: { x: 35, y: 62 } },
    { id: 'cut-two', kind: 'backdoor-cut', sequence: 2, actor_id: 2, timing: 1.2,
      timingPlan: { startAtMs: 500, waits: [{ id: 'wait-catch', actionId: 'pass-one', event: 'catch' }] },
      start: { x: 35, y: 62 }, end: { x: 50, y: 40 } },
  ],
};
validatePlaybookDocument(play);
const templates = authoredRoleCueTemplates(play);
const routes = authoredCourtRoutes(play);
assert.ok(routes.some((route) => route.actionId === 'pass-one' && route.playerId === 1), 'role route geometry includes the authored actions for the selected player');
assert.ok(routes.some((route) => route.actionId === 'cut-two' && route.playerId === 2), 'route geometry covers later authored moves before playback reaches them');
assert.ok(templates.some((cue) => cue.playerId === 1 && cue.phase === 'pass' && cue.text.includes('Player 2')));
assert.ok(templates.some((cue) => cue.playerId === 2 && cue.phase === 'receive' && cue.text.includes('Player 1')));
assert.ok(templates.some((cue) => cue.playerId === 2 && cue.phase === 'wait' && cue.text.includes('confirmed catch')));
assert.ok(templates.some((cue) => cue.playerId === 2 && cue.phase === 'cut'));

const executablePath = structuredClone(play);
delete executablePath.roleCues;
const separateLesson = { version: 1, cues: [{ playerId: 1, actionId: templates.find((cue) => cue.playerId === 1).actionId,
  phase: templates.find((cue) => cue.playerId === 1).phase, scope: 'shared', text: 'Use the new wording', signature: templates.find((cue) => cue.playerId === 1).signature }] };
assert.equal(buildRoleCues(executablePath, 1, null, new Set(['pass-one', 'cut-two']), [], 0, separateLesson)[0].text, 'Use the new wording', 'flattened executable paths apply lesson data from the separately preserved source document');

const pass = templates.find((cue) => cue.playerId === 2 && cue.phase === 'receive');
const wait = templates.find((cue) => cue.playerId === 2 && cue.phase === 'wait');
play.roleCues = { version: 1, cues: [{ playerId: 2, actionId: pass.actionId, phase: pass.phase, scope: 'shared', text: 'Secure the ball', signature: pass.signature }] };
validatePlaybookDocument(play);
assert.notEqual(playbookContentKey(play), playbookContentKey({ ...play, roleCues: undefined }), 'custom cue wording is saved content');
const savedPrecision = normalizePlaybookPrecision(play);
const savedPrecisionCues = buildRoleCues(savedPrecision, 2, null, new Set(['pass-one', 'cut-two']), [], 0);
assert.equal(savedPrecisionCues.find((cue) => cue.actionId === pass.actionId && cue.phase === pass.phase).reviewWording, false, 'save precision does not flag unchanged custom wording for review');
const legacyWording = structuredClone(play);
legacyWording.roleCues.cues[0].signature = pass.legacySignature;
const legacyCues = buildRoleCues(legacyWording, 2, null, new Set(['pass-one', 'cut-two']), [], 0);
assert.equal(legacyCues.find((cue) => cue.actionId === pass.actionId && cue.phase === pass.phase).reviewWording, false, 'existing full-action signatures remain compatible');

const pending = { actionId: 'cut-two', sequence: 2, actorId: 2, recipientId: null, partnerId: null,
  phase: 'pending', startedAtMs: null, completedAtMs: null, progress: 0, notice: null };
const caught = { actionId: 'pass-one', sequence: 1, actorId: 1, recipientId: 2, partnerId: null,
  phase: 'completed', startedAtMs: 100, completedAtMs: 1420, progress: 1, notice: null,
  transfer: { actionKey: 'pass-one', kind: 'pass', giverId: 1, receiverId: 2, release: null, arrival: null,
    outcome: { kind: 'caught', atMs: 1420, position: { x: 35, y: 62 } } } };
let cues = buildRoleCues(play, 2, null, new Set(['pass-one', 'cut-two']), [pending, caught], 900);
const receive = cues.find((cue) => cue.phase === 'receive');
assert.equal(receive.status, 'completed', 'receiving is complete only after a confirmed catch');
assert.equal(receive.startAtMs, 1420, 'receiver cue uses the recorded catch time');
assert.equal(cues.find((cue) => cue.phase === 'wait').status, 'waiting', 'a wait remains pending until its action starts');
assert.equal(cues.find((cue) => cue.phase === 'cut').status, 'waiting');

const changed = structuredClone(play);
changed.arrows[0].end.x = 39;
cues = buildRoleCues(changed, 2, null, new Set(['pass-one', 'cut-two']), [], 0);
assert.equal(cues.find((cue) => cue.phase === 'receive').reviewWording, false, 'route coordinates do not invalidate role wording');
assert.equal(cues.find((cue) => cue.phase === 'receive').text, 'Secure the ball', 'review never discards saved wording');
const changedKind = structuredClone(play);
changedKind.arrows[0].kind = 'handoff';
changedKind.arrows[0].actor_id = 1;
changedKind.arrows[0].recipient_id = 2;
cues = buildRoleCues(changedKind, 2, null, new Set(['pass-one', 'cut-two']), [], 0);
assert.equal(cues.find((cue) => cue.phase === 'receive').reviewWording, true, 'custom wording is flagged when its action type changes');
const changedWait = structuredClone(play);
changedWait.roleCues.cues.push({ playerId: 2, actionId: 'cut-two', phase: 'cut', scope: 'shared', text: 'Cut after the pass', signature: templates.find((cue) => cue.playerId === 2 && cue.actionId === 'cut-two' && cue.phase === 'cut').signature });
changedWait.arrows[1].timingPlan.waits[0].event = 'complete';
cues = buildRoleCues(changedWait, 2, null, new Set(['pass-one', 'cut-two']), [], 0);
assert.equal(cues.find((cue) => cue.actionId === 'cut-two' && cue.phase === 'cut').reviewWording, true, 'custom wording is flagged when its prerequisite changes');

const stationary = buildRoleCues(play, 3, null, new Set(['pass-one', 'cut-two']), [], 0);
assert.equal(stationary[0].text, 'Hold position');
assert.equal(stationary[0].status, 'active', 'a stationary responsibility remains active for the whole rehearsal');
const stationaryDocument = structuredClone(play);
stationaryDocument.roleCues = { version: 1, cues: [{ playerId: 3, actionId: 'stationary', phase: 'hold', scope: 'shared', text: 'Hold the corner', signature: stationary[0].signature }] };
validatePlaybookDocument(stationaryDocument);

for (const malformed of [
  { ...stationaryDocument, roleCues: { version: 1, cues: [{ ...stationaryDocument.roleCues.cues[0], playerId: 99 }] } },
  { ...stationaryDocument, roleCues: { version: 1, cues: [{ ...stationaryDocument.roleCues.cues[0], phase: 'guess' }] } },
  { ...stationaryDocument, roleCues: { version: 1, cues: [stationaryDocument.roleCues.cues[0], stationaryDocument.roleCues.cues[0]] } },
  { ...stationaryDocument, roleCues: { version: 1, cues: [{ ...stationaryDocument.roleCues.cues[0], unexpected: true }] } },
  { ...stationaryDocument, roleCues: { version: 2, cues: [] } },
]) assert.throws(() => validatePlaybookDocument(malformed));

console.log('My Role regressions passed: engine-bound participant cues, explicit waits, caught-pass timing, blocked/waiting state, stationary roles, saved wording, review flags, and validation');
