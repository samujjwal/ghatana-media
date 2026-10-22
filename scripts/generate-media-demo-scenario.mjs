#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDemoScenario, readSources, ROOT, validateDemoScenario, validateJsonSchema } from './lib/media-demo-scenario.mjs';

const OUTPUT = path.join(ROOT, 'docs/implementation/recipes/media-demo-j03-corrected-captions.v1.candidate.json');
const SCHEMA = path.join(ROOT, 'schemas/media-demo-scenario-spec.v1.schema.json');
const check = process.argv.includes('--check');
const strict = process.argv.includes('--strict');

const { parsed, fingerprints, phaseStatuses } = await readSources(ROOT);
const scenario = buildDemoScenario({ parsed, fingerprints, phaseStatuses });
const structuralErrors = validateDemoScenario(scenario);
const schema = JSON.parse(await readFile(SCHEMA, 'utf8'));
if (schema.$id !== 'https://ghatana.dev/schemas/media-demo-scenario-spec.v1.schema.json') {
  throw new Error('Unexpected schema identity.');
}
const schemaErrors = validateJsonSchema(scenario, schema);
if (schemaErrors.length > 0) {
  console.error(JSON.stringify(schemaErrors, null, 2));
  throw new Error(`Generated candidate failed JSON Schema validation (${schemaErrors.length} errors).`);
}
if (!scenario.demoScenarioId || !scenario.storyboard.beats.length || Object.keys(scenario.sourcePhaseStatuses).length !== 4) {
  throw new Error('Generated source recipe is structurally incomplete.');
}
if (structuralErrors.some((issue) => issue.code === 'EFFECT_OR_ADMISSION_CLAIM_FORBIDDEN')) {
  throw new Error('Generated recipe crossed the no-effect/no-admission boundary.');
}

const rendered = `${JSON.stringify(scenario, null, 2)}\n`;
if (check) {
  const existing = await readFile(OUTPUT, 'utf8').catch(() => null);
  if (existing !== rendered) {
    console.error(`STALE_DEMO_SCENARIO_CANDIDATE:${path.relative(ROOT, OUTPUT)}`);
    process.exitCode = 1;
  } else {
    console.log(`DEMO_SCENARIO_CANDIDATE_CURRENT:${scenario.status}:${scenario.storyboard.beats.length} beats:${scenario.validationIssues.length} source blockers`);
  }
} else {
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, rendered);
  console.log(`WROTE_DEMO_SCENARIO_CANDIDATE:${path.relative(ROOT, OUTPUT)}:${scenario.status}:${scenario.storyboard.beats.length} beats:${scenario.validationIssues.length} source blockers`);
}
if (strict && structuralErrors.length > 0) process.exitCode = 2;
