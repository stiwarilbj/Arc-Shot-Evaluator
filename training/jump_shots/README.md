# Jump-shot dataset and model registry

This directory is a manifest and tooling contract, not a bundled dataset. No
jump-shot probability is enabled until a rights-cleared, adjudicated dataset
and held-out evaluation satisfy the gates in `docs/accuracy.md`.

The first collection target is 6,000 jump shots from at least 150 shooters and
20 venues, with separate amateur, college, and professional cohorts. Include
three-pointers, mid-range shots, open and contested attempts, blocks,
airballs, occlusion, camera edits, replays, and clips with no attempts.

Each row in `schema.jsonl` identifies its source rights and duplicate group,
then records the shot outcome, shooter and opponent identities, court
calibration, motion events, defender state, visibility, and independent
reference measurements. Two reviewers adjudicate ambiguous events. Keep games,
sessions, replays, and duplicate footage in one split group; never split by
individual frame.

`config.yaml` freezes the release feature cutoffs and cohort/group split rules.
`model_registry.json` intentionally starts with no validated model. The
training script compares regularized logistic regression with histogram
gradient-boosted trees when scikit-learn and a manifest are supplied, but it
never writes a release model without a separate calibration and final-test
report. Install the optional local training dependency and run it with:

```bash
python -m pip install -e '.[training]'
python scripts/train_jump_models.py /path/to/jump-shots.jsonl --report work/jump-baselines.json
```

The report includes separate release and release-plus-200-ms cutoffs, grouped
development metrics, and the selected candidate. It intentionally does not
promote weights or enable probabilities in the application.

Public sources must permit the intended public or commercial ARC use. Research
only sources remain documented for experiments and are excluded from the
release manifest. User footage requires permission and a recorded consent
scope.
