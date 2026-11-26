import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest, formatSelection, testArgs, JOURNEY_IDS, REPO_ROOT } from '../scripts/check-journey-selectors.mjs';

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'integration-tests/journey-selectors.v1.json'), 'utf8'));
const remaining = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/development/remaining-work.json'), 'utf8'));

const clone = (x) => JSON.parse(JSON.stringify(x));
const check = (m, root = REPO_ROOT) => validateManifest(m, { remaining, repoRoot: root });

test('committed manifest validates against remaining-work.json and the test tree', () => {
  const { errors, journeys } = check(manifest);
  assert.deepEqual(errors, []);
  assert.equal(journeys.size, 30);
});

test('all 30 journey ids J-01..J-30 are present', () => {
  assert.equal(JOURNEY_IDS.length, 30);
  assert.equal(JOURNEY_IDS[0], 'J-01');
  assert.equal(JOURNEY_IDS[29], 'J-30');
  for (const id of JOURNEY_IDS) assert.ok(manifest.journeys.some((j) => j.id === id), id);
});

test('a missing journey is reported', () => {
  const m = clone(manifest);
  m.journeys = m.journeys.filter((j) => j.id !== 'J-05');
  assert.ok(check(m).errors.some((e) => e.includes('missing journey J-05')));
});

test('a class listed for a journey whose evidence does not mention it is rejected', () => {
  const m = clone(manifest);
  const j = m.journeys.find((x) => x.id === 'J-03');
  j.classes = ['com.ghatana.media.integration.MediaDevSimulationIT'];
  j.selectorCount = 1;
  j.runnable = true;
  j.cpuOnly = true;
  j.needsLocalModel = false;
  j.needsChromium = false;
  j.needsNode = false;
  j.needsFfmpeg = true;
  const { errors } = check(m);
  assert.ok(errors.some((e) => e.startsWith('J-03: MediaDevSimulationIT is listed but')), errors.join('\n'));
});

test('J-06 selector evidence may come from progress, but removing it from both fields is rejected', () => {
  const m = clone(manifest);
  const source = clone(remaining);
  const j = m.journeys.find((x) => x.id === 'J-06');
  const task = source.tasks.find((x) => x.id === j.taskId);
  const simple = j.classes[0].slice(j.classes[0].lastIndexOf('.') + 1);

  // This test exercises the progress fallback independently from whichever
  // source field currently carries the citation. Keep the fixture stable when
  // a coordinator compacts progress and preserves history in verificationEvidence.
  task.progress = `${task.progress ?? ''}\n${simple}`;
  task.verificationEvidence = '';
  let { errors } = validateManifest(m, { remaining: source, repoRoot: REPO_ROOT });
  assert.deepEqual(errors.filter((error) => error.startsWith('J-06:')), []);

  task.progress = task.progress.replaceAll(simple, '');
  task.verificationEvidence = task.verificationEvidence.replaceAll(simple, '');
  ({ errors } = validateManifest(m, { remaining: source, repoRoot: REPO_ROOT }));
  assert.ok(errors.some((error) => error.startsWith(`J-06: ${simple} is listed but`)), errors.join('\n'));
});

test('empty selector validation accepts progress evidence and rejects it when absent', () => {
  const m = clone(manifest);
  const source = clone(remaining);
  const j = m.journeys.find((x) => x.id === 'J-06');
  const task = source.tasks.find((x) => x.id === j.taskId);
  j.classes = [];
  j.runnable = false;
  j.selectorCount = 0;
  j.evidenceEmpty = false;
  task.verificationEvidence = '';

  let { errors } = validateManifest(m, { remaining: source, repoRoot: REPO_ROOT });
  assert.ok(!errors.includes('J-06: empty classes but evidenceEmpty is not true'), errors.join('\n'));

  task.progress = '';
  ({ errors } = validateManifest(m, { remaining: source, repoRoot: REPO_ROOT }));
  assert.ok(errors.includes('J-06: empty classes but evidenceEmpty is not true'), errors.join('\n'));
});

test('a class whose file does not exist is rejected', () => {
  const m = clone(manifest);
  const fqcn = 'com.ghatana.media.integration.MediaDevDoesNotExistIT';
  m.classes[fqcn] = { ...m.classes['com.ghatana.media.integration.MediaDevMasterIT'], file: 'integration-tests/src/test/java/com/ghatana/media/integration/MediaDevDoesNotExistIT.java' };
  const j = m.journeys.find((x) => x.id === 'J-17');
  j.classes = [...j.classes, fqcn];
  j.selectorCount = j.classes.length;
  const { errors } = check(m);
  assert.ok(errors.some((e) => e.includes('class file missing') && e.includes('MediaDevDoesNotExistIT')), errors.join('\n'));
});

