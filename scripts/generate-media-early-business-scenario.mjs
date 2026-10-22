import fs from 'node:fs';
import { buildMediaEarlyBusinessScenario, validateMediaEarlyBusinessScenario, MEDIA_EARLY_SCENARIO_PATH } from './lib/media-early-business-scenario.mjs';

const recipe = buildMediaEarlyBusinessScenario();
const errors = validateMediaEarlyBusinessScenario(recipe, recipe);
if (errors.length) throw new Error(errors.join('\n'));
const args = process.argv.slice(2);
const check = args.includes('--check');
const outputIndex = args.indexOf('--output');
const optionValues = new Set(outputIndex >= 0 ? [outputIndex + 1] : []);
if (args.some((arg, index) => !optionValues.has(index) && !['--check', '--output'].includes(arg)) || (outputIndex >= 0 && !args[outputIndex + 1])) {
  throw new Error('Usage: node scripts/generate-media-early-business-scenario.mjs [--check] [--output <path>]');
}
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : MEDIA_EARLY_SCENARIO_PATH;
const generated = `${JSON.stringify(recipe, null, 2)}\n`;
if (check) {
  let existing;
  try { existing = fs.readFileSync(outputPath, 'utf8'); }
  catch { console.error(`Missing generated projection: ${outputPath}`); process.exitCode = 1; }
  if (existing !== undefined && existing !== generated) {
    console.error(`Stale generated projection: ${outputPath}`);
    process.exitCode = 1;
  } else if (existing !== undefined) {
    console.log(`Checked ${outputPath} (${recipe.journeys.length} ordered journeys; ${recipe.blockers.length} preserved blockers)`);
  }
} else {
  fs.writeFileSync(outputPath, generated);
  console.log(`Wrote ${outputPath} (${recipe.journeys.length} ordered journeys; ${recipe.blockers.length} preserved blockers)`);
}
