// Offline only: features and labels come from the shipped motion engine
import { FEATURE_DEFINITION, FEATURE_ID, SHOTFORM_ENGINE, challengeFromSeed, motionFeatures, measure, randomStep } from '../frontend/src/features/games/shotformMotion.ts';
if (process.argv[2] === "--definition") { process.stdout.write(JSON.stringify({ engine: SHOTFORM_ENGINE, features: FEATURE_ID, featureDefinition: FEATURE_DEFINITION })); process.exit(0); }
let seed = Number(process.argv[2] ?? 43117) >>> 0;
const random = () => { let value; [seed, value] = randomStep(seed); return value; };
const rows = [];
for (let n = 0; n < 400; n++) {
  const c = challengeFromSeed(Math.floor(random() * 4294967296), [1, 4, 7][n % 3]);
  for (let k = 0; k < 30; k++) {
    const controls = k === 0 ? c.target : k === 1 ? c.start : [0, 0, 0].map(() => Math.floor(random() * 9) - 4);
    rows.push([motionFeatures(c, controls), measure(c, controls)]);
  }
}
process.stdout.write(JSON.stringify(rows));
