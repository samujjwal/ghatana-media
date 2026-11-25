#!/usr/bin/env node
// Validates integration-tests/journey-selectors.v1.json against the journey
// evidence in docs/development/remaining-work.json and the integration test
// sources, then prints Gradle --tests arguments for a journey selection.
//
// Usage:
//   node scripts/check-journey-selectors.mjs                 validate only
//   node scripts/check-journey-selectors.mjs --print J-24    Gradle --tests args for one journey
//   node scripts/check-journey-selectors.mjs --print cpu-only
//   node scripts/check-journey-selectors.mjs --print all
//   node scripts/check-journey-selectors.mjs --print J-24 --command
//       also prints the full Gradle command with the required -P flags

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 'media.journey-selectors.v1';
export const JOURNEY_IDS = Array.from({ length: 30 }, (_, i) => `J-${String(i + 1).padStart(2, '0')}`);
const TEST_ROOT = 'integration-tests/src/test/java';
const GRADLE_PROJECT = ':services:media:integration-tests';
const GRADLE_P_FLAGS = [
  '-Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE',
  '-Pghatana.media.compositeScope=FULL',
  '-Pghatana.kernel.path=/home/samujjwal/Developments/ghatana-kernel',
  '-Pghatana.tools.path=/home/samujjwal/Developments/ghatana-tools',
  '-Pghatana.lifecycle.path=/home/samujjwal/Developments/ghatana-lifecycle',
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(scriptDir, '..');
const DEFAULT_MANIFEST = join(REPO_ROOT, 'integration-tests/journey-selectors.v1.json');
const DEFAULT_REMAINING = join(REPO_ROOT, 'docs/development/remaining-work.json');

/** Returns { errors: string[], journeys: Map<id, journey>, selectors: Map<id, string[]> }. */
export function validateManifest(manifest, { remaining, repoRoot = REPO_ROOT }) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (manifest.schemaVersion !== SCHEMA_VERSION) err(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (manifest.testRoot !== TEST_ROOT) err(`testRoot must be ${TEST_ROOT}`);
  if (manifest.gradleProject !== GRADLE_PROJECT) err(`gradleProject must be ${GRADLE_PROJECT}`);

  const classes = manifest.classes ?? {};
  const journeys = Array.isArray(manifest.journeys) ? manifest.journeys : [];

  // Source journeys and outcome tasks.
  const sourceJourneys = new Map((remaining.journeys ?? []).map((j) => [j.id, j]));
  const outcomeTasks = new Map(
    (remaining.tasks ?? [])
      .filter((t) => typeof t.id === 'string' && t.id.startsWith('media.dev.outcome-'))
      .map((t) => [t.journeyId, t]),
  );

  const seen = new Set();
  const byId = new Map();
  for (const j of journeys) {
    if (seen.has(j.id)) err(`duplicate journey ${j.id}`);
    seen.add(j.id);
    byId.set(j.id, j);
  }
  for (const id of JOURNEY_IDS) {
    if (!byId.has(id)) err(`missing journey ${id}`);
  }
  for (const id of byId.keys()) {
    if (!JOURNEY_IDS.includes(id)) err(`unexpected journey id ${id}`);
  }

  const referenced = new Set();
  const selectors = new Map();

  for (const id of JOURNEY_IDS) {
    const j = byId.get(id);
    if (!j) continue;
    const src = sourceJourneys.get(id);
    const task = outcomeTasks.get(id);
    if (!src) err(`${id}: not in remaining-work.json journeys[]`);
    if (!task) {
      err(`${id}: no media.dev.outcome-* task with journeyId ${id}`);
    } else if (j.taskId !== task.id) {
      err(`${id}: taskId ${j.taskId} does not match ${task.id}`);
    }
    if (task && j.taskState !== task.state) err(`${id}: taskState ${j.taskState} does not match source ${task.state}`);

    const evidence = [task?.verificationEvidence, task?.progress]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .join('\n');
    const list = Array.isArray(j.classes) ? j.classes : [];
    if (new Set(list).size !== list.length) err(`${id}: duplicate class entries`);

    for (const fqcn of list) {
      referenced.add(fqcn);
      const info = classes[fqcn];
      if (!info) {
        err(`${id}: class ${fqcn} has no entry in classes{}`);
        continue;
      }
      const simple = fqcn.slice(fqcn.lastIndexOf('.') + 1);
      const expectedFile = join(TEST_ROOT, ...fqcn.split('.').slice(0, -1), `${simple}.java`);
      if (info.file !== expectedFile) err(`${fqcn}: file ${info.file} does not match package path ${expectedFile}`);
      const abs = join(repoRoot, info.file);
      if (!existsSync(abs)) {
        err(`${id}: class file missing: ${info.file}`);
        continue;
      }
      const src = readFileSync(abs, 'utf8');
      if (!new RegExp(`\\bclass\\s+${simple}\\b`).test(src)) err(`${fqcn}: no class declaration in ${info.file}`);
      if (!/@Tag\("integration"\)/.test(src)) err(`${fqcn}: not @Tag("integration"), Gradle would skip it`);
      if (/@Disabled\b/.test(src)) err(`${fqcn}: is @Disabled, Gradle would skip it`);
      if (!new RegExp(`\\b${simple}\\b`).test(evidence)) {
        err(`${id}: ${simple} is listed but ${id} evidence in ${task?.id ?? '(none)'} does not mention it`);
      }
    }

    // Flags on the journey must be the recomputation from its classes.
    const expectOr = (key) => list.some((c) => classes[c]?.[key]);
    if (list.length > 0) {
      for (const [jKey, cKey] of [
        ['needsLocalModel', 'needsLocalModel'],
        ['needsChromium', 'needsChromium'],
        ['needsNode', 'needsNode'],
        ['needsFfmpeg', 'needsFfmpeg'],
      ]) {
        if (j[jKey] !== expectOr(cKey)) err(`${id}: ${jKey} is ${j[jKey]}, classes say ${expectOr(cKey)}`);
      }
      if (j.cpuOnly !== !j.needsLocalModel) err(`${id}: cpuOnly must equal !needsLocalModel`);
    }
    if (j.runnable !== list.length > 0) err(`${id}: runnable must be ${list.length > 0}`);
    if (j.selectorCount !== list.length) err(`${id}: selectorCount ${j.selectorCount} != ${list.length}`);
    if (list.length === 0 && j.evidenceEmpty !== true && !evidence.trim()) {
      err(`${id}: empty classes but evidenceEmpty is not true`);
    }
    for (const n of j.evidenceNamesNotInIntegrationTree ?? []) {
      if (list.some((c) => c.endsWith(`.${n}`))) err(`${id}: ${n} is both listed and outside the tree`);
    }
    selectors.set(id, list);
  }

  for (const fqcn of Object.keys(classes)) {
    if (!referenced.has(fqcn)) err(`classes{} entry ${fqcn} is not used by any journey`);
  }

  // Derived selector sets.
  const cpu = new Set();
  const all = new Set();
  for (const id of JOURNEY_IDS) {
    const j = byId.get(id);
    if (!j || !j.runnable) continue;
    for (const c of selectors.get(id)) all.add(c);
    if (j.cpuOnly) for (const c of selectors.get(id)) cpu.add(c);
  }
  selectors.set('cpu-only', [...cpu].sort());
  selectors.set('all', [...all].sort());

  return { errors, journeys: byId, selectors };
}

/** Gradle --tests arguments, one selector per class. */
export function testArgs(fqcns) {
  return fqcns.flatMap((c) => ['--tests', c]);
}

export function gradleCommand(fqcns) {
  return [
    './gradlew',
    ...GRADLE_P_FLAGS,
    `${GRADLE_PROJECT}:test`,
    ...testArgs(fqcns),
  ].join(' ');
}

/** Formats a validated selector choice without starting a child process. */
export function formatSelection(selectors, selection, { command = false } = {}) {
  const key = selection.toUpperCase() === 'CPU-ONLY' ? 'cpu-only'
    : selection.toUpperCase() === 'ALL' ? 'all' : selection.toUpperCase();
  if (!selectors.has(key)) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `unknown selection ${selection}; use J-01..J-30, cpu-only or all`,
    };
  }
  const list = selectors.get(key);
  if (list.length === 0) {
    return {
      exitCode: 3,
      stdout: '',
      stderr: `${key} has no integration classes named in its evidence; nothing to run`,
    };
  }
  return {
    exitCode: 0,
    stdout: command ? gradleCommand(list) : testArgs(list).join(' '),
    stderr: '',
  };
}

function main(argv) {
  const printIdx = argv.indexOf('--print');
  const print = printIdx >= 0 ? argv[printIdx + 1] : undefined;
  const command = argv.includes('--command');
  const manifestPath = DEFAULT_MANIFEST;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const remaining = JSON.parse(readFileSync(DEFAULT_REMAINING, 'utf8'));
  const { errors, selectors, journeys } = validateManifest(manifest, { remaining });

  if (errors.length > 0) {
    for (const e of errors) console.error(`FAIL ${e}`);
    console.error(`${errors.length} problem(s)`);
    process.exit(1);
  }

  if (print) {
    const result = formatSelection(selectors, print, { command });
    if (result.exitCode !== 0) {
      console.error(result.stderr);
      process.exit(result.exitCode);
    }
    console.log(result.stdout);
    return;
  }

  const runnable = JOURNEY_IDS.filter((id) => journeys.get(id).runnable).length;
  console.log(`OK ${JOURNEY_IDS.length} journeys, ${runnable} runnable, ${selectors.get('all').length} distinct classes, ${selectors.get('cpu-only').length} cpu-only classes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
