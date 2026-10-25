# Swish Tuner

[Play online](https://stiwarilbj.github.io/Arc-Shot-Evaluator/#games/swish-tuner) · [Feature guide](feature-guide.md)

## Play

Tune **Release angle**, **Power**, and **Backspin** using sliders or numeric fields · Press **Shoot** to test the setup · Make three shots to unlock **Next round**, without a timer or attempt limit

The dashed curve is an approximate pre-contact prediction · The shaded band shows bounded release variation plus a conservative 5 cm neural-error allowance · The blue trace is the actual shot · A clean descending shot through the rim scores; rim and backboard contact ends the attempt as a miss, without rebound simulation

Three makes need not be consecutive · Round score is `round(300 ÷ attempts)`, capped at 100 · Misses do not remove makes or previously earned score

| Control | Supported range | Meaning |
| --- | --- | --- |
| Release angle | 35–75°, steps of 0.1° | Initial direction above horizontal |
| Power | 0–100%, steps of 0.1% | Linear mapping to 5–13 m/s release speed |
| Backspin | 0–5 revolutions per second, steps of 0.1 | Small lift effect in flight, not an automatic make |

Every shot has independent seeded variation of up to ±0.15° angle, ±0.2 percentage points of power, and ±0.03 rps, bounded by the controls' limits · The seed advances only when shooting or choosing the next setup, with no changes based on winning or losing

Rounds use 12 verified setups from 3.5–7.5 m distance and 2.7–3.5 m hoop height · The first round is 4 m at standard height · Early rounds use a smaller catalog before longer distances and challenge heights appear · Immediate repeats are excluded, and the last three setups are avoided where the unlocked pool permits

## Privacy and recovery

The game and weights load only after opening Swish Tuner · No API, account, cloud inference, sound, or runtime training is used · Both downloaded and hosted builds use the same browser implementation

The versioned local session stores controls, seed, setup, score, and the last shot's release values · A shot result is committed before its visual animation, so reload settles it once without awarding duplicate progress · Browser storage failure leaves the game playable for the current visit

Leaving the workspace or hiding the browser pauses the current shot · Returning offers **Resume shot** · Reduced-motion preference shows the completed trace without a flight animation · Restart practice requires confirmation

If the neural asset fails to load or validate, **Physics preview** is labeled explicitly, scoring continues normally, and **Retry neural model** fetches the asset again · There is no paid-service fallback

## Game physics and neural model

The independent `swish-flight-v1` solver uses meters, seconds, a 2 m release point, a 0.12 m ball radius, and RK4 integration at 240 Hz · Gravity is 9.81 m/s², linear drag is 0.035/s, and the perpendicular spin-lift coefficient is 0.012 per revolution per second · Swept checks prevent the ball from skipping rim contacts between samples

Hoop diameter is 0.4572 m and the standard height is 3.048 m, following [NBA equipment dimensions](https://official.nba.com/rule-no-1-court-dimensions-equipment/) · Altered heights are game challenges · Spin lift is a deliberately modest approximation, not an experimentally calibrated basketball model — [NASA describes the limitations of ideal spinning-ball models](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/ideal-lift-of-a-spinning-ball/)

The network has four inputs, two 48-unit tanh hidden layers, and two outputs · It predicts a correction to a ballistic trajectory, multiplied by time squared so the release position is exact · Inputs are normalized horizontal/vertical release velocity, spin, and time · Approximation is used only for the preview; the fixed-step solver determines outcomes

The checked-in artifact is 55,890 bytes · Training uses 40,000 synthetic samples, seed 87231, explicit edge coverage, Adam fitting, and full-batch refinement · The separate 12,000-sample training holdout has 1.35 cm p99 error and 2.71 cm maximum across the full four-second domain, including below-floor samples · A separate JavaScript regression checks another 12,000 samples and control-boundary fixtures against the actual browser solver

Publication gates are p99 ≤ 2 cm and maximum ≤ 5 cm · The bundled model records its engine, architecture, normalization, and measured validation results · Runtime checks validate the artifact and representative trajectories before enabling neural preview

Regenerate offline using the existing development Python environment with NumPy and PyTorch installed

```sh
.venv/bin/python scripts/train-swish-model.py
npm run test:swish-tuner --prefix frontend
```

Training never runs during app startup, normal builds, or deployment · A failed accuracy gate preserves the previous model artifact · Solver changes require a new engine identity, retraining, and verification before publication
