# Shotform Jenga

Open [Games → Shotform Jenga](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#games/shotform-jenga) on the hosted site or the same fragment in the downloaded app

## Play a round

Watch the three repetitions, then stage one change using Balance, Elbow, or Follow-through · Buttons move one step on a bounded −4 to +4 grid · The pending card names the change and its new position, and Cancel adjustment discards it without cost

**Test adjustment** commits one experiment and its result before animation begins · Compare every area's before/after score, not just the highlighted area · A change can help one part and disturb another · Faint outlines show the previous test using the same repetition and phase

All three measured scores must reach 80/100 · Tests are unlimited and the game is untimed · Completion locks the result until Next round · Round score is `min(100, round(100 × minimum adjustments ÷ tested adjustments))` · Completed rounds and best round score are retained

Undo restores the preceding tested controls once, without reducing the tested-adjustment count · After Undo, the score comparison and faint outline return to the starting baseline · Completed rounds stay locked · Replay changes no controls or statistics · While a test animation is paused, resume or scrub to its end before adjusting again

Newly generated rounds 1–3 start with exactly one unstable area, rounds 4–6 with exactly two, and round 7 onward with exactly three · A bounded seeded search retains the two-to-eight-adjustment solution requirement and recent-challenge protection · Existing saved challenges keep their original setup when resumed

The ball follows an illustrative arc from a fixed release point and remains inside the court at supported controls · It does not affect motion scores

## Motion and challenge generation

`shotformMotion.ts` defines engine `shotform-motion-v1` · A seeded challenge specifies a target, initial controls, a coupling matrix, handedness, and three bounded repetition samples · Every experiment reuses those samples

The normalized 3D skeleton uses fixed body segments · Forward kinematics drives the arms and inverse kinematics keeps both leg segments constant · Rendering projects the joints into a compact three-quarter silhouette with no footage or graphics dependency · The ball arc is illustrative and does not determine stability or a basket score

At three fixed motion phases, the engine measures body displacement over fixed feet, shooting-arm lateral angle, and wrist-to-hand finish angle across the repetitions · Nine normalized joint-difference features describe their spread · Each area's score is `clamp(100 − 28 × feature RMS, 0, 100)` · These are intentionally simplified game measures, not biomechanical quality judgments

The bounded 9 × 9 × 9 control grid is searched before accepting a challenge · Only solutions requiring two to eight one-step adjustments qualify · The minimum Manhattan distance to any stable grid point sets the scoring benchmark · Three recent challenge identities prevent immediate repeats

## Neural highlight model

A genuine ReLU network with widths **9 → 32 → 32 → 3** learns stability scores from the shipped engine's joint-motion features · It selects which region to highlight · Measured motion always determines displayed scores and completion, including when neural predictions are slightly different

Weights, normalization, feature identity, engine identity, and validation results are bundled in `frontend/src/features/games/shotform-model.json` · The loader enforces a 128 KiB download ceiling, pinned SHA-256, nested tensor validation, accuracy metadata gates, and independent startup probes · Failure activates labeled **Game motion analysis**, with retry · Playing neither downloads video models nor calls inference services

Training is an explicit developer command, absent from startup, builds, and deployment:

```sh
.venv/bin/python scripts/train-shotform-model.py
```

This requires local PyTorch and NumPy · The dataset generator imports the canonical TypeScript engine, avoiding duplicate motion equations · Training uses seed 91031 and 12,000 samples from seed 43117 · A separate 12,000-sample seed 791915 is held out from optimization

Publication gates require score errors ≤2 points at the 99th percentile and ≤5 maximum, plus ≥98% correct unstable-region identification when the two lowest scores differ by more than five points · The artifact records measured results · The regression suite independently evaluates the artifact on held-out data and extreme grid controls across all tiers

The neural model describes this animated game only · It does not analyze uploaded footage, establish correct real-world shooting mechanics, or provide medical or coaching assessments

## Progress and accessibility

Version-1 browser storage includes engine identity, challenge seed, random state, controls, pending change, preceding controls, tested count, recent seeds, and round totals · Motion and diagnostic values are reconstructed instead of trusting saved scores · Validation checks that undo history is reachable and best scores can be produced by the scoring formula, and checks the first round's saved best score against its actual result · Invalid records recover to a fresh game, and unavailable storage permits in-memory play

A test is persisted before playback, so reloading an interrupted test displays the settled outcome without recounting it · Completion only says it was saved when the write succeeds; otherwise it explains that the result is available for the current visit · Next round moves keyboard focus to its announced round and level · Workspace changes and hidden tabs pause animation · Resuming a paused test keeps adjustments locked until playback finishes or motion is scrubbed to the end · Reduced-motion preference disables autoplay and exposes the same manual motion scrubber · All adjustments use standard keyboard-operable buttons with text-and-symbol feedback

Data stays on the device · There are no accounts, uploads, paid APIs, sound, new backend endpoints, external inference calls, or runtime training

## Verification commands

```sh
cd frontend
npm run test:shotform-jenga
npm run test:box-score-error-hunt
npm run test:swish-tuner
npm run test:navigation
npm run build
VITE_DEPLOY_TARGET=github-pages npm run build
```

The game suite checks seeded solvability, fixed segment lengths, finite poses, coupled effects, minimum counts, complete rounds across tiers, one-change locking, undo, exactly-once completion, storage recovery, pinned weights, malformed structures, held-out accuracy, and boundary cases
