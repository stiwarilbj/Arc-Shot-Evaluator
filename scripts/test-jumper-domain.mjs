import assert from "node:assert/strict";
import {
  normalizeName,
  matchPlayers,
  validateMaskRequest,
  stats,
  attempt,
  clip,
  shuffled,
  unstableMask,
  maskResult,
} from "../frontend/src/features/jumper/domain.ts";
const players = [
  { id: "1", name: "Nikola Jokić", aliases: ["Joker"] },
  { id: "2", name: "Stephen Curry", aliases: ["Steph Curry"] },
  { id: "3", name: "Seth Curry", aliases: [] },
];
assert.equal(normalizeName("NIKOLA JOKIĆ!"), "nikolajokic");
assert.equal(matchPlayers("Joker", players)[0].id, "1");
assert.equal(matchPlayers("Stepehn Curry", players)[0].id, "2");
assert.equal(matchPlayers("Curry", players).length, 2);
const request = {
  start: 0,
  end: 3,
  target_id: 1,
  objects: [
    {
      id: 1,
      prompts: [
        { frame: 0, points: [[0.5, 0.5]], labels: [1] },
        { frame: 10, points: [[0.6, 0.6]], labels: [1] },
      ],
    },
  ],
};
validateMaskRequest(request);
for (const change of [
  { end: 16 },
  { start: NaN },
  { target_id: 2 },
  { objects: [] },
  { end: 0.01 },
  { objects: [null] },
  { objects: [{ id: 1, prompts: [null] }] },
  { objects: [{ id: 1, prompts: [{ frame: 0, box: { length: 4 } }] }] },
  {
    objects: [{ id: 1, prompts: [{ frame: 0, points: [null], labels: [1] }] }],
  },
  {
    objects: [
      { id: 1, prompts: [{ frame: 1, points: [[0.5, 0.5]], labels: [1] }] },
    ],
  },
])
  assert.throws(() => validateMaskRequest({ ...request, ...change }));
const answer = {
  id: "round",
  clipId: "clip",
  selected: players[0],
  correct: players[0],
  timestamp: "2026-10-16T00:00:00Z",
  outcome: true,
};
assert(attempt(answer));
assert(!attempt({ ...answer, outcome: false }));
assert.deepEqual(stats([answer]), {
  correct: 1,
  incorrect: 0,
  accuracy: 100,
  streak: 1,
});
assert(
  clip({
    version: 1,
    id: "clip",
    player: players[0],
    duration: 3,
    createdAt: answer.timestamp,
    mime: "video/mp4",
    quiz: true,
  }),
);
assert(!clip({}));
assert.deepEqual([...new Set(shuffled(["1", "2", "3"]))].sort(), [
  "1",
  "2",
  "3",
]);
console.log("Jumper domain regressions passed");
validateMaskRequest({
  ...request,
  objects: [
    ...request.objects,
    { id: 2, prompts: [{ frame: 20, points: [[0.3, 0.4]], labels: [1] }] },
  ],
});
assert(!unstableMask(null, { area: 100, x: 0.5, y: 0.5 }));
assert(
  !unstableMask({ area: 100, x: 0.5, y: 0.5 }, { area: 110, x: 0.51, y: 0.5 }),
);
assert(
  unstableMask({ area: 100, x: 0.5, y: 0.5 }, { area: 30, x: 0.5, y: 0.5 }),
);
assert(
  unstableMask({ area: 100, x: 0.5, y: 0.5 }, { area: 100, x: 0.9, y: 0.5 }),
);
assert(
  !maskResult({
    duration: 1,
    highlight: new Blob(["x"], { type: "video/mp4" }),
    quiz: new Blob(["x"], { type: "video/mp4" }),
    reveal: new Blob(["x"], { type: "video/mp4" }),
    warnings: [null],
  }),
);