test('an untagged or @Disabled class is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-sel-'));
  try {
    const pkgDir = join(root, 'integration-tests/src/test/java/com/ghatana/media/integration');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'MediaDevFixtureIT.java'), 'package com.ghatana.media.integration;\nclass MediaDevFixtureIT {}\n');
    const m = clone(manifest);
    const fqcn = 'com.ghatana.media.integration.MediaDevFixtureIT';
    m.classes = { [fqcn]: { file: 'integration-tests/src/test/java/com/ghatana/media/integration/MediaDevFixtureIT.java', tagIntegration: false, disabled: false, hasTestMethod: false, needsLocalModel: false, needsChromium: false, needsNode: false, needsFfmpeg: false } };
    const j = m.journeys.find((x) => x.id === 'J-01');
    m.journeys.forEach((x) => { if (x.id !== 'J-01') { x.classes = []; x.runnable = false; x.cpuOnly = false; x.selectorCount = 0; } });
    j.classes = [fqcn];
    j.selectorCount = 1;
    j.runnable = true;
    j.cpuOnly = true;
    const { errors } = check(m, root);
    assert.ok(errors.some((e) => e.includes('not @Tag("integration")')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journey flags must match the flags of their classes', () => {
  const m = clone(manifest);
  const j = m.journeys.find((x) => x.id === 'J-24');
  j.needsChromium = true;
  assert.ok(check(m).errors.some((e) => e.startsWith('J-24: needsChromium')));
});

test('cpu-only selection contains no class that needs a local model', () => {
  const { selectors, journeys } = check(manifest);
  const cpu = selectors.get('cpu-only');
  assert.ok(cpu.length > 0);
  for (const c of cpu) assert.equal(manifest.classes[c].needsLocalModel, false, c);
  for (const j of journeys.values()) if (j.cpuOnly) assert.equal(j.needsLocalModel, false, j.id);
});

test('selection formatter prints Gradle --tests arguments for J-24', () => {
  const { selectors } = check(manifest);
  const result = formatSelection(selectors, 'J-24');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '--tests com.ghatana.media.integration.MediaDevStructuredCliBatchIT');
  assert.equal(result.stderr, '');
  assert.deepEqual(testArgs(['a.B', 'c.D']), ['--tests', 'a.B', '--tests', 'c.D']);
});

test('selection formatter prints the full Gradle command with the required -P flags', () => {
  const { selectors } = check(manifest);
  const result = formatSelection(selectors, 'J-24', { command: true });
  assert.equal(result.exitCode, 0);
  const out = result.stdout;
  for (const flag of [
    '-Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE',
    '-Pghatana.media.compositeScope=FULL',
    '-Pghatana.kernel.path=',
    '-Pghatana.tools.path=',
    '-Pghatana.lifecycle.path=',
  ]) assert.ok(out.includes(flag), flag);
  assert.ok(out.includes(':services:media:integration-tests:test --tests com.ghatana.media.integration.MediaDevStructuredCliBatchIT'));
});

test('selection formatter prints every selector for a journey', () => {
  const { selectors } = check(manifest);
  const result = formatSelection(selectors, 'J-03');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout,
    '--tests com.ghatana.media.integration.MediaDevCaptionJourneyIT '
      + '--tests com.ghatana.media.integration.MediaDevExplorerCaptionCorrectionLiveIT');
});

test('selection formatter supports all and cpu-only aliases case-insensitively', () => {
  const { selectors } = check(manifest);
  for (const [selection, key] of [['all', 'all'], ['CPU-ONLY', 'cpu-only']]) {
    const result = formatSelection(selectors, selection);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, testArgs(selectors.get(key)).join(' '));
  }
});

test('selection formatter reports unknown and empty selections without starting a child process', () => {
  const unknown = formatSelection(new Map(), 'J-31');
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.stderr, 'unknown selection J-31; use J-01..J-30, cpu-only or all');
  const empty = formatSelection(new Map([['J-18', []]]), 'J-18');
  assert.equal(empty.exitCode, 3);
  assert.equal(empty.stderr, 'J-18 has no integration classes named in its evidence; nothing to run');
});
