import assert from "node:assert/strict";
import {
  normalizeName,
  maskingErrorMessage,
  matchPlayers,
  validateMaskRequest,
  stats,
  attempt,
  clip,
  shuffled,
  unstableMask,
  maskResult,
} from "../frontend/src/features/jumper/domain.ts";
import {
  clearFramePoints,
  needsSelection,
} from "../frontend/src/features/jumper/editorSelections.ts";

const boxedTracks = [
  {
    id: 1,
    prompts: [
      {
        frame: 0,
        box: [0.1, 0.1, 0.8, 0.9],
        points: [[0.4, 0.5]],
        labels: [1],
      },
      { frame: 5, points: [[0.5, 0.5]], labels: [1] },
    ],
  },
  { id: 2, prompts: [{ frame: 0, points: [[0.2, 0.2]], labels: [1] }] },
];
const clearedBox = clearFramePoints(boxedTracks, 1, 0);
assert.deepEqual(clearedBox[0].prompts[0], {
  frame: 0,
  box: [0.1, 0.1, 0.8, 0.9],
});
assert.equal(clearedBox[1], boxedTracks[1]);
assert.equal(boxedTracks[0].prompts[0].points.length, 1);
assert.equal(needsSelection(clearedBox[0]), false);
assert.equal(needsSelection(clearFramePoints(boxedTracks, 2, 0)[1]), true);
assert.equal(clearFramePoints(boxedTracks, 1, 5)[0].prompts.length, 1);
assert.equal(
  needsSelection({
    id: 1,
    prompts: [{ frame: 0, points: [[0.5, 0.5]], labels: [0] }],
  }),
  true,
);
assert.equal(needsSelection(undefined), true);
const pointOnlyWithCorrection = [
  {
    id: 3,
    prompts: [
      { frame: 4, points: [[0.2, 0.2]], labels: [1] },
      { frame: 8, points: [[0.3, 0.3]], labels: [1] },
    ],
  },
];
const clearedSeed = clearFramePoints(pointOnlyWithCorrection, 3, 4)[0];
assert.equal(needsSelection(clearedSeed), true);
assert.deepEqual(clearedSeed.prompts[0], { frame: 4 });
assert.equal(clearedSeed.prompts[1], pointOnlyWithCorrection[0].prompts[1]);

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

// Browser/native association uses the same input fixtures and expectations.
const { readFileSync } = await import("node:fs");
const { resolvePeople, clickedPersonBox } = await import(
  "../frontend/src/features/jumper/discovery.ts"
);
const bodies = [
  [0.1, 0.1, 0.4, 0.9],
  [0.6, 0.1, 0.9, 0.9],
];
assert.deepEqual(clickedPersonBox(bodies, [0.2, 0.5]), bodies[0]);
assert.equal(clickedPersonBox(bodies, [0.5, 0.5]), undefined);
assert.equal(clickedPersonBox([...bodies, bodies[0]], [0.2, 0.5]), undefined);
for (const fixture of JSON.parse(
  readFileSync(
    new URL("../tests/fixtures/jumper/discovery.json", import.meta.url),
  ),
)) {
  const owners = new Uint8Array(fixture.width * fixture.height);
  for (const [id, x1, y1, x2, y2] of fixture.masks)
    for (let y = y1; y < y2; y++)
      for (let x = x1; x < x2; x++) owners[y * fixture.width + x] = id;
  assert.deepEqual(
    resolvePeople(fixture.boxes, owners, fixture.width, fixture.height),
    { unmatched: fixture.unmatched, ambiguous: fixture.ambiguous },
    fixture.name,
  );
}
validateMaskRequest({
  ...request,
  auto_detect_others: true,
  presentation: "silhouette",
});
for (const change of [
  { auto_detect_others: "yes" },
  { presentation: "original" },
  { objects: request.objects.map((o) => ({ ...o, ignored: true })) },
])
  assert.throws(() => validateMaskRequest({ ...request, ...change }));
console.log("Silhouette options and one-to-one discovery passed");

const gpuFailure = maskingErrorMessage(
  new Error(
    "OrtRun failed: A valid external Instance reference no longer exists. mapAsync",
  ),
);
assert.match(gpuFailure, /video and selections are unchanged/);
assert.match(gpuFailure, /free downloaded editor/);
assert.doesNotMatch(gpuFailure, /OrtRun|mapAsync/);
assert.match(
  maskingErrorMessage(new Error("Model integrity check failed")),
  /integrity check failed/,
);
