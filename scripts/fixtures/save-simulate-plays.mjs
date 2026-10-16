const point = (x, y) => ({ x, y });
const marker = (id, x, y, extra = {}) => ({ id, x, y, ...extra });
const action = (id, kind, sequence, start, end, extra = {}) => ({ id, kind, sequence, start: point(...start), end: point(...end), ...extra });
const play = (name, players, arrows, defenders = [], ball = players[0]) => ({
  version: 1, id: `draft-${name}`, name, players, defenders, arrows,
  defenders_visible: defenders.length > 0, ball: ball ? point(ball.x, ball.y) : null,
});

// Expected IDs specify executable order independently of the document's array order.
export const SAVE_SIMULATE_PLAYS = [
  {
    document: play('curves-and-simultaneous-actions', [
      marker(1, 50, 78, { ratings: { threePoint: 5, midrange: 2, finishing: 4 }, badges: ['playmaker'] }),
      marker(4, 28, 58), marker(9, 76, 56, { badges: ['cutter'] }),
    ], [
      action('feed', 'pass', 2, [50, 65], [28, 58], { actor_id: 1, recipient_id: 4, timing: 1.1 }),
      action('curved-cut', 'movement', 1, [76, 56], [74, 35], { actor_id: 9, path: 'curve', control: point(88, 50) }),
      action('handler-drive', 'movement', 1, [50, 78], [50, 65], { actor_id: 1, path: 'curve', timing: 1.4 }),
    ], [marker(7, 47, 70, { badges: ['helper'] })]),
    order: ['curved-cut', 'handler-drive', 'feed'], actors: [9, 1, 1],
  },
  {
    document: play('slip-and-pass', [marker(1, 50, 78), marker(5, 60, 68)], [
      action('slip', 'slip-screen', 1, [60, 68], [55, 68], { screener_id: 5, handler_id: 1, timing: 1.3 }),
      action('slip-feed', 'pass', 2, [50, 78], [51, 50], { actor_id: 1, recipient_id: 5 }),
    ], [marker(2, 47, 70), marker(8, 57, 65)]),
    order: ['slip', 'slip-feed'], actors: [5, 1],
  },
  {
    document: play('handoff-possession', [marker(3, 50, 70), marker(8, 53, 70)], [
      action('handoff', 'handoff', 1, [50, 70], [53, 70], { actor_id: 3, recipient_id: 8, timing: .9 }),
      action('receiver-drive', 'movement', 2, [53, 70], [62, 55], { actor_id: 8 }),
    ]),
    order: ['handoff', 'receiver-drive'], actors: [3, 8],
  },
  {
    document: play('legacy-participant-binding', [marker(1, 50, 75), marker(2, 28, 55)], [
      action('legacy-pass', 'pass', undefined, [50, 75], [28, 55]),
      action('legacy-cut', 'movement', undefined, [28, 55], [36, 40], { path: 'curve' }),
    ]),
    order: ['legacy-pass', 'legacy-cut'], actors: [1, 2],
  },
  {
    document: play('precision-and-pop', [marker(1, 50.1234567, 78.00005), marker(5, 60, 68)], [
      action('pop', 'pick-pop', 1, [60, 68], [55.1234567, 68.00015], {
        screener_id: 5, handler_id: 1, timing: 2.675,
        control: point(56.00005, 65.1234567), exit_target: point(69.00015, 58.1234567),
      }),
    ], [marker(1, 47.1234567, 70.00015)]),
    order: ['pop'], actors: [5],
    precision: [
      ['players.0.x', 50.1235], ['players.0.y', 78.0001],
      ['defenders.0.x', 47.1235], ['defenders.0.y', 70.0002],
      ['ball.x', 50.1235], ['ball.y', 78.0001],
      ['arrows.0.end.x', 55.1235], ['arrows.0.end.y', 68.0002],
      ['arrows.0.control.x', 56.0001], ['arrows.0.control.y', 65.1235],
      ['arrows.0.exit_target.x', 69.0002], ['arrows.0.exit_target.y', 58.1235], ['arrows.0.timing', 2.67],
    ],
  },
  {
    document: play('one-player-no-defense', [marker(11, 50, 75)], [
      action('solo-curve', 'movement', 1, [50, 75], [60, 55], { actor_id: 11, path: 'curve', control: point(70, 70) }),
    ]),
    order: ['solo-curve'], actors: [11],
  },
  { document: play('empty-legacy-drawing', [], [], [], null), order: [], actors: [] },
];
