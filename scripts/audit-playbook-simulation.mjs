import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { generateAuditCase, executeAuditCase, reduceAuditFailure, readableTrace } from './lib/simulation-adversarial.mjs';
import { SIMULATION_ENGINE_VERSION } from '../frontend/src/features/playbook/simulationVersion.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function saveAuditFailure(directory, test, original, reduction) {
  await mkdir(directory, { recursive: true });
  const body = JSON.stringify(test, null, 2) + '\n';
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const stem = resolve(directory, `seed-${test.seed}-${digest}`);
  // Write each artifact atomically. Original input permits a wider reduction later.
  for (const [suffix, contents] of [
    ['.original.json', JSON.stringify(original, null, 2) + '\n'],
    ['.trace.txt', readableTrace(test, reduction.result, reduction)],
    ['.case.json', body],
  ]) {
    const target = stem + suffix, temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, target);
  }
  return stem + '.case.json';
}

async function main() {
  const options = { seed: 20261020, startIndex: 0, cases: 128, commands: 96, shrinkRuns: 400, output: resolve(root, 'tests/fixtures/simulation-adversarial') };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help') {
      console.log('npm run audit:simulation -- [--seed UINT32] [--start-index N] [--cases 1..10000] [--commands 1..1000] [--shrink-runs 1..10000] [--output DIRECTORY] [--fixture FILE] [--report FILE]\nFailures stop the sweep, reduce automatically, and save .case.json + original + readable trace. No CI or deployment changes.'); return;
    }
    const fields = { '--seed': 'seed', '--start-index': 'startIndex', '--cases': 'cases', '--commands': 'commands', '--shrink-runs': 'shrinkRuns', '--output': 'output', '--fixture': 'fixture', '--report': 'report' };
    const field = fields[name], value = args[++i];
    if (!field || !value) throw new Error(`Unknown or incomplete option: ${name}`);
    options[field] = ['seed', 'startIndex', 'cases', 'commands', 'shrinkRuns'].includes(field) ? Number(value) : resolve(value);
  }
  for (const [field, min, max] of [['seed', 0, 0xffffffff], ['startIndex', 0, 1000000], ['cases', 1, 10000], ['commands', 1, 1000], ['shrinkRuns', 1, 10000]]) {
    if (!Number.isInteger(options[field]) || options[field] < min || options[field] > max) throw new Error(`Invalid ${field}: expected ${min}..${max}.`);
  }
  const started = performance.now(), totals = {}, layouts = {}, coverage = {}, coverages = new Set(), offenseModes = new Set();
  let checked = 0, failed = null;
  console.log(`Adversarial audit: engine ${SIMULATION_ENGINE_VERSION}, seed ${options.seed}, ${options.fixture ? 'fixture replay' : `${options.cases} cases × ${options.commands} generated commands`}`);
  for (let i = 0; i < (options.fixture ? 1 : options.cases); i++) {
    const index = options.startIndex + i;
    const test = options.fixture ? JSON.parse(await readFile(options.fixture, 'utf8')) : generateAuditCase((options.seed + index) >>> 0, { index, commands: options.commands });
    const result = executeAuditCase(test);
    checked++;
    layouts[test.layout] = (layouts[test.layout] ?? 0) + 1;
    coverages.add(`${test.settings.defenseScheme}/${test.settings.defenseStrategy}`); offenseModes.add(test.settings.offenseMode);
    for (const [key, value] of Object.entries(result.counts)) totals[key] = (totals[key] ?? 0) + value;
    for (const [key, values] of Object.entries(result.coverage)) { coverage[key] ??= new Set(); for (const value of values) coverage[key].add(value); }
    if (!result.ok) {
      console.error(`FAIL seed ${test.seed}, ${test.layout}: ${result.failure.code} / ${result.failure.subject} at ${result.failure.atMs}ms. Reducing…`);
      const reduction = reduceAuditFailure(test, { maxRuns: options.shrinkRuns });
      const path = await saveAuditFailure(options.output, reduction.test, test, reduction);
      failed = { path, failure: result.failure, reduction: { runs: reduction.runs, minimality: reduction.minimality } };
      console.error(`Saved regression: ${path}\n${reduction.minimality}, ${reduction.runs} executions. Replay with --fixture FILE.`); break;
    }
    if (checked % 8 === 0) console.log(`Passed ${checked} cases; ${totals.slices} execution slices; ${((performance.now() - started) / 1000).toFixed(1)}s`);
    await new Promise(done => setImmediate(done));
  }
  const report = { version: 1, engineVersion: SIMULATION_ENGINE_VERSION, options, checked, totals, layouts,
    coverage: Object.fromEntries(Object.entries(coverage).map(([key, values]) => [key, [...values].sort()])),
    initialCoverages: [...coverages].sort(), offenseModes: [...offenseModes].sort(), elapsedSeconds: (performance.now() - started) / 1000, failed };
  if (options.report) { await mkdir(dirname(options.report), { recursive: true }); await writeFile(options.report, JSON.stringify(report, null, 2) + '\n'); }
  console.log(`${failed ? 'FAILED' : 'PASSED'}: ${checked} cases; ${totals.slices} execution slices; ${totals.commands} commands.`);
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
